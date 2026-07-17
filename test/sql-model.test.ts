import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineSqlModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"
import { runModel } from "../src/testing/index.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const SQL_FILE = new URL("./fixtures/daily_events.sql", import.meta.url).pathname

const makeSqlModel = () =>
  defineSqlModel({
    name: "med.events",
    kind: kind.incrementalByTimeRange({
      timeColumn: "happened_at",
      start: "2026-01-01T00:00:00Z",
    }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
    file: SQL_FILE,
    refs: [raw],
  })

describe("raw .sql models (SPEC §14.1)", () => {
  test("@ref/@start/@end are parsed; the model lives a full plan→apply cycle", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(`
          CREATE TABLE src.events AS SELECT * FROM (VALUES
            ('e1', TIMESTAMP '2026-01-01 10:00:00'),
            ('e2', TIMESTAMP '2026-01-02 11:00:00')
          ) t(id, happened_at)
        `)
        const model = makeSqlModel()
        expect([...model.deps]).toEqual(["src.events"])

        const jan3 = fromIso("2026-01-03T00:00:00Z")
        yield* Efmesh.apply("dev", [raw, model], { now: jan3 })
        const rows = yield* engine.query(`SELECT id FROM dev__med.events ORDER BY id`)
        expect(rows).toEqual([{ id: "e1" }, { id: "e2" }])
      }),
    )
  })

  test("testModel works: sources are declared as values", async () => {
    const rows = await runModel(makeSqlModel(), {
      inputs: {
        "src.events": [
          { id: "x", happened_at: "2026-01-01T05:00:00Z" },
          { id: "y", happened_at: "2026-02-01T05:00:00Z" }, // outside the interval
        ],
      },
      interval: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    })
    expect(rows.map((row) => row.id)).toEqual(["x"])
  })

  test("@ref not declared in refs and an extraneous ref — definition errors", () => {
    const attempt = (refs: ReadonlyArray<import("../src/core/model.ts").AnyModel>) => {
      try {
        defineSqlModel({
          name: "med.events",
          kind: kind.full(),
          schema: Schema.Struct({ id: Schema.String }),
          file: SQL_FILE,
          refs,
        })
        return undefined
      } catch (error) {
        return error as { _tag?: string; reason?: string }
      }
    }
    const missing = attempt([])
    expect(missing?._tag).toBe("ModelDefinitionError")
    expect(missing?.reason).toContain("@ref(src.events)")

    const extraneous = attempt([
      raw,
      defineExternal({
        name: "src.unused",
        source: external.table("src.unused"),
        schema: Schema.Struct({ id: Schema.String }),
      }),
    ])
    expect(extraneous?._tag).toBe("ModelDefinitionError")
    expect(extraneous?.reason).toContain("src.unused")
  })
})
