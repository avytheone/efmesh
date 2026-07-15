import { Effect } from "effect"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import { render } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError, SqlParseError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import { envSchema, physicalRef, physicalSchema, viewRef } from "./naming.ts"
import type { InvalidEnvironmentError, Plan } from "./planner.ts"

export interface AppliedPlan {
  readonly plan: Plan
  /** Имена моделей, для которых собиралась физика (остальные — только view-swap). */
  readonly built: ReadonlyArray<string>
}

export type ApplyError =
  | GraphError
  | StateError
  | EngineError
  | SqlParseError
  | InvalidEnvironmentError

/**
 * Применяет план (SPEC §5): в топологическом порядке собирает недостающую
 * физику (ссылки в SQL резолвятся в физические таблицы ЭТОГО плана, не во
 * view окружения — середина apply не видна снаружи), затем промоушен —
 * пересоздание view + транзакционная запись набора в state store.
 */
export const applyPlan = (
  plan: Plan,
  graph: ModelGraph,
): Effect.Effect<AppliedPlan, ApplyError, EngineAdapter | StateStore> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const store = yield* StateStore

    const fingerprintOf = new Map(plan.actions.map((a) => [a.name, a.fingerprint]))
    const resolveRef = (ref: string): string => {
      const model = graph.models.get(ref)
      const fingerprint = fingerprintOf.get(ref)
      if (model === undefined || fingerprint === undefined) {
        throw new Error(`ссылка на модель вне плана: ${ref}`)
      }
      return physicalRef(model.name, fingerprint)
    }

    // 1. Физика
    yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS "${physicalSchema}"`)
    const built: Array<string> = []
    for (const action of plan.actions) {
      if (!action.build) continue
      const model = graph.models.get(action.name)!
      const body = render(model.fragment, { resolveRef })
      const target = physicalRef(model.name, action.fingerprint)
      const ddl =
        model.kind._tag === "view"
          ? `CREATE OR REPLACE VIEW ${target} AS ${body}`
          : `CREATE OR REPLACE TABLE ${target} AS ${body}`
      yield* engine.execute(ddl)
      yield* store.upsertSnapshot({
        name: action.name,
        fingerprint: action.fingerprint,
        renderedSql: body,
        kind: model.kind._tag,
      })
      built.push(action.name)
    }

    // 2. Промоушен: view-слой окружения
    for (const action of plan.actions) {
      if (action.change === "unchanged") continue
      if (action.change === "removed") {
        // имя модели из state store; схему восстанавливаем из полного имени
        const [schema, table] = action.name.split(".") as [string, string]
        yield* engine.execute(
          `DROP VIEW IF EXISTS "${envSchema(plan.env, schema)}"."${table}"`,
        )
        continue
      }
      const model = graph.models.get(action.name)!
      yield* engine.execute(
        `CREATE SCHEMA IF NOT EXISTS "${envSchema(plan.env, model.name.schema)}"`,
      )
      yield* engine.execute(
        `CREATE OR REPLACE VIEW ${viewRef(plan.env, model.name)} AS SELECT * FROM ${physicalRef(model.name, action.fingerprint)}`,
      )
    }

    // 3. Состояние окружения + журнал
    yield* store.promote(
      plan.env,
      plan.actions
        .filter((a) => a.change !== "removed")
        .map((a) => ({ name: a.name, fingerprint: a.fingerprint })),
    )
    yield* store.recordPlan(
      plan.env,
      JSON.stringify({
        actions: plan.actions.map((a) => ({
          name: a.name,
          change: a.change,
          fingerprint: a.fingerprint.slice(0, 8),
          build: a.build,
        })),
      }),
    )

    return { plan, built }
  })
