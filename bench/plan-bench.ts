/**
 * Bench of efmesh's overhead over the engine: how much plan (canonicalize +
 * fingerprint of the whole graph) and apply cost on N synthetic models.
 * Run: bun bench/plan-bench.ts [N]
 * DAG: chains of 5 models from shared roots — both depth and fan-out.
 */
import { Effect, Layer, Schema } from "effect"
import { buildGraph } from "../src/core/graph.ts"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { applyPlan } from "../src/plan/executor.ts"
import { planChanges } from "../src/plan/planner.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const N = Number(process.argv[2] ?? 200)
const CHAIN = 5

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, v: Schema.Number }),
})

const models: Array<AnyModel> = [raw]
let prev: AnyModel = raw
for (let i = 0; i < N; i++) {
  const parent: AnyModel = i % CHAIN === 0 ? raw : prev
  const model = defineModel(
    {
      name: `m.t${String(i).padStart(4, "0")}`,
      kind: kind.full(),
      schema: Schema.Struct({ id: Schema.String, v: Schema.Number }),
    },
    (ctx) => ctx.sql`SELECT id, v + ${String(i)} AS v FROM ${ctx.ref(parent)}`,
  )
  models.push(model)
  prev = model
}

const layer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())
const ms = (from: number) => `${(performance.now() - from).toFixed(0)} мс`

await Effect.runPromise(
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    yield* StateStore
    yield* engine.execute(`CREATE SCHEMA src`)
    yield* engine.execute(`CREATE TABLE src.events AS SELECT 'e' || range::TEXT AS id, range::DOUBLE AS v FROM range(1000)`)

    let t = performance.now()
    const graph = yield* buildGraph(models)
    console.log(`buildGraph (${N} моделей):      ${ms(t)}`)

    t = performance.now()
    const plan = yield* planChanges("dev", graph)
    console.log(`plan холодный (всё added):     ${ms(t)}`)

    t = performance.now()
    yield* applyPlan(plan, graph)
    console.log(`apply (физика ${N} таблиц):     ${ms(t)}`)

    t = performance.now()
    const idle = yield* planChanges("dev", graph)
    console.log(`plan повторный (unchanged):    ${ms(t)}`)
    if (idle.hasChanges) throw new Error("ожидался пустой план")

    t = performance.now()
    const plan2 = yield* planChanges("prod", graph)
    yield* applyPlan(plan2, graph)
    console.log(`промоушен prod (view-swap):    ${ms(t)}`)
  }).pipe(Effect.provide(layer)),
)
