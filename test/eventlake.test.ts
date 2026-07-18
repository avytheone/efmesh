import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DuckDBInstance } from "@duckdb/node-api"
import { Effect, Layer, Schema } from "effect"
import { fromIso } from "../src/core/interval.ts"
import { audit } from "../src/core/audit.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { auditEnvironment } from "../src/plan/audit-run.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"
import {
  crossHorizonDuplicates,
  dailyVolume,
  events,
  rawEvents,
} from "../examples/eventlake/models.ts"

/**
 * The event-lake canonical table (#38). An at-least-once archiver writes the
 * same event more than once, so `count(*)` over the raw lake counts
 * redeliveries as data — in the incident behind this issue by a factor of 3.8
 * (179 095 rows against 46 875 distinct ids). The recipe's promise is narrow
 * and must stay testable: duplicates are eliminated **within the model's
 * horizon**, and a redelivery that arrives later is not — it is surfaced by the
 * ops view instead of silently corrupting a count.
 */

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const count = (engine: { query: (sql: string) => Effect.Effect<any, any> }, sql: string) =>
  Effect.map(engine.query(sql), (rows: ReadonlyArray<{ n: number }>) => rows[0]!.n)

describe("event-lake canonical table (#38)", () => {
  test("the shipped example: 16 archived rows, 9 distinct ids, 10 canonical rows", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        // `now` is pinned so the assertion does not drift with the wall clock:
        // the archive ends on 2026-03-05, a week of backfill covers all of it
        yield* Efmesh.apply("dev", [rawEvents, events, crossHorizonDuplicates, dailyVolume], {
          now: fromIso("2026-03-08T00:00:00Z"),
        })

        const archive = `${new URL("../examples/eventlake/archive", import.meta.url).pathname}/**/*.parquet`
        const raw = yield* count(
          engine,
          `SELECT count(*)::INT AS n FROM read_parquet('${archive}', union_by_name = true, hive_partitioning = true)`,
        )
        expect(raw).toBe(16)

        expect(yield* count(engine, `SELECT count(*)::INT AS n FROM dev__core.events`)).toBe(10)
        expect(
          yield* count(engine, `SELECT count(DISTINCT event_id)::INT AS n FROM dev__core.events`),
        ).toBe(9)

        // the windowed guarantee, spelled out as data: exactly one id survives
        // twice — the one whose redelivery arrived four days after the
        // original, past the three-day horizon
        const survivors = yield* engine.query(
          `SELECT event_id, copies FROM dev__ops.cross_horizon_duplicates`,
        )
        expect(survivors).toEqual([{ event_id: "ev-004", copies: 2 }])

        // union_by_name: the older partitions have no source_node and read NULL
        // rather than failing the scan or shearing the columns
        expect(
          yield* count(
            engine,
            `SELECT count(*)::INT AS n FROM dev__core.events WHERE source_node IS NULL`,
          ),
        ).toBe(7)

        // the typed cast landed: the archive stores the metric as text
        const typed = yield* engine.query(
          `SELECT typeof(metric_value) AS t FROM dev__core.events LIMIT 1`,
        )
        expect(typed).toEqual([{ t: "DOUBLE" }])

        // `efmesh audit` reads audits over the WHOLE environment view, where
        // the cross-horizon residual lives by design — so the recipe's
        // uniqueness audits warn rather than block, and the environment stays
        // servable instead of failing on a documented, accepted property
        const report = yield* auditEnvironment("dev", [
          rawEvents,
          events,
          crossHorizonDuplicates,
          dailyVolume,
        ])
        expect(report.blockingViolations).toBe(0)
        expect(report.results.filter((r) => !r.blocking && r.violations > 0)).toEqual([
          { model: "core.events", audit: "unique(event_id)", blocking: false, violations: 1 },
          {
            model: "ops.cross_horizon_duplicates",
            audit: "no_cross_horizon_duplicates",
            blocking: false,
            violations: 1,
          },
        ])
      }),
    )
  })

  test("the incident, scaled: 950 archived rows collapse to exactly 250 distinct ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-eventlake-"))
    const archive = join(dir, "archive")
    // 250 ids with 2/3/4/5/5 copies each — 950 rows, an inflation of 3.8×, the
    // same shape as the incident at a size a test can run instantly. Every
    // redelivery lands within two days of its original, i.e. inside the
    // horizon, so the canonical count must be exactly the number of ids.
    const instance = await DuckDBInstance.create(":memory:")
    const connection = await instance.connect()
    await connection.run(`
      COPY (
        SELECT
          'ev-' || lpad(id::VARCHAR, 4, '0') AS event_id,
          'created' AS event_type,
          occurred_at,
          arrived_at,
          (id * 10 + copy) AS archiver_offset,
          ((id % 97) + 1)::VARCHAR AS metric_value,
          arrived_at::DATE AS arrival_date
        FROM (
          SELECT
            id,
            copy,
            TIMESTAMP '2026-03-01 00:00:00' + INTERVAL (id % 3) DAY AS occurred_at,
            TIMESTAMP '2026-03-01 00:00:00'
              + INTERVAL (id % 3) DAY
              + INTERVAL (copy % 3) DAY
              + INTERVAL (id * 10 + copy) SECOND AS arrived_at
          FROM generate_series(0, 249) AS g(id),
          LATERAL generate_series(0, list_value(2, 3, 4, 5, 5)[(id % 5) + 1] - 1) AS c(copy)
        )
      ) TO '${archive}' (FORMAT PARQUET, PARTITION_BY (arrival_date), OVERWRITE_OR_IGNORE)
    `)
    connection.closeSync()
    instance.closeSync()

    const raw = defineExternal({
      name: "raw.events",
      source: external.files(`${archive}/**/*.parquet`, "parquet", {
        unionByName: true,
        hivePartitioning: true,
      }),
      schema: Schema.Struct({
        event_id: Schema.String,
        event_type: Schema.String,
        occurred_at: Schema.DateTimeUtc,
        arrived_at: Schema.DateTimeUtc,
        archiver_offset: Schema.Number,
        metric_value: Schema.String,
        arrival_date: Schema.DateTimeUtc,
      }),
    })
    const canonical = defineModel(
      {
        name: "core.events",
        kind: kind.incrementalByTimeRange({
          timeColumn: "arrived_at",
          start: "2026-03-01T00:00:00Z",
          interval: "day",
          batchSize: 1,
        }),
        schema: Schema.Struct({
          event_id: Schema.String,
          occurred_at: Schema.DateTimeUtc,
          arrived_at: Schema.DateTimeUtc,
          metric_value: Schema.Number,
        }),
        grain: ["event_id"],
        audits: [audit.unique("event_id")],
      },
      (ctx) => ctx.sql`
        SELECT event_id, occurred_at, arrived_at, metric_value
        FROM (
          SELECT
            ${ctx.cols(raw, "event_id", "occurred_at", "arrived_at")},
            CAST(metric_value AS DOUBLE) AS metric_value,
            row_number() OVER (
              PARTITION BY event_id
              ORDER BY arrived_at ASC, archiver_offset ASC
            ) AS copy_rank
          FROM ${ctx.ref(raw)}
          WHERE arrived_at >= ${ctx.start} - INTERVAL 3 DAY AND arrived_at < ${ctx.end}
        ) horizon
        WHERE copy_rank = 1 AND arrived_at >= ${ctx.start}
      `,
    )

    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* Efmesh.apply("dev", [raw, canonical], { now: fromIso("2026-03-10T00:00:00Z") })

        const rawRows = yield* count(
          engine,
          `SELECT count(*)::INT AS n FROM read_parquet('${archive}/**/*.parquet', union_by_name = true, hive_partitioning = true)`,
        )
        expect(rawRows).toBe(950)
        expect(rawRows / 250).toBeCloseTo(3.8, 5)

        expect(yield* count(engine, `SELECT count(*)::INT AS n FROM dev__core.events`)).toBe(250)
        expect(
          yield* count(engine, `SELECT count(DISTINCT event_id)::INT AS n FROM dev__core.events`),
        ).toBe(250)
      }),
    )
  })

  test("external.files options render as reader arguments and only when asked for", async () => {
    const { externalSourceRef } = await import("../src/plan/naming.ts")
    // a source that asks for nothing renders exactly as it always did — the
    // fingerprint of every external model defined before the options existed
    // depends on this
    expect(externalSourceRef(external.files("lake/raw/*.parquet", "parquet"))).toBe(
      `read_parquet('lake/raw/*.parquet')`,
    )
    expect(
      externalSourceRef(
        external.files("lake/raw/**/*.parquet", "parquet", {
          unionByName: true,
          hivePartitioning: true,
        }),
      ),
    ).toBe(`read_parquet('lake/raw/**/*.parquet', union_by_name = true, hive_partitioning = true)`)
  })
})
