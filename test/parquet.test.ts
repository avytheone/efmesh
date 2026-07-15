import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { fp8 } from "../src/plan/naming.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(`
    CREATE TABLE src.events AS SELECT * FROM (VALUES
      ('e1', TIMESTAMP '2026-01-01 10:00:00'),
      ('e2', TIMESTAMP '2026-01-02 11:00:00'),
      ('e3', TIMESTAMP '2026-01-03 12:00:00')
    ) t(id, happened_at)
  `)
})

describe("parquet-цель (SPEC §3.3)", () => {
  test("full: физика — файл в озере, view читает read_parquet, потребители тоже", async () => {
    const lake = mkdtempSync(join(tmpdir(), "efmesh-lake-"))
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const mart = defineModel(
          {
            name: "med.mart",
            kind: kind.full(),
            target: "parquet",
            schema: Schema.Struct({ id: Schema.String }),
          },
          (ctx) => ctx.sql`SELECT id FROM ${ctx.ref(raw)}`,
        )
        const consumer = defineModel(
          {
            name: "med.top",
            kind: kind.full(),
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT count(*)::INT AS n FROM ${ctx.ref(mart)}`,
        )

        const applied = yield* Efmesh.apply("dev", [raw, mart, consumer], { lakePath: lake })
        expect(applied.built).toEqual(["med.mart", "med.top"])

        // файл лежит в раскладке <lake>/<схема>/<таблица>/fp=<fp8>/
        const fp = applied.plan.actions.find((a) => a.name === "med.mart")!.fingerprint
        expect(existsSync(join(lake, "med", "mart", `fp=${fp8(fp)}`, "data.parquet"))).toBe(true)

        // view окружения читает озеро; потребитель посчитал из него
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.mart`)
        expect(rows).toEqual([{ n: 3 }])
        const top = yield* engine.query(`SELECT n FROM dev__med.top`)
        expect(top).toEqual([{ n: 3 }])
      }),
    )
  })

  test("incremental: интервал = партиция, resume дописывает только новые партиции", async () => {
    const lake = mkdtempSync(join(tmpdir(), "efmesh-lake-"))
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const events = defineModel(
          {
            name: "med.events",
            kind: kind.incrementalByTimeRange({
              timeColumn: "happened_at",
              start: "2026-01-01T00:00:00Z",
            }),
            target: "parquet",
            schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
          },
          (ctx) => ctx.sql`
            SELECT id, happened_at FROM ${ctx.ref(raw)}
            WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
          `,
        )
        const models = [raw, events]

        // now = 3 января: завершены интервалы 1-го и 2-го — две партиции
        const jan3 = fromIso("2026-01-03T00:00:00Z")
        const applied = yield* Efmesh.apply("dev", models, { now: jan3, lakePath: lake })
        const fp = applied.plan.actions.find((a) => a.name === "med.events")!.fingerprint
        const prefix = join(lake, "med", "events", `fp=${fp8(fp)}`)
        expect(existsSync(join(prefix, "interval=2026-01-01", "data.parquet"))).toBe(true)
        expect(existsSync(join(prefix, "interval=2026-01-02", "data.parquet"))).toBe(true)
        expect(existsSync(join(prefix, "interval=2026-01-03", "data.parquet"))).toBe(false)

        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows).toEqual([{ n: 2 }])

        // время прошло — дописалась ровно партиция 3-го января
        const jan4 = fromIso("2026-01-04T00:00:00Z")
        yield* Efmesh.apply("dev", models, { now: jan4, lakePath: lake })
        expect(existsSync(join(prefix, "interval=2026-01-03", "data.parquet"))).toBe(true)
        const rows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows2).toEqual([{ n: 3 }])
      }),
    )
  })

  test("parquet-модель без lakePath — LakeNotConfiguredError до любых действий", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        const mart = defineModel(
          {
            name: "med.mart",
            kind: kind.full(),
            target: "parquet",
            schema: Schema.Struct({ id: Schema.String }),
          },
          (ctx) => ctx.sql`SELECT id FROM ${ctx.ref(raw)}`,
        )
        const error = yield* Effect.flip(Efmesh.apply("dev", [raw, mart]))
        expect(error._tag).toBe("LakeNotConfiguredError")
      }),
    )
  })
})
