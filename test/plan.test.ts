import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`
    SELECT * FROM (VALUES ('c1', 'ICU'), ('c2', 'therapy')) AS t(case_id, dept)
  `,
)

const staysV1 = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT ${ctx.cols(moves, "case_id", "dept")} FROM ${ctx.ref(moves)}`,
)

/** Same model, changed body — a "code edit" between plans. */
const staysV2 = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(moves, "case_id", "dept")} FROM ${ctx.ref(moves)} WHERE dept = ${"ICU"}
  `,
)

/**
 * One live rig for the whole scenario: a shared DuckDB + a shared state store,
 * as in a real project between CLI invocations.
 */
const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(
  body: Effect.Effect<A, E, EngineAdapter | import("../src/state/store.ts").StateStore>,
) => Effect.runPromise(body.pipe(Effect.provide(testLayer)))

describe("F0: the stop condition SPEC §13", () => {
  test("plan→apply→change→plan→apply; prod is not recomputed", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const v1: ReadonlyArray<AnyModel> = [moves, staysV1]
        const v2: ReadonlyArray<AnyModel> = [moves, staysV2]

        // — the first plan in dev: both models added, both are built
        const plan1 = yield* Efmesh.plan("dev", v1)
        expect(plan1.actions.map((a) => a.change)).toEqual(["added", "added"])
        const applied1 = yield* Efmesh.apply("dev", v1)
        expect(applied1.built).toEqual(["med.moves", "med.stays"])
        const devRows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(devRows).toEqual([{ n: 2 }])

        // — a repeated apply in dev: no changes, nothing is built
        const applied2 = yield* Efmesh.apply("dev", v1)
        expect(applied2.plan.hasChanges).toBe(false)
        expect(applied2.built).toEqual([])

        // ★ promotion to prod: the snapshots are already built by dev — view-swap only
        const appliedProd = yield* Efmesh.apply("prod", v1)
        expect(appliedProd.built).toEqual([]) // prod does NOT recompute
        const prodRows = yield* engine.query(`SELECT count(*)::INT AS n FROM med.stays`)
        expect(prodRows).toEqual([{ n: 2 }])

        // — editing stays: in dev only stays is rebuilt, moves untouched
        const plan2 = yield* Efmesh.plan("dev", v2)
        const changes = new Map(plan2.actions.map((a) => [a.name, a.change]))
        expect(changes.get("med.moves")).toBe("unchanged")
        expect(changes.get("med.stays")).toBe("breaking")
        const applied3 = yield* Efmesh.apply("dev", v2)
        expect(applied3.built).toEqual(["med.stays"])
        const devRows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(devRows2).toEqual([{ n: 1 }])

        // prod lives on the old version until it is promoted
        const prodStill = yield* engine.query(`SELECT count(*)::INT AS n FROM med.stays`)
        expect(prodStill).toEqual([{ n: 2 }])

        // ★ promoting the edit to prod: again without a build
        const appliedProd2 = yield* Efmesh.apply("prod", v2)
        expect(appliedProd2.built).toEqual([])
        const prodRows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM med.stays`)
        expect(prodRows2).toEqual([{ n: 1 }])
      }),
    )
  })

  test("removing a model from the project drops its view on promotion", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* Efmesh.apply("dev", [moves, staysV1])
        const applied = yield* Efmesh.apply("dev", [moves])
        expect(applied.plan.actions.find((a) => a.name === "med.stays")?.change).toBe("removed")
        const error = yield* Effect.flip(engine.query(`SELECT * FROM dev__med.stays`))
        expect(error._tag).toBe("EngineError")
      }),
    )
  })

  test("a view model is materialized as a view over the parent's physical table", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const wards = defineModel(
          {
            name: "med.wards",
            kind: kind.view(),
            schema: Schema.Struct({ dept: Schema.String }),
          },
          (ctx) => ctx.sql`SELECT DISTINCT dept FROM ${ctx.ref(moves)}`,
        )
        yield* Efmesh.apply("dev", [moves, wards])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.wards`)
        expect(rows).toEqual([{ n: 2 }])
      }),
    )
  })
})
