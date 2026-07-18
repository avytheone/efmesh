import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { canonicalizePostgresSql } from "../src/engine/postgres.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { hasWindowFunction } from "../src/plan/window-risk.ts"

/**
 * #54: a backfill batch renders ONE [start, end) for the whole batch, so a
 * model whose result depends on the width of that frame silently means
 * something different while catching up than on the steady tick. The warning
 * fires on the declaration, at plan time, before anything is written.
 */

const raw = defineExternal({
  name: "src.rows",
  source: external.table("src.rows"),
  schema: Schema.Struct({ id: Schema.String, k: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const windowed = (name: string, batchSize: number) =>
  defineModel(
    {
      name,
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        interval: "day",
        batchSize,
      }),
      schema: Schema.Struct({
        id: Schema.String,
        k: Schema.String,
        happened_at: Schema.DateTimeUtc,
      }),
    },
    (ctx) => ctx.sql`
      SELECT * FROM (
        SELECT ${ctx.cols(raw, "id", "k", "happened_at")},
               row_number() OVER (PARTITION BY k ORDER BY happened_at) AS rn
        FROM ${ctx.ref(raw)}
        WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
      ) ranked WHERE rn = 1
    `,
  )

const plain = (name: string, batchSize: number) =>
  defineModel(
    {
      name,
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        interval: "day",
        batchSize,
      }),
      schema: Schema.Struct({
        id: Schema.String,
        k: Schema.String,
        happened_at: Schema.DateTimeUtc,
      }),
    },
    (ctx) => ctx.sql`
      SELECT ${ctx.cols(raw, "id", "k", "happened_at")} FROM ${ctx.ref(raw)}
      WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
    `,
  )

const planning = (model: ReturnType<typeof plain>, env: string) =>
  Effect.runPromise(
    Efmesh.plan(env, [raw, model]).pipe(
      Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())),
    ),
  )

describe("a window function over a wide batch is warned about at plan time (#54)", () => {
  test("batchSize > 1 with a window function warns, and names what to do", async () => {
    const plan = await planning(windowed("mart.dedup", 7), "dev")
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]!.code).toBe("window-over-batch")
    expect(plan.warnings[0]!.model).toBe("mart.dedup")
    expect(plan.warnings[0]!.message).toContain("batchSize: 1")
  })

  test("batchSize 1 is the safe configuration and says nothing", async () => {
    expect((await planning(windowed("mart.pinned", 1), "dev2")).warnings).toEqual([])
  })

  test("no window function, no warning — a wide batch is a performance knob there", async () => {
    expect((await planning(plain("mart.rows", 30), "dev3")).warnings).toEqual([])
  })

  test("the warning is not a refusal — the plan still has its actions", async () => {
    const plan = await planning(windowed("mart.dedup2", 7), "dev4")
    // a window over a wide frame is legitimate when the result does not depend
    // on it, and efmesh cannot know which; refusing would make a correct model
    // unbuildable to protect an incorrect one
    expect(plan.hasChanges).toBe(true)
    expect(plan.actions.some((action) => action.name === "mart.dedup2")).toBe(true)
  })
})

describe("detection is structural, not textual (#54)", () => {
  const duck = (sql: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { EngineAdapter } = yield* Effect.promise(() => import("../src/engine/adapter.ts"))
        const engine = yield* EngineAdapter
        return yield* engine.canonicalize(sql)
      }).pipe(Effect.provide(DuckDBEngineLive())),
    )

  test("DuckDB: a window function is found, a column named `over` is not", async () => {
    expect(hasWindowFunction(await duck("SELECT lead(x) OVER (ORDER BY t) AS d FROM t"))).toBe(true)
    expect(hasWindowFunction(await duck("SELECT sum(x) AS d FROM t GROUP BY k"))).toBe(false)
    // the trap a grep for "OVER" falls into
    expect(hasWindowFunction(await duck(`SELECT "over" FROM t`))).toBe(false)
    expect(hasWindowFunction(await duck(`SELECT 'x OVER y' AS s FROM t`))).toBe(false)
  })

  test("Postgres: the same three cases, through libpg_query", async () => {
    const pg = (sql: string) => Effect.runPromise(canonicalizePostgresSql(sql))
    expect(hasWindowFunction(await pg("SELECT lead(x) OVER (ORDER BY t) AS d FROM t"))).toBe(true)
    expect(hasWindowFunction(await pg("SELECT sum(x) AS d FROM t GROUP BY k"))).toBe(false)
    expect(hasWindowFunction(await pg(`SELECT "over" FROM t`))).toBe(false)
  })

  test("an AST that is not a serialized tree makes no claim", () => {
    expect(hasWindowFunction("")).toBe(false)
    expect(hasWindowFunction("not json")).toBe(false)
  })
})
