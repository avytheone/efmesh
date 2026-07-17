import { Data, Duration, Effect, Ref } from "effect"
import { StateStore, type StateError } from "../state/store.ts"

/**
 * Cross-process lock via the state store (SPEC §7, §14.6): environment
 * mutations — apply and run — go under ONE lock `env:<name>`, so parallel
 * apply+apply and apply+run from different processes are cut off. A stale
 * lock of a crashed process is reclaimed by ttl (the same-millisecond race is
 * accounted for: expires_at <= now).
 *
 * A live holder keeps the lock fresh with a heartbeat (#18): a forked fiber
 * renews the lease on a short schedule while the guarded effect runs, so a
 * backfill that outlives the raw ttl is never mistaken for a crash and
 * reclaimed under it. The heartbeat is fenced on the expiry it last wrote — if
 * the lock was nonetheless reclaimed (a stall longer than the ttl), the renewal
 * misses and we abort loudly rather than write behind a second holder.
 */

const DEFAULT_TTL_MS = 3_600_000

/**
 * Renew at a third of the ttl: two beats can be missed before the lease lapses,
 * so a single slow tick doesn't hand the lock away. `interval ≪ ttl` is the
 * whole point — a shorter cushion here trades store writes for safety margin.
 */
const heartbeatInterval = (ttlMs: number): Duration.Duration =>
  Duration.millis(Math.max(1, Math.floor(ttlMs / 3)))

export class LockHeldError extends Data.TaggedError("LockHeldError")<{
  readonly name: string
}> {
  override get message(): string {
    return `lock «${this.name}» is held by another apply/run process`
  }
}

export class LockLostError extends Data.TaggedError("LockLostError")<{
  readonly name: string
}> {
  override get message(): string {
    return `lock «${this.name}» was reclaimed by another process mid-operation — aborting before a second writer corrupts the environment`
  }
}

export interface LockOptions {
  /** How long the lock lives without being renewed (crashed process); by default 1 hour. */
  readonly lockTtlMs?: number
}

/** Name of the lock under which an environment is mutated (shared by apply and run). */
export const envLockName = (env: string): string => `env:${env}`

/** The janitor lock is global: physical-storage cleanup is not tied to an environment. */
export const janitorLockName = "janitor"

export const withStateLock =
  (name: string, ttlMs?: number) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | LockHeldError | LockLostError | StateError, R | StateStore> =>
    Effect.gen(function* () {
      const store = yield* StateStore
      const ttl = ttlMs ?? DEFAULT_TTL_MS
      const acquired = yield* store.acquireLock(name, ttl)
      if (!acquired) return yield* new LockHeldError({ name })
      // lock lifecycle is an internal detail — DEBUG only, keyed by lock name (#14)
      yield* Effect.logDebug("lock acquired").pipe(Effect.annotateLogs("lock", name))

      // The fence tracks the expiry we last wrote; heartbeat and release both
      // key on it, so neither ever touches a lease reclaimed by someone else.
      // Just-acquired, the row exists — lockExpiry is non-null here.
      const seed = yield* store.lockExpiry(name)
      const fence = yield* Ref.make(seed ?? "")

      const beat = Ref.get(fence).pipe(
        Effect.flatMap((expected) => store.renewLock(name, expected, ttl)),
        // The failure branch lives inside the effect, evaluated per beat — not a
        // call-time ternary (CLAUDE.md retry rule): a lost lock fails loudly, a
        // renewed one advances the fence for the next beat.
        Effect.flatMap((renewed) =>
          renewed === null ? Effect.fail(new LockLostError({ name })) : Ref.set(fence, renewed),
        ),
      )
      // `forever` gives a `never`-success loop that only settles by failing
      // (LockLostError); the leading delay means the first renewal lands well
      // inside the ttl, when the lease is still unambiguously ours.
      const heartbeat = beat.pipe(Effect.delay(heartbeatInterval(ttl)), Effect.forever)

      const release = Ref.get(fence).pipe(
        Effect.flatMap((expected) => store.releaseLock(name, expected)),
        Effect.andThen(Effect.logDebug("lock released").pipe(Effect.annotateLogs("lock", name))),
        Effect.ignore,
      )

      // raceFirst: whichever settles first wins and interrupts the loser. The
      // body finishing (ok or its own error) interrupts the heartbeat; the
      // heartbeat failing with LockLostError aborts the body. `release` is
      // fenced, so on a lost lock it is a no-op — the reclaimer keeps its lock.
      return yield* Effect.raceFirst(effect, heartbeat).pipe(Effect.ensuring(release))
    })
