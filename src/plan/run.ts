import { Clock, Data, Effect, Schedule } from "effect"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { StateStore, type RunRecord } from "../state/store.ts"
import { applyPlan, type AppliedPlan, type ApplyError, type ApplyOptions } from "./executor.ts"
import { envLockName, withStateLock, type LockHeldError, type LockOptions } from "./lock.ts"
import { planChanges, type PlanOptions } from "./planner.ts"

/**
 * `run` — a scheduler tick (SPEC §7): catches up intervals and upserts of
 * EXISTING versions, never applies model changes — that is the job of
 * plan/apply with a human at the helm. Idempotent and safe for cron/systemd:
 * a parallel run is cut off by a lock in the state store — the same
 * `env:<name>` as apply's (SPEC §14.6), so run will not wedge into someone
 * else's apply and vice versa.
 */

export class RunBlockedByChangesError extends Data.TaggedError("RunBlockedByChangesError")<{
  readonly env: string
  readonly changes: ReadonlyArray<string>
}> {
  override get message(): string {
    return `environment «${this.env}» has unapplied structural changes: ${this.changes.join(", ")} — run \`efmesh apply ${this.env}\``
  }
}

export type RunError = ApplyError | LockHeldError | RunBlockedByChangesError

export interface RunOptions extends PlanOptions, ApplyOptions, LockOptions {}

/** Tick outcome for the journal: error → category + detail. */
const classify = (error: RunError): Pick<RunRecord, "outcome" | "detail"> => {
  switch (error._tag) {
    case "RunBlockedByChangesError":
      return { outcome: "awaiting-human", detail: error.changes.join("; ") }
    case "LockHeldError":
      return { outcome: "lock-held", detail: error.name }
    default:
      return { outcome: "error", detail: error._tag }
  }
}

export const run = (
  env: string,
  models: Iterable<AnyModel>,
  options?: RunOptions,
): Effect.Effect<AppliedPlan, RunError, EngineAdapter | StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    // tick journal (SPEC §7, #2): the outcome is written ALWAYS, including
    // failure — a cron tick that fell over at three in the morning is debugged
    // after the fact; a failure of the write itself does not mask the real
    // outcome (log + ignore)
    const journal = (entry: Pick<RunRecord, "outcome" | "detail">) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          store.recordRun({
            env,
            startedAt,
            finishedAt: new Date(now).toISOString(),
            ...entry,
          }),
        ),
        Effect.catchCause((cause) => Effect.logWarning("tick journal is unavailable", cause)),
      )

    return yield* Effect.gen(function* () {
      const graph = yield* buildGraph(models)
      const plan = yield* planChanges(env, graph, options)
      const structural = plan.actions
        .filter((a) => a.change !== "unchanged")
        .map((a) => `${a.name}: ${a.change}`)
      if (structural.length > 0) {
        return yield* new RunBlockedByChangesError({ env, changes: structural })
      }
      return yield* applyPlan(plan, graph, options)
    }).pipe(
      withStateLock(envLockName(env), options?.lockTtlMs),
      Effect.tap((applied) =>
        journal({ outcome: "ok", detail: JSON.stringify(applied.built) }),
      ),
      Effect.tapError((error) => journal(classify(error))),
    )
  })

/**
 * Long-lived scheduler for embedding in an Effect application (SPEC §7):
 * ticks on a Schedule; a tick error is logged and does not bring the daemon
 * down (except a held lock — that is routine, logged more quietly).
 */
export const daemon = (
  env: string,
  models: Iterable<AnyModel>,
  schedule: Schedule.Schedule<unknown>,
  options?: RunOptions,
): Effect.Effect<never, never, EngineAdapter | StateStore> =>
  run(env, models, options).pipe(
    Effect.tap((applied) =>
      applied.built.length > 0
        ? Effect.logInfo(`run ${env}: built ${applied.built.join(", ")}`)
        : Effect.void,
    ),
    Effect.catchTag("LockHeldError", () =>
      Effect.logDebug(`run ${env}: lock held by another process, skipping tick`),
    ),
    Effect.catchCause((cause) => Effect.logError(`run ${env}: tick failed`, cause)),
    Effect.schedule(schedule),
    Effect.andThen(Effect.never),
  )

export const Runner = { run, daemon } as const
