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

describe("run — тик планировщика (SPEC §7)", () => {
  test("догоняет интервалы существующей версии; изменения не применяет", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const models = [raw, events]

        // изменения (added) — run отказывается, нужен apply
        const blocked = yield* Effect.flip(
          run("dev", models, { now: fromIso("2026-01-02T00:00:00Z") }),
        )
        expect(blocked._tag).toBe("RunBlockedByChangesError")

        // человек применил план; дальше run догоняет новые интервалы сам
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })
        const tick = yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        expect(tick.built).toEqual(["med.events"])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows).toEqual([{ n: 2 }])

        // идемпотентность: без новых интервалов run ничего не делает
        const idle = yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        expect(idle.built).toEqual([])
      }),
    )
  })

  test("параллельный run отсечён блокировкой; протухший лок перехватывается", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const models = [raw, events]
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })

        // «другой процесс» держит лок — общий env:<имя>, тот же, что у apply
        expect(yield* store.acquireLock(envLockName("dev"), 3_600_000)).toBe(true)
        const held = yield* Effect.flip(
          run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") }),
        )
        expect(held._tag).toBe("LockHeldError")

        // лок протух (ttl отрицательный не сделать — эмулируем перехват освобождением)
        yield* store.releaseLock(envLockName("dev"))
        const tick = yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        expect(tick.built).toEqual(["med.events"])

        // после run лок освобождён
        expect(yield* store.acquireLock(envLockName("dev"), 1000)).toBe(true)
      }),
    )
  })

  test("apply под тем же env-локом: параллельный apply и apply↔run отсекаются (SPEC §14.6)", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const models = [raw, events]

        // «другой процесс» мутирует dev — apply не проходит
        expect(yield* store.acquireLock(envLockName("dev"), 3_600_000)).toBe(true)
        const held = yield* Effect.flip(
          Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") }),
        )
        expect(held._tag).toBe("LockHeldError")

        // другое окружение — другой лок, prod применяется свободно
        yield* Efmesh.apply("prod", models, { now: fromIso("2026-01-02T00:00:00Z") })

        // лок отпущен — apply проходит и освобождает лок за собой
        yield* store.releaseLock(envLockName("dev"))
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })
        expect(yield* store.acquireLock(envLockName("dev"), 1000)).toBe(true)
      }),
    )
  })

  test("протухший лок упавшего процесса перехватывается", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        // лок с нулевым ttl — протухает мгновенно
        expect(yield* store.acquireLock("run:zombie", 0)).toBe(true)
        expect(yield* store.acquireLock("run:zombie", 1000)).toBe(true)
      }),
    )
  })
})
