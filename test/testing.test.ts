import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { runModel, testModel } from "../src/testing/index.ts"

const moves = defineExternal({
  name: "src.moves",
  source: external.table("src.moves"),
  schema: Schema.Struct({
    case_id: Schema.String,
    dept: Schema.String,
    moved_at: Schema.DateTimeUtc,
  }),
})

const stays = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      duration: Schema.NullOr(Schema.Number),
    }),
  },
  (ctx) => ctx.sql`
    SELECT
      ${ctx.cols(moves, "case_id", "dept")},
      extract(epoch FROM lead(moved_at) OVER w - moved_at)::INT AS duration
    FROM ${ctx.ref(moves)}
    WINDOW w AS (PARTITION BY case_id ORDER BY moved_at)
  `,
)

describe("testModel (SPEC §8)", () => {
  test("fixtures → CTE → result is compared", async () => {
    await testModel(stays, {
      inputs: {
        [moves.name.full]: [
          { case_id: "c1", dept: "ICU", moved_at: "2026-01-01T10:00:00Z" },
          { case_id: "c1", dept: "therapy", moved_at: "2026-01-02T10:00:00Z" },
        ],
      },
      expect: [
        { case_id: "c1", dept: "ICU", duration: 86400 },
        { case_id: "c1", dept: "therapy", duration: null },
      ],
    })
  })

  test("a mismatch — a clear error with both sides", async () => {
    await expect(
      testModel(stays, {
        inputs: {
          [moves.name.full]: [{ case_id: "c1", dept: "ICU", moved_at: "2026-01-01T10:00:00Z" }],
        },
        expect: [{ case_id: "c1", dept: "ICU", duration: 999 }],
      }),
    ).rejects.toThrow("did not match the expectation")
  })

  test("a fixture invalid per Schema is rejected", async () => {
    await expect(
      testModel(stays, {
        inputs: {
          [moves.name.full]: [{ case_id: 42, dept: "ICU", moved_at: "2026-01-01T10:00:00Z" }],
        },
        expect: [],
      }),
    ).rejects.toThrow()
  })

  test("a missing fixture and a typo in the name — errors before the run", async () => {
    await expect(testModel(stays, { expect: [] })).rejects.toThrow("no fixture")
    await expect(
      testModel(stays, {
        inputs: { "med.typo": [], [moves.name.full]: [] },
        expect: [],
      }),
    ).rejects.toThrow("is not a source")
  })

  test("incremental: interval is required and filters fixtures", async () => {
    const daily = defineModel(
      {
        name: "med.daily",
        kind: kind.incrementalByTimeRange({ timeColumn: "moved_at", start: "2026-01-01" }),
        schema: Schema.Struct({ case_id: Schema.String, moved_at: Schema.DateTimeUtc }),
      },
      (ctx) => ctx.sql`
        SELECT ${ctx.cols(moves, "case_id", "moved_at")} FROM ${ctx.ref(moves)}
        WHERE moved_at >= ${ctx.start} AND moved_at < ${ctx.end}
      `,
    )
    await expect(
      testModel(daily, { inputs: { [moves.name.full]: [] }, expect: [] }),
    ).rejects.toThrow("provide interval")

    const rows = await runModel(daily, {
      inputs: {
        [moves.name.full]: [
          { case_id: "in", dept: "ICU", moved_at: "2026-01-01T12:00:00Z" },
          { case_id: "out", dept: "ICU", moved_at: "2026-02-01T12:00:00Z" },
        ],
      },
      interval: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    })
    expect(rows.map((r) => r["case_id"])).toEqual(["in"])
  })

  test("an empty fixture yields an empty typed input", async () => {
    await testModel(stays, {
      inputs: { [moves.name.full]: [] },
      expect: [],
    })
  })
})
