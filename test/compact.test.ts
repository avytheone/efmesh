import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import type { AnyModel, CompactPolicy } from "../src/core/model.ts"
import { compactToJson } from "../src/cli/json.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { compact, compactMergeSql, compactWritePath } from "../src/plan/compact.ts"

/**
 * `efmesh compact` (#40). Every test below is one bullet of the behavior spec
 * on the issue — orchestration rules a production incident paid for, so each
 * gets its own test rather than riding along in a happy path.
 */

const testLayer = DuckDBEngineLive()

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const NOW = fromIso("2026-03-10T12:00:00Z")
const MINUTE = 60_000

const roots: Array<string> = []
const newLake = (): string => {
  const root = mkdtempSync(join(tmpdir(), "efmesh-compact-"))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A parquet file in a partition, with its mtime placed relative to NOW. */
const writeFile = (
  root: string,
  day: string,
  name: string,
  values: string,
  minutesAgo: number,
): Effect.Effect<string, never, EngineAdapter> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const partition = `${root}/arrival_date=${day}`
    mkdirSync(partition, { recursive: true })
    const path = `${partition}/${name}`
    yield* Effect.orDie(engine.execute(`COPY (${values}) TO '${path}' (FORMAT PARQUET)`))
    const when = new Date(NOW - minutesAgo * MINUTE)
    yield* Effect.sync(() => utimesSync(path, when, when))
    return path
  })

/** Two columns; `source_node` is the column the archiver grew later. */
const gen1 = (id: string, arrived: string): string =>
  `SELECT '${id}' AS event_id, TIMESTAMP '${arrived}' AS arrived_at`
const gen2 = (id: string, arrived: string, node: string): string =>
  `${gen1(id, arrived)}, '${node}' AS source_node`

const archive = (root: string, policy?: Partial<CompactPolicy>): AnyModel =>
  defineExternal({
    name: "raw.events",
    source: external.files(`${root}/**/*.parquet`, "parquet", {
      unionByName: true,
      hivePartitioning: true,
    }),
    schema: Schema.Struct({
      event_id: Schema.String,
      arrived_at: Schema.DateTimeUtc,
      source_node: Schema.NullOr(Schema.String),
    }),
    maintenance: {
      compact: {
        partitionKey: "arrival_date",
        uniqueKey: ["event_id"],
        orderBy: ["arrived_at"],
        ...policy,
      },
    },
  })

const parquetIn = (partition: string): ReadonlyArray<string> =>
  readdirSync(partition)
    .filter((name) => name.endsWith(".parquet"))
    .sort()

const rowsOf = (path: string): Effect.Effect<ReadonlyArray<unknown>, never, EngineAdapter> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    // hive_partitioning off so this reads the FILE's own columns: the partition
    // key must live in the directory name, never baked into the merged file
    return yield* Effect.orDie(
      engine.query(
        `SELECT * FROM read_parquet('${path}', hive_partitioning = false) ORDER BY event_id, arrived_at`,
      ),
    )
  })

