import { Data, Effect } from "effect"
import { StateStore, type StateError } from "../state/store.ts"

/**
 * Межпроцессная блокировка через state store (SPEC §7, §14.6): мутации
 * окружения — apply и run — идут под ОДНИМ локом `env:<имя>`, поэтому
 * параллельные apply+apply и apply+run из разных процессов отсекаются.
 * Протухший лок упавшего процесса перехватывается по ttl (учтена гонка
 * в ту же миллисекунду: expires_at <= now).
 */

export class LockHeldError extends Data.TaggedError("LockHeldError")<{
  readonly name: string
}> {}

export interface LockOptions {
  /** Сколько лок живёт без освобождения (упавший процесс); по умолчанию 1 час. */
  readonly lockTtlMs?: number
}

/** Имя лока, под которым мутируется окружение (общий для apply и run). */
export const envLockName = (env: string): string => `env:${env}`

/** Лок janitor — глобальный: уборка физики не привязана к окружению. */
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
      return yield* effect.pipe(Effect.ensuring(store.releaseLock(name).pipe(Effect.ignore)))
    })
