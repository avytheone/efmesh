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
 * Continuity audits (#42), carrying two invariants from a gate that was paid
 * for by two incidents in one day:
 *
 * - the gate verifies the FACT of coverage, computing it from the data, never
 *   the presence of a flag some other process set;
 * - refusal prints the numbers of the hole's boundaries, so the operator knows
 *   what to restate without writing a query of their own.
 *
 * "Refuse with numbers before the first write, rather than succeed with
 * silently lost history."
 */

const raw = defineExternal({
  name: "src.rows",
  source: external.table("src.rows"),
  schema: Schema.Struct({ seq: Schema.Number, happened_at: Schema.DateTimeUtc }),
})

const gated = (name: string, audits: ReadonlyArray<ReturnType<typeof audit.assertContiguous>>) =>
  defineModel(
    {
      name,
      kind: kind.full(),
      schema: Schema.Struct({ seq: Schema.Number, happened_at: Schema.DateTimeUtc }),
      audits,
    },
    (ctx) => ctx.sql`SELECT ${ctx.cols(raw, "seq", "happened_at")} FROM ${ctx.ref(raw)}`,
  )

const rows = (values: ReadonlyArray<readonly [number, string]>) =>
  values.map(([seq, day]) => `(${seq}, TIMESTAMP '${day} 10:00:00')`).join(", ")

const seed = (
  engine: { execute: (sql: string) => Effect.Effect<unknown, unknown> },
  values: ReadonlyArray<readonly [number, string]>,
) =>
  Effect.gen(function* () {
    yield* engine.execute("CREATE SCHEMA IF NOT EXISTS src")
    yield* engine.execute(
      `CREATE OR REPLACE TABLE src.rows AS SELECT * FROM (VALUES ${rows(values)}) t(seq, happened_at)`,
    )
  })

const live = () => Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const applying = (
  model: ReturnType<typeof gated>,
  values: ReadonlyArray<readonly [number, string]>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineAdapter
      yield* seed(engine, values)
      return yield* Efmesh.apply("dev", [raw, model]).pipe(
        Effect.map(() => "applied" as const),
        Effect.catchTag("AuditFailure", (error) => Effect.succeed(error.message)),
      )
    }).pipe(Effect.provide(live())),
  )

describe("assertContiguous — the fact of coverage, not a flag (#42)", () => {
  test("a hole in the sequence refuses with the boundaries of the hole", async () => {
    const outcome = await applying(gated("mart.seq", [audit.assertContiguous("seq")]), [
      [1, "2026-01-01"],
      [2, "2026-01-02"],
      // 3 and 4 never arrived
      [5, "2026-01-05"],
    ])
    expect(outcome).toContain("covered through 2")
    expect(outcome).toContain("resumes at 5")
  })

  test("an unbroken sequence applies", async () => {
    const outcome = await applying(gated("mart.seq", [audit.assertContiguous("seq")]), [
      [1, "2026-01-01"],
      [2, "2026-01-02"],
      [3, "2026-01-03"],
    ])
    expect(outcome).toBe("applied")
  })

  test("neither end of the observed range is assumed — a late start is not a hole", async () => {
    // starts at 5 and stops at 7: contiguous over what exists. Refusing here
    // would mean inventing bounds nobody declared — how far the data reaches is
    // a freshness question, and `completeThrough` (#43) already answers it.
    const outcome = await applying(gated("mart.seq", [audit.assertContiguous("seq")]), [
      [5, "2026-01-01"],
      [6, "2026-01-02"],
      [7, "2026-01-03"],
    ])
    expect(outcome).toBe("applied")
  })

  test("further gaps are counted, not listed — a broken table stays readable", async () => {
    const outcome = await applying(gated("mart.seq", [audit.assertContiguous("seq")]), [
      [1, "2026-01-01"],
      [5, "2026-01-02"],
      [9, "2026-01-03"],
      [20, "2026-01-04"],
    ])
    expect(outcome).toContain("covered through 1")
    expect(outcome).toContain("and 2 further gap(s)")
  })
})

describe("assertNoGaps — missing buckets, in ISO (#42)", () => {
  test("a missing day refuses with the day it stopped and the day it resumed", async () => {
    const outcome = await applying(gated("mart.days", [audit.assertNoGaps("happened_at", "day")]), [
      [1, "2026-01-01"],
      [2, "2026-01-02"],
      // 2026-01-03 never arrived
      [3, "2026-01-04"],
    ])
    expect(outcome).toContain("covered through 2026-01-02")
    expect(outcome).toContain("resumes at 2026-01-04")
  })

  test("several rows inside one bucket are one bucket, not a false gap", async () => {
    const outcome = await applying(gated("mart.days", [audit.assertNoGaps("happened_at", "day")]), [
      [1, "2026-01-01"],
      [2, "2026-01-01"],
      [3, "2026-01-02"],
    ])
    expect(outcome).toBe("applied")
  })
})

describe("continuity audits are whole-scoped by construction (#42, #53)", () => {
  test("the standalone command reports the same numbers, and does not skip them", async () => {
    const model = gated("mart.seq", [audit.warn(audit.assertContiguous("seq"))])
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seed(engine, [
          [1, "2026-01-01"],
          [4, "2026-01-02"],
        ])
        yield* Efmesh.apply("dev", [raw, model])
        return yield* auditEnvironment("dev", [raw, model])
      }).pipe(Effect.provide(live())),
    )
    // whole-scoped, so `efmesh audit` evaluates it rather than reporting a skip
    expect(report.skipped).toEqual([])
    expect(report.results[0]!.detail).toContain("covered through 1")
  })

  test("the scope is whole — an interval pass could never see a cross-interval hole", () => {
    expect(audit.assertContiguous("seq").scope).toBe("whole")
    expect(audit.assertNoGaps("happened_at", "day").scope).toBe("whole")
  })
})
