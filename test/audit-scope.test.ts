import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { audit } from "../src/core/audit.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { auditEnvironment } from "../src/plan/audit-run.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

/**
 * #53: the same audit object was evaluated at two scopes — `apply` over the
 * interval it just wrote, `efmesh audit` over the whole environment view — with
 * nothing in the API to say which the author meant. The case that proves it is
 * a WINDOWED guarantee: uniqueness that holds inside every written interval and
 * legitimately fails across the table.
 */

const raw = defineExternal({
  name: "src.rows",
  source: external.table("src.rows"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const withAudits = (name: string, audits: ReadonlyArray<ReturnType<typeof audit.unique>>) =>
  defineModel(
    {
      name,
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        interval: "day",
        // the interval pass audits the batch AS RENDERED, and a batch may span
        // several intervals — with the default batchSize the whole backfill is
        // one window and `perInterval` would silently mean "per batch" (#54)
        batchSize: 1,
      }),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      audits,
    },
    (ctx) => ctx.sql`
      SELECT ${ctx.cols(raw, "id", "happened_at")} FROM ${ctx.ref(raw)}
      WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
    `,
  )

/**
 * The same id on two different days: unique WITHIN each written interval,
 * duplicated ACROSS the table. Exactly the shape a de-duplication window
 * produces, and the shape that gave one declaration two verdicts.
 */
const seed = (engine: { execute: (sql: string) => Effect.Effect<unknown, unknown> }) =>
  Effect.gen(function* () {
    yield* engine.execute("CREATE SCHEMA IF NOT EXISTS src")
    yield* engine.execute(
      `CREATE OR REPLACE TABLE src.rows AS SELECT * FROM (VALUES
         ('dup', TIMESTAMP '2026-01-01 10:00:00'),
         ('dup', TIMESTAMP '2026-01-02 10:00:00')) t(id, happened_at)`,
    )
  })

const live = () => Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

describe("an audit's scope is declared, not inferred from who runs it (#53)", () => {
  test("perInterval passes apply and is reported as skipped, never answered wrongly", async () => {
    const model = withAudits("mart.windowed", [audit.perInterval(audit.unique("id"))])
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seed(engine)
        // apply must succeed: within each written day the id is unique
        yield* Efmesh.apply("dev", [raw, model], { now: Date.parse("2026-01-03T00:00:00Z") })
        return yield* auditEnvironment("dev", [raw, model])
      }).pipe(Effect.provide(live())),
    )
    // before the fix this ran over the whole view, found the cross-day duplicate
    // and exited 1 on correct data — the workaround was to downgrade the audit
    // to a warning, giving up blocking on apply as well
    expect(report.results).toEqual([])
    expect(report.blockingViolations).toBe(0)
    expect(report.skipped).toEqual([
      { model: "mart.windowed", audit: "unique(id)", reason: "interval-scoped" },
    ])
  })

  test("an unscoped audit still runs everywhere — nothing changes for a project that says nothing", async () => {
    const model = withAudits("mart.plain", [audit.warn(audit.unique("id"))])
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seed(engine)
        yield* Efmesh.apply("dev", [raw, model], { now: Date.parse("2026-01-03T00:00:00Z") })
        return yield* auditEnvironment("dev", [raw, model])
      }).pipe(Effect.provide(live())),
    )
    expect(report.skipped).toEqual([])
    expect(report.results).toHaveLength(1)
    // the cross-day duplicate is real at this scope, and a warn audit reports it
    expect(report.results[0]!.violations).toBeGreaterThan(0)
  })

  test("a whole-scoped audit blocks apply before promotion, not merely after the fact", async () => {
    const model = withAudits("mart.strict", [audit.whole(audit.unique("id"))])
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seed(engine)
        return yield* Efmesh.apply("dev", [raw, model], {
          now: Date.parse("2026-01-03T00:00:00Z"),
        }).pipe(
          Effect.map(() => "applied" as const),
          Effect.catchTag("AuditFailure", (error) => Effect.succeed(error.audit)),
        )
      }).pipe(Effect.provide(live())),
    )
    // each interval on its own is clean, so an interval-scoped pass could never
    // catch this; without the pre-promotion whole pass the declaration would be
    // enforced by nothing until someone ran `efmesh audit` by hand
    expect(outcome).toBe("unique(id)")
    const served = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        return yield* engine.query("SELECT count(*) AS n FROM dev__mart.strict").pipe(
          Effect.map(() => true as const),
          Effect.orElseSucceed(() => false as const),
        )
      }).pipe(Effect.provide(live())),
    )
    // the environment never got a view over data that failed its own invariant
    expect(served).toBe(false)
  })
})
