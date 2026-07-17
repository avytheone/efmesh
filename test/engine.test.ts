import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EngineAdapter, type Engine } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"

const withEngine = <A, E>(body: (engine: Engine) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineAdapter
      return yield* body(engine)
    }).pipe(Effect.provide(DuckDBEngineLive())),
  )

describe("DuckDBEngine", () => {
  test("query returns rows", async () => {
    const rows = await withEngine((engine) => engine.query("SELECT 42 AS answer"))
    expect(rows).toEqual([{ answer: 42 }])
  })

  test("execute + query over a single connection", async () => {
    const rows = await withEngine((engine) =>
      Effect.gen(function* () {
        yield* engine.execute("CREATE TABLE t AS SELECT 'x' AS a")
        return yield* engine.query("SELECT a FROM t")
      }),
    )
    expect(rows).toEqual([{ a: "x" }])
  })

  test("describe returns names and types without executing the query", async () => {
    const columns = await withEngine((engine) =>
      engine.describe("SELECT 1::INTEGER AS n, 'a' AS s"),
    )
    expect(columns).toEqual([
      { name: "n", type: "INTEGER" },
      { name: "s", type: "VARCHAR" },
    ])
  })

  test("broken SQL — EngineError with the query text", async () => {
    const error = await withEngine((engine) => Effect.flip(engine.query("SELECT FROM nope")))
    expect(error._tag).toBe("EngineError")
    expect(error.sql).toContain("nope")
  })

  test("canonicalize: reformatting does not change the result", async () => {
    const [a, b] = await withEngine((engine) =>
      Effect.all([
        engine.canonicalize("select  a,b from t where x=1 and ts>=$start"),
        engine.canonicalize('SELECT "a", "b"\nFROM "t"\nWHERE "x" = 1 AND "ts" >= $start'),
      ]),
    )
    expect(a).toBe(b)
  })

  test("canonicalize: different queries differ", async () => {
    const [a, b] = await withEngine((engine) =>
      Effect.all([engine.canonicalize("SELECT a FROM t"), engine.canonicalize("SELECT b FROM t")]),
    )
    expect(a).not.toBe(b)
  })

  test("canonicalize: non-SELECT/broken text — SqlParseError, not an exception", async () => {
    const error = await withEngine((engine) => Effect.flip(engine.canonicalize("SELEC oops")))
    expect(error._tag).toBe("SqlParseError")
    expect(error.message).toContain("SELEC")
  })

  test("canonicalize survives single quotes in literals", async () => {
    const canon = await withEngine((engine) => engine.canonicalize("SELECT 'o''hara' AS s FROM t"))
    expect(canon).toContain("o'hara")
  })
})
