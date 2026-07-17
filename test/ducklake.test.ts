import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { janitor } from "../src/plan/janitor.ts"
import { ducklakeAlias } from "../src/plan/naming.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
  )

const freshDucklake = () => {
  const dir = mkdtempSync(join(tmpdir(), "efmesh-ducklake-"))
  return { catalog: join(dir, "catalog.sqlite"), dataPath: join(dir, "data") }
}

/** Tables physically living in the DuckLake catalog. */
const lakeTables = (engine: {
  readonly query: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
}) =>
  engine
    .query(`SELECT table_name FROM duckdb_tables() WHERE database_name = '${ducklakeAlias}'`)
    .pipe(Effect.map((rows) => rows.map((row) => String(row["table_name"]))))

describe("target: ducklake (SPEC §14.5)", () => {
  test("full: physical table in the catalog, view on top, no table in _efmesh", async () => {
    const ducklake = freshDucklake()
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const totals = defineModel(
          {
            name: "med.totals",
            kind: kind.full(),
            target: "ducklake",
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT 42 AS n`,
        )
        const applied = yield* Efmesh.apply("dev", [totals], { ducklake })
        expect(applied.built).toEqual(["med.totals"])
        expect(yield* engine.query(`SELECT n FROM dev__med.totals`)).toEqual([{ n: 42 }])
        expect(yield* lakeTables(engine)).toEqual([expect.stringMatching(/^med__totals__/)])
        // this model has no native physical table
        const native = yield* engine.query(
          `SELECT table_name FROM duckdb_tables() WHERE schema_name = '_efmesh'`,
        )
        expect(native).toEqual([])
      }),
    )
  })

  test("incremental model: DELETE+INSERT backfill works in the catalog", async () => {
    const ducklake = freshDucklake()
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA src`)
        yield* engine.execute(`
          CREATE TABLE src.events AS SELECT * FROM (VALUES
            ('e1', TIMESTAMP '2026-01-01 10:00:00'),
            ('e2', TIMESTAMP '2026-01-02 11:00:00')
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
              batchSize: 1,
            }),
            target: "ducklake",
            schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
          },
          (ctx) => ctx.sql`
            SELECT id, happened_at FROM ${ctx.ref(raw)}
            WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
          `,
        )
        const jan3 = fromIso("2026-01-03T00:00:00Z")
        yield* Efmesh.apply("dev", [raw, events], { ducklake, now: jan3 })
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows).toEqual([{ n: 2 }])
        // idempotency: intervals are done, the second apply does nothing
        const again = yield* Efmesh.apply("dev", [raw, events], { ducklake, now: jan3 })
        expect(again.plan.hasChanges).toBe(false)
      }),
    )
  })

  test("without a catalog config — DucklakeNotConfiguredError before any actions", async () => {
    await scenario(
      Effect.gen(function* () {
        const totals = defineModel(
          {
            name: "med.totals",
            kind: kind.full(),
            target: "ducklake",
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT 1 AS n`,
        )
        const error = yield* Effect.flip(Efmesh.apply("dev", [totals]))
        expect(error._tag).toBe("DucklakeNotConfiguredError")
      }),
    )
  })

  test("janitor removes an orphaned table from the catalog", async () => {
    const ducklake = freshDucklake()
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const v1 = defineModel(
          {
            name: "med.totals",
            kind: kind.full(),
            target: "ducklake",
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT 1 AS n`,
        )
        const v2 = defineModel(
          {
            name: "med.totals",
            kind: kind.full(),
            target: "ducklake",
            schema: Schema.Struct({ n: Schema.Number }),
          },
          (ctx) => ctx.sql`SELECT 2 AS n`,
        )
        yield* Efmesh.apply("dev", [v1], { ducklake, now: fromIso("2026-01-01T00:00:00Z") })
        yield* Efmesh.apply("dev", [v2], { ducklake, now: fromIso("2026-01-02T00:00:00Z") })
        expect((yield* lakeTables(engine)).length).toBe(2)
        const report = yield* janitor({ ttlDays: 0, ducklake })
        expect(report.removed).toEqual([expect.stringMatching(/^med\.totals@/)])
        expect((yield* lakeTables(engine)).length).toBe(1)
        expect(yield* engine.query(`SELECT n FROM dev__med.totals`)).toEqual([{ n: 2 }])
      }),
    )
  })
})
