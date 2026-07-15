import { Effect } from "effect"
import type { GraphError, ModelGraph } from "../core/graph.ts"
import type { Interval } from "../core/interval.ts"
import { intervalsWithin, splitIntoBatches, sqlTimestamp, toIso } from "../core/interval.ts"
import type { AnyModel } from "../core/model.ts"
import { quoteIdent, render } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { Engine, EngineError, SqlParseError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError, StateStoreShape } from "../state/store.ts"
import { checkContract, type SchemaMismatchError } from "./contract.ts"
import { envSchema, externalSourceRef, physicalRef, physicalSchema, viewRef } from "./naming.ts"
import type { InvalidEnvironmentError, Plan, PlanAction } from "./planner.ts"

export interface AppliedPlan {
  readonly plan: Plan
  /** Имена моделей, для которых собиралась физика или гнался бэкфилл. */
  readonly built: ReadonlyArray<string>
}

export type ApplyError =
  | GraphError
  | StateError
  | EngineError
  | SqlParseError
  | SchemaMismatchError
  | InvalidEnvironmentError

/** Несколько стейтментов одной транзакцией движка; откат при любой ошибке. */
const transactional = (
  engine: Engine,
  statements: ReadonlyArray<string>,
): Effect.Effect<void, EngineError> =>
  engine.execute("BEGIN").pipe(
    Effect.andThen(Effect.forEach(statements, engine.execute, { discard: true })),
    Effect.andThen(engine.execute("COMMIT")),
    Effect.onError(() => engine.execute("ROLLBACK").pipe(Effect.ignore)),
  )

/**
 * Бэкфилл incrementalByTimeRange (SPEC §5.3): каждый диапазон плана режется
 * на батчи ≤ batchSize; батч — транзакция DELETE-диапазона + INSERT, после
 * успеха его интервалы помечаются done. Упавший батч помечается failed и
 * прерывает apply; уже отмеченное не пересчитывается при повторе — бэкфилл
 * продолжается с места остановки.
 */
const backfillModel = (
  engine: Engine,
  store: StateStoreShape,
  model: AnyModel,
  action: PlanAction,
  target: string,
  resolveRef: (ref: string) => string,
): Effect.Effect<void, EngineError | StateError> =>
  Effect.gen(function* () {
    if (model.kind._tag !== "incrementalByTimeRange") return
    const kind = model.kind
    for (const range of action.backfill) {
      for (const batch of splitIntoBatches(range, kind.interval, kind.batchSize)) {
        const marks = intervalsWithin(batch, kind.interval).map((interval: Interval) => ({
          startTs: toIso(interval.start),
          endTs: toIso(interval.end),
        }))
        const start = sqlTimestamp(batch.start)
        const end = sqlTimestamp(batch.end)
        const body = render(model.fragment, { resolveRef, interval: { start, end } })
        yield* transactional(engine, [
          `DELETE FROM ${target} WHERE ${quoteIdent(kind.timeColumn)} >= ${start} AND ${quoteIdent(kind.timeColumn)} < ${end}`,
          `INSERT INTO ${target} ${body}`,
        ]).pipe(
          Effect.tapError(() =>
            store.markIntervals(action.fingerprint, marks, "failed").pipe(Effect.ignore),
          ),
        )
        yield* store.markIntervals(action.fingerprint, marks, "done")
      }
    }
  })

/**
 * Применяет план (SPEC §5): в топологическом порядке собирает недостающую
 * физику и догоняет интервалы (ссылки в SQL резолвятся в физические таблицы
 * ЭТОГО плана, не во view окружения — середина apply не видна снаружи),
 * затем промоушен — пересоздание view + транзакционная запись набора
 * в state store.
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
      // external читается напрямую из источника — физики у него нет
      if (model.kind._tag === "external") return externalSourceRef(model.kind.source)
      return physicalRef(model.name, fingerprint)
    }

    // 1. Физика + бэкфилл
    yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS "${physicalSchema}"`)
    const built: Array<string> = []
    for (const action of plan.actions) {
      if (!action.build && action.backfill.length === 0) continue
      const model = graph.models.get(action.name)!
      const target = physicalRef(model.name, action.fingerprint)
      switch (model.kind._tag) {
        case "external":
          continue
        case "view":
        case "full": {
          const body = render(model.fragment, { resolveRef })
          // контракт схемы (SPEC §3.2): дрейф типов ловится до сборки
          yield* checkContract(engine, model, body)
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
          break
        }
        case "incrementalByTimeRange": {
          // пустой скелет с формой запроса; при resume уже существует
          const zero = sqlTimestamp(0)
          const emptyBody = render(model.fragment, {
            resolveRef,
            interval: { start: zero, end: zero },
          })
          yield* checkContract(engine, model, emptyBody)
          yield* engine.execute(
            `CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM (${emptyBody}) q LIMIT 0`,
          )
          yield* store.upsertSnapshot({
            name: action.name,
            fingerprint: action.fingerprint,
            renderedSql: render(model.fragment, { resolveRef: (ref) => ref }),
            kind: model.kind._tag,
          })
          yield* backfillModel(engine, store, model, action, target, resolveRef)
          break
        }
      }
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
      if (model.kind._tag === "external") continue // view-слоя у external нет
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
          backfill: a.backfill.map((r) => `[${toIso(r.start)}, ${toIso(r.end)})`),
        })),
      }),
    )

    return { plan, built }
  })
