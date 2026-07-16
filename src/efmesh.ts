import { Effect } from "effect"
import { buildGraph } from "./core/graph.ts"
import type { AnyModel } from "./core/model.ts"
import { render } from "./core/sql.ts"
import type { EngineError, SqlParseError } from "./engine/adapter.ts"
import { EngineAdapter } from "./engine/adapter.ts"
import { canonicalSql } from "./plan/fingerprint.ts"
import {
  applyPlan,
  type AppliedPlan,
  type ApplyError,
  type ApplyOptions,
} from "./plan/executor.ts"
import { envLockName, withStateLock, type LockHeldError, type LockOptions } from "./plan/lock.ts"
import {
  planChanges,
  type ForwardOnlyError,
  type InvalidEnvironmentError,
  type Plan,
  type PlanOptions,
} from "./plan/planner.ts"
import type { SeedReadError } from "./core/errors.ts"
import type { GraphError } from "./core/graph.ts"
import type { StateError } from "./state/store.ts"
import { StateStore } from "./state/store.ts"
import { externalSourceRef, viewRef } from "./plan/naming.ts"

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
    | GraphError
    | StateError
    | InvalidEnvironmentError
    | ForwardOnlyError
    | EngineError
    | SqlParseError
    | SeedReadError,
    StateStore | EngineAdapter
  > => buildGraph(models).pipe(Effect.flatMap((graph) => planChanges(env, graph, options))),

  /**
   * План + применение: физика, бэкфилл интервалов, view-слой, состояние.
   * Идёт под межпроцессным локом `env:<имя>` (SPEC §14.6) — тем же, что у
   * run: параллельные мутации окружения из разных процессов отсекаются.
   */
  apply: (
    env: string,
    models: Iterable<AnyModel>,
    options?: PlanOptions & ApplyOptions & LockOptions,
  ): Effect.Effect<AppliedPlan, ApplyError | LockHeldError, EngineAdapter | StateStore> =>
    Effect.gen(function* () {
      const graph = yield* buildGraph(models)
      const plan = yield* planChanges(env, graph, options)
      return yield* applyPlan(plan, graph, options)
    }).pipe(withStateLock(envLockName(env), options?.lockTtlMs)),

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
        // view-слоя у external и embedded нет: источник как есть / подзапрос
        const resolve = (ref: string): string => {
          const source = graph.models.get(ref)!
          if (source.kind._tag === "external") return externalSourceRef(source.kind.source)
          if (source.kind._tag === "embedded") {
            return `(${render(source.fragment, { resolveRef: resolve })})`
          }
          return viewRef(env, source.name)
        }
        return render(model.fragment, { resolveRef: resolve })
      }),
    ),
} as const
