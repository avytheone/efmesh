import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { fp8, parquetPrefix } from "../src/plan/naming.ts"
import { janitor } from "../src/plan/janitor.ts"
import { restate } from "../src/plan/restate.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { hasDocker, startMinio, type MinioEndpoint } from "./helpers/minio.ts"

let minio: MinioEndpoint

beforeAll(async () => {
  if (!hasDocker) return
  minio = await startMinio()
}, 120_000)

afterAll(() => minio?.stop())

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const eventsModel = (suffix = "") =>
  defineModel(
    {
      name: "med.events",
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        batchSize: 1,
      }),
      target: "parquet",
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
    },
    (ctx) => ctx.sql`
      SELECT id, happened_at FROM ${ctx.ref(raw)}
      WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
      ${suffix === "" ? ctx.sql`` : ctx.sql`AND id <> ${suffix}`}
    `,
  )

describe.skipIf(!hasDocker)("S3 parquet lake against MinIO (#65)", () => {
  test("apply, query, append, restate, manifest, atomic failure and janitor", async () => {
    const lake = `s3://${minio.bucket}/project`
    const credential = {
      name: "lake_s3",
      type: "s3",
      scope: `s3://${minio.bucket}`,
      values: {
        KEY_ID: minio.accessKeyId,
        SECRET: minio.secretAccessKey,
        REGION: "us-east-1",
        ENDPOINT: minio.host,
        USE_SSL: false,
        URL_STYLE: "path",
      },
    } as const
    const layer = Layer.mergeAll(
      DuckDBEngineLive({
        init: { extensions: ["httpfs"], credentials: [credential] },
      }),
      SqliteStateLive(),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        expect(engine.objectStore).toBeDefined()
        yield* engine.execute(`CREATE SCHEMA src`)
        yield* engine.execute(`
          CREATE TABLE src.events AS SELECT * FROM (VALUES
            ('e1', TIMESTAMP '2026-01-01 10:00:00'),
            ('e2', TIMESTAMP '2026-01-02 11:00:00'),
            ('e3', TIMESTAMP '2026-01-03 12:00:00')
          ) t(id, happened_at)
        `)

        const events = eventsModel()
        const models = [raw, events]
        const first = yield* Efmesh.apply("dev", models, {
          now: fromIso("2026-01-03T00:00:00Z"),
          lakePath: lake,
        })
        const fingerprint = first.plan.actions.find(
          (action) => action.name === "med.events",
        )!.fingerprint
        const prefix = parquetPrefix(lake, events.name, fingerprint)
        expect(
          (yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`))[0]?.["n"],
        ).toBe(2)

        yield* Efmesh.apply("dev", models, {
          now: fromIso("2026-01-04T00:00:00Z"),
          lakePath: lake,
        })
        expect(
          (yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`))[0]?.["n"],
        ).toBe(3)

        yield* restate("dev", "med.events", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", models)
        yield* Efmesh.apply("dev", models, {
          now: fromIso("2026-01-04T00:00:00Z"),
          lakePath: lake,
        })
        expect(
          (yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`))[0]?.["n"],
        ).toBe(3)

        const manifest = JSON.parse(
          yield* engine.objectStore!.readText(`${prefix}/manifest.json`),
        ) as { files: ReadonlyArray<string>; intervals: ReadonlyArray<unknown> }
        expect(manifest.files).toHaveLength(3)
        expect(manifest.intervals).toHaveLength(3)

        // DuckDB/httpfs must abort a failed upload rather than expose a partial key.
        const unfinished = `${lake}/atomicity/unfinished.parquet`
        yield* Effect.flip(
          engine.execute(
            `COPY (SELECT CASE WHEN i = 50000 THEN error('boom') ELSE i END AS i FROM range(100000) t(i)) TO '${unfinished}' (FORMAT PARQUET)`,
          ),
        )
        expect(yield* engine.objectStore!.exists(unfinished)).toBe(false)

        // Change the model, orphan the old prefix, and prove janitor deletes S3 keys.
        const changed = eventsModel("never")
        yield* Efmesh.apply("dev", [raw, changed], {
          now: fromIso("2026-01-04T00:00:00Z"),
          lakePath: lake,
        })
        const report = yield* janitor({ ttlDays: 0, lakePath: lake })
        expect(report.warnings).toEqual([])
        expect(report.removed).toContain(`med.events@${fp8(fingerprint)}`)
        expect(yield* engine.objectStore!.list(`${prefix}/`)).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
  }, 60_000)
})
