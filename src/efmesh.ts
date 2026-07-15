import { Effect } from "effect"
import { buildGraph } from "./core/graph.ts"
import type { AnyModel } from "./core/model.ts"
import { render } from "./core/sql.ts"
import type { EngineError, SqlParseError } from "./engine/adapter.ts"
import { EngineAdapter } from "./engine/adapter.ts"
import { canonicalSql } from "./plan/fingerprint.ts"
import { applyPlan, type AppliedPlan, type ApplyError } from "./plan/executor.ts"
import {
  planChanges,
  type InvalidEnvironmentError,
  type Plan,
  type PlanOptions,
} from "./plan/planner.ts"
import type { GraphError } from "./core/graph.ts"
import type { StateError } from "./state/store.ts"
import { StateStore } from "./state/store.ts"
import { viewRef } from "./plan/naming.ts"

/**
 * Фасад efmesh (SPEC §10): обычные Effect'ы, встраиваемые в любое
 * приложение; CLI — тонкая обёртка над ними.
 */
export const Efmesh = {
  /** Посчитать план для окружения, ничего не меняя. Движок нужен для канонизации SQL. */
  plan: (
    env: string,
    models: Iterable<AnyModel>,
    options?: PlanOptions,
  ): Effect.Effect<
    Plan,
    GraphError | StateError | InvalidEnvironmentError | EngineError | SqlParseError,
    StateStore | EngineAdapter
  > => buildGraph(models).pipe(Effect.flatMap((graph) => planChanges(env, graph, options))),

  /** План + применение: физика, бэкфилл интервалов, view-слой, состояние. */
  apply: (
    env: string,
    models: Iterable<AnyModel>,
    options?: PlanOptions,
  ): Effect.Effect<AppliedPlan, ApplyError, EngineAdapter | StateStore> =>
    Effect.gen(function* () {
      const graph = yield* buildGraph(models)
      const plan = yield* planChanges(env, graph, options)
      return yield* applyPlan(plan, graph)
    }),

  /** Canonical-рендер SQL модели (ссылки — логические имена) для отладки. */
  render: (models: Iterable<AnyModel>, name: string): Effect.Effect<string, GraphError> =>
    buildGraph(models).pipe(Effect.map((graph) => canonicalSql(graph, name))),

  /** Рендер SQL модели против view-слоя окружения — «как выполнит движок». */
  renderFor: (
    models: Iterable<AnyModel>,
    name: string,
    env: string,
  ): Effect.Effect<string, GraphError> =>
    buildGraph(models).pipe(
      Effect.map((graph) => {
        const model = graph.models.get(name)
        if (model === undefined) throw new Error(`модели ${name} нет в проекте`)
        return render(model.fragment, {
          resolveRef: (ref) => viewRef(env, graph.models.get(ref)!.name),
        })
      }),
    ),
} as const
