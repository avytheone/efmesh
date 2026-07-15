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
  test("query возвращает строки", async () => {
    const rows = await withEngine((engine) => engine.query("SELECT 42 AS answer"))
    expect(rows).toEqual([{ answer: 42 }])
  })

  test("execute + query через одно соединение", async () => {
    const rows = await withEngine((engine) =>
      Effect.gen(function* () {
        yield* engine.execute("CREATE TABLE t AS SELECT 'x' AS a")
        return yield* engine.query("SELECT a FROM t")
      }),
    )
    expect(rows).toEqual([{ a: "x" }])
  })

  test("describe отдаёт имена и типы, не выполняя запрос", async () => {
    const columns = await withEngine((engine) =>
      engine.describe("SELECT 1::INTEGER AS n, 'a' AS s"),
    )
    expect(columns).toEqual([
      { name: "n", type: "INTEGER" },
      { name: "s", type: "VARCHAR" },
    ])
  })

  test("битый SQL — EngineError с текстом запроса", async () => {
    const error = await withEngine((engine) => Effect.flip(engine.query("SELECT FROM nope")))
    expect(error._tag).toBe("EngineError")
    expect(error.sql).toContain("nope")
  })
})
