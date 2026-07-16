import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { envLockName } from "../src/plan/lock.ts"
import { run } from "../src/plan/run.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const events = defineModel(
  {
    name: "med.events",
    kind: kind.incrementalByTimeRange({ timeColumn: "happened_at", start: "2026-01-01T00:00:00Z" }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
  },
  (ctx) => ctx.sql`
    SELECT id, happened_at FROM ${ctx.ref(raw)}
    WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
  `,
)

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA src`)
  yield* engine.execute(`
    CREATE TABLE src.events AS SELECT * FROM (VALUES
      ('e1', TIMESTAMP '2026-01-01 10:00:00'),
      ('e2', TIMESTAMP '2026-01-02 11:00:00')
    ) t(id, happened_at)
  `)
})

describe("run — a scheduler tick (SPEC §7)", () => {
  test("catches up intervals of the existing version; does not apply changes", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const models = [raw, events]

        // changes (added) — run refuses, apply is needed
        const blocked = yield* Effect.flip(
          run("dev", models, { now: fromIso("2026-01-02T00:00:00Z") }),
        )
        expect(blocked._tag).toBe("RunBlockedByChangesError")

        // a human applied the plan; from then on run catches up new intervals itself
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })
        const tick = yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        expect(tick.built).toEqual(["med.events"])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows).toEqual([{ n: 2 }])

        // idempotency: with no new intervals run does nothing
        const idle = yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        expect(idle.built).toEqual([])
      }),
    )
  })

  test("a concurrent run is cut off by the lock; a stale lock is reclaimed", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const models = [raw, events]
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })

        // "another process" holds the lock — the shared env:<name>, the same one apply uses
        expect(yield* store.acquireLock(envLockName("dev"), 3_600_000)).toBe(true)
        const held = yield* Effect.flip(
          run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") }),
        )
        expect(held._tag).toBe("LockHeldError")

        // the lock went stale (a negative ttl is impossible — we emulate reclaim by releasing)
        yield* store.releaseLock(envLockName("dev"))
        const tick = yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        expect(tick.built).toEqual(["med.events"])

        // after run the lock is released
        expect(yield* store.acquireLock(envLockName("dev"), 1000)).toBe(true)
      }),
    )
  })

  test("apply under the same env lock: a concurrent apply and apply↔run are cut off (SPEC §14.6)", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const models = [raw, events]

        // "another process" mutates dev — apply does not go through
        expect(yield* store.acquireLock(envLockName("dev"), 3_600_000)).toBe(true)
        const held = yield* Effect.flip(
          Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") }),
        )
        expect(held._tag).toBe("LockHeldError")

        // a different environment — a different lock, prod applies freely
        yield* Efmesh.apply("prod", models, { now: fromIso("2026-01-02T00:00:00Z") })

        // the lock is released — apply goes through and releases the lock after itself
        yield* store.releaseLock(envLockName("dev"))
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })
        expect(yield* store.acquireLock(envLockName("dev"), 1000)).toBe(true)
      }),
    )
  })

  test("a stale lock of a crashed process is reclaimed", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        // a lock with zero ttl — goes stale instantly
        expect(yield* store.acquireLock("run:zombie", 0)).toBe(true)
        expect(yield* store.acquireLock("run:zombie", 1000)).toBe(true)
      }),
    )
  })
})
