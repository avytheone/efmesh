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
      Effect.map((versions) => new Map([...versions].map(([name, v]) => [name, v.fingerprint]))),
      Effect.provide(DuckDBEngineLive()),
    ),
  )

const schema = Schema.Struct({ case_id: Schema.String, dept: Schema.String })

const movesUgly = defineModel(
  { name: "med.moves", kind: kind.full(), schema },
  (ctx) => ctx.sql`select   case_id,dept from src.raw_moves where dept='ICU'`,
)

const movesPretty = defineModel(
  { name: "med.moves", kind: kind.full(), schema },
  (ctx) => ctx.sql`
    SELECT "case_id", "dept"
    FROM src.raw_moves
    WHERE "dept" = 'ICU'
  `,
)

const movesOther = defineModel(
  { name: "med.moves", kind: kind.full(), schema },
  (ctx) => ctx.sql`SELECT case_id, dept FROM src.raw_moves WHERE dept = 'therapy'`,
)

describe("fingerprint over the canonical AST (SPEC §4)", () => {
  test("reformatting and identifier quoting do not change the fingerprint", async () => {
    const ugly = await fingerprintsOf([movesUgly])
    const pretty = await fingerprintsOf([movesPretty])
    expect(ugly.get("med.moves")).toBe(pretty.get("med.moves")!)
  })

  test("a semantic edit changes the fingerprint", async () => {
    const before = await fingerprintsOf([movesPretty])
    const after = await fingerprintsOf([movesOther])
    expect(before.get("med.moves")).not.toBe(after.get("med.moves")!)
  })

  test("external: the version is determined by the source", async () => {
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

  test("a column type change (Number→String) is a new version — types are the DAG contract (#17)", async () => {
    // identical name, kind and SQL body; only the declared type of `n` differs.
    // Before v2 the fingerprint hashed column names only, so both hashed equal
    // and the plan lied "unchanged"; now the type family (numeric vs text) parts them.
    const counted = (n: Schema.Struct.Fields[string]) =>
      defineModel(
        {
          name: "med.counts",
          kind: kind.full(),
          schema: Schema.Struct({ case_id: Schema.String, n }),
        },
        (ctx) => ctx.sql`SELECT case_id, n FROM src.raw`,
      )
    const asNumber = await fingerprintsOf([counted(Schema.Number)])
    const asString = await fingerprintsOf([counted(Schema.String)])
    expect(asNumber.get("med.counts")).not.toBe(asString.get("med.counts")!)
  })

  test("a same-family retype does not churn — family granularity (#17)", async () => {
    // NullOr(Number) stays in the numeric family: no rebuild, unlike Number→String.
    const nType = (n: Schema.Struct.Fields[string]) =>
      defineModel(
        {
          name: "med.counts",
          kind: kind.full(),
          schema: Schema.Struct({ case_id: Schema.String, n }),
        },
        (ctx) => ctx.sql`SELECT case_id, n FROM src.raw`,
      )
    const plain = await fingerprintsOf([nType(Schema.Number)])
    const nullable = await fingerprintsOf([nType(Schema.NullOr(Schema.Number))])
    expect(plain.get("med.counts")).toBe(nullable.get("med.counts")!)
  })

  test("changing timeColumn — a new version, changing batchSize — not", async () => {
    const incremental = (timeColumn: "case_id" | "dept", batchSize: number) =>
      defineModel(
        {
          name: "med.stays",
          kind: kind.incrementalByTimeRange({ timeColumn, start: "2026-01-01", batchSize }),
          schema,
        },
        (ctx) =>
          ctx.sql`SELECT case_id, dept FROM src.raw WHERE ts >= ${ctx.start} AND ts < ${ctx.end}`,
      )
    const base = await fingerprintsOf([incremental("case_id", 30)])
    const otherColumn = await fingerprintsOf([incremental("dept", 30)])
    const otherBatch = await fingerprintsOf([incremental("case_id", 7)])
    expect(base.get("med.stays")).not.toBe(otherColumn.get("med.stays")!)
    expect(base.get("med.stays")).toBe(otherBatch.get("med.stays")!)
  })
})
