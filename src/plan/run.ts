import { Clock, Data, Effect, type Schedule } from "effect"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import type { EngineAdapter } from "../engine/adapter.ts"
import { StateStore, type RunRecord } from "../state/store.ts"
import { applyPlan, type AppliedPlan, type ApplyError, type ApplyOptions } from "./executor.ts"
import {
  envLockName,
  withStateLock,
  type LockHeldError,
  type LockLostError,
  type LockOptions,
} from "./lock.ts"
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

export type RunError = ApplyError | LockHeldError | LockLostError | RunBlockedByChangesError

export interface RunOptions extends PlanOptions, ApplyOptions, LockOptions {}

/**
 * Structured tick detail (SPEC §7, #19), stored as a JSON string in the
 * journal's `detail` column — the column is already text, so this is NOT a
 * schema change (no STATE_VERSION bump). The shape is discriminated by the
 * sibling `outcome`; `status --json` hands it back as an object (no more
 * JSON-inside-a-string), and `status` renders it for a human. The `error`
 * case names the model and interval it died on when the tagged error carries
 * them, plus the same human message the failure screen shows.
 */
export type TickDetail =
  | { readonly built: ReadonlyArray<string> }
  | { readonly blockedBy: ReadonlyArray<string> }
  | { readonly lock: string }
  | {
      readonly error: string
      readonly model?: string
      readonly interval?: string
      readonly message?: string
    }

/** Tick outcome for the journal: error → category + structured detail. */
const classify = (error: RunError): { outcome: RunRecord["outcome"]; detail: TickDetail } => {
  switch (error._tag) {
    case "RunBlockedByChangesError":
      return { outcome: "awaiting-human", detail: { blockedBy: error.changes } }
    case "LockHeldError":
      return { outcome: "lock-held", detail: { lock: error.name } }
    default: {
      // an ApplyError/LockLostError names its culprit when it knows it (EngineError
      // has `model`, others may add `interval`); `message` is every TaggedError's
      // rendered line — the same one the failure screen prints
      const named = error as { model?: unknown; interval?: unknown; message?: unknown }
      return {
        outcome: "error",
        detail: {
          error: error._tag,
          ...(typeof named.model === "string" ? { model: named.model } : {}),
          ...(typeof named.interval === "string" ? { interval: named.interval } : {}),
          ...(typeof named.message === "string" ? { message: named.message } : {}),
        },
      }
    }
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
    const journal = (outcome: RunRecord["outcome"], detail: TickDetail) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          store.recordRun({
            env,
            startedAt,
            finishedAt: new Date(now).toISOString(),
            outcome,
            detail: JSON.stringify(detail),
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
      Effect.tap((applied) => journal("ok", { built: applied.built })),
      Effect.tapError((error) => {
        const { detail, outcome } = classify(error)
        return journal(outcome, detail)
      }),
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
        ? Effect.logInfo(`tick built ${applied.built.join(", ")}`)
        : Effect.logInfo("tick: no new intervals"),
    ),
    // a held lock is routine (another process ticks) — debug, not an alarm
    Effect.catchTag("LockHeldError", () =>
      Effect.logDebug("tick skipped: lock held by another process"),
    ),
    Effect.catchCause((cause) => Effect.logError("tick failed", cause)),
    // env is a structured field, not baked into every message (#14)
    Effect.annotateLogs("env", env),
    Effect.schedule(schedule),
    Effect.andThen(Effect.never),
  )

export const Runner = { run, daemon } as const
