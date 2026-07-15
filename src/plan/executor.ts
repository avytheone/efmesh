import { mkdirSync } from "node:fs"
import { Data, Effect } from "effect"
import { AuditFailure } from "../core/audit.ts"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import type { Interval } from "../core/interval.ts"
import { intervalsWithin, splitIntoBatches, sqlTimestamp, toIso } from "../core/interval.ts"
import type { AnyModel } from "../core/model.ts"
import { quoteIdent, render } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { Engine, EngineError, SqlParseError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError, StateStoreShape } from "../state/store.ts"
import { checkContract, type SchemaMismatchError } from "./contract.ts"
import {
  envSchema,
  externalSourceRef,
  intervalKey,
  parquetPrefix,
  parquetRef,
  physicalRef,
  physicalSchema,
  viewRef,
} from "./naming.ts"
import type { InvalidEnvironmentError, Plan, PlanAction } from "./planner.ts"

export interface AppliedPlan {
  readonly plan: Plan
  /** Имена моделей, для которых собиралась физика или гнался бэкфилл. */
  readonly built: ReadonlyArray<string>
}

/** В проекте есть parquet-модели, но путь озера не задан в конфиге. */
export class LakeNotConfiguredError extends Data.TaggedError("LakeNotConfiguredError")<{
  readonly model: string
}> {}

export type ApplyError =
  | GraphError
  | StateError
  | EngineError
  | SqlParseError
  | SchemaMismatchError
  | LakeNotConfiguredError
  | AuditFailure
  | InvalidEnvironmentError

export interface ApplyOptions {
  /** Корень parquet-озера — локальная директория или s3://… (httpfs). */
  readonly lakePath?: string
}

/** Несколько стейтментов одной транзакцией движка; откат при любой ошибке. */
const transactional = (
  engine: Engine,
  statements: ReadonlyArray<string>,
): Effect.Effect<void, EngineError> =>
  engine.execute("BEGIN").pipe(
    Effect.andThen(Effect.forEach(statements, engine.execute, { discard: true })),
    Effect.andThen(engine.execute("COMMIT")),
    Effect.onError(() => engine.execute("ROLLBACK").pipe(Effect.ignore)),
  )

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
): Effect.Effect<void, EngineError | StateError | AuditFailure> =>
  Effect.gen(function* () {
    if (model.kind._tag !== "incrementalByTimeRange") return
    const kind = model.kind
    for (const range of action.backfill) {
      for (const batch of splitIntoBatches(range, kind.interval, kind.batchSize)) {
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
          `INSERT INTO ${target} ${body}`,
        ]).pipe(Effect.tapError(markFailed))
        // аудит свежезагруженного интервала — до отметки done (SPEC §8)
        yield* runAudits(
          engine,
          model,
          `(SELECT * FROM ${target} WHERE ${quoteIdent(kind.timeColumn)} >= ${start} AND ${quoteIdent(kind.timeColumn)} < ${end})`,
        ).pipe(Effect.tapError(markFailed))
        yield* store.markIntervals(action.fingerprint, marks, "done")
      }
    }
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
          .pipe(Effect.tapError(markFailed))
        // аудит записанной партиции — до отметки done; провал = не done → перезапись
        yield* runAudits(engine, model, `(SELECT * FROM read_parquet('${file}'))`).pipe(
          Effect.tapError(markFailed),
        )
        yield* store.markIntervals(action.fingerprint, mark, "done")
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

    const fingerprintOf = new Map(plan.actions.map((a) => [a.name, a.fingerprint]))
    // физика модели — то, что увидят её потребители и view окружения
    const physicalFor = (model: AnyModel, fingerprint: string): string => {
      if (model.kind._tag === "external") return externalSourceRef(model.kind.source)
      if (model.target === "parquet") {
        if (lakePath === undefined) throw new LakeNotConfiguredError({ model: model.name.full })
        return parquetRef(lakePath, model.name, fingerprint)
      }
      return physicalRef(model.name, fingerprint)
    }
    const resolveRef = (ref: string): string => {
      const model = graph.models.get(ref)
      const fingerprint = fingerprintOf.get(ref)
      if (model === undefined || fingerprint === undefined) {
        throw new Error(`ссылка на модель вне плана: ${ref}`)
      }
      return physicalFor(model, fingerprint)
    }

    // parquet-модели без озера — падение до любых действий
    for (const action of plan.actions) {
      const model = graph.models.get(action.name)
      if (model !== undefined && model.target === "parquet" && lakePath === undefined) {
        return yield* new LakeNotConfiguredError({ model: model.name.full })
      }
    }

    // 1. Физика + бэкфилл
    yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS "${physicalSchema}"`)
    const built: Array<string> = []
    for (const action of plan.actions) {
      if (!action.build && action.backfill.length === 0) continue
      const model = graph.models.get(action.name)!
      switch (model.kind._tag) {
        case "external":
          continue
        case "view":
        case "full": {
          const body = render(model.fragment, { resolveRef })
          // контракт схемы (SPEC §3.2): дрейф типов ловится до сборки
          yield* checkContract(engine, model, body)
          if (model.kind._tag === "full" && model.target === "parquet") {
            const prefix = parquetPrefix(lakePath!, model.name, action.fingerprint)
            yield* ensureDir(prefix)
            yield* engine.execute(
              `COPY (${body}) TO '${prefix.replaceAll(`'`, `''`)}/data.parquet' (FORMAT PARQUET)`,
            )
          } else {
            const target = physicalRef(model.name, action.fingerprint)
            const ddl =
              model.kind._tag === "view"
                ? `CREATE OR REPLACE VIEW ${target} AS ${body}`
                : `CREATE OR REPLACE TABLE ${target} AS ${body}`
            yield* engine.execute(ddl)
          }
          // аудиты собранного снапшота — до промоушена (SPEC §8)
          yield* runAudits(engine, model, physicalFor(model, action.fingerprint))
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
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
          if (model.target === "parquet") {
            const prefix = parquetPrefix(lakePath!, model.name, action.fingerprint)
            yield* store.upsertSnapshot({
              name: action.name,
              fingerprint: action.fingerprint,
              canonicalAst: action.canonicalAst ?? "",
              renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
              kind: model.kind._tag,
            })
            yield* backfillIntoParquet(engine, store, model, action, prefix, resolveRef)
          } else {
            // пустой скелет с формой запроса; при resume уже существует
            const target = physicalRef(model.name, action.fingerprint)
            yield* engine.execute(
              `CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM (${emptyBody}) q LIMIT 0`,
            )
            yield* store.upsertSnapshot({
              name: action.name,
              fingerprint: action.fingerprint,
              canonicalAst: action.canonicalAst ?? "",
              renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
              kind: model.kind._tag,
            })
            yield* backfillIntoTable(engine, store, model, action, target, resolveRef)
          }
          break
        }
      }
      built.push(action.name)
    }

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
      if (model.kind._tag === "external") continue // view-слоя у external нет
      yield* engine.execute(
        `CREATE SCHEMA IF NOT EXISTS "${envSchema(plan.env, model.name.schema)}"`,
      )
      yield* engine.execute(
        `CREATE OR REPLACE VIEW ${viewRef(plan.env, model.name)} AS SELECT * FROM ${physicalFor(model, action.fingerprint)}`,
      )
    }

    // 3. Состояние окружения + журнал
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
  })
