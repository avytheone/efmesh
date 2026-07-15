import { Data, Effect, Schedule } from "effect"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import { applyPlan, type AppliedPlan, type ApplyError, type ApplyOptions } from "./executor.ts"
import { planChanges, type PlanOptions } from "./planner.ts"

/**
 * `run` — тик планировщика (SPEC §7): догоняет интервалы и upsert'ы
 * СУЩЕСТВУЮЩИХ версий, никогда не применяет изменения моделей — это
 * работа plan/apply с человеком у руля. Идемпотентен и безопасен для
 * cron/systemd: параллельный запуск отсекается блокировкой в state store,
 * протухший лок упавшего процесса перехватывается.
 */

export class RunLockHeldError extends Data.TaggedError("RunLockHeldError")<{
  readonly env: string
}> {}

export class RunBlockedByChangesError extends Data.TaggedError("RunBlockedByChangesError")<{
  readonly env: string
  readonly changes: ReadonlyArray<string>
}> {}

export type RunError = ApplyError | RunLockHeldError | RunBlockedByChangesError

export interface RunOptions extends PlanOptions, ApplyOptions {
  /** Сколько лок живёт без освобождения (упавший процесс); по умолчанию 1 час. */
  readonly lockTtlMs?: number
}

export const run = (
  env: string,
  models: Iterable<AnyModel>,
  options?: RunOptions,
): Effect.Effect<AppliedPlan, RunError, EngineAdapter | StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore
    const lockName = `run:${env}`
    const acquired = yield* store.acquireLock(lockName, options?.lockTtlMs ?? 3_600_000)
    if (!acquired) return yield* new RunLockHeldError({ env })

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
    }).pipe(Effect.ensuring(store.releaseLock(lockName).pipe(Effect.ignore)))
  })

/**
 * Долгоживущий планировщик для встраивания в Effect-приложение (SPEC §7):
 * тики по Schedule, ошибка тика логируется и не роняет демона
 * (кроме занятого лока — это штатно, лог потише).
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
        ? Effect.logInfo(`run ${env}: обработано ${applied.built.join(", ")}`)
        : Effect.void,
    ),
    Effect.catchTag("RunLockHeldError", () =>
      Effect.logDebug(`run ${env}: лок занят другим процессом, пропуск тика`),
    ),
    Effect.catchCause((cause) => Effect.logError(`run ${env}: тик упал`, cause)),
    Effect.schedule(schedule),
    Effect.andThen(Effect.never),
  )

export const Runner = { run, daemon } as const
