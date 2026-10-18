import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { familyOfAst } from "../src/plan/contract.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { testModel } from "../src/testing/index.ts"

for (const [name, field, expected] of [
  ["String", Schema.String, "text"],
  ["Number", Schema.Number, "numeric"],
  ["BigInt", Schema.BigInt, "numeric"],
  ["Boolean", Schema.Boolean, "boolean"],
  ["DateTimeUtc", Schema.DateTimeUtc, "temporal"],
  ["DateTimeUtcFromString", Schema.DateTimeUtcFromString, "temporal"],
  ["nullable date", Schema.NullOr(Schema.DateTimeUtc), "temporal"],
  ["optional date", Schema.optional(Schema.DateTimeUtc), "temporal"],
  ["nullable text", Schema.NullOr(Schema.String), "text"],
  ["optional number", Schema.optional(Schema.Number), "numeric"],
] as const) {
  test(`stable Schema runtime AST: ${name} has the supported family, never any`, () => {
    expect(familyOfAst(field.ast)).toBe(expected)
  })
}

test("stable date declarations still reject SQL text before materialization", async () => {
  const model = defineModel(
    { name: "med.bad_date", kind: kind.full(), schema: Schema.Struct({ at: Schema.DateTimeUtc }) },
    (ctx) => ctx.sql`SELECT 'not-a-date' AS at`,
  )
  const exit = await Effect.runPromise(
    Effect.exit(Efmesh.apply("dev", [model])).pipe(
      Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("temporal")
})

const fixtureProbe = () => {
  const source = defineExternal({
    name: "raw.types",
    source: external.table("src.types"),
    schema: Schema.Struct({
      text: Schema.String,
      number: Schema.Number,
      flag: Schema.Boolean,
      happened_at: Schema.DateTimeUtc,
      optional_date: Schema.optional(Schema.DateTimeUtc),
    }),
  })
  const probe = defineModel(
    {
      name: "med.types",
      kind: kind.full(),
      schema: Schema.Struct({
        text: Schema.String,
        number: Schema.String,
        flag: Schema.String,
        happened_at: Schema.String,
        optional_date: Schema.String,
      }),
    },
    (ctx) => ctx.sql`SELECT
    typeof((SELECT text FROM ${ctx.ref(source)} LIMIT 1)) AS text,
    typeof((SELECT number FROM ${ctx.ref(source)} LIMIT 1)) AS number,
    typeof((SELECT flag FROM ${ctx.ref(source)} LIMIT 1)) AS flag,
    typeof((SELECT happened_at FROM ${ctx.ref(source)} LIMIT 1)) AS happened_at,
    typeof((SELECT optional_date FROM ${ctx.ref(source)} LIMIT 1)) AS optional_date`,
  )

  return probe
}

test("testModel empty fixtures retain primitive, date and optional SQL types", async () => {
  await testModel(fixtureProbe(), {
    inputs: { "raw.types": [] },
    expect: [
      {
        text: "VARCHAR",
        number: "DOUBLE",
        flag: "BOOLEAN",
        happened_at: "TIMESTAMP",
        optional_date: "TIMESTAMP",
      },
    ],
  })
})

test("testModel date fixtures are timestamps, including optional fields", async () => {
  await testModel(fixtureProbe(), {
    inputs: {
      "raw.types": [
        {
          text: "hello",
          number: 1.5,
          flag: true,
          happened_at: "2026-01-01T00:00:00Z",
          optional_date: "2026-01-02T00:00:00Z",
        },
      ],
    },
    expect: [
      {
        text: "VARCHAR",
        number: "DECIMAL(2,1)",
        flag: "BOOLEAN",
        happened_at: "TIMESTAMP",
        optional_date: "TIMESTAMP",
      },
    ],
  })
})

test("testModel rejects invalid date fixtures by family before SQL", async () => {
  await expect(
    testModel(fixtureProbe(), {
      inputs: {
        "raw.types": [{ text: "hello", number: 1.5, flag: true, happened_at: "not-a-date" }],
      },
      expect: [],
    }),
  ).rejects.toThrow(/expects temporal/)
})
