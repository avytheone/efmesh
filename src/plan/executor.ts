import { mkdirSync, renameSync } from "node:fs"
import { userInfo } from "node:os"
import { Clock, Data, Deferred, Effect, Schedule } from "effect"
import { AuditFailure } from "../core/audit.ts"
import type { SeedReadError } from "../core/errors.ts"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import type { Interval } from "../core/interval.ts"
import { intervalsWithin, splitIntoBatches, sqlTimestamp, toIso } from "../core/interval.ts"
import { columnNames, type AnyModel } from "../core/model.ts"
import { quoteIdent, render } from "../core/sql.ts"
import { EngineAdapter, EngineError } from "../engine/adapter.ts"
import type { Engine, SqlParseError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError, StateStoreShape } from "../state/store.ts"
import { Metric } from "effect"
import { checkContract, SchemaMismatchError } from "./contract.ts"
import { FINGERPRINT_VERSION } from "./fingerprint.ts"
import {
  auditFailuresTotal,
  auditsPassed,
  intervalsDone,
  intervalsFailed,
  modelBuildSeconds,
  snapshotsBuilt,
} from "./metrics.ts"
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
import type {
  FingerprintVersionError,
  ForwardOnlyError,
  ReclassifyError,
  InvalidEnvironmentError,
  Plan,
  PlanAction,
} from "./planner.ts"

export interface AppliedPlan {
  readonly plan: Plan
  /** Names of models for which physics was built or backfill was run. */
  readonly built: ReadonlyArray<string>
}

/** The project has parquet models, but the lake path is not set in the config. */
export class LakeNotConfiguredError extends Data.TaggedError("LakeNotConfiguredError")<{
  readonly model: string
}> {
  override get message(): string {
    return `model «${this.model}» targets parquet, but no lake path is configured`
  }
}

/** The project has ducklake models, but the catalog is not set in the config. */
export class DucklakeNotConfiguredError extends Data.TaggedError("DucklakeNotConfiguredError")<{
  readonly model: string
}> {
  override get message(): string {
    return `model «${this.model}» targets ducklake, but no catalog is configured`
  }
}

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
  | ReclassifyError
  | FingerprintVersionError
  | EngineFeatureError

export interface ApplyOptions {
  /** "Now" for scdType2 versioning; defaults to Clock. Injection point for tests. */
  readonly now?: number
  /** Root of the parquet lake — a local directory or s3://… (httpfs). */
  readonly lakePath?: string
  /** ATTACH databases by alias (SPEC §9.3) — for export models. */
  readonly attach?: Readonly<Record<string, { readonly url: string; readonly options?: string }>>
  /** DuckLake catalog for target: "ducklake" (SPEC §14.5). DuckDB-only. */
  readonly ducklake?: { readonly catalog: string; readonly dataPath?: string }
  /**
   * How many backfill batches of one model to compute concurrently (SPEC §5.3).
   * Meaningful only on an engine with a connection pool (Postgres); DuckDB holds
   * a single connection — there backfill is sequential regardless of the value.
   */
  readonly concurrency?: number
  /**
   * Inter-model DAG concurrency (SPEC §5.3): how many models to build at once.
   * A model starts as soon as its parents from this plan are ready —
   * independent DAG branches run in parallel. Meaningful on an engine with a
   * pool (Postgres); DuckDB holds a single connection — there models build
   * sequentially, otherwise foreign statements would wedge into a BEGIN/COMMIT.
   */
  readonly modelConcurrency?: number
  /**
   * Retries of a failed backfill batch (SPEC §5.3): Schedule.exponential from
   * baseDelayMs (500 ms by default), no more than attempts retries. A batch is
   * transactional (DELETE+INSERT in one transaction, COPY overwrites the whole
   * partition) — a retry is safe. Audits are not retried: an audit failure is
   * deterministic, it is not a transient fault.
   */
  readonly retry?: { readonly attempts: number; readonly baseDelayMs?: number }
  /** Who applies the plan — into the journal (SPEC §6); defaults to the OS user. */
  readonly appliedBy?: string
}

/** OS user for the plan journal; in sterile environments (CI) — ''. */
const osUser = (): string => {
  try {
    return userInfo().username
  } catch {
    return process.env["USER"] ?? ""
  }
}

