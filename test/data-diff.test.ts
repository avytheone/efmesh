import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { dataDiffEnvironments } from "../src/plan/diff.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

/**
 * #6: diff --data — comparing the data of two environments' view layers: row
 * counts, key intersection (grain), per-model column divergences.
 * Drift is arranged honestly: dev is applied, the source mutates, prod is
 * applied with already-different data — the views look at different snapshots.
 */

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.visits",
  source: external.table("src.visits"),
  schema: Schema.Struct({ id: Schema.String, dept: Schema.String, cost: Schema.Number }),
})

const visits = defineModel(
  {
    name: "med.visits",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, dept: Schema.String, cost: Schema.Number }),
    grain: ["id"],
  },
  (ctx) => ctx.sql`SELECT id, dept, cost FROM ${ctx.ref(raw)}`,
)

const keyless = defineModel(
  {
    name: "med.keyless",
    kind: kind.full(),
    schema: Schema.Struct({ dept: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT DISTINCT dept FROM ${ctx.ref(raw)}`,
)

describe("diff --data (#6)", () => {
  test("counts, key intersection, column divergences; without a key — counts only", async () => {
    const report = await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(`
          CREATE TABLE src.visits AS SELECT * FROM (VALUES
            ('v1', 'icu', 100), ('v2', 'icu', 200), ('v3', 'therapy', 50)
          ) t(id, dept, cost)
        `)
        const models = [raw, visits, keyless]
        yield* Efmesh.apply("dev", models)
        // the source drifts: v2 got pricier, v3 vanished, v4 appeared —
        // prod builds ALREADY-different data (a breaking edit is not needed
        // here: do environments point at different snapshots of one model?
        // no — full rebuilds only on a new fingerprint, so we induce the
        // drift by hand via the prod snapshot's physical table after promotion)
        yield* Efmesh.apply("prod", models)
        // the environments point at ONE snapshot — there should be no divergence
        const cleanReport = yield* dataDiffEnvironments("dev", "prod", models)
        expect(cleanReport.models.map((m) => m.model)).toEqual(["med.keyless", "med.visits"])
        const cleanVisits = cleanReport.models.find((m) => m.model === "med.visits")!
        expect(cleanVisits).toMatchObject({
          rowsA: 3,
          rowsB: 3,
          onlyInA: 0,
          onlyInB: 0,
          matched: 3,
          columns: [],
        })

        // drift: the prod view is switched by hand to an edited copy —
        // this is what a divergence of environments pointing at different versions looks like
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS prod_phys`)
        yield* engine.execute(`
          CREATE TABLE prod_phys.visits AS SELECT * FROM (VALUES
            ('v1', 'icu', 100), ('v2', 'icu', 250), ('v4', 'surgery', 70)
          ) t(id, dept, cost)
        `)
        // prod is a special env: its views live in the model's bare schema (naming.ts)
        yield* engine.execute(
          `CREATE OR REPLACE VIEW "med"."visits" AS SELECT * FROM prod_phys.visits`,
        )
        return yield* dataDiffEnvironments("dev", "prod", models)
      }),
    )
    const drifted = report.models.find((m) => m.model === "med.visits")!
    expect(drifted.rowsA).toBe(3)
    expect(drifted.rowsB).toBe(3)
    expect(drifted.key).toEqual(["id"])
    expect(drifted.onlyInA).toBe(1) // v3
    expect(drifted.onlyInB).toBe(1) // v4
    expect(drifted.matched).toBe(2) // v1, v2
    expect(drifted.columns).toEqual([{ column: "cost", mismatches: 1, rate: 0.5 }])

    const counted = report.models.find((m) => m.model === "med.keyless")!
    expect(counted.key).toBeUndefined()
    expect(counted.rowsA).toBe(2)
    expect(counted.onlyInA).toBeUndefined()
  })

  test("md5-bucket sampling is aligned: the sample does not create false only-in", async () => {
    const report = await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(`
          CREATE TABLE src.visits AS
          SELECT 'v' || range::VARCHAR AS id, 'icu' AS dept, range::INT AS cost
          FROM range(1000)
        `)
        const models = [raw, visits]
        yield* Efmesh.apply("dev", models)
        yield* Efmesh.apply("prod", models)
        return yield* dataDiffEnvironments("dev", "prod", models, { samplePercent: 25 })
      }),
    )
    const sampled = report.models.find((m) => m.model === "med.visits")!
    expect(sampled.sampledPercent).toBe(25)
    expect(sampled.rowsA).toBe(1000) // row counts — full
    expect(sampled.onlyInA).toBe(0) // the sample is aligned — pairs are not lost
    expect(sampled.onlyInB).toBe(0)
    expect(sampled.matched).toBeGreaterThan(100) // ~250 at 25%
    expect(sampled.matched!).toBeLessThan(500)
    expect(sampled.columns).toEqual([])
  })

  test("a model not in both environments/not in the project — DataDiffError", async () => {
    const failure = await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(
          `CREATE TABLE src.visits AS SELECT 'v1' AS id, 'icu' AS dept, 1 AS cost`,
        )
        yield* Efmesh.apply("dev", [raw, visits])
        return yield* Effect.flip(
          dataDiffEnvironments("dev", "prod", [raw, visits], { models: ["med.visits"] }),
        )
      }),
    )
    expect(failure._tag).toBe("DataDiffError")
    expect(failure).toMatchObject({ model: "med.visits" })
  })
})
