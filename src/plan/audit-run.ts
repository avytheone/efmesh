import { Data, Effect } from "effect"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import { render } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { externalSourceRef, viewRef } from "./naming.ts"

/**
 * Standalone audit run (SPEC §8, F4): checks what the environment serves to
 * consumers RIGHT NOW — the whole view-layer, not the freshly loaded interval
 * as in apply. Catches degradation after the fact: late data via lookback,
 * physical storage edited by hand, drift of external sources.
 *
 * Changes and marks nothing; the report is complete — a failed blocking audit
 * does not hide the ones that follow it.
 */

export interface AuditRunResult {
  readonly model: string
  readonly audit: string
  readonly blocking: boolean
  readonly violations: number
}

export interface AuditRunReport {
  readonly results: ReadonlyArray<AuditRunResult>
  /** Total blocking-audit violations — nonzero ⇒ the environment cannot be trusted. */
  readonly blockingViolations: number
}

/** The requested model is not in the project (or has no audits — nothing to run). */
export class AuditTargetError extends Data.TaggedError("AuditTargetError")<{
  readonly model: string
  readonly reason: string
}> {}

/** Result for the CLI: the environment's blocking audits are violated. */
export class EnvironmentAuditError extends Data.TaggedError("EnvironmentAuditError")<{
  readonly env: string
  readonly blockingViolations: number
}> {}

const selfFor = (graph: ModelGraph, env: string, model: AnyModel): string => {
  const resolve = (ref: string): string => {
    const source = graph.models.get(ref)!
    if (source.kind._tag === "external") return externalSourceRef(source.kind.source)
    if (source.kind._tag === "embedded") {
      return `(${render(source.fragment, { resolveRef: resolve })})`
    }
    return viewRef(env, source.name)
  }
  // embedded is not materialized — the subquery is audited against the environment's view
  if (model.kind._tag === "embedded") {
    return `(${render(model.fragment, { resolveRef: resolve })})`
  }
  return viewRef(env, model.name)
}

export const auditEnvironment = (
  env: string,
  models: Iterable<AnyModel>,
  only?: ReadonlyArray<string>,
): Effect.Effect<AuditRunReport, GraphError | AuditTargetError | EngineError, EngineAdapter> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const graph = yield* buildGraph(models)
    for (const name of only ?? []) {
      if (!graph.models.has(name)) {
        return yield* new AuditTargetError({ model: name, reason: "model is not in the project" })
      }
    }
    const wanted = only === undefined ? undefined : new Set(only)

    const results: Array<AuditRunResult> = []
    for (const name of graph.order) {
      if (wanted !== undefined && !wanted.has(name)) continue
      const model = graph.models.get(name)!
      if (model.audits.length === 0) continue
      const self = selfFor(graph, env, model)
      for (const auditDef of model.audits) {
        const violations = yield* engine.query(
          render(auditDef.fragment, { resolveRef: (ref) => ref, self }),
        )
        results.push({
          model: name,
          audit: auditDef.name,
          blocking: auditDef.blocking,
          violations: violations.length,
        })
      }
    }

    return {
      results,
      blockingViolations: results
        .filter((result) => result.blocking)
        .reduce((sum, result) => sum + result.violations, 0),
    }
  }).pipe(Effect.withSpan("efmesh.audit", { attributes: { env } }))