describe("compact — only settled partitions are touched (#40)", () => {
  test("only partitions strictly older than the current UTC day are compacted", async () => {
    const root = newLake()
    await scenario(
      Effect.gen(function* () {
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e2", "2026-03-08 02:00:00"), 600)
        // the day the run happens on: a live writer owns it, whatever the mtimes say
        yield* writeFile(root, "2026-03-10", "a.parquet", gen1("e3", "2026-03-10 01:00:00"), 600)
        yield* writeFile(root, "2026-03-10", "b.parquet", gen1("e4", "2026-03-10 02:00:00"), 600)

        const report = yield* compact({ models: [archive(root)], now: NOW })
        expect(report.compacted.map((entry) => entry.partition)).toEqual([
          `${root}/arrival_date=2026-03-08`,
        ])
        expect(report.skipped).toEqual([
          {
            model: "raw.events",
            partition: `${root}/arrival_date=2026-03-10`,
            reason: "current-day",
          },
        ])
        expect(parquetIn(`${root}/arrival_date=2026-03-08`)).toEqual(["compacted.parquet"])
        expect(parquetIn(`${root}/arrival_date=2026-03-10`)).toEqual(["a.parquet", "b.parquet"])
      }),
    )
  })

  test("a grace period on the newest file's mtime protects a batch still in flight", async () => {
    const root = newLake()
    await scenario(
      Effect.gen(function* () {
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        // the batch landed five minutes ago — the rest of it may still be coming
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e2", "2026-03-08 02:00:00"), 5)
        const model = archive(root)

        const early = yield* compact({ models: [model], now: NOW })
        expect(early.compacted).toEqual([])
        expect(early.skipped[0]?.reason).toBe("grace-period")
        expect(parquetIn(`${root}/arrival_date=2026-03-08`)).toEqual(["a.parquet", "b.parquet"])

        // past the default ten minutes, with nothing new landing since
        const later = yield* compact({ models: [model], now: NOW + 10 * MINUTE })
        expect(later.compacted).toHaveLength(1)
        expect(parquetIn(`${root}/arrival_date=2026-03-08`)).toEqual(["compacted.parquet"])
      }),
    )
  })
})

describe("compact — publishing and deletion (#40)", () => {
  test("publishes via a .tmp and an atomic rename, leaving no temp behind", async () => {
    const root = newLake()
    const published = `${root}/arrival_date=2026-03-08/compacted.parquet`
    // the merge never writes the published path directly: a reader of the
    // partition sees the old files or the merged one, never a partial file
    expect(compactWritePath(published, 4242)).toBe(`${published}.4242.tmp`)
    expect(compactWritePath(published, 4242).endsWith(".tmp")).toBe(true)
    expect(compactWritePath(published, 4242)).not.toBe(published)

    await scenario(
      Effect.gen(function* () {
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e2", "2026-03-08 02:00:00"), 600)
        yield* compact({ models: [archive(root)], now: NOW })
        expect(existsSync(published)).toBe(true)
        expect(
          readdirSync(`${root}/arrival_date=2026-03-08`).filter((n) => n.includes(".tmp")),
        ).toEqual([])
      }),
    )
  })

  test("deletes only the pre-merge snapshot — a file arriving mid-run is never lost", async () => {
    const root = newLake()
    const partition = `${root}/arrival_date=2026-03-08`
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e2", "2026-03-08 02:00:00"), 600)

        yield* compact({
          models: [archive(root)],
          now: NOW,
          // the writer lands a file after the list was taken and before the merge
          afterSnapshot: () =>
            Effect.orDie(
              engine.execute(
                `COPY (${gen1("e9", "2026-03-08 03:00:00")}) TO '${partition}/late.parquet' (FORMAT PARQUET)`,
              ),
            ),
        })

        // the latecomer survives untouched; only the snapshotted files are gone
        expect(parquetIn(partition)).toEqual(["compacted.parquet", "late.parquet"])
        const merged = yield* rowsOf(`${partition}/compacted.parquet`)
        expect(merged.map((row) => (row as { event_id: string }).event_id)).toEqual(["e1", "e2"])
        const late = yield* rowsOf(`${partition}/late.parquet`)
        expect(late).toHaveLength(1)
      }),
    )
  })
})

