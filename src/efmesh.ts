import { Effect } from "effect"
import { buildGraph } from "./core/graph.ts"
import type { AnyModel } from "./core/model.ts"
import { render } from "./core/sql.ts"
import type { EngineError, SqlParseError } from "./engine/adapter.ts"
import type { EngineAdapter } from "./engine/adapter.ts"
import { canonicalSql } from "./plan/fingerprint.ts"
import { applyPlan, type AppliedPlan, type ApplyError, type ApplyOptions } from "./plan/executor.ts"
import {
  envLockName,
  withStateLock,
  type LockHeldError,
  type LockLostError,
  type LockOptions,
} from "./plan/lock.ts"
import {
  planChanges,
  type FingerprintVersionError,
  type ForwardOnlyError,
  type ReclassifyError,
  type InvalidEnvironmentError,
  type Plan,
  type PlanOptions,
} from "./plan/planner.ts"
import type { SeedReadError } from "./core/errors.ts"
import { UnknownModelError } from "./core/errors.ts"
import type { GraphError } from "./core/graph.ts"
import type { StateError } from "./state/store.ts"
import type { StateStore } from "./state/store.ts"
import { externalSourceRef, viewRef } from "./plan/naming.ts"

/**
 * The efmesh facade (SPEC §10): plain Effects embeddable in any
 * application; the CLI is a thin wrapper over them.
 */
export const Efmesh = {
  /** Compute a plan for an environment without changing anything. The engine is needed to canonicalize SQL. */
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
    | ReclassifyError
    | FingerprintVersionError
    | EngineError
    | SqlParseError
    | SeedReadError,
    StateStore | EngineAdapter
  > => buildGraph(models).pipe(Effect.flatMap((graph) => planChanges(env, graph, options))),

  /**
   * Plan + apply: physics, interval backfill, view layer, state.
   * Runs under the cross-process lock `env:<name>` (SPEC §14.6) — the same
   * one `run` uses: concurrent environment mutations from different
   * processes are cut off.
   */
  apply: (
    env: string,
    models: Iterable<AnyModel>,
    options?: PlanOptions & ApplyOptions & LockOptions,
  ): Effect.Effect<
    AppliedPlan,
    ApplyError | LockHeldError | LockLostError,
    EngineAdapter | StateStore
  > =>
    Effect.gen(function* () {
      const graph = yield* buildGraph(models)
      const plan = yield* planChanges(env, graph, options)
      return yield* applyPlan(plan, graph, options)
    }).pipe(withStateLock(envLockName(env), options?.lockTtlMs)),

  /** Canonical SQL render of a model (refs are logical names), for debugging. */
  render: (
    models: Iterable<AnyModel>,
    name: string,
  ): Effect.Effect<string, GraphError | UnknownModelError> =>
    buildGraph(models).pipe(Effect.flatMap((graph) => canonicalSql(graph, name))),

  /** SQL render of a model against an environment's view layer — "as the engine would run it". */
  renderFor: (
    models: Iterable<AnyModel>,
    name: string,
    env: string,
  ): Effect.Effect<string, GraphError | UnknownModelError> =>
    buildGraph(models).pipe(
      Effect.flatMap((graph) => {
        const model = graph.models.get(name)
        if (model === undefined) return new UnknownModelError({ model: name })
        // external and embedded have no view layer: source as-is / subquery
        const resolve = (ref: string): string => {
          const source = graph.models.get(ref)!
          if (source.kind._tag === "external") return externalSourceRef(source.kind.source)
          if (source.kind._tag === "embedded") {
            return `(${render(source.fragment, { resolveRef: resolve })})`
          }
          return viewRef(env, source.name)
        }
        return Effect.succeed(render(model.fragment, { resolveRef: resolve }))
      }),
    ),
} as const
