import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter, EngineError, type Engine } from "../src/engine/adapter.ts"
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

/**
 * An engine that drops the first failures.left transactions — emulating a
 * transient failure. The branch choice is inside suspend: a retry re-runs the
 * effect, and each run must see the fresh counter, not the decision made at
 * call time.
 */
const flaky = (real: Engine, failures: { left: number }): Engine => ({
  ...real,
  transaction: (statements) =>
    Effect.suspend(() => {
      if (failures.left <= 0) return real.transaction(statements)
      failures.left -= 1
      return Effect.fail(new EngineError({ sql: statements[0] ?? "", cause: "transient" }))
    }),
})

describe("backfill retries (SPEC §5.3)", () => {
  test("a transient batch failure is waited out by Schedule.exponential", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const failures = { left: 2 }
        const applied = yield* Efmesh.apply("dev", [raw, events], {
          now: fromIso("2026-01-03T00:00:00Z"),
          retry: { attempts: 3, baseDelayMs: 1 },
        }).pipe(Effect.provideService(EngineAdapter, flaky(engine, failures)))
        expect(applied.built).toEqual(["med.events"])
        expect(failures.left).toBe(0)
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows).toEqual([{ n: 2 }])
      }),
    )
  })

  test("without retry the behavior is unchanged: the first failure drops apply, a rerun continues", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const failed = yield* Effect.flip(
          Efmesh.apply("dev", [raw, events], { now: fromIso("2026-01-03T00:00:00Z") }).pipe(
            Effect.provideService(EngineAdapter, flaky(engine, { left: 1 })),
          ),
        )
        expect(failed._tag).toBe("EngineError")

        // retries exhausted — the error is surfaced, the interval stays failed
        const exhausted = yield* Effect.flip(
          Efmesh.apply("dev", [raw, events], {
            now: fromIso("2026-01-03T00:00:00Z"),
            retry: { attempts: 1, baseDelayMs: 1 },
          }).pipe(Effect.provideService(EngineAdapter, flaky(engine, { left: 5 }))),
        )
        expect(exhausted._tag).toBe("EngineError")

        // a healthy engine — resume from where it stopped
        const applied = yield* Efmesh.apply("dev", [raw, events], {
          now: fromIso("2026-01-03T00:00:00Z"),
        })
        expect(applied.built).toEqual(["med.events"])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`)
        expect(rows).toEqual([{ n: 2 }])
      }),
    )
  })
})
