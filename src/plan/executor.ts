import { mkdirSync } from "node:fs"
import { Clock, Data, Deferred, Effect, Schedule } from "effect"
import { AuditFailure } from "../core/audit.ts"
import type { SeedReadError } from "../core/errors.ts"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import type { Interval } from "../core/interval.ts"
import { intervalsWithin, splitIntoBatches, sqlTimestamp, toIso } from "../core/interval.ts"
import { columnNames, type AnyModel } from "../core/model.ts"
import { quoteIdent, render } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { Engine, EngineError, SqlParseError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError, StateStoreShape } from "../state/store.ts"
import { Metric } from "effect"
import { checkContract, SchemaMismatchError } from "./contract.ts"
import { auditFailuresTotal, intervalsDone, snapshotsBuilt } from "./metrics.ts"
import {
  ducklakeAttachSql,
  ducklakeRef,
  envSchema,
  externalSourceRef,
  intervalKey,
  parquetPrefix,
  parquetRef,
  physicalRef,
  physicalSchema,
  physicalTable,
  viewRef,
} from "./naming.ts"
import type { ForwardOnlyError, InvalidEnvironmentError, Plan, PlanAction } from "./planner.ts"

export interface AppliedPlan {
  readonly plan: Plan
  /** Имена моделей, для которых собиралась физика или гнался бэкфилл. */
  readonly built: ReadonlyArray<string>
}

/** В проекте есть parquet-модели, но путь озера не задан в конфиге. */
export class LakeNotConfiguredError extends Data.TaggedError("LakeNotConfiguredError")<{
  readonly model: string
}> {}

/** В проекте есть ducklake-модели, но каталог не задан в конфиге. */
export class DucklakeNotConfiguredError extends Data.TaggedError("DucklakeNotConfiguredError")<{
  readonly model: string
}> {}

export type ApplyError =
  | GraphError
  | StateError
  | EngineError
  | SqlParseError
  | SeedReadError
  | SchemaMismatchError
  | LakeNotConfiguredError
  | DucklakeNotConfiguredError
  | AttachNotConfiguredError
  | AuditFailure
  | InvalidEnvironmentError
  | ForwardOnlyError
  | EngineFeatureError

export interface ApplyOptions {
  /** «Сейчас» для scdType2-версионирования; по умолчанию — Clock. Инъекция для тестов. */
  readonly now?: number
  /** Корень parquet-озера — локальная директория или s3://… (httpfs). */
  readonly lakePath?: string
  /** ATTACH-базы по алиасам (SPEC §9.3) — для export-моделей. */
  readonly attach?: Readonly<Record<string, { readonly url: string; readonly options?: string }>>
  /** DuckLake-каталог для target: "ducklake" (SPEC §14.5). DuckDB-only. */
  readonly ducklake?: { readonly catalog: string; readonly dataPath?: string }
  /**
   * Сколько батчей бэкфилла одной модели считать одновременно (SPEC §5.3).
   * Осмыслен только на движке с пулом соединений (Postgres); DuckDB держит
   * одно соединение — там бэкфилл последовательный независимо от значения.
   */
  readonly concurrency?: number
  /**
   * Межмодельная DAG-конкурентность (SPEC §5.3): сколько моделей строить
   * одновременно. Модель стартует, как только готовы её родители из этого
   * плана — независимые ветки DAG идут параллельно. Осмыслен на движке
   * с пулом (Postgres); DuckDB держит одно соединение — там модели строятся
   * последовательно, иначе чужие стейтменты вклинивались бы в BEGIN/COMMIT.
   */
  readonly modelConcurrency?: number
  /**
   * Ретраи упавшего батча бэкфилла (SPEC §5.3): Schedule.exponential от
   * baseDelayMs (по умолчанию 500 мс), не больше attempts повторов. Батч
   * транзакционен (DELETE+INSERT в одной транзакции, COPY перезаписывает
   * партицию целиком) — повтор безопасен. Аудиты не ретраятся: провал
   * аудита детерминирован, это не транзиентный сбой.
   */
  readonly retry?: { readonly attempts: number; readonly baseDelayMs?: number }
}

/** Модель просит экспорт в ATTACH-алиас, которого нет в конфиге. */
export class AttachNotConfiguredError extends Data.TaggedError("AttachNotConfiguredError")<{
  readonly model: string
  readonly attach: string
}> {}

