import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { parquetRef } from "../src/plan/naming.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

/**
 * #55: the lake's directory layout is efmesh's bookkeeping, not the model's
 * data. With hive detection left on, DuckDB read `fp=`/`interval=` off the path
 * and every parquet model's view served two columns no schema declared — the
 * declared schema stopped being the whole truth about what a model serves,
 * which is the promise the DESCRIBE contract exists to keep.
 */

const raw = defineExternal({
  name: "src.rows",
  source: external.table("src.rows"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const lakeModel = defineModel(
  {
    name: "mart.rows",
    kind: kind.incrementalByTimeRange({
      timeColumn: "happened_at",
      start: "2026-01-01T00:00:00Z",
      interval: "day",
    }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
    target: "parquet",
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(raw, "id", "happened_at")} FROM ${ctx.ref(raw)}
    WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
  `,
)

describe("the lake layout is bookkeeping, not data (#55)", () => {
  test("the rendered scan turns hive detection off and keeps union_by_name", () => {
    const rendered = parquetRef("lake", lakeModel.name, "abc12345deadbeef")
    expect(rendered).toContain("hive_partitioning = false")
    // additive schema growth across a version's partitions must still reconcile
    expect(rendered).toContain("union_by_name = true")
  })

  test("a consumer sees exactly the declared columns — no fp, no interval", async () => {
    const columns = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute("CREATE SCHEMA IF NOT EXISTS src")
        yield* engine.execute(
          `CREATE OR REPLACE TABLE src.rows AS
             SELECT * FROM (VALUES ('r1', TIMESTAMP '2026-01-01 10:00:00')) t(id, happened_at)`,
        )
        yield* Efmesh.apply("dev", [raw, lakeModel], {
          lakePath: "efmesh-hive-test-lake",
          now: Date.parse("2026-01-02T00:00:00Z"),
        })
        const rows = yield* engine.query("SELECT * FROM dev__mart.rows LIMIT 1")
        return Object.keys(rows[0] ?? {})
      }).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
    )
    expect(columns).toEqual(["id", "happened_at"])
  })
})
