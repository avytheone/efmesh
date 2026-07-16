import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, kind } from "../src/core/model.ts"
import type { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const applyOne = (model: Parameters<typeof Efmesh.apply>[1] extends Iterable<infer M> ? M : never) =>
  scenario(Effect.flip(Efmesh.apply("dev", [model])))

describe("schema contract (SPEC §3.2)", () => {
  test("type diverged — SchemaMismatchError before building, with a clear list", async () => {
    const bad = defineModel(
      {
        name: "med.stats",
        kind: kind.full(),
        // n is actually INTEGER, ts — TIMESTAMP
        schema: Schema.Struct({ n: Schema.String, ts: Schema.DateTimeUtc }),
      },
      (ctx) => ctx.sql`SELECT 1::INTEGER AS n, TIMESTAMP '2026-01-01' AS ts`,
    )
    const error = await applyOne(bad)
    expect(error._tag).toBe("SchemaMismatchError")
    const mismatch = error as { problems: ReadonlyArray<string> }
    expect(mismatch.problems).toHaveLength(1)
    expect(mismatch.problems[0]).toContain("«n»")
    expect(mismatch.problems[0]).toContain("INTEGER")
  })

  test("missing and extraneous columns are listed", async () => {
    const bad = defineModel(
      {
        name: "med.cols",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, missing: Schema.Number }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS extra`,
    )
    const error = await applyOne(bad)
    expect(error._tag).toBe("SchemaMismatchError")
    const problems = (error as { problems: ReadonlyArray<string> }).problems
    expect(problems.some((p) => p.includes("«missing»"))).toBe(true)
    expect(problems.some((p) => p.includes("«extra»"))).toBe(true)
  })

  test("compatible families pass: Number covers INTEGER and DOUBLE, NullOr is transparent", async () => {
    const ok = defineModel(
      {
        name: "med.ok",
        kind: kind.full(),
        schema: Schema.Struct({
          i: Schema.Number,
          d: Schema.Number,
          s: Schema.NullOr(Schema.String),
          b: Schema.Boolean,
          ts: Schema.DateTimeUtc,
        }),
      },
      (ctx) => ctx.sql`
        SELECT 1::INTEGER AS i, 1.5::DOUBLE AS d, NULL::VARCHAR AS s,
               TRUE AS b, TIMESTAMP '2026-01-01' AS ts
      `,
    )
    const applied = await scenario(Efmesh.apply("dev", [ok]))
    expect(applied.built).toEqual(["med.ok"])
  })
})
