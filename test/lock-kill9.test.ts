import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { run } from "../src/plan/run.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

/**
 * #7: перехват протухшего лока под НАСТОЯЩИЙ kill -9 — не юнит-эмуляция.
 * Чужой bun-процесс берёт env-лок через file-based стор и убивается
 * SIGKILL: освобождения не будет никогда, только ttl. Проверяем обе
 * стороны: пока лок жив — LockHeldError, после протухания — run
 * перехватывает и работает.
 */

// директория ВНУТРИ репо: дочерний процесс импортирует src (резолв effect)
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

describe("лок под kill -9 (#7)", () => {
  test("убитый процесс не оставляет вечный замок: ttl перехватывается живым run", async () => {
    // бутстрап окружения обычным apply
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

    // чужой процесс берёт env:dev с ttl 900 мс и виснет
    const TTL = 900
    const holder = Bun.spawn(
      ["bun", join(import.meta.dir, "helpers", "lock-holder.ts"), storePath, "env:dev", String(TTL)],
      { stdout: "pipe", stderr: "inherit" },
    )
    const reader = holder.stdout.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first.trim()).toBe("LOCKED")
    const grabbedAt = Date.now()

    holder.kill(9) // SIGKILL: ни finally, ни releaseLock не выполнятся
    await holder.exited
    expect(holder.signalCode).toBe("SIGKILL")

    // лок мёртвого процесса ещё жив по ttl — честный LockHeldError
    const held = await scenario(
      Effect.flip(run("dev", [raw, events], { now: fromIso("2026-01-03T00:00:00Z") })),
    )
    expect(held._tag).toBe("LockHeldError")

    // после протухания run перехватывает лок и работает
    await Bun.sleep(Math.max(0, grabbedAt + TTL - Date.now()) + 100)
    const tick = await scenario(
      run("dev", [raw, events], { now: fromIso("2026-01-03T00:00:00Z") }),
    )
    expect(tick.built).toEqual(["med.events"])

    // и освобождает за собой: следующий захват мгновенный
    const reclaimed = await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        return yield* store.acquireLock("env:dev", 1000)
      }),
    )
    expect(reclaimed).toBe(true)
  }, 15000)
})
