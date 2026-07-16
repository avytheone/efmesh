import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.moves",
  source: external.table("src.moves"),
  schema: Schema.Struct({ id: Schema.String, dept: Schema.String }),
})

/** Встраиваемый фильтр: не материализуется, подставляется потребителям. */
const makeIcu = (dept: string): AnyModel =>
  defineModel(
    {
      name: "med.icu_moves",
      kind: kind.embedded(),
      schema: Schema.Struct({ id: Schema.String, dept: Schema.String }),
    },
    (ctx) => ctx.sql`SELECT id, dept FROM ${ctx.ref(raw)} WHERE dept = ${dept}`,
  )

const makeCount = (icu: AnyModel): AnyModel =>
  defineModel(
    {
      name: "med.icu_count",
      kind: kind.full(),
      schema: Schema.Struct({ n: Schema.Number }),
    },
    (ctx) => ctx.sql`SELECT count(*)::INT AS n FROM ${ctx.ref(icu)}`,
  )

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(`
    CREATE TABLE src.moves AS SELECT * FROM (VALUES
      ('m1', 'ОРИТ'), ('m2', 'терапия'), ('m3', 'ОРИТ')
    ) t(id, dept)
  `)
})

describe("embedded (SPEC §3.1)", () => {
  test("подставляется потребителю подзапросом; ни физики, ни view", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const icu = makeIcu("ОРИТ")
        yield* Efmesh.apply("dev", [raw, icu, makeCount(icu)])

        const count = yield* engine.query(`SELECT n FROM dev__med.icu_count`)
        expect(count).toEqual([{ n: 2 }])

        // embedded не оставил ни view окружения, ни физической таблицы
        const noView = yield* Effect.flip(engine.query(`SELECT * FROM dev__med.icu_moves`))
        expect(noView._tag).toBe("EngineError")
        const physics = yield* engine.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '_efmesh'`,
        )
        expect(physics.some((row) => String(row.table_name).includes("icu_moves"))).toBe(false)
      }),
    )
  })

  test("правка тела embedded каскадит на потребителя (indirect) и меняет данные", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const v1 = makeIcu("ОРИТ")
        yield* Efmesh.apply("dev", [raw, v1, makeCount(v1)])

        const v2 = makeIcu("терапия")
        const plan = yield* Efmesh.plan("dev", [raw, v2, makeCount(v2)])
        expect(plan.actions.find((a) => a.name === "med.icu_moves")!.change).toBe("breaking")
        expect(plan.actions.find((a) => a.name === "med.icu_count")!.change).toBe("indirect")

        yield* Efmesh.apply("dev", [raw, v2, makeCount(v2)])
        const count = yield* engine.query(`SELECT n FROM dev__med.icu_count`)
        expect(count).toEqual([{ n: 1 }])
      }),
    )
  })

  test("renderFor инлайнит embedded и источник external", async () => {
    const icu = makeIcu("ОРИТ")
    const sql = await Effect.runPromise(Efmesh.renderFor([raw, icu, makeCount(icu)], "med.icu_count", "dev"))
    expect(sql).toContain("(SELECT id, dept FROM src.moves WHERE dept = 'ОРИТ')")
  })
})