describe("compact — the merge query (#40)", () => {
  test("SELECT * EXCLUDE (_rn), never an explicit column list — additive growth survives", () => {
    const sql = compactMergeSql(["/lake/a.parquet", "/lake/b.parquet"], {
      uniqueKey: ["event_id"],
      orderBy: ["arrived_at"],
    })
    expect(sql).toContain("SELECT * EXCLUDE (_rn)")
    // the projection must not name columns: one written today would freeze the
    // shape and silently drop whatever the writer adds tomorrow
    expect(sql).not.toContain('"source_node"')
    expect(sql).toContain(`row_number() OVER (PARTITION BY "event_id" ORDER BY "arrived_at")`)
  })

  test("a column the policy never heard of survives the merge, and _rn does not leak", async () => {
    const root = newLake()
    await scenario(
      Effect.gen(function* () {
        // `note` is in neither the model schema nor the policy — the archiver
        // simply started writing it
        yield* writeFile(
          root,
          "2026-03-08",
          "a.parquet",
          `${gen1("e1", "2026-03-08 01:00:00")}, 'kept' AS note`,
          600,
        )
        yield* writeFile(
          root,
          "2026-03-08",
          "b.parquet",
          `${gen1("e2", "2026-03-08 02:00:00")}, 'kept too' AS note`,
          600,
        )
        yield* compact({ models: [archive(root)], now: NOW })
        const merged = yield* rowsOf(`${root}/arrival_date=2026-03-08/compacted.parquet`)
        expect(Object.keys(merged[0] as object).sort()).toEqual(["arrived_at", "event_id", "note"])
      }),
    )
  })

  test("union_by_name — a transition-day partition holding two schema generations merges", async () => {
    const root = newLake()
    expect(compactMergeSql(["/lake/a.parquet"], { uniqueKey: [], orderBy: [] })).toContain(
      "union_by_name = true",
    )
    await scenario(
      Effect.gen(function* () {
        // the day the archiver grew a column: old and new files side by side
        yield* writeFile(root, "2026-03-08", "old.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        yield* writeFile(
          root,
          "2026-03-08",
          "new.parquet",
          gen2("e2", "2026-03-08 02:00:00", "node-a"),
          600,
        )
        yield* compact({ models: [archive(root)], now: NOW })
        const merged = (yield* rowsOf(
          `${root}/arrival_date=2026-03-08/compacted.parquet`,
        )) as ReadonlyArray<{ event_id: string; source_node: string | null }>
        expect(merged.map((row) => [row.event_id, row.source_node])).toEqual([
          ["e1", null],
          ["e2", "node-a"],
        ])
      }),
    )
  })

  test("dedup by the declared unique key during the merge", async () => {
    const root = newLake()
    await scenario(
      Effect.gen(function* () {
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        // the same event redelivered into a later file of the same partition
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e1", "2026-03-08 05:00:00"), 600)
        yield* writeFile(root, "2026-03-08", "c.parquet", gen1("e2", "2026-03-08 06:00:00"), 600)
        const report = yield* compact({ models: [archive(root)], now: NOW })
        expect(report.compacted[0]?.rows).toBe(2)
        const merged = (yield* rowsOf(
          `${root}/arrival_date=2026-03-08/compacted.parquet`,
        )) as ReadonlyArray<{ event_id: string; arrived_at: unknown }>
        expect(merged.map((row) => row.event_id)).toEqual(["e1", "e2"])
        // orderBy decides which copy survives: the first arrival
        expect(String(merged[0]!.arrived_at)).toContain("01:00")
      }),
    )
  })
})

