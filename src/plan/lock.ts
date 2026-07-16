import { Data, Effect } from "effect"
import { StateStore, type StateError } from "../state/store.ts"

/**
 * Cross-process lock via the state store (SPEC §7, §14.6): environment
 * mutations — apply and run — go under ONE lock `env:<name>`, so parallel
 * apply+apply and apply+run from different processes are cut off. A stale
 * lock of a crashed process is reclaimed by ttl (the same-millisecond race is
 * accounted for: expires_at <= now).
 */

export class LockHeldError extends Data.TaggedError("LockHeldError")<{
  readonly name: string
}> {
  override get message(): string {
    return `lock «${this.name}» is held by another apply/run process`
  }
}

export interface LockOptions {
  /** How long the lock lives without being released (crashed process); by default 1 hour. */
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
  ): Effect.Effect<A, E | LockHeldError | StateError, R | StateStore> =>
    Effect.gen(function* () {
      const store = yield* StateStore
      const acquired = yield* store.acquireLock(name, ttlMs ?? 3_600_000)
      if (!acquired) return yield* new LockHeldError({ name })
      // lock lifecycle is an internal detail — DEBUG only, keyed by lock name (#14)
      yield* Effect.logDebug("lock acquired").pipe(Effect.annotateLogs("lock", name))
      return yield* effect.pipe(
        Effect.ensuring(
          store
            .releaseLock(name)
            .pipe(
              Effect.andThen(
                Effect.logDebug("lock released").pipe(Effect.annotateLogs("lock", name)),
              ),
              Effect.ignore,
            ),
        ),
      )
    })