/** Возможность DuckDB-федерации, недоступная на текущем движке (SPEC §9.3). */
export class EngineFeatureError extends Data.TaggedError("EngineFeatureError")<{
  readonly model: string
  readonly feature: string
  readonly dialect: string
}> {}

/** Несколько стейтментов одной транзакцией движка; откат при любой ошибке. */
const transactional = (
  engine: Engine,
  statements: ReadonlyArray<string>,
): Effect.Effect<void, EngineError> => engine.transaction(statements)

/** Ретраи транзиентного сбоя записи батча; без retry в опциях — как было. */
const withBatchRetry =
  (retry: ApplyOptions["retry"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    retry === undefined || retry.attempts <= 0
      ? effect
      : Effect.retry(effect, {
          times: retry.attempts,
          schedule: Schedule.exponential(retry.baseDelayMs ?? 500),
        })

/** Для s3://-путей mkdir не нужен (и невозможен) — httpfs пишет напрямую. */
const ensureDir = (path: string): Effect.Effect<void> =>
  path.startsWith("s3://")
    ? Effect.void
    : Effect.sync(() => mkdirSync(path, { recursive: true }))

/**
 * Прогон аудитов модели (SPEC §8): `self` — физика снапшота или подзапрос
 * только что загруженного интервала. Запрос аудита возвращает нарушения:
 * blocking → AuditFailure, warn → лог и дальше.
 */
const runAudits = (
  engine: Engine,
  model: AnyModel,
  self: string,
): Effect.Effect<void, EngineError | AuditFailure> =>
  Effect.gen(function* () {
    for (const auditDef of model.audits) {
      const violations = yield* engine.query(
        render(auditDef.fragment, { resolveRef: (ref) => ref, self }),
      )
      if (violations.length === 0) continue
      if (auditDef.blocking) {
        yield* Metric.update(auditFailuresTotal, 1)
        return yield* new AuditFailure({
          model: model.name.full,
          audit: auditDef.name,
          violations: violations.length,
        })
      }
      yield* Effect.logWarning(
        `аудит ${auditDef.name} модели ${model.name.full}: ${violations.length} нарушений (warn)`,
      )
    }
  })

/**
 * Эволюция унаследованной таблицы при forward-only (SPEC §5.2): колонки,
 * появившиеся в новом запросе, добавляются через ALTER (история получает
 * NULL — она не переигрывается), удаление колонок реюзом не выражается —
 * это честный breaking с пересборкой.
 */
const evolveTableForForwardOnly = (
  engine: Engine,
  model: AnyModel,
  target: string,
  emptyBody: string,
): Effect.Effect<void, EngineError | SchemaMismatchError> =>
  Effect.gen(function* () {
    const wanted = yield* engine.describe(emptyBody)
    const actual = yield* engine.describe(`SELECT * FROM ${target}`)
    const have = new Set(actual.map((column) => column.name))
    const wantedNames = new Set(wanted.map((column) => column.name))
    const vanished = actual.filter((column) => !wantedNames.has(column.name))
    if (vanished.length > 0) {
      return yield* new SchemaMismatchError({
        model: model.name.full,
        problems: vanished.map(
          (column) =>
            `forward-only: колонка «${column.name}» есть в унаследованной физике, но исчезла из запроса — удаление колонок требует обычного (breaking) применения`,
        ),
      })
    }
    for (const column of wanted) {
      if (have.has(column.name)) continue
      yield* engine.execute(
        `ALTER TABLE ${target} ADD COLUMN ${quoteIdent(column.name)} ${column.type}`,
      )
    }
  })

/**
 * Бэкфилл incrementalByTimeRange в таблицу (SPEC §5.3): каждый диапазон
 * плана режется на батчи ≤ batchSize; батч — транзакция DELETE-диапазона +
 * INSERT, после успеха его интервалы помечаются done. Упавший батч
 * помечается failed и прерывает apply; уже отмеченное не пересчитывается
 * при повторе — бэкфилл продолжается с места остановки.
 */
const backfillIntoTable = (
  engine: Engine,
  store: StateStoreShape,
  model: AnyModel,
  action: PlanAction,
  target: string,
  resolveRef: (ref: string) => string,
  concurrency: number,
  retry: ApplyOptions["retry"],
): Effect.Effect<void, EngineError | StateError | AuditFailure> =>
  Effect.gen(function* () {
    if (model.kind._tag !== "incrementalByTimeRange") return
    const kind = model.kind
    // вставка по именам: после forward-only-эволюции порядок колонок физики
    // может отличаться от запроса; контракт схемы гарантирует совпадение имён
    const columns = columnNames(model).map(quoteIdent).join(", ")

    const runBatch = (batch: Interval) =>
      Effect.gen(function* () {
        const marks = intervalsWithin(batch, kind.interval).map((interval: Interval) => ({
          startTs: toIso(interval.start),
          endTs: toIso(interval.end),
        }))
        const start = sqlTimestamp(batch.start)
        const end = sqlTimestamp(batch.end)
        const body = render(model.fragment, { resolveRef, interval: { start, end } })
        const markFailed = () =>
          store.markIntervals(action.fingerprint, marks, "failed").pipe(Effect.ignore)
        yield* transactional(engine, [
          `DELETE FROM ${target} WHERE ${quoteIdent(kind.timeColumn)} >= ${start} AND ${quoteIdent(kind.timeColumn)} < ${end}`,
          `INSERT INTO ${target} (${columns}) SELECT ${columns} FROM (${body}) q`,
        ]).pipe(withBatchRetry(retry), Effect.tapError(markFailed))
        // аудит свежезагруженного интервала — до отметки done (SPEC §8)
        yield* runAudits(
          engine,
          model,
          `(SELECT * FROM ${target} WHERE ${quoteIdent(kind.timeColumn)} >= ${start} AND ${quoteIdent(kind.timeColumn)} < ${end})`,
        ).pipe(Effect.tapError(markFailed))
        yield* store.markIntervals(action.fingerprint, marks, "done")
        yield* Metric.update(intervalsDone, marks.length)
      })

    // пул соединений (Postgres) → батчи параллельно: интервалы не пересекаются,
    // каждый — своя транзакция; DuckDB (одно соединение) — последовательно
    const batches = action.backfill.flatMap((range) =>
      splitIntoBatches(range, kind.interval, kind.batchSize),
    )
    yield* Effect.forEach(batches, runBatch, {
      concurrency: engine.dialect === "duckdb" ? 1 : Math.max(1, concurrency),
      discard: true,
    })
  })

/**
 * Бэкфилл в parquet-озеро (SPEC §3.3): интервал = партиция, пересчёт —
 * перезапись файла партиции. Транзакция не нужна: недописанная партиция
 * не помечена done и будет перезаписана при повторе.
 */
const backfillIntoParquet = (
  engine: Engine,
  store: StateStoreShape,
  model: AnyModel,
  action: PlanAction,
  prefix: string,
  resolveRef: (ref: string) => string,
  retry: ApplyOptions["retry"],
): Effect.Effect<void, EngineError | StateError | AuditFailure> =>
  Effect.gen(function* () {
    if (model.kind._tag !== "incrementalByTimeRange") return
    const kind = model.kind
    for (const range of action.backfill) {
      for (const interval of intervalsWithin(range, kind.interval)) {
        const partition = `${prefix}/interval=${intervalKey(kind.interval, interval.start)}`
        yield* ensureDir(partition)
        const body = render(model.fragment, {
          resolveRef,
          interval: { start: sqlTimestamp(interval.start), end: sqlTimestamp(interval.end) },
        })
        const mark = [{ startTs: toIso(interval.start), endTs: toIso(interval.end) }]
        const markFailed = () =>
          store.markIntervals(action.fingerprint, mark, "failed").pipe(Effect.ignore)
        const file = `${partition.replaceAll(`'`, `''`)}/data.parquet`
        yield* engine
          .execute(`COPY (${body}) TO '${file}' (FORMAT PARQUET)`)
          .pipe(withBatchRetry(retry), Effect.tapError(markFailed))
        // аудит записанной партиции — до отметки done; провал = не done → перезапись
        yield* runAudits(engine, model, `(SELECT * FROM read_parquet('${file}'))`).pipe(
          Effect.tapError(markFailed),
        )
        yield* store.markIntervals(action.fingerprint, mark, "done")
        yield* Metric.update(intervalsDone, 1)
      }
    }
  })

/**
 * Применяет план (SPEC §5): в топологическом порядке собирает недостающую
 * физику и догоняет интервалы (ссылки в SQL резолвятся в физические таблицы
 * ЭТОГО плана, не во view окружения — середина apply не видна снаружи),
 * затем промоушен — пересоздание view + транзакционная запись набора
 * в state store.
 */
export const applyPlan = (
  plan: Plan,
  graph: ModelGraph,
  options?: ApplyOptions,
): Effect.Effect<AppliedPlan, ApplyError, EngineAdapter | StateStore> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const store = yield* StateStore
    const lakePath = options?.lakePath
    const nowMs = options?.now ?? (yield* Clock.currentTimeMillis)

    // физика модели — то, что увидят её потребители и view окружения;
    // ключ — physicalFingerprint: при forward-only это физика старой версии
    const physicalFpOf = new Map(plan.actions.map((a) => [a.name, a.physicalFingerprint]))
    const physicalFor = (model: AnyModel, fingerprint: string): string => {
      if (model.kind._tag === "external") return externalSourceRef(model.kind.source)
      // embedded не материализуется — подставляется потребителю подзапросом,
      // его собственные ссылки резолвятся рекурсивно (DAG ацикличен)
      if (model.kind._tag === "embedded") return `(${render(model.fragment, { resolveRef })})`
      if (model.target === "parquet") {
        if (lakePath === undefined) throw new LakeNotConfiguredError({ model: model.name.full })
        return parquetRef(lakePath, model.name, fingerprint)
      }
      return tableRef(model, fingerprint)
    }
    // нативная физика или таблица DuckLake-каталога — по цели модели
    const tableRef = (model: AnyModel, fingerprint: string): string =>
      model.target === "ducklake"
        ? ducklakeRef(model.name, fingerprint)
        : physicalRef(model.name, fingerprint)
    const resolveRef = (ref: string): string => {
      const model = graph.models.get(ref)
      const fingerprint = physicalFpOf.get(ref)
      if (model === undefined || fingerprint === undefined) {
        throw new Error(`ссылка на модель вне плана: ${ref}`)
      }
      return physicalFor(model, fingerprint)
    }

    // parquet-модели без озера — падение до любых действий
    for (const action of plan.actions) {
      const model = graph.models.get(action.name)
      if (model === undefined) continue
      if (model.target === "parquet" && lakePath === undefined) {
        return yield* new LakeNotConfiguredError({ model: model.name.full })
      }
      if (model.target === "ducklake" && options?.ducklake === undefined) {
        return yield* new DucklakeNotConfiguredError({ model: model.name.full })
      }
      // DuckDB-федерация (SPEC §9.3) на других движках не выражается —
      // честная ошибка до любых действий
      if (engine.dialect !== "duckdb") {
        const feature =
          model.target === "parquet"
            ? "target: parquet"
            : model.target === "ducklake"
              ? "target: ducklake"
            : model.kind._tag === "seed"
              ? "seed (read_csv/read_json)"
              : model.kind._tag === "external" && model.kind.source._tag === "files"
                ? "external по файлам/URL (read_*)"
                : model.export !== undefined
                  ? "export в ATTACH-базу"
                  : undefined
        if (feature !== undefined) {
          return yield* new EngineFeatureError({
            model: model.name.full,
            feature,
            dialect: engine.dialect,
          })
        }
      }
    }

    // 1. Физика + бэкфилл — DAG-конкурентно (SPEC §5.3): модель стартует,
    // как только готовы её родители из этого плана (Deferred-гейты, без
    // волновых барьеров); независимые ветки идут параллельно на движке
    // с пулом; упавший родитель не открывает гейт — потомки не строятся
    yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS "${physicalSchema}"`)
    // ducklake-каталог нужен и для сборки, и для чистого view-swap —
    // view окружений ссылаются на таблицы каталога по алиасу
    if (options?.ducklake !== undefined && engine.dialect === "duckdb") {
      yield* engine.execute(ducklakeAttachSql(options.ducklake))
    }
    const working = plan.actions.filter(
      (action) =>
        (action.build || action.backfill.length > 0 || action.refresh) &&
        graph.models.get(action.name)?.kind._tag !== "external",
    )
    const gates = new Map<string, Deferred.Deferred<void>>()
    for (const action of working) gates.set(action.name, yield* Deferred.make<void>())

    const buildOne = (action: PlanAction): Effect.Effect<void, ApplyError> =>
      Effect.gen(function* () {
      const model = graph.models.get(action.name)!
      switch (model.kind._tag) {
        case "external":
          return
        case "embedded": {
          // физики нет — но контракт и аудиты версии проверяются здесь,
          // чтобы потребители не унесли в себя сломанный подзапрос
          const body = render(model.fragment, { resolveRef })
          yield* checkContract(engine, model, body)
          yield* runAudits(engine, model, `(${body})`)
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
            physicalFp: action.physicalFingerprint,
            canonicalAst: action.canonicalAst ?? "",
            renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
            kind: model.kind._tag,
          })
          break
        }
        case "seed": {
          const reader = model.kind.format === "csv" ? "read_csv" : "read_json"
          const body = `SELECT * FROM ${reader}('${model.kind.file.replaceAll(`'`, `''`)}')`
          yield* checkContract(engine, model, body)
          const target = tableRef(model, action.physicalFingerprint)
          yield* engine.execute(`CREATE OR REPLACE TABLE ${target} AS ${body}`)
          yield* runAudits(engine, model, target)
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
            physicalFp: action.physicalFingerprint,
            canonicalAst: "",
            renderedSql: body,
            kind: model.kind._tag,
          })
          break
        }
        case "incrementalByUniqueKey": {
          const body = render(model.fragment, { resolveRef })
          yield* checkContract(engine, model, body)
          const target = tableRef(model, action.physicalFingerprint)
          yield* engine.execute(
            `CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM (${body}) q LIMIT 0`,
          )
          // upsert: строки с ключами из свежего запроса заменяются, остальные живут
          const keys = model.kind.key.map(quoteIdent).join(", ")
          yield* transactional(engine, [
            `DELETE FROM ${target} WHERE (${keys}) IN (SELECT ${keys} FROM (${body}) q)`,
            `INSERT INTO ${target} ${body}`,
          ])
          yield* runAudits(engine, model, target)
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
            physicalFp: action.physicalFingerprint,
            canonicalAst: action.canonicalAst ?? "",
            renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
            kind: model.kind._tag,
          })
          break
        }
        case "scdType2": {
          const scd = model.kind
          const body = render(model.fragment, { resolveRef })
          const managed = new Set([scd.validFrom, scd.validTo])
          yield* checkContract(engine, model, body, managed)
          const target = tableRef(model, action.physicalFingerprint)
          const from = quoteIdent(scd.validFrom)
          const to = quoteIdent(scd.validTo)
          yield* engine.execute(
            `CREATE TABLE IF NOT EXISTS ${target} AS
             SELECT q.*, CAST(NULL AS TIMESTAMP) AS ${from}, CAST(NULL AS TIMESTAMP) AS ${to}
             FROM (${body}) q LIMIT 0`,
          )
          const cols = columnNames(model)
            .filter((column) => !managed.has(column))
            .map(quoteIdent)
          const tableName = quoteIdent(physicalTable(model.name, action.physicalFingerprint))
          const ts = sqlTimestamp(nowMs)
          const sameAsOuter = cols
            .map((column) => `q.${column} IS NOT DISTINCT FROM ${tableName}.${column}`)
            .join(" AND ")
          const sameAsOpen = cols
            .map((column) => `t.${column} IS NOT DISTINCT FROM q.${column}`)
            .join(" AND ")
          // SCD2-сверка (SPEC §3.1): открытая строка без идентичной строки в
          // запросе закрывается (изменилась или исчезла); строка запроса без
          // идентичной открытой строки вставляется новой открытой версией.
          // Идентичные пары не трогаются — их valid_from не дрожит.
          yield* transactional(engine, [
            `UPDATE ${target} SET ${to} = ${ts}
             WHERE ${to} IS NULL
               AND NOT EXISTS (SELECT 1 FROM (${body}) q WHERE ${sameAsOuter})`,
            `INSERT INTO ${target} (${cols.join(", ")}, ${from}, ${to})
             SELECT ${cols.map((column) => `q.${column}`).join(", ")}, ${ts}, NULL
             FROM (${body}) q
             WHERE NOT EXISTS (
               SELECT 1 FROM ${target} t WHERE t.${to} IS NULL AND ${sameAsOpen}
             )`,
          ])
          yield* runAudits(engine, model, target)
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
            physicalFp: action.physicalFingerprint,
            canonicalAst: action.canonicalAst ?? "",
            renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
            kind: model.kind._tag,
          })
          break
        }
        case "view":
        case "full": {
          const body = render(model.fragment, { resolveRef })
          // контракт схемы (SPEC §3.2): дрейф типов ловится до сборки
          yield* checkContract(engine, model, body)
          if (model.kind._tag === "full" && model.target === "parquet") {
            const prefix = parquetPrefix(lakePath!, model.name, action.physicalFingerprint)
            yield* ensureDir(prefix)
            yield* engine.execute(
              `COPY (${body}) TO '${prefix.replaceAll(`'`, `''`)}/data.parquet' (FORMAT PARQUET)`,
            )
          } else {
            const target = tableRef(model, action.physicalFingerprint)
            if (model.kind._tag === "view") {
              yield* engine.execute(`CREATE OR REPLACE VIEW ${target} AS ${body}`)
            } else if (engine.dialect === "duckdb") {
              yield* engine.execute(`CREATE OR REPLACE TABLE ${target} AS ${body}`)
            } else {
              // у Postgres нет CREATE OR REPLACE TABLE — атомарно через транзакцию
              yield* transactional(engine, [
                `DROP TABLE IF EXISTS ${target}`,
                `CREATE TABLE ${target} AS ${body}`,
              ])
            }
          }
          // аудиты собранного снапшота — до промоушена (SPEC §8)
          yield* runAudits(engine, model, physicalFor(model, action.physicalFingerprint))
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
            physicalFp: action.physicalFingerprint,
            canonicalAst: action.canonicalAst ?? "",
            renderedSql: body,
            kind: model.kind._tag,
          })
          break
        }
        case "incrementalByTimeRange": {
          const zero = sqlTimestamp(0)
          const emptyBody = render(model.fragment, {
            resolveRef,
            interval: { start: zero, end: zero },
          })
          yield* checkContract(engine, model, emptyBody)
          // forward-only: done-интервалы старой версии наследуются до бэкфилла —
          // сделанное не переигрывается, пересчитывается только недостающее
          if (action.reusedFrom !== undefined) {
            const inherited = (yield* store.listIntervals(action.reusedFrom))
              .filter((record) => record.status === "done")
              .map((record) => ({ startTs: record.startTs, endTs: record.endTs }))
            yield* store.markIntervals(action.fingerprint, inherited, "done")
          }
          if (model.target === "parquet") {
            const prefix = parquetPrefix(lakePath!, model.name, action.physicalFingerprint)
            yield* store.upsertSnapshot({
              name: action.name,
              fingerprint: action.fingerprint,
              physicalFp: action.physicalFingerprint,
              canonicalAst: action.canonicalAst ?? "",
              renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
              kind: model.kind._tag,
            })
            yield* backfillIntoParquet(
              engine,
              store,
              model,
              action,
              prefix,
              resolveRef,
              options?.retry,
            )
          } else {
            // пустой скелет с формой запроса; при resume уже существует
            const target = tableRef(model, action.physicalFingerprint)
            yield* engine.execute(
              `CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM (${emptyBody}) q LIMIT 0`,
            )
            // forward-only на живой таблице: колонки, появившиеся в запросе,
            // добавляются к унаследованной физике (история получает NULL);
            // исчезнувшие из запроса — сигнал, что реюз невозможен
            if (action.change === "forward-only") {
              yield* evolveTableForForwardOnly(engine, model, target, emptyBody)
            }
            yield* store.upsertSnapshot({
              name: action.name,
              fingerprint: action.fingerprint,
              physicalFp: action.physicalFingerprint,
              canonicalAst: action.canonicalAst ?? "",
              renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
              kind: model.kind._tag,
            })
            yield* backfillIntoTable(
              engine,
              store,
              model,
              action,
              target,
              resolveRef,
              options?.concurrency ?? 4,
              options?.retry,
            )
          }
          break
        }
      }
      })

    const runOne = (action: PlanAction): Effect.Effect<void, ApplyError> =>
      Effect.gen(function* () {
        const model = graph.models.get(action.name)!
        // ждём только родителей, которые строит этот же план; остальные готовы
        yield* Effect.forEach(
          [...model.deps].flatMap((dep) => {
            const gate = gates.get(dep)
            return gate === undefined ? [] : [gate]
          }),
          (gate) => Deferred.await(gate),
          { discard: true },
        )
        yield* buildOne(action)
        yield* Metric.update(snapshotsBuilt, 1)
        yield* Deferred.succeed(gates.get(action.name)!, undefined)
      })

    // working в топологическом порядке, а forEach стартует элементы по
    // порядку — у самого раннего незавершённого элемента родители всегда
    // уже готовы, поэтому ожидание гейтов не выедает слоты до дедлока
    yield* Effect.forEach(working, runOne, {
      concurrency:
        engine.dialect === "duckdb" ? 1 : Math.max(1, options?.modelConcurrency ?? 4),
      discard: true,
    })
    const built = working.map((action) => action.name)

    // 2. Промоушен: view-слой окружения
    for (const action of plan.actions) {
      if (action.change === "unchanged") continue
      if (action.change === "removed") {
        // имя модели из state store; схему восстанавливаем из полного имени
        const [schema, table] = action.name.split(".") as [string, string]
        yield* engine.execute(
          `DROP VIEW IF EXISTS "${envSchema(plan.env, schema)}"."${table}"`,
        )
        continue
      }
      const model = graph.models.get(action.name)!
      // view-слоя у external и embedded нет — они не материализуются
      if (model.kind._tag === "external" || model.kind._tag === "embedded") continue
      yield* engine.execute(
        `CREATE SCHEMA IF NOT EXISTS "${envSchema(plan.env, model.name.schema)}"`,
      )
      yield* engine.execute(
        `CREATE OR REPLACE VIEW ${viewRef(plan.env, model.name)} AS SELECT * FROM ${physicalFor(model, action.physicalFingerprint)}`,
      )
    }

    // 3. Экспорт наружу (SPEC §9.3): после аудитов и промоушена — наружу
    // не уезжает непроверенное; готовая витрина пишется в ATTACH-базу
    for (const action of plan.actions) {
      if (action.change === "removed") continue
      const model = graph.models.get(action.name)!
      if (model.export === undefined) continue
      // экспорт освежается, когда есть что везти: сборка/бэкфилл/refresh
      if (!action.build && action.backfill.length === 0 && !action.refresh) continue
      const attach = options?.attach?.[model.export.attach]
      if (attach === undefined) {
        return yield* new AttachNotConfiguredError({
          model: model.name.full,
          attach: model.export.attach,
        })
      }
      yield* engine.execute(
        `ATTACH IF NOT EXISTS '${attach.url.replaceAll(`'`, `''`)}' AS ${quoteIdent(model.export.attach)}${attach.options !== undefined ? ` (${attach.options})` : ""}`,
      )
      const [exportSchema, exportTable] = model.export.table.includes(".")
        ? (model.export.table.split(".") as [string, string])
        : ["main", model.export.table]
      yield* engine.execute(
        `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(model.export.attach)}.${quoteIdent(exportSchema)}`,
      )
      yield* engine.execute(
        `CREATE OR REPLACE TABLE ${quoteIdent(model.export.attach)}.${quoteIdent(exportSchema)}.${quoteIdent(exportTable)} AS SELECT * FROM ${physicalFor(model, action.physicalFingerprint)}`,
      )
    }

    // 4. Состояние окружения + журнал
    yield* store.promote(
      plan.env,
      plan.actions
        .filter((a) => a.change !== "removed")
        .map((a) => ({ name: a.name, fingerprint: a.fingerprint })),
    )
    yield* store.recordPlan(
      plan.env,
      JSON.stringify({
        actions: plan.actions.map((a) => ({
          name: a.name,
          change: a.change,
          fingerprint: a.fingerprint.slice(0, 8),
          build: a.build,
          backfill: a.backfill.map((r) => `[${toIso(r.start)}, ${toIso(r.end)})`),
        })),
      }),
    )

    return { plan, built }
  }).pipe(Effect.withSpan("efmesh.apply", { attributes: { env: plan.env } }))