/** The model asks to export to an ATTACH alias that is not in the config. */
export class AttachNotConfiguredError extends Data.TaggedError("AttachNotConfiguredError")<{
  readonly model: string
  readonly attach: string
}> {
  override get message(): string {
    return `model «${this.model}» exports to ATTACH alias «${this.attach}», which is not in the config`
  }
}

/** A DuckDB federation feature unavailable on the current engine (SPEC §9.3). */
export class EngineFeatureError extends Data.TaggedError("EngineFeatureError")<{
  readonly model: string
  readonly feature: string
  readonly dialect: string
}> {
  override get message(): string {
    return `model «${this.model}» uses ${this.feature}, unavailable on the ${this.dialect} engine (DuckDB only)`
  }
}

/**
 * Names the culprit on an engine failure raised while building a model: the
 * adapter cannot know which model a statement belongs to, so the executor
 * attaches it here (#13). Only fills in a model that is not already set, and
 * only for EngineError — every other error in the channel already carries the
 * model in a typed field.
 */
const attachModel =
  (model: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.mapError(effect, (error) =>
      error instanceof EngineError && error.model === undefined
        ? (new EngineError({ sql: error.sql, cause: error.cause, model }) as E & EngineError)
        : error,
    )

/** Several statements in one engine transaction; rollback on any error. */
const transactional = (
  engine: Engine,
  statements: ReadonlyArray<string>,
): Effect.Effect<void, EngineError> => engine.transaction(statements)

/** Retries of a transient batch-write failure; without retry in the options — as before. */
const withBatchRetry =
  (retry: ApplyOptions["retry"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    retry === undefined || retry.attempts <= 0
      ? effect
      : Effect.retry(effect, {
          times: retry.attempts,
          schedule: Schedule.exponential(retry.baseDelayMs ?? 500),
        })

/** For s3:// paths mkdir is not needed (and impossible) — httpfs writes directly. */
const ensureDir = (path: string): Effect.Effect<void> =>
  path.startsWith("s3://") ? Effect.void : Effect.sync(() => mkdirSync(path, { recursive: true }))

/**
 * The rendered statement about to run — DEBUG only (#14): SQL is a firehose and
 * would drown the info lifecycle a human watches; an operator or agent asks for
 * it with `--log-level debug`. The model/env are inherited from the enclosing
 * per-model log scope, so only `sql` is annotated here.
 */
const logSql = (sql: string): Effect.Effect<void> =>
  Effect.logDebug("rendered SQL").pipe(Effect.annotateLogs("sql", sql))

/**
 * Runs a model's audits (SPEC §8): `self` is the snapshot's physics or a
 * subquery of the just-loaded interval. The audit query returns violations:
 * blocking → AuditFailure, warn → log and continue.
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
      if (violations.length === 0) {
        yield* Metric.update(auditsPassed, 1)
        continue
      }
      if (auditDef.blocking) {
        yield* Metric.update(auditFailuresTotal, 1)
        return yield* new AuditFailure({
          model: model.name.full,
          audit: auditDef.name,
          violations: violations.length,
        })
      }
      yield* Effect.logWarning(
        `audit ${auditDef.name} of model ${model.name.full}: ${violations.length} violations (warn)`,
      )
    }
  })

/**
 * Evolution of an inherited table under forward-only (SPEC §5.2): columns
 * that appeared in the new query are added via ALTER (history gets NULL — it
 * is not replayed); dropping columns cannot be expressed by reuse — that is
 * an honest breaking change with a rebuild.
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
            `forward-only: column «${column.name}» exists in the inherited physics but vanished from the query — dropping columns requires a regular (breaking) apply`,
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
 * Backfill of incrementalByTimeRange into a table (SPEC §5.3): each range of
 * the plan is cut into batches ≤ batchSize; a batch is a transaction of a
 * range DELETE + INSERT, and after success its intervals are marked done. A
 * failed batch is marked failed and aborts apply; what is already marked is
 * not recomputed on retry — backfill resumes from where it stopped.
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
    // insert by name: after forward-only evolution the physics' column order
    // may differ from the query; the schema contract guarantees the names match
    const columns = columnNames(model).map(quoteIdent).join(", ")

    // connection pool (Postgres) → batches in parallel: intervals do not
    // overlap, each is its own transaction; DuckDB (single connection) — sequentially
    const batches = action.backfill.flatMap((range) =>
      splitIntoBatches(range, kind.interval, kind.batchSize),
    )
    const total = batches.length

    const runBatch = (batch: Interval, index: number) =>
      Effect.gen(function* () {
        const marks = intervalsWithin(batch, kind.interval).map((interval: Interval) => ({
          startTs: toIso(interval.start),
          endTs: toIso(interval.end),
        }))
        const start = sqlTimestamp(batch.start)
        const end = sqlTimestamp(batch.end)
        const body = render(model.fragment, { resolveRef, interval: { start, end } })
        // info lifecycle: a human watching a long backfill sees n-of-m progress;
        // interval bounds are structured (annotation), not baked into the message
        yield* Effect.logInfo(`backfill batch ${index + 1} of ${total}`).pipe(
          Effect.annotateLogs("interval", `[${toIso(batch.start)}, ${toIso(batch.end)})`),
        )
        yield* logSql(body)
        const markFailed = () =>
          store
            .markIntervals(action.fingerprint, marks, "failed")
            .pipe(Effect.andThen(Metric.update(intervalsFailed, marks.length)), Effect.ignore)
        yield* transactional(engine, [
          `DELETE FROM ${target} WHERE ${quoteIdent(kind.timeColumn)} >= ${start} AND ${quoteIdent(kind.timeColumn)} < ${end}`,
          `INSERT INTO ${target} (${columns}) SELECT ${columns} FROM (${body}) q`,
        ]).pipe(withBatchRetry(retry), Effect.tapError(markFailed))
        // audit of the freshly loaded interval — before marking done (SPEC §8)
        yield* runAudits(
          engine,
          model,
          `(SELECT * FROM ${target} WHERE ${quoteIdent(kind.timeColumn)} >= ${start} AND ${quoteIdent(kind.timeColumn)} < ${end})`,
        ).pipe(Effect.tapError(markFailed))
        yield* store.markIntervals(action.fingerprint, marks, "done")
        yield* Metric.update(intervalsDone, marks.length)
      })

    yield* Effect.forEach(batches, runBatch, {
      concurrency: engine.dialect === "duckdb" ? 1 : Math.max(1, concurrency),
      discard: true,
    })
  })

/**
 * Backfill into the parquet lake (SPEC §3.3): interval = partition, a
 * recompute is a rewrite of the partition file. No transaction is needed: an
 * unfinished partition is not marked done and will be overwritten on retry.
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
    // interval = partition; flat list so progress reads "n of m" across all ranges
    const intervals = action.backfill.flatMap((range) => intervalsWithin(range, kind.interval))
    const total = intervals.length
    yield* Effect.forEach(
      intervals,
      (interval, index) =>
        Effect.gen(function* () {
          const partition = `${prefix}/interval=${intervalKey(kind.interval, interval.start)}`
          yield* ensureDir(partition)
          const body = render(model.fragment, {
            resolveRef,
            interval: { start: sqlTimestamp(interval.start), end: sqlTimestamp(interval.end) },
          })
          yield* Effect.logInfo(`backfill partition ${index + 1} of ${total}`).pipe(
            Effect.annotateLogs("interval", `[${toIso(interval.start)}, ${toIso(interval.end)})`),
          )
          yield* logSql(body)
          const mark = [{ startTs: toIso(interval.start), endTs: toIso(interval.end) }]
          const markFailed = () =>
            store
              .markIntervals(action.fingerprint, mark, "failed")
              .pipe(Effect.andThen(Metric.update(intervalsFailed, 1)), Effect.ignore)
          // locally COPY writes to a temp file, rename is atomic (POSIX): a kill
          // mid-write leaves no broken partition, and a lookback recompute does
          // not hand the view reader an unfinished file; s3 — direct write
          // (no rename; the unfinished key is not marked done and gets overwritten)
          const target = `${partition}/data.parquet`
          const writePath = partition.startsWith("s3://") ? target : `${target}.tmp`
          yield* engine
            .execute(`COPY (${body}) TO '${writePath.replaceAll(`'`, `''`)}' (FORMAT PARQUET)`)
            .pipe(withBatchRetry(retry), Effect.tapError(markFailed))
          if (writePath !== target) {
            yield* Effect.sync(() => renameSync(writePath, target))
          }
          const file = target.replaceAll(`'`, `''`)
          // audit of the written partition — before marking done; failure = not done → rewrite
          yield* runAudits(engine, model, `(SELECT * FROM read_parquet('${file}'))`).pipe(
            Effect.tapError(markFailed),
          )
          yield* store.markIntervals(action.fingerprint, mark, "done")
          yield* Metric.update(intervalsDone, 1)
        }),
      { discard: true },
    )
  })

/**
 * Applies the plan (SPEC §5): in topological order it builds the missing
 * physics and catches up intervals (refs in SQL resolve to the physical
 * tables of THIS plan, not to the environment's views — the middle of apply
 * is not visible from outside), then promotion — recreating the views + a
 * transactional write of the set into the state store.
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

    // a model's physics — what its consumers and the environment views will
    // see; the key is physicalFingerprint: under forward-only it is the old version's physics
    const physicalFpOf = new Map(plan.actions.map((a) => [a.name, a.physicalFingerprint]))
    const physicalFor = (model: AnyModel, fingerprint: string): string => {
      if (model.kind._tag === "external") return externalSourceRef(model.kind.source)
      // embedded is not materialized — it is inlined into the consumer as a
      // subquery, its own refs resolve recursively (the DAG is acyclic)
      if (model.kind._tag === "embedded") return `(${render(model.fragment, { resolveRef })})`
      if (model.target === "parquet") {
        if (lakePath === undefined) throw new LakeNotConfiguredError({ model: model.name.full })
        return parquetRef(lakePath, model.name, fingerprint)
      }
      return tableRef(model, fingerprint)
    }
    // native physics or a DuckLake-catalog table — by the model's target
    const tableRef = (model: AnyModel, fingerprint: string): string =>
      model.target === "ducklake"
        ? ducklakeRef(model.name, fingerprint)
        : physicalRef(model.name, fingerprint)
    const resolveRef = (ref: string): string => {
      const model = graph.models.get(ref)
      const fingerprint = physicalFpOf.get(ref)
      if (model === undefined || fingerprint === undefined) {
        // invariant: deps and the plan are built from the same graph, so every
        // ref resolves — a miss is a defect in efmesh, not user-recoverable
        throw new Error(`invariant violated: reference to a model «${ref}» outside the plan`)
      }
      return physicalFor(model, fingerprint)
    }

    // parquet models without a lake — fail before any actions
    for (const action of plan.actions) {
      const model = graph.models.get(action.name)
      if (model === undefined) continue
      if (model.target === "parquet" && lakePath === undefined) {
        return yield* new LakeNotConfiguredError({ model: model.name.full })
      }
      if (model.target === "ducklake" && options?.ducklake === undefined) {
        return yield* new DucklakeNotConfiguredError({ model: model.name.full })
      }
      // DuckDB federation (SPEC §9.3) cannot be expressed on other engines —
      // an honest error before any actions
      if (engine.dialect !== "duckdb") {
        const feature =
          model.target === "parquet"
            ? "target: parquet"
            : model.target === "ducklake"
              ? "target: ducklake"
              : model.kind._tag === "seed"
                ? "seed (read_csv/read_json)"
                : model.kind._tag === "external" && model.kind.source._tag === "files"
                  ? "external over files/URL (read_*)"
                  : model.export !== undefined
                    ? "export to an ATTACH database"
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

    // 1. Physics + backfill — DAG-concurrent (SPEC §5.3): a model starts as
    // soon as its parents from this plan are ready (Deferred gates, no wave
    // barriers); independent branches run in parallel on an engine with a
    // pool; a failed parent does not open its gate — descendants are not built
    yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS "${physicalSchema}"`)
    // the ducklake catalog is needed both for building and for a pure
    // view-swap — environment views reference catalog tables by alias
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
            // there is no physics — but the contract and the version's audits are
            // checked here so consumers do not carry a broken subquery into themselves
            const body = render(model.fragment, { resolveRef })
            yield* logSql(body)
            yield* checkContract(engine, model, body)
            yield* runAudits(engine, model, `(${body})`)
            yield* store.upsertSnapshot({
              name: action.name,
              fingerprint: action.fingerprint,
              physicalFp: action.physicalFingerprint,
              canonicalAst: action.canonicalAst ?? "",
              renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
              kind: model.kind._tag,
              fingerprintVersion: FINGERPRINT_VERSION,
            })
            break
          }
          case "seed": {
            const reader = model.kind.format === "csv" ? "read_csv" : "read_json"
            const body = `SELECT * FROM ${reader}('${model.kind.file.replaceAll(`'`, `''`)}')`
            yield* logSql(body)
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
              fingerprintVersion: FINGERPRINT_VERSION,
            })
            break
          }
          case "incrementalByUniqueKey": {
            const body = render(model.fragment, { resolveRef })
            yield* logSql(body)
            yield* checkContract(engine, model, body)
            const target = tableRef(model, action.physicalFingerprint)
            yield* engine.execute(
              `CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM (${body}) q LIMIT 0`,
            )
            // upsert: rows with keys from the fresh query are replaced, the rest live on
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
              fingerprintVersion: FINGERPRINT_VERSION,
            })
            break
          }
          case "scdType2": {
            const scd = model.kind
            const body = render(model.fragment, { resolveRef })
            yield* logSql(body)
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
            // SCD2 reconciliation (SPEC §3.1): an open row with no identical row
            // in the query is closed (it changed or vanished); a query row with
            // no identical open row is inserted as a new open version. Identical
            // pairs are left alone — their valid_from does not jitter.
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
              fingerprintVersion: FINGERPRINT_VERSION,
            })
            break
          }
          case "view":
          case "full": {
            const body = render(model.fragment, { resolveRef })
            yield* logSql(body)
            // schema contract (SPEC §3.2): type drift is caught before building
            yield* checkContract(engine, model, body)
            // indirect reuse (#5): the data is identical by construction (parents
            // non-breaking/forward-only, own body unchanged) — the rebuild is
            // skipped, audits run against the inherited physics
            if (model.kind._tag === "full" && action.reusedFrom !== undefined) {
              yield* runAudits(engine, model, physicalFor(model, action.physicalFingerprint))
              yield* store.upsertSnapshot({
                name: action.name,
                fingerprint: action.fingerprint,
                physicalFp: action.physicalFingerprint,
                canonicalAst: action.canonicalAst ?? "",
                renderedSql: body,
                kind: model.kind._tag,
                fingerprintVersion: FINGERPRINT_VERSION,
              })
              break
            }
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
                // Postgres has no CREATE OR REPLACE TABLE — atomically via a transaction
                yield* transactional(engine, [
                  `DROP TABLE IF EXISTS ${target}`,
                  `CREATE TABLE ${target} AS ${body}`,
                ])
              }
            }
            // audits of the built snapshot — before promotion (SPEC §8)
            yield* runAudits(engine, model, physicalFor(model, action.physicalFingerprint))
            yield* store.upsertSnapshot({
              name: action.name,
              fingerprint: action.fingerprint,
              physicalFp: action.physicalFingerprint,
              canonicalAst: action.canonicalAst ?? "",
              renderedSql: body,
              kind: model.kind._tag,
              fingerprintVersion: FINGERPRINT_VERSION,
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
            // forward-only: the old version's done-intervals are inherited before
            // backfill — what is done is not replayed, only the missing is recomputed
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
                fingerprintVersion: FINGERPRINT_VERSION,
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
              // an empty skeleton with the query's shape; on resume it already exists
              const target = tableRef(model, action.physicalFingerprint)
              yield* engine.execute(
                `CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM (${emptyBody}) q LIMIT 0`,
              )
              // forward-only on a live table: columns that appeared in the query
              // are added to the inherited physics (history gets NULL); ones that
              // vanished from the query signal that reuse is impossible
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
                fingerprintVersion: FINGERPRINT_VERSION,
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
        // wait only for parents that this same plan builds; the rest are ready
        yield* Effect.forEach(
          [...model.deps].flatMap((dep) => {
            const gate = gates.get(dep)
            return gate === undefined ? [] : [gate]
          }),
          (gate) => Deferred.await(gate),
          { discard: true },
        )
        const startedAt = yield* Clock.currentTimeMillis
        yield* Effect.logInfo("build start")
        yield* buildOne(action).pipe(attachModel(action.name))
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt
        yield* Effect.logInfo(`build done in ${elapsed} ms`)
        yield* Metric.update(modelBuildSeconds, elapsed / 1000)
        yield* Metric.update(snapshotsBuilt, 1)
        yield* Deferred.succeed(gates.get(action.name)!, undefined)
      }).pipe(
        // one structured log scope per model: model/env/change flow into every
        // line the build emits (SQL at debug, backfill progress at info), so a
        // machine reader can group them without parsing the message text (#14)
        Effect.annotateLogs({ model: action.name, env: plan.env, change: action.change }),
        // the same scope for metrics: every counter updated while building this
        // model carries model/env, so an operator alerts per model without a
        // second accounting path (#39)
        Effect.provideService(Metric.CurrentMetricAttributes, {
          model: action.name,
          env: plan.env,
        }),
      )

    // working is in topological order, and forEach starts elements in order —
    // the earliest unfinished element always has its parents ready, so waiting
    // on gates does not eat up slots into a deadlock
    yield* Effect.forEach(working, runOne, {
      concurrency: engine.dialect === "duckdb" ? 1 : Math.max(1, options?.modelConcurrency ?? 4),
      discard: true,
    })
    const built = working.map((action) => action.name)

    // 2. Promotion: the environment's view layer
    for (const action of plan.actions) {
      if (action.change === "unchanged") continue
      if (action.change === "removed") {
        // the model name comes from the state store; the schema is recovered from the full name
        const [schema, table] = action.name.split(".") as [string, string]
        yield* engine.execute(`DROP VIEW IF EXISTS "${envSchema(plan.env, schema)}"."${table}"`)
        continue
      }
      const model = graph.models.get(action.name)!
      // external and embedded have no view layer — they are not materialized
      if (model.kind._tag === "external" || model.kind._tag === "embedded") continue
      yield* engine.execute(
        `CREATE SCHEMA IF NOT EXISTS "${envSchema(plan.env, model.name.schema)}"`,
      )
      yield* engine.execute(
        `CREATE OR REPLACE VIEW ${viewRef(plan.env, model.name)} AS SELECT * FROM ${physicalFor(model, action.physicalFingerprint)}`,
      )
    }

    // 3. Export outward (SPEC §9.3): after audits and promotion — nothing
    // unverified leaves; the finished mart is written to the ATTACH database
    for (const action of plan.actions) {
      if (action.change === "removed") continue
      const model = graph.models.get(action.name)!
      if (model.export === undefined) continue
      // the export is refreshed when there is something to ship: build/backfill/refresh
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

    // 4. Environment state + journal; requireSnapshot guards against the race
    // with the janitor (F6): for materialized models the snapshot must be alive
    // at the moment of promotion, otherwise the view would point at removed physics
    yield* store.promote(
      plan.env,
      plan.actions
        .filter((a) => a.change !== "removed")
        .map((a) => ({
          name: a.name,
          fingerprint: a.fingerprint,
          requireSnapshot: graph.models.get(a.name)?.kind._tag !== "external",
        })),
    )
    yield* store.recordPlan(
      plan.env,
      JSON.stringify({
        actions: plan.actions.map((a) => ({
          name: a.name,
          change: a.change,
          // operator override (#5) in the journal: it is visible who declared what
          ...(a.reclassifiedFrom !== undefined ? { reclassifiedFrom: a.reclassifiedFrom } : {}),
          fingerprint: a.fingerprint.slice(0, 8),
          build: a.build,
          backfill: a.backfill.map((r) => `[${toIso(r.start)}, ${toIso(r.end)})`),
        })),
      }),
      options?.appliedBy ?? osUser(),
    )

    yield* Effect.logInfo(
      built.length > 0 ? `promoted, built ${built.join(", ")}` : "promoted (view-swap only)",
    ).pipe(Effect.annotateLogs("env", plan.env))

    return { plan, built }
  }).pipe(Effect.withSpan("efmesh.apply", { attributes: { env: plan.env } }))
