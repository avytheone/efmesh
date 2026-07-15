import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { buildGraph } from "../src/core/graph.ts"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { fingerprintGraph } from "../src/plan/fingerprint.ts"

const fingerprintsOf = (models: ReadonlyArray<AnyModel>) =>
  Effect.runPromise(
    buildGraph(models).pipe(
      Effect.flatMap(fingerprintGraph),
      Effect.provide(DuckDBEngineLive()),
    ),
  )

const schema = Schema.Struct({ case_id: Schema.String, dept: Schema.String })

const movesUgly = defineModel(
  { name: "med.moves", kind: kind.full(), schema },
  (ctx) => ctx.sql`select   case_id,dept from src.raw_moves where dept='ОРИТ'`,
)

const movesPretty = defineModel(
  { name: "med.moves", kind: kind.full(), schema },
  (ctx) => ctx.sql`
    SELECT "case_id", "dept"
    FROM src.raw_moves
    WHERE "dept" = 'ОРИТ'
  `,
)

const movesOther = defineModel(
  { name: "med.moves", kind: kind.full(), schema },
  (ctx) => ctx.sql`SELECT case_id, dept FROM src.raw_moves WHERE dept = 'терапия'`,
)

describe("fingerprint по каноническому AST (SPEC §4)", () => {
  test("переформатирование и кавычки идентификаторов не меняют fingerprint", async () => {
    const ugly = await fingerprintsOf([movesUgly])
    const pretty = await fingerprintsOf([movesPretty])
    expect(ugly.get("med.moves")).toBe(pretty.get("med.moves")!)
  })

  test("смысловая правка меняет fingerprint", async () => {
    const before = await fingerprintsOf([movesPretty])
    const after = await fingerprintsOf([movesOther])
    expect(before.get("med.moves")).not.toBe(after.get("med.moves")!)
  })

  test("external: версия определяется источником", async () => {
    const src = (path: string) =>
      defineExternal({
        name: "raw.moves",
        source: external.files(path, "parquet"),
        schema,
      })
    const a = await fingerprintsOf([src("s3://lake/a/*.parquet")])
    const b = await fingerprintsOf([src("s3://lake/b/*.parquet")])
    const a2 = await fingerprintsOf([src("s3://lake/a/*.parquet")])
    expect(a.get("raw.moves")).not.toBe(b.get("raw.moves")!)
    expect(a.get("raw.moves")).toBe(a2.get("raw.moves")!)
  })

  test("смена timeColumn — новая версия, смена batchSize — нет", async () => {
    const incremental = (timeColumn: "case_id" | "dept", batchSize: number) =>
      defineModel(
        {
          name: "med.stays",
          kind: kind.incrementalByTimeRange({ timeColumn, start: "2026-01-01", batchSize }),
          schema,
        },
        (ctx) => ctx.sql`SELECT case_id, dept FROM src.raw WHERE ts >= ${ctx.start} AND ts < ${ctx.end}`,
      )
    const base = await fingerprintsOf([incremental("case_id", 30)])
    const otherColumn = await fingerprintsOf([incremental("dept", 30)])
    const otherBatch = await fingerprintsOf([incremental("case_id", 7)])
    expect(base.get("med.stays")).not.toBe(otherColumn.get("med.stays")!)
    expect(base.get("med.stays")).toBe(otherBatch.get("med.stays")!)
  })
})
