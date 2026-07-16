import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { buildGraph } from "../src/core/graph.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { formatLineage, lineage } from "../src/plan/lineage.ts"

const raw = defineExternal({
  name: "raw.moves",
  source: external.files("lake/raw/moves.parquet", "parquet"),
  schema: Schema.Struct({
    case_id: Schema.String,
    dept: Schema.String,
    moved_at: Schema.DateTimeUtc,
  }),
})

const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.full(),
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      moved_at: Schema.DateTimeUtc,
    }),
  },
  (ctx) => ctx.sql`SELECT case_id, dept, moved_at FROM ${ctx.ref(raw)}`,
)

const stays = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({
      case_id: Schema.String,
      duration: Schema.NullOr(Schema.Number),
    }),
  },
  (ctx) => ctx.sql`
    SELECT
      case_id,
      extract(epoch FROM lead(moved_at) OVER w - moved_at)::DOUBLE AS duration
    FROM ${ctx.ref(moves)}
    WINDOW w AS (PARTITION BY case_id ORDER BY moved_at)
  `,
)

const trace = (name: string, column: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const graph = yield* buildGraph([raw, moves, stays])
      return yield* lineage(graph, name, column)
    }).pipe(Effect.provide(DuckDBEngineLive())),
  )

describe("column lineage (SPEC §9.4)", () => {
  test("an expression is unwound down to the raw external column", async () => {
    const tree = await trace("med.stays", "duration")
    // duration ← lead(moved_at) - moved_at ← med.moves.moved_at ← raw.moves.moved_at
    expect(tree.model).toBe("med.stays")
    const viaMoves = tree.sources.filter((s) => s.model === "med.moves")
    expect(viaMoves.map((s) => s.column).sort()).toEqual(["case_id", "moved_at"])
    const movedAt = viaMoves.find((s) => s.column === "moved_at")!
    expect(movedAt.sources).toEqual([
      { model: "raw.moves", column: "moved_at", kind: "external", sources: [] },
    ])
  })

  test("a pass-through column and tree printing", async () => {
    const tree = await trace("med.stays", "case_id")
    const lines = formatLineage(tree)
    expect(lines[0]).toBe("med.stays.case_id")
    expect(lines).toContain("    raw.moves.case_id  [external]")
  })

  test("an unknown column — LineageError", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const graph = yield* buildGraph([raw, moves, stays])
        return yield* Effect.flip(lineage(graph, "med.stays", "nope"))
      }).pipe(Effect.provide(DuckDBEngineLive())),
    )
    expect(failure._tag).toBe("LineageError")
  })
})