describe("compact — scope boundary (#40)", () => {
  test("a foreign lake is compacted only where the declaration opted in", async () => {
    const root = newLake()
    const silent = defineExternal({
      name: "raw.silent",
      source: external.files(`${root}/**/*.parquet`, "parquet"),
      schema: Schema.Struct({ event_id: Schema.String }),
    })
    await scenario(
      Effect.gen(function* () {
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e2", "2026-03-08 02:00:00"), 600)
        const report = yield* compact({ models: [silent], now: NOW })
        expect(report.compacted).toEqual([])
        expect(report.skipped).toEqual([])
        expect(parquetIn(`${root}/arrival_date=2026-03-08`)).toEqual(["a.parquet", "b.parquet"])
      }),
    )
  })

  test("efmesh's own parquet partitions are a target without any declaration", async () => {
    const lake = newLake()
    const model = defineModel(
      {
        name: "core.events",
        kind: kind.incrementalByTimeRange({ timeColumn: "arrived_at", start: "2026-03-01" }),
        target: "parquet",
        grain: ["event_id"],
        schema: Schema.Struct({ event_id: Schema.String, arrived_at: Schema.DateTimeUtc }),
      },
      (ctx) => ctx.sql`SELECT 'e1' AS event_id, ${ctx.start} AS arrived_at`,
    )
    const partition = `${lake}/core/events/fp=abcdef12/interval=2026-03-08`
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        mkdirSync(partition, { recursive: true })
        for (const [name, body] of [
          ["data.parquet", gen1("e1", "2026-03-08 01:00:00")],
          ["extra.parquet", gen1("e2", "2026-03-08 02:00:00")],
        ] as const) {
          yield* Effect.orDie(
            engine.execute(`COPY (${body}) TO '${partition}/${name}' (FORMAT PARQUET)`),
          )
          const when = new Date(NOW - 600 * MINUTE)
          yield* Effect.sync(() => utimesSync(`${partition}/${name}`, when, when))
        }
        const report = yield* compact({ models: [model], lakePath: lake, now: NOW })
        // published under the executor's own file name: a lookback recompute
        // rewrites `data.parquet` for the whole partition, and a merged file
        // beside it under another name would make the partition read double
        expect(report.compacted[0]?.published).toBe(`${partition}/data.parquet`)
        expect(parquetIn(partition)).toEqual(["data.parquet"])
      }),
    )
  })

  test("a compact policy is refused at definition time where it cannot be honoured", () => {
    const cases: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "csv source",
        () =>
          defineExternal({
            name: "raw.bad",
            source: external.files("/lake/**/*.csv", "csv"),
            schema: Schema.Struct({ id: Schema.String }),
            maintenance: { compact: { partitionKey: "day" } },
          }),
      ],
      [
        "remote path",
        () =>
          defineExternal({
            name: "raw.bad",
            source: external.files("s3://bucket/lake/**/*.parquet", "parquet"),
            schema: Schema.Struct({ id: Schema.String }),
            maintenance: { compact: { partitionKey: "day" } },
          }),
      ],
      [
        "unknown key column",
        () =>
          defineExternal({
            name: "raw.bad",
            source: external.files("/lake/**/*.parquet", "parquet"),
            schema: Schema.Struct({ id: Schema.String }),
            maintenance: { compact: { partitionKey: "day", uniqueKey: ["nope"] } },
          }),
      ],
      [
        "empty partitionKey",
        () =>
          defineExternal({
            name: "raw.bad",
            source: external.files("/lake/**/*.parquet", "parquet"),
            schema: Schema.Struct({ id: Schema.String }),
            maintenance: { compact: { partitionKey: "" } },
          }),
      ],
    ]
    for (const [label, build] of cases) {
      expect(build, label).toThrow(/maintenance.compact/)
    }
  })
})

describe("compact --json (#40)", () => {
  test("dry run reports what would be merged and writes nothing", async () => {
    const root = newLake()
    await scenario(
      Effect.gen(function* () {
        yield* writeFile(root, "2026-03-08", "a.parquet", gen1("e1", "2026-03-08 01:00:00"), 600)
        yield* writeFile(root, "2026-03-08", "b.parquet", gen1("e2", "2026-03-08 02:00:00"), 600)
        yield* writeFile(root, "2026-03-10", "a.parquet", gen1("e3", "2026-03-10 01:00:00"), 600)
        yield* writeFile(root, "2026-03-10", "b.parquet", gen1("e4", "2026-03-10 02:00:00"), 600)
        const report = yield* compact({ models: [archive(root)], now: NOW, dryRun: true })
        expect(compactToJson(report)).toEqual({
          dryRun: true,
          compacted: [
            {
              model: "raw.events",
              partition: `${root}/arrival_date=2026-03-08`,
              files: 2,
              rows: null,
              published: `${root}/arrival_date=2026-03-08/compacted.parquet`,
            },
          ],
          skipped: [
            {
              model: "raw.events",
              partition: `${root}/arrival_date=2026-03-10`,
              reason: "current-day",
            },
          ],
        })
        expect(parquetIn(`${root}/arrival_date=2026-03-08`)).toEqual(["a.parquet", "b.parquet"])
      }),
    )
  })
})
