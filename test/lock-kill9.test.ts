import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Duration, Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { withStateLock } from "../src/plan/lock.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { run } from "../src/plan/run.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

/**
 * #7: reclaiming a stale lock under a REAL kill -9 — not a unit emulation.
 * Another bun process takes the env lock via the file-based store and is
 * killed with SIGKILL: there will never be a release, only ttl. We check both
 * sides: while the lock is alive — LockHeldError, after it goes stale — run
 * reclaims it and works.
 */

// a directory INSIDE the repo: the child process imports src (effect resolution)
const dir = mkdtempSync(join(import.meta.dir, "..", "efmesh-kill9-test-"))
const storePath = join(dir, "state.sqlite")

afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

const layer = Layer.mergeAll(
  DuckDBEngineLive({ path: join(dir, "engine.duckdb") }),
  SqliteStateLive({ path: storePath }),
)

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(layer)))

describe("lock under kill -9 (#7)", () => {
  test("a killed process leaves no eternal lock: the ttl is reclaimed by a live run", async () => {
    // bootstrap the environment with a normal apply
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(
          `CREATE TABLE IF NOT EXISTS src.events AS SELECT 'e1' AS id, TIMESTAMP '2026-01-01 10:00:00' AS happened_at`,
        )
        yield* Efmesh.apply("dev", [raw, events], { now: fromIso("2026-01-02T00:00:00Z") })
      }),
    )

    // another process takes env:dev with a 900 ms ttl and hangs
    const TTL = 900
    const holder = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "helpers", "lock-holder.ts"),
        storePath,
        "env:dev",
        String(TTL),
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    const reader = holder.stdout.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first.trim()).toBe("LOCKED")
    const grabbedAt = Date.now()

    holder.kill(9) // SIGKILL: neither finally nor releaseLock will run
    await holder.exited
    expect(holder.signalCode).toBe("SIGKILL")

    // the dead process's lock is still alive by ttl — an honest LockHeldError
    const held = await scenario(
      Effect.flip(run("dev", [raw, events], { now: fromIso("2026-01-03T00:00:00Z") })),
    )
    expect(held._tag).toBe("LockHeldError")

    // after it goes stale run reclaims the lock and works
    await Bun.sleep(Math.max(0, grabbedAt + TTL - Date.now()) + 100)
    const tick = await scenario(run("dev", [raw, events], { now: fromIso("2026-01-03T00:00:00Z") }))
    expect(tick.built).toEqual(["med.events"])

    // and releases it after itself: the next acquire is instant
    const reclaimed = await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        return yield* store.acquireLock("env:dev", 1000)
      }),
    )
    expect(reclaimed).toBe(true)
  }, 15000)
})

/**
 * #18: the fixed-ttl lock let a backfill outliving the ttl be reclaimed while
 * still writing — two writers on one env, the one data-corruption path. The
 * heartbeat renews the lease under a live holder; a SIGKILLed holder stops
 * heart­beating, so ttl still reclaims it. Both halves are checked here, plus
 * the loud abort when a holder's own renewal is lost.
 */
describe("lock heartbeat (#18)", () => {
  const acquireOn = (path: string, name: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        return yield* store.acquireLock(name, 1000)
      }).pipe(Effect.provide(SqliteStateLive({ path }))),
    )

  test("a live holder with heartbeat is NOT reclaimed past the ttl; a SIGKILLed one IS", async () => {
    const hbStore = join(dir, "heartbeat.sqlite")
    // ttl 600ms, heartbeat every ~200ms — the lease is renewed 3x per ttl
    const TTL = 600
    const holder = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "helpers", "lock-holder-heartbeat.ts"),
        hbStore,
        "env:hb",
        String(TTL),
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    const reader = holder.stdout.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first.trim()).toBe("LOCKED")

    // well past the raw ttl: a fixed-ttl lock would be stale and reclaimable by
    // now — the heartbeat keeps it held, so an acquire from elsewhere fails
    await Bun.sleep(TTL * 2.5)
    expect(await acquireOn(hbStore, "env:hb")).toBe(false)

    // SIGKILL stops the heartbeat; after one ttl the lease lapses and is reclaimed
    holder.kill(9)
    await holder.exited
    expect(holder.signalCode).toBe("SIGKILL")
    await Bun.sleep(TTL + 200)
    expect(await acquireOn(hbStore, "env:hb")).toBe(true)
  }, 15000)

  test("a holder whose renewal is lost aborts loudly with LockLostError", async () => {
    const lostStore = join(dir, "lost.sqlite")
    const outcome = await Effect.runPromise(
      Effect.flip(
        withStateLock(
          "env:lost",
          300, // heartbeat every ~100ms
        )(
          Effect.gen(function* () {
            const store = yield* StateStore
            // simulate another process reclaiming the (assumed-stale) lock: our
            // row is replaced by a fresh lease with a different expiry, so the
            // fenced heartbeat can no longer renew — it must fail, not clobber it
            yield* Effect.sleep(Duration.millis(30))
            yield* store.releaseLock("env:lost")
            yield* store.acquireLock("env:lost", 60_000)
            // stay alive long enough for the next heartbeat beat to notice
            yield* Effect.sleep(Duration.millis(400))
          }),
        ).pipe(Effect.provide(SqliteStateLive({ path: lostStore }))),
      ),
    )
    expect(outcome._tag).toBe("LockLostError")

    // the reclaimer's lease survived: the aborted holder's fenced release was a
    // no-op, so the lock is still held (acquire from elsewhere fails)
    expect(await acquireOn(lostStore, "env:lost")).toBe(false)
  }, 15000)
})
