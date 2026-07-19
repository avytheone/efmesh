import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { statusToJson } from "../src/cli/json.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { run } from "../src/plan/run.ts"
import { environmentStatus } from "../src/plan/status.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

describe("engine initialization seam (#66)", () => {
  test("semantic settings are present before the first query/canonicalization", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const canon = yield* engine.canonicalize("SELECT 1")
        const rows = yield* engine.query("SELECT current_setting('threads') AS value")
        return { canon, rows }
      }).pipe(Effect.provide(DuckDBEngineLive({ init: { settings: { threads: 1 } } }))),
    )
    expect(result.canon).toContain("SELECT_NODE")
    expect(result.rows).toEqual([{ value: 1n }])
  })

  test("a failing credential cannot put its value in EngineError or serialized output", async () => {
    const secret = "super-secret-value-that-must-never-escape"
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* EngineAdapter
        }).pipe(
          Effect.provide(
            DuckDBEngineLive({
              init: {
                credentials: [
                  {
                    name: "broken",
                    type: "type_that_does_not_exist",
                    values: { SECRET: secret },
                  },
                ],
              },
            }),
          ),
        ),
      ),
    )

    const surfaces = [error.message, error.sql, String(error.cause), JSON.stringify(error)].join(
      "\n",
    )
    expect(error._tag).toBe("EngineError")
    expect(surfaces).toContain("<credential broken>")
    expect(surfaces).toContain("redacted")
    expect(surfaces).not.toContain(secret)
  })

  test("a failing credential leaves neither a journal leak nor a status --json leak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-secret-"))
    const statePath = join(dir, "state.sqlite")
    const secret = "journal-must-not-remember-this"
    try {
      const failed = await Effect.runPromise(
        Effect.flip(
          run("dev", []).pipe(
            Effect.provide(
              Layer.mergeAll(
                DuckDBEngineLive({
                  init: {
                    credentials: [
                      {
                        name: "broken",
                        type: "type_that_does_not_exist",
                        values: { SECRET: secret },
                      },
                    ],
                  },
                }),
                SqliteStateLive({ path: statePath }),
              ),
            ),
          ),
        ),
      )
      const report = await Effect.runPromise(
        environmentStatus("dev", []).pipe(Effect.provide(SqliteStateLive({ path: statePath }))),
      )
      const output = JSON.stringify(statusToJson(report))

      expect(failed.message).not.toContain(secret)
      expect(report.ticks).toEqual([])
      expect(output).not.toContain(secret)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
