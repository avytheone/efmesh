import { Clock, Effect } from "effect"
import { buildGraph, type GraphError } from "../core/graph.ts"
import { enumerateIntervals, fromIso, missingIntervals, toIso } from "../core/interval.ts"
import type { AnyModel } from "../core/model.ts"
import { STATE_VERSION, StateStore } from "../state/store.ts"
import type { PlanRecord, RunRecord, StateError } from "../state/store.ts"

/**
 * `efmesh status <env>` (issue #1): одна команда на вопрос «что вообще
 * происходит» — для оператора ночного cron и для автора, забывшего
 * команды. Только чтение: стор открыт → версия схемы уже совпала.
 */

export interface ModelLag {
  readonly model: string
  /** Конец последнего done-интервала (ISO); null — ещё ничего не посчитано. */
  readonly doneUpTo: string | null
  /** Сколько интервалов не хватает до «сейчас». 0 — догнано. */
  readonly missing: number
  /** Интервалы, помеченные failed, — застрявший бэкфилл виден сразу. */
  readonly failed: number
}

export interface StatusReport {
  readonly env: string
  readonly storeVersion: number
  /** Строк в окружении; 0 — окружение не существует (ни разу не применялось). */
  readonly models: number
  /** Последний промоушен (ISO); null — окружения нет. */
  readonly promotedAt: string | null
  readonly lastPlan: PlanRecord | null
  /** Последние тики run, свежие первыми. */
  readonly ticks: ReadonlyArray<RunRecord>
  /** Отставание incremental-моделей окружения. */
  readonly lag: ReadonlyArray<ModelLag>
}

export interface StatusOptions {
  /** «Сейчас» для расчёта отставания; по умолчанию — Clock. Инъекция для тестов. */
  readonly now?: number
  /** Сколько последних тиков показать; по умолчанию 5. */
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
      rows.length === 0
        ? null
        : rows.map((row) => row.promotedAt).reduce((a, b) => (a > b ? a : b))

    const plans = yield* store.listPlans(env)
    const lastPlan = plans.at(-1) ?? null
    const ticks = yield* store.listRuns(env, options?.ticks ?? 5)

    // отставание — по УКАЗАТЕЛЯМ окружения (что реально отдаётся
    // потребителям), а не по локальным fingerprint'ам проекта
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
