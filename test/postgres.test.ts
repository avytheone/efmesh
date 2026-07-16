import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, defineSeed, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { PostgresEngineLive } from "../src/engine/postgres.ts"
import { PostgresStateLive } from "../src/state/postgres.ts"
import { StateStore } from "../src/state/store.ts"
import { hasPostgres, startCluster, type TestCluster } from "./helpers/pg-cluster.ts"

let cluster: TestCluster

beforeAll(async () => {
  if (!hasPostgres) return
  cluster = await startCluster()
})

afterAll(() => {
  cluster?.stop()
})

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(
        Layer.mergeAll(
          PostgresEngineLive({ url: cluster.url }),
          PostgresStateLive({ url: cluster.url }),
        ),
      ),
    ),
  )

describe.skipIf(!hasPostgres)("Postgres-адаптер (SPEC §9.1, F3)", () => {
  test("state store: снапшоты, promote с учётом сиротства, интервалы, лок с ttl", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        const base = {
          name: "med.a",
          renderedSql: "SELECT 1",
          canonicalAst: "{}",
          kind: "full",
        }
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" }) // идемпотентно
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        expect((yield* store.getSnapshot("med.a", "f1"))?.orphanedAt).toBeNull()

        yield* store.upsertSnapshot({ ...base, fingerprint: "f2", physicalFp: "f2" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f2" }])
        expect((yield* store.getSnapshot("med.a", "f1"))?.orphanedAt).toMatch(/^\d{4}-/)
        expect(yield* store.listReferencedFingerprints()).toEqual(new Set(["f2"]))

        const jan1 = { startTs: "2026-01-01T00:00:00Z", endTs: "2026-01-02T00:00:00Z" }
        yield* store.markIntervals("f2", [jan1], "failed")
        yield* store.markIntervals("f2", [jan1], "done")
        const ledger = yield* store.listIntervals("f2")
        expect(ledger.map((i) => [i.startTs, i.status])).toEqual([
          ["2026-01-01T00:00:00Z", "done"],
        ])

        expect(yield* store.acquireLock("run:dev", 60_000)).toBe(true)
        expect(yield* store.acquireLock("run:dev", 60_000)).toBe(false)
        yield* store.releaseLock("run:dev")
        expect(yield* store.acquireLock("run:dev", 0)).toBe(true)
        // ttl=0: протухший лок перехватывается сразу
        expect(yield* store.acquireLock("run:dev", 60_000)).toBe(true)
        yield* store.releaseLock("run:dev")
      }),
    )
  })

  test("canonicalize: libpg_query, формат-инвариантность и ошибка парсинга", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const a = yield* engine.canonicalize(`SELECT a, b FROM t WHERE x >= $start AND x < $end`)
        const b = yield* engine.canonicalize(
          `select   a,\n       b\nfrom t\nwhere x >= $start and x < $end`,
        )
        expect(a).toBe(b)
        const c = yield* engine.canonicalize(`SELECT a FROM t`)
        expect(c).not.toBe(a)

        const failure = yield* Effect.flip(engine.canonicalize(`SELECT FROM WHERE`))
        expect(failure._tag).toBe("SqlParseError")
      }),
    )
  })

  test("describe: имена и типы без выполнения запроса", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const columns = yield* engine.describe(
          `SELECT 'x'::TEXT AS name, 1::INT AS n, now()::TIMESTAMP AS ts`,
        )
        expect(columns.map((c) => c.name)).toEqual(["name", "n", "ts"])
        expect(columns[1]!.type).toContain("int")
        expect(columns[2]!.type).toContain("timestamp")
      }),
    )
  })

  test("e2e: full + view + инкрементальный бэкфилл с параллельными батчами", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(`
          CREATE TABLE src.events AS SELECT * FROM (VALUES
            ('e1', TIMESTAMP '2026-01-01 10:00:00'),
            ('e2', TIMESTAMP '2026-01-02 11:00:00'),
            ('e3', TIMESTAMP '2026-01-03 12:00:00'),
            ('e4', TIMESTAMP '2026-01-04 09:00:00'),
            ('e5', TIMESTAMP '2026-01-05 23:00:00'),
            ('e6', TIMESTAMP '2026-01-06 07:00:00')
          ) t(id, happened_at)
        `)
        const raw = defineExternal({
          name: "src.events",
          source: external.table("src.events"),
          schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
        })
        const events = defineModel(
          {
            name: "med.events",
            kind: kind.incrementalByTimeRange({
              timeColumn: "happened_at",
              start: "2026-01-01T00:00:00Z",
              batchSize: 1, // каждый день — свой батч и своя транзакция
            }),
            schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
          },
          (ctx) => ctx.sql`
            SELECT id, happened_at FROM ${ctx.ref(raw)}
            WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
          `,
        )
        const daily = defineModel(
          {
            name: "med.daily",
            kind: kind.full(),
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT count(*)::INT AS n FROM ${ctx.ref(events)}`,
        )
        const load = defineModel(
          {
            name: "med.load",
            kind: kind.view(),
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT n FROM ${ctx.ref(daily)}`,
        )
        const models = [raw, events, daily, load]
        const jan7 = fromIso("2026-01-07T00:00:00Z")

        // 6 однодневных батчей, конкурентность 4 — пул соединений
        const applied = yield* Efmesh.apply("dev", models, { now: jan7, concurrency: 4 })
        expect(applied.built).toEqual(["med.events", "med.daily", "med.load"])
        const rows = yield* engine.query(`SELECT n FROM dev__med.load`)
        expect(rows).toEqual([{ n: 6 }])

        // идемпотентность
        const again = yield* Efmesh.apply("dev", models, { now: jan7, concurrency: 4 })
        expect(again.plan.hasChanges).toBe(false)

        // promote в prod — родные схемы, без пересчёта
        yield* Efmesh.apply("prod", models, { now: jan7 })
        const prod = yield* engine.query(`SELECT n FROM med.load`)
        expect(prod).toEqual([{ n: 6 }])
      }),
    )
  })

  test("e2e: upsert по ключу и scdType2 на Postgres", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src2`)
        yield* engine.execute(
          `CREATE TABLE src2.depts AS SELECT * FROM (VALUES ('icu', 'Иванов')) t(id, head)`,
        )
        const raw = defineExternal({
          name: "src2.depts",
          source: external.table("src2.depts"),
          schema: Schema.Struct({ id: Schema.String, head: Schema.String }),
        })
        const latest = defineModel(
          {
            name: "med2.latest",
            kind: kind.incrementalByUniqueKey({ key: ["id"] }),
            schema: Schema.Struct({ id: Schema.String, head: Schema.String }),
          },
          (ctx) => ctx.sql`SELECT id, head FROM ${ctx.ref(raw)}`,
        )
        const dim = defineModel(
          {
            name: "med2.dim",
            kind: kind.scdType2({ key: ["id"] }),
            schema: Schema.Struct({
              id: Schema.String,
              head: Schema.String,
              valid_from: Schema.NullOr(Schema.DateTimeUtc),
              valid_to: Schema.NullOr(Schema.DateTimeUtc),
            }),
          },
          (ctx) => ctx.sql`SELECT id, head FROM ${ctx.ref(raw)}`,
        )
        const models = [raw, latest, dim]
        const t1 = fromIso("2026-02-01T00:00:00Z")
        const t2 = fromIso("2026-02-02T00:00:00Z")

        yield* Efmesh.apply("dev", models, { now: t1 })
        yield* engine.execute(`UPDATE src2.depts SET head = 'Сидоров' WHERE id = 'icu'`)
        yield* Efmesh.apply("dev", models, { now: t2 })

        const upserted = yield* engine.query(`SELECT head FROM dev__med2.latest`)
        expect(upserted).toEqual([{ head: "Сидоров" }])
        const history = yield* engine.query(`
          SELECT head, CAST(valid_to AS VARCHAR) AS t
          FROM dev__med2.dim ORDER BY valid_from
        `)
        expect(history).toEqual([
          { head: "Иванов", t: "2026-02-02 00:00:00" },
          { head: "Сидоров", t: null },
        ])
      }),
    )
  })

  test("DuckDB-федерация на Postgres — честная EngineFeatureError", async () => {
    await scenario(
      Effect.gen(function* () {
        const departments = defineSeed({
          name: "ref2.departments",
          file: "examples/hospital/departments.csv",
          schema: Schema.Struct({ dept: Schema.String, floor: Schema.Number }),
        })
        const failure = yield* Effect.flip(Efmesh.apply("dev", [departments]))
        expect(failure._tag).toBe("EngineFeatureError")
      }),
    )
  })
})
