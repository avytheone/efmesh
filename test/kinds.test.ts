import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defineExternal, defineModel, defineSeed, external, kind } from "../src/core/model.ts"
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

/**
 * #51: Bun does not typecheck and the CLI imports the user's config, so a
 * project with no `tsc` in the loop reaches these functions with fields simply
 * missing. `as any` is how that arrives — the point is that the refusal happens
 * here, naming the model and the field, instead of degrading into malformed SQL
 * that fails later in the engine's catalog.
 */
describe("definition-time validation of an unchecked config (#51)", () => {
  const shape = Schema.Struct({ id: Schema.String })

  const reasonOf = (define: () => unknown): string => {
    try {
      define()
    } catch (error) {
      expect((error as { _tag?: string })._tag).toBe("ModelDefinitionError")
      return (error as { message: string }).message
    }
    throw new Error("expected the definition to be refused")
  }

  test("external.files without a format is refused, not rendered as FROM undefined(…)", () => {
    const reason = reasonOf(() =>
      defineExternal({
        name: "raw.events",
        source: (external.files as any)("lake/raw/*.csv"),
        schema: shape,
      }),
    )
    expect(reason).toContain("raw.events")
    expect(reason).toContain("needs a format")
    expect(reason).toContain("lake/raw/*.csv")
  })

  test("a missing source names the constructors to use", () => {
    const reason = reasonOf(() => defineExternal({ name: "raw.events", schema: shape } as any))
    expect(reason).toContain("external.table")
    expect(reason).toContain("external.files")
  })

  test("an empty table name is refused", () => {
    const reason = reasonOf(() =>
      defineExternal({ name: "raw.events", source: external.table("  "), schema: shape }),
    )
    expect(reason).toContain("non-empty table name")
  })

  test("a missing schema is refused — it is the data-shape contract", () => {
    const reason = reasonOf(() =>
      defineExternal({ name: "raw.events", source: external.table("src.events") } as any),
    )
    expect(reason).toContain("schema is required")
  })

  test("a seed without a file is refused", () => {
    const reason = reasonOf(() => defineSeed({ name: "ref.depts", schema: shape } as any))
    expect(reason).toContain("file is required")
  })

  test("a missing kind is refused before the body is assembled", () => {
    const reason = reasonOf(() =>
      defineModel({ name: "mart.rollup", schema: shape } as any, (ctx) => ctx.sql`SELECT 1 AS id`),
    )
    expect(reason).toContain("kind is required")
  })
})
