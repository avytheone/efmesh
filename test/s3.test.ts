import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { compactToJson } from "../src/cli.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { fp8, parquetPrefix } from "../src/plan/naming.ts"
import { janitor } from "../src/plan/janitor.ts"
import { restate } from "../src/plan/restate.ts"
import { compact } from "../src/plan/compact.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"
import { hasDocker, startMinio, type MinioEndpoint } from "./helpers/minio.ts"

let minio: MinioEndpoint

const s3CompactWarning =
  "S3 compaction is not implemented; no S3 partitions were listed, merged, or deleted: med.events"

beforeAll(async () => {
  if (!hasDocker) return
  minio = await startMinio()
}, 600_000)

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
  test("apply, dev-to-prod promotion, query, append, corrected restate, manifest, failed COPY and janitor", async () => {
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
        const store = yield* StateStore
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

        // Promotion reuses dev's physical S3 version without writing objects.
        const beforePromotion = yield* engine.objectStore!.list(`${prefix}/`)
        const beforeManifest = yield* engine.objectStore!.readText(`${prefix}/manifest.json`)
        const publicationWrites: string[] = []
        const objectStore = engine.objectStore!
        const promotionEngine = {
          ...engine,
          execute: (sql: string) => {
            if (/^\s*COPY\s/i.test(sql)) publicationWrites.push("COPY")
            return engine.execute(sql)
          },
          objectStore: {
            ...objectStore,
            writeText: (path: string, content: string) => {
              publicationWrites.push(path)
              return objectStore.writeText(path, content)
            },
            delete: (path: string) => {
              publicationWrites.push(path)
              return objectStore.delete(path)
            },
            deletePrefix: (path: string) => {
              publicationWrites.push(path)
              return objectStore.deletePrefix(path)
            },
          },
        }
        const promoted = yield* Efmesh.apply("prod", models, {
          now: fromIso("2026-01-03T00:00:00Z"),
          lakePath: lake,
        }).pipe(Effect.provideService(EngineAdapter, promotionEngine))
        expect(promoted.built).toEqual([])
        expect(publicationWrites).toEqual([])
        for (const env of ["dev", "prod"])
          expect(
            (yield* store.getEnvironment(env)).find((row) => row.name === "med.events")!
              .fingerprint,
          ).toBe(fingerprint)
        expect(yield* engine.objectStore!.list(`${prefix}/`)).toEqual(beforePromotion)
        expect(yield* engine.objectStore!.readText(`${prefix}/manifest.json`)).toBe(beforeManifest)
        expect(yield* engine.query("SELECT id FROM med.events ORDER BY id")).toEqual([
          { id: "e1" },
          { id: "e2" },
        ])
        expect(
          yield* engine.query(
            `SELECT count(*)::INT AS n FROM read_parquet('${prefix}/**/*.parquet')`,
          ),
        ).toEqual([{ n: 2 }])

        yield* Efmesh.apply("dev", models, {
          now: fromIso("2026-01-04T00:00:00Z"),
          lakePath: lake,
        })
        expect(
          (yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`))[0]?.["n"],
        ).toBe(3)

        expect(yield* engine.query("SELECT count(*)::INT AS n FROM med.events")).toEqual([{ n: 3 }])
        // Corrected data must be read by the reopened interval, not just counted again.
        yield* engine.execute(
          "INSERT INTO src.events VALUES ('e2-corrected', TIMESTAMP '2026-01-02 15:00:00')",
        )
        yield* restate("dev", "med.events", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z", models)
        yield* Efmesh.apply("dev", models, {
          now: fromIso("2026-01-04T00:00:00Z"),
          lakePath: lake,
        })
        expect(
          (yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.events`))[0]?.["n"],
        ).toBe(4)
        expect(yield* engine.query("SELECT id FROM med.events ORDER BY id")).toEqual([
          { id: "e1" },
          { id: "e2" },
          { id: "e2-corrected" },
          { id: "e3" },
        ])

        const manifest = JSON.parse(
          yield* engine.objectStore!.readText(`${prefix}/manifest.json`),
        ) as {
          fingerprint: string
          files: ReadonlyArray<string>
          intervals: ReadonlyArray<unknown>
          effective: { completeThrough: string | null }
        }
        expect(manifest.files).toHaveLength(3)
        expect(manifest.intervals).toHaveLength(3)
        expect(manifest.fingerprint).toBe(fingerprint)
        expect(manifest.effective.completeThrough).toBe("2026-01-04T00:00:00.000Z")
        const objectsBeforeCompact = yield* engine.objectStore!.list(`${prefix}/`)
        const compactReport = yield* compact({ models, lakePath: lake })
        expect(compactReport.compacted).toEqual([])
        expect(compactReport.warnings).toEqual([s3CompactWarning])
        expect(compactToJson(compactReport)).toMatchObject({ warnings: [s3CompactWarning] })
        expect(yield* engine.objectStore!.list(`${prefix}/`)).toEqual(objectsBeforeCompact)

        // This expression-error COPY leaves no key on the tested endpoint.
        // It does not establish that multipart upload began, or cover crashes/network loss.
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
        // Prod still references the old version: janitor must preserve those objects.
        const kept = yield* janitor({ ttlDays: 0, lakePath: lake })
        expect(kept.removed).not.toContain(`med.events@${fp8(fingerprint)}`)
        expect(yield* engine.objectStore!.list(`${prefix}/`)).toEqual(objectsBeforeCompact)
        expect(yield* engine.query("SELECT count(*)::INT AS n FROM med.events")).toEqual([{ n: 4 }])
        const promotedChanged = yield* Efmesh.apply("prod", [raw, changed], {
          now: fromIso("2026-01-04T00:00:00Z"),
          lakePath: lake,
        })
        expect(promotedChanged.built).toEqual([])
        const report = yield* janitor({ ttlDays: 0, lakePath: lake })
        expect(report.warnings).toEqual([])
        expect(report.removed).toContain(`med.events@${fp8(fingerprint)}`)
        expect(yield* engine.objectStore!.list(`${prefix}/`)).toEqual([])
        expect(yield* engine.query("SELECT count(*)::INT AS n FROM dev__med.events")).toEqual([
          { n: 4 },
        ])
        expect(yield* engine.query("SELECT count(*)::INT AS n FROM med.events")).toEqual([{ n: 4 }])
      }).pipe(Effect.provide(layer)),
    )
  }, 60_000)
})
