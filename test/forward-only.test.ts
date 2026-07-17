import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { fp8 } from "../src/plan/naming.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({
    id: Schema.String,
    happened_at: Schema.DateTimeUtc,
    amount: Schema.Number,
  }),
})

/** v1 — no amount; v2 — with amount (column added); v3 — WITHOUT id (dropped). */
const makeEvents = (version: 1 | 2 | 3): AnyModel =>
  defineModel(
    {
      name: "med.events",
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
      }),
      schema:
        version === 1
          ? Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc })
          : version === 2
            ? Schema.Struct({
                id: Schema.String,
                happened_at: Schema.DateTimeUtc,
                amount: Schema.NullOr(Schema.Number),
              })
            : Schema.Struct({ happened_at: Schema.DateTimeUtc }),
    },
    (ctx) =>
      version === 1
        ? ctx.sql`
            SELECT id, happened_at FROM ${ctx.ref(raw)}
            WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
          `
        : version === 2
          ? ctx.sql`
              SELECT id, happened_at, amount FROM ${ctx.ref(raw)}
              WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
            `
          : ctx.sql`
              SELECT happened_at FROM ${ctx.ref(raw)}
              WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
            `,
  )

/** Incremental child with its own unchanged AST — a cascade candidate. */
const makeChild = (parent: AnyModel): AnyModel =>
  defineModel(
    {
      name: "med.daily",
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
      }),
      schema: Schema.Struct({ happened_at: Schema.DateTimeUtc, n: Schema.Number }),
    },
    (ctx) => ctx.sql`
      SELECT happened_at, count(*)::INT AS n FROM ${ctx.ref(parent)}
      WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
      GROUP BY happened_at
    `,
  )

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(`
    CREATE TABLE src.events AS SELECT * FROM (VALUES
      ('e1', TIMESTAMP '2026-01-01 10:00:00', 10.0::DOUBLE),
      ('e2', TIMESTAMP '2026-01-02 11:00:00', 20.0::DOUBLE),
      ('e3', TIMESTAMP '2026-01-03 12:00:00', 30.0::DOUBLE)
    ) t(id, happened_at, amount)
  `)
})

describe("forward-only (SPEC §5.2)", () => {
  test("physical table and done intervals are reused, history is not replayed", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        yield* seedSource

        // v1: two days of history
        const jan3 = fromIso("2026-01-03T00:00:00Z")
        yield* Efmesh.apply("dev", [raw, makeEvents(1)], { now: jan3 })
        const planV1 = yield* Efmesh.plan("dev", [raw, makeEvents(1)], { now: jan3 })
        const fpV1 = planV1.actions.find((a) => a.name === "med.events")!.fingerprint

        // v2 adds a column; forward-only: same physical table, backfill only the new day
        const jan4 = fromIso("2026-01-04T00:00:00Z")
        const models2 = [raw, makeEvents(2)]
        const plan2 = yield* Efmesh.plan("dev", models2, {
          now: jan4,
          forwardOnly: ["med.events"],
        })
        const action2 = plan2.actions.find((a) => a.name === "med.events")!
        expect(action2.change).toBe("forward-only")
        expect(action2.physicalFingerprint).toBe(fpV1)
        expect(action2.reusedFrom).toBe(fpV1)
        expect(action2.backfill).toEqual([{ start: jan3, end: jan4 }])

        yield* Efmesh.apply("dev", models2, { now: jan4, forwardOnly: ["med.events"] })

        // same physical table: history with NULL, new day with a value
        const table = `"_efmesh"."med__events__${fp8(fpV1)}"`
        const rows = yield* engine.query(`SELECT id, amount FROM ${table} ORDER BY happened_at`)
        expect(rows).toEqual([
          { id: "e1", amount: null },
          { id: "e2", amount: null },
          { id: "e3", amount: 30 },
        ])

        // done intervals of the old version are inherited by the new one
        const ledger = yield* store.listIntervals(action2.fingerprint)
        expect(ledger.filter((i) => i.status === "done")).toHaveLength(3)

        // the environment view points at the same physical table and sees the new column
        const viaView = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(viaView).toEqual([{ n: 3 }])

        // a repeated plan is already unchanged
        const planAgain = yield* Efmesh.plan("dev", models2, { now: jan4 })
        expect(planAgain.actions.find((a) => a.name === "med.events")!.change).toBe("unchanged")
      }),
    )
  })

  test("cascade: an indirect child of a forward-only parent is forward-only too", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        const jan3 = fromIso("2026-01-03T00:00:00Z")
        const v1 = makeEvents(1)
        yield* Efmesh.apply("dev", [raw, v1, makeChild(v1)], { now: jan3 })

        const v2 = makeEvents(2)
        const plan = yield* Efmesh.plan("dev", [raw, v2, makeChild(v2)], {
          now: jan3,
          forwardOnly: ["med.events"],
        })
        const child = plan.actions.find((a) => a.name === "med.daily")!
        expect(child.change).toBe("forward-only")
        expect(child.backfill).toEqual([]) // the child has nothing to replay
      }),
    )
  })

  test("dropping a column is not expressible as forward-only — SchemaMismatchError", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        const jan3 = fromIso("2026-01-03T00:00:00Z")
        yield* Efmesh.apply("dev", [raw, makeEvents(1)], { now: jan3 })

        const failure = yield* Effect.flip(
          Efmesh.apply("dev", [raw, makeEvents(3)], { now: jan3, forwardOnly: ["med.events"] }),
        )
        expect(failure._tag).toBe("SchemaMismatchError")
      }),
    )
  })

  test("forward-only applies only to incrementalByTimeRange", async () => {
    await scenario(
      Effect.gen(function* () {
        const full = defineModel(
          { name: "med.totals", kind: kind.full(), schema: Schema.Struct({ n: Schema.Number }) },
          (ctx) => ctx.sql`SELECT 1 AS n`,
        )
        const failure = yield* Effect.flip(
          Efmesh.plan("dev", [full], { forwardOnly: ["med.totals"] }),
        )
        expect(failure._tag).toBe("ForwardOnlyError")
      }),
    )
  })
})
