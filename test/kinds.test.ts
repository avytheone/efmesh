import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { render } from "../src/core/sql.ts"

const rawMoves = defineExternal({
  name: "raw.moves",
  source: external.files("s3://lake/raw/moves/*.parquet", "parquet"),
  schema: Schema.Struct({ case_id: Schema.String, moved_at: Schema.String }),
})

const incremental = defineModel(
  {
    name: "med.moves",
    kind: kind.incrementalByTimeRange({ timeColumn: "moved_at", start: "2026-01-01" }),
    schema: Schema.Struct({ case_id: Schema.String, moved_at: Schema.String }),
  },
  (ctx) => ctx.sql`
    SELECT case_id, moved_at FROM ${ctx.ref(rawMoves)}
    WHERE moved_at >= ${ctx.start} AND moved_at < ${ctx.end}
  `,
)

describe("kinds F1", () => {
  test("incrementalByTimeRange: grain/batch/lookback defaults", () => {
    const k = incremental.kind
    if (k._tag !== "incrementalByTimeRange") throw new Error("wrong kind")
    expect(k.interval).toBe("day")
    expect(k.batchSize).toBe(30)
    expect(k.lookback).toBe(0)
  })

  test("ctx.start/ctx.end: without interval — placeholders, with interval — literals", () => {
    const canonical = render(incremental.fragment, { resolveRef: (r) => r })
    expect(canonical).toContain("moved_at >= $start AND moved_at < $end")

    const executable = render(incremental.fragment, {
      resolveRef: (r) => r,
      interval: {
        start: "TIMESTAMP '2026-01-01 00:00:00'",
        end: "TIMESTAMP '2026-01-02 00:00:00'",
      },
    })
    expect(executable).toContain("moved_at >= TIMESTAMP '2026-01-01 00:00:00'")
    expect(executable).toContain("moved_at < TIMESTAMP '2026-01-02 00:00:00'")
  })

  test("ctx.start in a full model — a definition error", () => {
    try {
      defineModel(
        {
          name: "med.bad",
          kind: kind.full(),
          schema: Schema.Struct({ x: Schema.String }),
        },
        (ctx) => ctx.sql`SELECT 1 WHERE ts >= ${ctx.start}`,
      )
      throw new Error("should have failed")
    } catch (error) {
      expect((error as { _tag: string })._tag).toBe("ModelDefinitionError")
    }
  })

  test("timeColumn outside the schema — a definition error", () => {
    try {
      defineModel(
        {
          name: "med.bad2",
          kind: kind.incrementalByTimeRange({ timeColumn: "nope", start: "2026-01-01" }),
          schema: Schema.Struct({ x: Schema.String }),
        },
        (ctx) => ctx.sql`SELECT 1`,
      )
      throw new Error("should have failed")
    } catch (error) {
      expect((error as { _tag: string })._tag).toBe("ModelDefinitionError")
    }
  })

  test("external: participates in the consumer's deps, has no deps itself", () => {
    expect(incremental.deps.has("raw.moves")).toBe(true)
    expect(rawMoves.deps.size).toBe(0)
    expect(rawMoves.kind._tag).toBe("external")
  })
})
