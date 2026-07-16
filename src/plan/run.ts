import { Clock, Data, Effect, Schedule } from "effect"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { StateStore, type RunRecord } from "../state/store.ts"
import { applyPlan, type AppliedPlan, type ApplyError, type ApplyOptions } from "./executor.ts"
import { envLockName, withStateLock, type LockHeldError, type LockOptions } from "./lock.ts"
import { planChanges, type PlanOptions } from "./planner.ts"

/**
 * `run` — тик планировщика (SPEC §7): догоняет интервалы и upsert'ы
 * СУЩЕСТВУЮЩИХ версий, никогда не применяет изменения моделей — это
 * работа plan/apply с человеком у руля. Идемпотентен и безопасен для
 * cron/systemd: параллельный запуск отсекается блокировкой в state store —
 * той же `env:<имя>`, что у apply (SPEC §14.6), поэтому run не вклинится
 * в чужое применение и наоборот.
 */

export class RunBlockedByChangesError extends Data.TaggedError("RunBlockedByChangesError")<{
  readonly env: string
  readonly changes: ReadonlyArray<string>
}> {}

export type RunError = ApplyError | LockHeldError | RunBlockedByChangesError

export interface RunOptions extends PlanOptions, ApplyOptions, LockOptions {}

/** Исход тика для журнала: ошибка → категория + деталь. */
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
    // журнал тиков (SPEC §7, #2): исход пишется ВСЕГДА, включая неуспех —
    // упавший в три часа ночи cron-тик дебажится задним числом; сбой самой
    // записи не маскирует настоящий исход (лог + ignore)
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
        Effect.catchCause((cause) => Effect.logWarning("журнал тиков недоступен", cause)),
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
    Effect.catchTag("LockHeldError", () =>
      Effect.logDebug(`run ${env}: лок занят другим процессом, пропуск тика`),
    ),
    Effect.catchCause((cause) => Effect.logError(`run ${env}: тик упал`, cause)),
    Effect.schedule(schedule),
    Effect.andThen(Effect.never),
  )

export const Runner = { run, daemon } as const
