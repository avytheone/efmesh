import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { restateToJson } from "../src/cli.ts"
import { fromIso, toIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { restate } from "../src/plan/restate.ts"
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
    kind: kind.incrementalByTimeRange({
      timeColumn: "happened_at",
      start: "2026-01-01T00:00:00Z",
      batchSize: 1,
    }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
  },
  (ctx) => ctx.sql`
    SELECT id, happened_at FROM ${ctx.ref(raw)}
    WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
  `,
)

// downstream incremental model — proves the cascade reaches descendants
const rollup = defineModel(
  {
    name: "med.rollup",
    kind: kind.incrementalByTimeRange({
      timeColumn: "happened_at",
      start: "2026-01-01T00:00:00Z",
      batchSize: 1,
    }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
  },
  (ctx) => ctx.sql`
    SELECT id, happened_at FROM ${ctx.ref(events)}
    WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
  `,
)

// a full model and an scdType2 model — restate must refuse both kinds
const total = defineModel(
  {
    name: "med.total",
    kind: kind.full(),
    schema: Schema.Struct({ n: Schema.Number }),
  },
  (ctx) => ctx.sql`SELECT count(*) AS n FROM ${ctx.ref(events)}`,
)

const dim = defineModel(
  {
    name: "med.dim",
    kind: kind.scdType2({ key: ["id"] }),
    schema: Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      valid_from: Schema.DateTimeUtc,
      valid_to: Schema.DateTimeUtc,
    }),
  },
  (ctx) => ctx.sql`SELECT id, id AS label FROM ${ctx.ref(raw)}`,
)

const models = [raw, events, rollup, total, dim]

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

const countView = (view: string) =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM ${view}`)
    return (rows[0] as { n: number }).n
  })

const jan3 = "2026-01-03T00:00:00Z"
const jan4 = "2026-01-04T00:00:00Z"
const jan7 = fromIso("2026-01-07T00:00:00Z")

describe("restate (#21)", () => {
  test("grain validation: misaligned bounds and a malformed range are typed errors", async () => {
    await scenario(
      Effect.gen(function* () {
        // --from is not on a day boundary
        const misFrom = yield* Effect.flip(
          restate("dev", "med.events", "2026-01-03T06:00:00Z", jan4, models),
        )
        expect(misFrom._tag).toBe("RestateGrainError")
        expect((misFrom as { bound: string }).bound).toBe("from")

        // --to is not on a day boundary
        const misTo = yield* Effect.flip(
          restate("dev", "med.events", jan3, "2026-01-04T06:00:00Z", models),
        )
        expect(misTo._tag).toBe("RestateGrainError")

        // not an ISO time at all
        const notIso = yield* Effect.flip(restate("dev", "med.events", "yesterday", jan4, models))
        expect(notIso._tag).toBe("RestateRangeError")

        // empty range: from is not before to
        const empty = yield* Effect.flip(restate("dev", "med.events", jan4, jan3, models))
        expect(empty._tag).toBe("RestateRangeError")
      }),
    )
  })

  test("scdType2 is refused by name; other non-time-range kinds are refused generically", async () => {
    await scenario(
      Effect.gen(function* () {
        const scd = yield* Effect.flip(restate("dev", "med.dim", jan3, jan4, models))
        expect(scd._tag).toBe("RestateKindError")
        expect((scd as { kind: string }).kind).toBe("scdType2")
        expect((scd as { message: string }).message).toContain("scdType2")

        const full = yield* Effect.flip(restate("dev", "med.total", jan3, jan4, models))
        expect(full._tag).toBe("RestateKindError")
        expect((full as { kind: string }).kind).toBe("full")

        const unknown = yield* Effect.flip(restate("dev", "med.ghost", jan3, jan4, models))
        expect(unknown._tag).toBe("UnknownModelError")
      }),
    )
  })

  test("a model not applied to the environment cannot be restated", async () => {
    await scenario(
      Effect.gen(function* () {
        const err = yield* Effect.flip(restate("dev", "med.events", jan3, jan4, models))
        expect(err._tag).toBe("RestateEnvError")
      }),
    )
  })

  test("--dry-run previews the cascade and mutates nothing", async () => {
    await scenario(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* seedSource
        yield* Efmesh.apply("dev", models, { now: jan7 })

        const eventsFp = new Map(
          (yield* store.getEnvironment("dev")).map((r) => [r.name, r.fingerprint]),
        ).get("med.events")!
        const before = yield* store.listIntervals(eventsFp)

        const plan = yield* restate("dev", "med.events", jan3, jan4, models, { dryRun: true })
        expect(plan.dryRun).toBe(true)
        // target first, then the incremental descendant — the full/scd models never appear
        expect(plan.targets.map((t) => t.name)).toEqual(["med.events", "med.rollup"])
        for (const target of plan.targets) {
          expect(target.intervals).toEqual([{ start: fromIso(jan3), end: fromIso(jan4) }])
        }

        // the ledger is untouched — a dry run holds no lock and clears nothing
        const after = yield* store.listIntervals(eventsFp)
        expect(after).toEqual(before)
      }),
    )
  })

  test("restate → apply recomputes the range for the model and its descendants", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countView("dev__med.events")).toBe(5)
        expect(yield* countView("dev__med.rollup")).toBe(5)

        // corrected source data lands for January 3 after the fact
        yield* engine.execute(
          `INSERT INTO src.events VALUES ('e3b', TIMESTAMP '2026-01-03 15:00:00')`,
        )

        // a plain apply does NOT pick it up: January 3 is already marked done
        yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(yield* countView("dev__med.events")).toBe(5)

        // restate clears the January-3 interval for the model and its descendant
        const plan = yield* restate("dev", "med.events", jan3, jan4, models)
        expect(plan.dryRun).toBe(false)
        expect(plan.targets.map((t) => t.name)).toEqual(["med.events", "med.rollup"])

        // now apply recomputes exactly that interval, everywhere downstream
        const applied = yield* Efmesh.apply("dev", models, { now: jan7 })
        expect(applied.built).toContain("med.events")
        expect(applied.built).toContain("med.rollup")
        expect(yield* countView("dev__med.events")).toBe(6)
        expect(yield* countView("dev__med.rollup")).toBe(6)
      }),
    )
  })

  test("restateToJson — an object shape, intervals ISO UTC", () => {
    const json = restateToJson({
      env: "dev",
      model: "med.events",
      from: fromIso(jan3),
      to: fromIso(jan4),
      interval: "day",
      dryRun: true,
      targets: [
        {
          name: "med.events",
          fingerprint: "abc12345def",
          intervals: [{ start: fromIso(jan3), end: fromIso(jan4) }],
        },
      ],
    })
    expect(json).toEqual({
      env: "dev",
      model: "med.events",
      from: toIso(fromIso(jan3)),
      to: toIso(fromIso(jan4)),
      interval: "day",
      dryRun: true,
      targets: [
        {
          name: "med.events",
          fingerprint: "abc12345def",
          intervals: [{ start: "2026-01-03T00:00:00.000Z", end: "2026-01-04T00:00:00.000Z" }],
        },
      ],
    })
  })
})
