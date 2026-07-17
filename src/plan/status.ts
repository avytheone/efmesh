import { Clock, Effect } from "effect"
import { buildGraph, type GraphError } from "../core/graph.ts"
import { enumerateIntervals, fromIso, missingIntervals, toIso } from "../core/interval.ts"
import type { AnyModel } from "../core/model.ts"
import { STATE_VERSION, StateStore } from "../state/store.ts"
import type { PlanRecord, RunRecord, StateError } from "../state/store.ts"

/**
 * `efmesh status <env>` (issue #1): one command for the question «what is
 * even going on» — for the nightly-cron operator and for the author who
 * forgot the commands. Read-only: if the store opened → its schema version
 * already matched.
 */

export interface ModelLag {
  readonly model: string
  /** End of the last done interval (ISO); null — nothing computed yet. */
  readonly doneUpTo: string | null
  /** How many intervals are missing up to «now». 0 — caught up. */
  readonly missing: number
  /** Intervals marked failed — a stuck backfill is visible at once. */
  readonly failed: number
}

export interface StatusReport {
  readonly env: string
  readonly storeVersion: number
  /** Rows in the environment; 0 — the environment does not exist (never applied). */
  readonly models: number
  /** Last promotion (ISO); null — no environment. */
  readonly promotedAt: string | null
  readonly lastPlan: PlanRecord | null
  /** Latest run ticks, freshest first. */
  readonly ticks: ReadonlyArray<RunRecord>
  /** Lag of the environment's incremental models. */
  readonly lag: ReadonlyArray<ModelLag>
}

export interface StatusOptions {
  /** «Now» for computing lag; by default — Clock. Injected for tests. */
  readonly now?: number
  /** How many latest ticks to show; by default 5. */
  readonly ticks?: number
}

export const environmentStatus = (
  env: string,
  models: Iterable<AnyModel>,
  options?: StatusOptions,
): Effect.Effect<StatusReport, GraphError | StateError, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore
    const graph = yield* buildGraph(models)
    const now = options?.now ?? (yield* Clock.currentTimeMillis)

    const rows = yield* store.getEnvironment(env)
    const promotedAt =
      rows.length === 0 ? null : rows.map((row) => row.promotedAt).reduce((a, b) => (a > b ? a : b))

    const plans = yield* store.listPlans(env)
    const lastPlan = plans.at(-1) ?? null
    const ticks = yield* store.listRuns(env, options?.ticks ?? 5)

    // lag — by the environment's POINTERS (what is actually served to
    // consumers), not by the project's local fingerprints
    const lag: Array<ModelLag> = []
    for (const row of rows) {
      const model = graph.models.get(row.name)
      if (model === undefined || model.kind._tag !== "incrementalByTimeRange") continue
      const kind = model.kind
      const records = yield* store.listIntervals(row.fingerprint)
      const done = records
        .filter((record) => record.status === "done")
        .map((record) => ({ start: fromIso(record.startTs), end: fromIso(record.endTs) }))
      const wanted = enumerateIntervals(kind.interval, fromIso(kind.start), now)
      const missing = missingIntervals(wanted, done)
      lag.push({
        model: row.name,
        doneUpTo: done.length === 0 ? null : toIso(Math.max(...done.map((i) => i.end))),
        missing: missing.length,
        failed: records.filter((record) => record.status === "failed").length,
      })
    }

    return {
      env,
      storeVersion: STATE_VERSION,
      models: rows.length,
      promotedAt,
      lastPlan,
      ticks,
      lag,
    }
  })
