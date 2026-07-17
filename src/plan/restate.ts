import { Data, Effect } from "effect"
import { UnknownModelError } from "../core/errors.ts"
import { buildGraph, transitiveDependents, type GraphError } from "../core/graph.ts"
import type { Interval, IntervalUnit } from "../core/interval.ts"
import { floorTo, fromIso, toIso } from "../core/interval.ts"
import type { AnyModel } from "../core/model.ts"
import { StateStore, type StateError } from "../state/store.ts"
import {
  envLockName,
  withStateLock,
  type LockHeldError,
  type LockLostError,
  type LockOptions,
} from "./lock.ts"

/**
 * `restate` (#21) — recompute a past time range after the fact: bad source
 * data landed, so a range of an incrementalByTimeRange model (and the
 * downstream models that read it) must be replayed. It does NOT rebuild
 * anything itself: it CLEARS the done-intervals of the target and its
 * incrementalByTimeRange descendants in `[from, to)` so the very next
 * `plan`/`apply` (or a `run` tick) picks them up as ordinary backfill — the
 * cascade is the planner's normal missing-interval logic, not a second engine.
 * The clear runs under the environment lock (the same one apply/run take), so
 * it cannot race a build in progress; `--dry-run` takes no lock and mutates
 * nothing.
 */

/** Restate applies only to incrementalByTimeRange — scdType2 refused by name (SPEC §3.1). */
export class RestateKindError extends Data.TaggedError("RestateKindError")<{
  readonly model: string
  readonly kind: string
}> {
  override get message(): string {
    return this.kind === "scdType2"
      ? `model «${this.model}» is scdType2 — restate has no time-range semantics over accumulated version history; recompute it through a regular apply`
      : `model «${this.model}» is ${this.kind}, not incrementalByTimeRange — restate recomputes time-range intervals and nothing else`
  }
}

/** A `--from`/`--to` bound is not aligned to the model's interval grain. */
export class RestateGrainError extends Data.TaggedError("RestateGrainError")<{
  readonly model: string
  readonly bound: "from" | "to"
  readonly value: string
  readonly interval: IntervalUnit
}> {
  override get message(): string {
    return `restate «${this.model}»: --${this.bound} «${this.value}» is not aligned to the ${this.interval} grain — give a bound on a ${this.interval} boundary (UTC)`
  }
}

/** A malformed or empty range (not ISO, or from is not before to). */
export class RestateRangeError extends Data.TaggedError("RestateRangeError")<{
  readonly model: string
  readonly reason: string
}> {
  override get message(): string {
    return `restate «${this.model}»: ${this.reason}`
  }
}

/** The model has not been promoted to the environment — there is nothing to restate. */
export class RestateEnvError extends Data.TaggedError("RestateEnvError")<{
  readonly model: string
  readonly env: string
}> {
  override get message(): string {
    return `model «${this.model}» is not in environment «${this.env}» — nothing has been applied there to restate`
  }
}

export type RestateError =
  | GraphError
  | StateError
  | UnknownModelError
  | RestateKindError
  | RestateGrainError
  | RestateRangeError
  | RestateEnvError
  | LockHeldError
  | LockLostError

/** One model whose ledger restate touches: the env's current version and its cleared intervals. */
export interface RestateTarget {
  readonly name: string
  /** The environment's current fingerprint — the ledger being cleared. */
  readonly fingerprint: string
  /** Recorded done/failed intervals in `[from, to)` that will be (or were) cleared → recomputed. */
  readonly intervals: ReadonlyArray<Interval>
}

export interface RestatePlan {
  readonly env: string
  readonly model: string
  readonly from: number
  readonly to: number
  readonly interval: IntervalUnit
  /** The target first, then its incrementalByTimeRange descendants present in the env (topological). */
  readonly targets: ReadonlyArray<RestateTarget>
  /** true — nothing was mutated, this is only a preview. */
  readonly dryRun: boolean
}

export interface RestateOptions extends LockOptions {
  /** Preview only: compute what would be recomputed and change nothing (no lock). */
  readonly dryRun?: boolean
}

/** ISO bound → epoch ms, aligned to the grain; a bad or misaligned bound is a typed failure. */
const parseBound = (
  model: string,
  bound: "from" | "to",
  value: string,
  interval: IntervalUnit,
): Effect.Effect<number, RestateRangeError | RestateGrainError> =>
  Effect.gen(function* () {
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) {
      return yield* new RestateRangeError({
        model,
        reason: `--${bound} «${value}» is not an ISO time`,
      })
    }
    if (floorTo(interval, ms) !== ms) {
      return yield* new RestateGrainError({ model, bound, value, interval })
    }
    return ms
  })

export const restate = (
  env: string,
  modelName: string,
  from: string,
  to: string,
  models: Iterable<AnyModel>,
  options?: RestateOptions,
): Effect.Effect<RestatePlan, RestateError, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore
    const graph = yield* buildGraph(models)
    const target = graph.models.get(modelName)
    if (target === undefined) return yield* new UnknownModelError({ model: modelName })
    // scdType2 is refused by name; every other non-time-range kind gets the generic refusal
    if (target.kind._tag !== "incrementalByTimeRange") {
      return yield* new RestateKindError({ model: modelName, kind: target.kind._tag })
    }
    const interval = target.kind.interval

    const fromMs = yield* parseBound(modelName, "from", from, interval)
    const toMs = yield* parseBound(modelName, "to", to, interval)
    if (fromMs >= toMs) {
      return yield* new RestateRangeError({
        model: modelName,
        reason: `--from «${from}» must be before --to «${to}»`,
      })
    }

    const current = new Map(
      (yield* store.getEnvironment(env)).map((row) => [row.name, row.fingerprint]),
    )
    if (!current.has(modelName)) return yield* new RestateEnvError({ model: modelName, env })

    // cascade is the graph's descendants, filtered to those that carry a time
    // interval ledger and are actually in this environment; ordered
    // topologically for a stable, parents-before-children report
    const descendants = transitiveDependents(graph, modelName)
    const names = graph.order.filter(
      (name) =>
        name === modelName ||
        (descendants.has(name) &&
          current.has(name) &&
          graph.models.get(name)!.kind._tag === "incrementalByTimeRange"),
    )

    const fromIsoStr = toIso(fromMs)
    const toIsoStr = toIso(toMs)
    const targets: Array<RestateTarget> = []
    for (const name of names) {
      const fingerprint = current.get(name)!
      const intervals = (yield* store.listIntervals(fingerprint))
        .filter((record) => record.startTs >= fromIsoStr && record.startTs < toIsoStr)
        .map((record) => ({ start: fromIso(record.startTs), end: fromIso(record.endTs) }))
      targets.push({ name, fingerprint, intervals })
    }

    const dryRun = options?.dryRun === true
    const plan: RestatePlan = {
      env,
      model: modelName,
      from: fromMs,
      to: toMs,
      interval,
      targets,
      dryRun,
    }
    if (dryRun) return plan

    // the mutation — under the env lock so it never lands mid-apply; each clear
    // is a single transactional DELETE, the ensuing backfill rewrites the physics
    return yield* Effect.gen(function* () {
      for (const t of targets) {
        yield* store.clearIntervals(t.fingerprint, fromIsoStr, toIsoStr)
      }
      return plan
    }).pipe(withStateLock(envLockName(env), options?.lockTtlMs))
  }).pipe(Effect.withSpan("efmesh.restate", { attributes: { env, model: modelName } }))
