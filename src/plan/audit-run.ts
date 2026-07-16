import { Data, Effect } from "effect"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import { render } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { externalSourceRef, viewRef } from "./naming.ts"

/**
 * Автономный прогон аудитов (SPEC §8, F4): проверяет то, что окружение
 * отдаёт потребителям СЕЙЧАС — view-слой целиком, не свежезагруженный
 * интервал, как в apply. Ловит деградацию задним числом: поздние данные
 * через lookback, руками поправленную физику, дрейф external-источников.
 *
 * Ничего не меняет и не помечает; отчёт целиком — упавший blocking-аудит
 * не прячет следующие за ним.
 */

export interface AuditRunResult {
  readonly model: string
  readonly audit: string
  readonly blocking: boolean
  readonly violations: number
}

export interface AuditRunReport {
  readonly results: ReadonlyArray<AuditRunResult>
  /** Суммарные нарушения blocking-аудитов — не ноль ⇒ окружению нельзя верить. */
  readonly blockingViolations: number
}

/** Запрошенной модели нет в проекте (или у неё нет аудитов — нечего гонять). */
export class AuditTargetError extends Data.TaggedError("AuditTargetError")<{
  readonly model: string
  readonly reason: string
}> {}

/** Итог для CLI: blocking-аудиты окружения нарушены. */
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
  // embedded не материализуется — аудируется подзапрос против view окружения
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
        return yield* new AuditTargetError({ model: name, reason: "модели нет в проекте" })
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
