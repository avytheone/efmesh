import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { run } from "../src/plan/run.ts"
import { environmentStatus } from "../src/plan/status.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore, STATE_VERSION } from "../src/state/store.ts"

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
  yield* engine.execute(
    `CREATE TABLE src.events AS SELECT 'e1' AS id, TIMESTAMP '2026-01-01 10:00:00' AS happened_at`,
  )
})

describe("efmesh status + журнал тиков (#1, #2)", () => {
  test("несуществующее окружение — models: 0, без ошибок", async () => {
    const report = await scenario(environmentStatus("dev", [raw, events]))
    expect(report.models).toBe(0)
    expect(report.promotedAt).toBeNull()
    expect(report.lastPlan).toBeNull()
  })

  test("журнал: ok-тик с собранными моделями; awaiting-human при изменениях", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const models = [raw, events]

        // изменения не применены — run отказывается И журналирует awaiting-human
        yield* Effect.flip(run("dev", models, { now: fromIso("2026-01-02T00:00:00Z") }))
        let ticks = yield* store.listRuns("dev", 10)
        expect(ticks.map((t) => t.outcome)).toEqual(["awaiting-human"])
        expect(ticks[0]!.detail).toContain("med.events: added")

        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })
        yield* run("dev", models, { now: fromIso("2026-01-03T00:00:00Z") })
        ticks = yield* store.listRuns("dev", 10)
        // свежие первыми
        expect(ticks.map((t) => t.outcome)).toEqual(["ok", "awaiting-human"])
        expect(JSON.parse(ticks[0]!.detail)).toEqual(["med.events"])
        expect(ticks[0]!.finishedAt >= ticks[0]!.startedAt).toBe(true)
      }),
    )
  })

  test("status: отставание, догнанность и последний план", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        const models = [raw, events]
        yield* Efmesh.apply("dev", models, { now: fromIso("2026-01-02T00:00:00Z") })

        // «сейчас» уехало на 3 дня вперёд — модель отстаёт на 2 суточных интервала
        const behind = yield* environmentStatus("dev", models, {
          now: fromIso("2026-01-04T00:00:00Z"),
        })
        expect(behind.models).toBe(2)
        expect(behind.storeVersion).toBe(STATE_VERSION)
        expect(behind.lastPlan?.appliedAt).toBeDefined()
        expect(behind.lag).toEqual([
          {
            model: "med.events",
            doneUpTo: "2026-01-02T00:00:00.000Z",
            missing: 2,
            failed: 0,
          },
        ])

        // run догнал — отставание нулевое, тик в отчёте
        yield* run("dev", models, { now: fromIso("2026-01-04T00:00:00Z") })
        const caught = yield* environmentStatus("dev", models, {
          now: fromIso("2026-01-04T00:00:00Z"),
        })
        expect(caught.lag[0]!.missing).toBe(0)
        expect(caught.ticks[0]!.outcome).toBe("ok")
      }),
    )
  })
})
