import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { diffEnvironments } from "../src/plan/diff.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

describe("экспорт в ATTACH (SPEC §9.3)", () => {
  test("готовая витрина уезжает в attach-базу после аудитов и промоушена", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-export-"))
    const appDb = join(dir, "app.duckdb")
    const mart = defineModel(
      {
        name: "med.mart",
        kind: kind.full(),
        schema: Schema.Struct({ id: Schema.String }),
        export: { attach: "app", table: "public.mart" },
      },
      (ctx) => ctx.sql`SELECT 'x' AS id`,
    )
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* Efmesh.apply("prod", [mart], { attach: { app: { url: appDb } } })
        const rows = yield* engine.query(`SELECT * FROM app.public.mart`)
        expect(rows).toEqual([{ id: "x" }])
      }),
    )
  })

  test("алиас не задан в конфиге — AttachNotConfiguredError", async () => {
    const orphan = defineModel(
      {
        name: "med.orphan",
        kind: kind.full(),
        schema: Schema.Struct({ id: Schema.String }),
        export: { attach: "ghost", table: "public.orphan" },
      },
      (ctx) => ctx.sql`SELECT 'x' AS id`,
    )
    const error = await scenario(Effect.flip(Efmesh.apply("prod", [orphan])))
    expect(error._tag).toBe("AttachNotConfiguredError")
  })
})

describe("diff окружений (SPEC §11)", () => {
  test("only-in / different / same", async () => {
    const modelOf = (name: string, value: string) =>
      defineModel(
        { name, kind: kind.full(), schema: Schema.Struct({ a: Schema.String }) },
        (ctx) => ctx.sql`SELECT ${value} AS a`,
      )
    await scenario(
      Effect.gen(function* () {
        yield* Efmesh.apply("dev", [modelOf("med.x", "1"), modelOf("med.devonly", "1")])
        yield* Efmesh.apply("prod", [modelOf("med.x", "2"), modelOf("med.prodonly", "1")])
        const diff = yield* diffEnvironments("dev", "prod")
        expect(diff.onlyInA).toEqual(["med.devonly"])
        expect(diff.onlyInB).toEqual(["med.prodonly"])
        expect(diff.different.map((d) => d.name)).toEqual(["med.x"])
        expect(diff.same).toEqual([])
      }),
    )
  })
})
