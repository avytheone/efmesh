import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { audit } from "../src/core/audit.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

describe("аудиты (SPEC §8)", () => {
  test("blocking notNull: провал роняет apply, view не промоутится", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const bad = defineModel(
          {
            name: "med.dirty",
            kind: kind.full(),
            schema: Schema.Struct({ id: Schema.NullOr(Schema.String) }),
            audits: [audit.notNull("id")],
          },
          (ctx) => ctx.sql`SELECT * FROM (VALUES ('a'), (NULL)) t(id)`,
        )
        const error = yield* Effect.flip(Efmesh.apply("dev", [bad]))
        expect(error._tag).toBe("AuditFailure")
        const failure = error as { audit: string; violations: number }
        expect(failure.audit).toBe("not_null(id)")
        expect(failure.violations).toBe(1)
        // view-слой не появился
        const missing = yield* Effect.flip(engine.query(`SELECT * FROM dev__med.dirty`))
        expect(missing._tag).toBe("EngineError")
      }),
    )
  })

  test("unique и accepted: чистые данные проходят", async () => {
    await scenario(
      Effect.gen(function* () {
        const clean = defineModel(
          {
            name: "med.clean",
            kind: kind.full(),
            schema: Schema.Struct({ id: Schema.String, dept: Schema.String }),
            audits: [
              audit.notNull("id"),
              audit.unique("id"),
              audit.accepted("dept", ["ОРИТ", "терапия"]),
            ],
          },
          (ctx) => ctx.sql`SELECT * FROM (VALUES ('a','ОРИТ'), ('b','терапия')) t(id, dept)`,
        )
        const applied = yield* Efmesh.apply("dev", [clean])
        expect(applied.built).toEqual(["med.clean"])
      }),
    )
  })

  test("warn-аудит: нарушения логируются, конвейер едет", async () => {
    await scenario(
      Effect.gen(function* () {
        const warned = defineModel(
          {
            name: "med.warned",
            kind: kind.full(),
            schema: Schema.Struct({ dept: Schema.String }),
            audits: [audit.warn(audit.accepted("dept", ["ОРИТ"]))],
          },
          (ctx) => ctx.sql`SELECT 'морг' AS dept`,
        )
        const applied = yield* Efmesh.apply("dev", [warned])
        expect(applied.built).toEqual(["med.warned"])
      }),
    )
  })

  test("incremental: провальный интервал помечается failed и не считается done", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        yield* engine.execute(`CREATE SCHEMA src`)
        yield* engine.execute(`
          CREATE TABLE src.events AS SELECT * FROM (VALUES
            ('e1', TIMESTAMP '2026-01-01 10:00:00'),
            (NULL, TIMESTAMP '2026-01-02 11:00:00')
          ) t(id, happened_at)
        `)
        const raw = defineExternal({
          name: "src.events",
          source: external.table("src.events"),
          schema: Schema.Struct({
            id: Schema.NullOr(Schema.String),
            happened_at: Schema.DateTimeUtc,
          }),
        })
        const events = defineModel(
          {
            name: "med.events",
            kind: kind.incrementalByTimeRange({
              timeColumn: "happened_at",
              start: "2026-01-01T00:00:00Z",
              batchSize: 1,
            }),
            schema: Schema.Struct({
              id: Schema.NullOr(Schema.String),
              happened_at: Schema.DateTimeUtc,
            }),
            audits: [audit.custom("нет NULL id", (a) => a.sql`
              SELECT * FROM ${a.self} WHERE id IS NULL
            `)],
          },
          (ctx) => ctx.sql`
            SELECT id, happened_at FROM ${ctx.ref(raw)}
            WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
          `,
        )
        const jan3 = fromIso("2026-01-03T00:00:00Z")
        const error = yield* Effect.flip(Efmesh.apply("dev", [raw, events], { now: jan3 }))
        expect(error._tag).toBe("AuditFailure")

        // 1 января прошло аудит и done; 2 января — failed
        const plan = yield* Efmesh.plan("dev", [raw, events], { now: jan3 })
        const fp = plan.actions.find((a) => a.name === "med.events")!.fingerprint
        const ledger = yield* store.listIntervals(fp)
        expect(ledger.map((i) => [i.startTs.slice(0, 10), i.status])).toEqual([
          ["2026-01-01", "done"],
          ["2026-01-02", "failed"],
        ])
      }),
    )
  })
})
