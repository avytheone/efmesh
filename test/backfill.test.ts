import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
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

const makeDaily = (lookback = 0) =>
  defineModel(
    {
      name: "med.events",
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        batchSize: 2,
        lookback,
      }),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
    },
    (ctx) => ctx.sql`
      SELECT id, happened_at FROM ${ctx.ref(raw)}
      WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
    `,
  )

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(`
    CREATE TABLE src.events AS SELECT * FROM (VALUES
      ('e1', TIMESTAMP '2026-01-01 10:00:00'),
      ('e2', TIMESTAMP '2026-01-02 11:00:00'),
      ('e3', TIMESTAMP '2026-01-03 12:00:00'),
      ('e4', TIMESTAMP '2026-01-05 09:00:00'),
      ('e5', TIMESTAMP '2026-01-06 23:00:00')
    ) t(id, happened_at)
  `)
})

const countRows = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
  return (rows[0] as { n: number }).n
})

describe("бэкфилл incrementalByTimeRange (SPEC §5.3)", () => {
  test("полный бэкфилл → идемпотентность → догон новых интервалов", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const daily = makeDaily()
        const models = [raw, daily]

        // now = 4 января: завершены интервалы 1..3
        const jan4 = fromIso("2026-01-04T00:00:00Z")
        const plan1 = yield* Efmesh.plan("dev", models, { now: jan4 })
        const action = plan1.actions.find((a) => a.name === "med.events")!
        expect(action.backfill).toEqual([
          { start: fromIso("2026-01-01T00:00:00Z"), end: jan4 },
        ])

        const applied1 = yield* Efmesh.apply("dev", models, { now: jan4 })
        expect(applied1.built).toEqual(["med.events"])
        expect(yield* countRows).toBe(3) // e1..e3; e4/e5 ещё в будущем

        // учёт: 3 done-интервала (батчами по 2)
        const ledger = yield* store.listIntervals(action.fingerprint)
        expect(ledger.filter((i) => i.status === "done")).toHaveLength(3)

        // повторный apply тем же now: дыр нет, работы нет, дублей нет
        const applied2 = yield* Efmesh.apply("dev", models, { now: jan4 })
        expect(applied2.plan.hasChanges).toBe(false)
        expect(applied2.built).toEqual([])
        expect(yield* countRows).toBe(3)

        // время прошло: now = 7 января → досчитываются ровно интервалы 4..6
        const jan7 = fromIso("2026-01-07T00:00:00Z")
        const plan3 = yield* Efmesh.plan("dev", models, { now: jan7 })
        const action3 = plan3.actions.find((a) => a.name === "med.events")!
        expect(action3.change).toBe("unchanged") // модель не менялась — только дыры
        expect(action3.backfill).toEqual([
          { start: jan4, end: fromIso("2026-01-07T00:00:00Z") },
        ])
        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countRows).toBe(5)
      }),
    )
  })

  test("resume: failed-интервал пересчитывается без дублей, остальные не трогаются", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        const daily = makeDaily()
        const models = [raw, daily]
        const jan7 = fromIso("2026-01-07T00:00:00Z")

        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countRows).toBe(5)

        // имитация упавшего батча: 5 января помечено failed (данные при этом лежат)
        const plan = yield* Efmesh.plan("dev", models, { now: jan7 })
        const fp = plan.actions.find((a) => a.name === "med.events")!.fingerprint
        yield* store.markIntervals(
          fp,
          [{ startTs: "2026-01-05T00:00:00.000Z", endTs: "2026-01-06T00:00:00.000Z" }],
          "failed",
        )

        // план видит ровно эту дыру
        const planResume = yield* Efmesh.plan("dev", models, { now: jan7 })
        const actionResume = planResume.actions.find((a) => a.name === "med.events")!
        expect(actionResume.backfill).toEqual([
          { start: fromIso("2026-01-05T00:00:00Z"), end: fromIso("2026-01-06T00:00:00Z") },
        ])

        // пересчёт: DELETE+INSERT интервала — строк по-прежнему 5, дублей нет
        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countRows).toBe(5)
        const ledger = yield* store.listIntervals(fp)
        expect(ledger.every((i) => i.status === "done")).toBe(true)
      }),
    )
  })

  test("lookback: последний done-интервал перечитывается — поздние данные подъезжают", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const daily = makeDaily(1)
        const models = [raw, daily]
        const jan7 = fromIso("2026-01-07T00:00:00Z")

        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countRows).toBe(5)

        // задним числом приехала строка за 6 января
        yield* engine.execute(
          `INSERT INTO src.events VALUES ('e6', TIMESTAMP '2026-01-06 07:00:00')`,
        )

        // без изменений модели план всё равно перечитывает хвост
        const plan = yield* Efmesh.plan("dev", models, { now: jan7 })
        const action = plan.actions.find((a) => a.name === "med.events")!
        expect(action.backfill).toEqual([
          { start: fromIso("2026-01-06T00:00:00Z"), end: jan7 },
        ])
        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countRows).toBe(6)
      }),
    )
  })
})
