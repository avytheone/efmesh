import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EngineAdapter, type Engine } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { withStateLock } from "../src/plan/lock.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

test("stable Layer scope closes the actual DuckDB service after use", async () => {
  const engine = await Effect.runPromise(EngineAdapter.pipe(Effect.provide(DuckDBEngineLive())))
  const exit = await Effect.runPromise(Effect.exit(engine.query("SELECT 1")))
  expect(Exit.isFailure(exit)).toBe(true)
})

test("stable transaction failure rolls back and releases the semaphore for the next transaction", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineAdapter
      yield* engine.execute("CREATE TABLE events (id INTEGER)")
      const exit = yield* Effect.exit(
        engine.transaction([
          "INSERT INTO events VALUES (1)",
          "INSERT INTO missing_table VALUES (2)",
        ]),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* engine.query("SELECT * FROM events")).toEqual([])
      yield* engine.transaction(["INSERT INTO events VALUES (3)"])
      expect(yield* engine.query("SELECT * FROM events")).toEqual([{ id: 3 }])
    }).pipe(Effect.provide(DuckDBEngineLive())),
  )
})

test("stable cancellation releases the state lease and closes the scoped engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "efmesh-effect-cancel-"))
  const path = join(root, "state.sqlite")
  const ready = await Effect.runPromise(Deferred.make<void>())
  let heldEngine: Engine | undefined
  const program = Effect.gen(function* () {
    heldEngine = yield* EngineAdapter
    yield* withStateLock("env:cancel")(
      Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
    )
  }).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive({ path }))))
  const fiber = Effect.runFork(program)
  try {
    await Effect.runPromise(Deferred.await(ready))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(heldEngine).toBeDefined()
    expect(
      Exit.isFailure(await Effect.runPromise(Effect.exit(heldEngine!.query("SELECT 1")))),
    ).toBe(true)
    const acquired = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        const acquired = yield* store.acquireLock("env:cancel", 1000)
        if (acquired) yield* store.releaseLock("env:cancel")
        return acquired
      }).pipe(Effect.provide(SqliteStateLive({ path }))),
    )
    expect(acquired).toBe(true)
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    rmSync(root, { recursive: true, force: true })
  }
})
