import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { compactForCli } from "../src/cli/maintenance.ts"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineModel, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { compact } from "../src/plan/compact.ts"
import { janitorLockName, withStateLock } from "../src/plan/lock.ts"
import { janitor } from "../src/plan/janitor.ts"
import { parquetPrefix, physicalRef } from "../src/plan/naming.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const NOW = fromIso("2027-03-10T12:00:00Z")
const WRITTEN = fromIso("2027-03-09T00:00:00Z")
const model = (version: string) =>
  defineModel(
    {
      name: "med.events",
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2027-03-08T00:00:00Z",
        batchSize: 1,
      }),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      target: "parquet",
      grain: ["id"],
    },
    (ctx) =>
      ctx.sql`SELECT ${version} AS id, TIMESTAMP '2027-03-08 10:00:00' AS happened_at WHERE TIMESTAMP '2027-03-08 10:00:00' >= ${ctx.start} AND TIMESTAMP '2027-03-08 10:00:00' < ${ctx.end}`,
  )
const inventory = (root: string) =>
  existsSync(root) ? readdirSync(root, { recursive: true }).map(String).sort() : []
const scenario = async <A, E>(
  body: (lake: string, statePath: string) => Effect.Effect<A, E, EngineAdapter | StateStore>,
) => {
  const root = mkdtempSync(join(tmpdir(), "efmesh-maintenance-"))
  const lake = join(root, "lake")
  const statePath = join(root, "state.sqlite")
  try {
    return await Effect.runPromise(
      body(lake, statePath).pipe(
        Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive({ path: statePath }))),
      ),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const setup = (lake: string) =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const oldModel = model("old")
    const liveModel = model("live")
    const first = yield* Efmesh.apply("dev", [oldModel], { lakePath: lake, now: WRITTEN })
    const old = first.plan.actions[0]!
    const next = yield* Efmesh.apply("dev", [liveModel], { lakePath: lake, now: WRITTEN })
    const live = next.plan.actions[0]!
    expect(live.physicalFingerprint).not.toBe(old.physicalFingerprint)
    const oldPrefix = parquetPrefix(lake, oldModel.name, old.physicalFingerprint)
    const livePrefix = parquetPrefix(lake, liveModel.name, live.physicalFingerprint)
    for (const [prefix, id] of [
      [oldPrefix, "old-extra"],
      [livePrefix, "live-extra"],
    ] as const) {
      const partition = `${prefix}/interval=2027-03-08`
      yield* engine.execute(
        `COPY (SELECT '${id}' AS id, TIMESTAMP '2027-03-08 11:00:00' AS happened_at) TO '${partition}/extra.parquet' (FORMAT PARQUET)`,
      )
      for (const file of ["data.parquet", "extra.parquet"])
        utimesSync(`${partition}/${file}`, new Date(NOW - 3600000), new Date(NOW - 3600000))
    }
    return {
      model: liveModel,
      old,
      live,
      oldPrefix,
      livePrefix,
      options: { models: [liveModel], lakePath: lake, now: NOW, graceMinutes: 0 },
      cleanup: { lakePath: lake, ttlDays: 0, now: NOW },
    }
  })
const assertLive = (prefix: string) =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    expect(
      yield* engine.query(
        `SELECT id FROM read_parquet('${prefix}/**/*.parquet', hive_partitioning = false) ORDER BY id`,
      ),
    ).toEqual([{ id: "live" }, { id: "live-extra" }])
    expect(yield* engine.query("SELECT id FROM dev__med.events ORDER BY id")).toEqual([
      { id: "live" },
      { id: "live-extra" },
    ])
  })

describe("compact and janitor ordering on the same local lake (#58)", () => {
  for (const order of ["compact-first", "janitor-first"] as const) {
    test(`${order}: orphan storage disappears; live data survives`, async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          const fixture = yield* setup(lake)
          if (order === "compact-first") {
            const merged = yield* compact(fixture.options)
            expect(merged.compacted).toHaveLength(2)
            expect(inventory(fixture.oldPrefix)).toEqual([
              "interval=2027-03-08",
              "interval=2027-03-08/data.parquet",
              "manifest.json",
            ])
          }
          const removed = yield* janitor(fixture.cleanup)
          expect(removed.removed).toEqual([`med.events@${fixture.old.fingerprint.slice(0, 8)}`])
          if (order === "janitor-first")
            expect((yield* compact(fixture.options)).compacted).toHaveLength(1)
          expect(inventory(fixture.oldPrefix)).toEqual([])
          expect(existsSync(fixture.oldPrefix)).toBe(false)
          yield* assertLive(fixture.livePrefix)
          const store = yield* StateStore
          expect(
            yield* store.getSnapshot(fixture.old.name, fixture.old.fingerprint),
          ).toBeUndefined()
          expect((yield* janitor(fixture.cleanup)).removed).toEqual([])
        }),
      )
    })
  }

  test("unsupported raw overlap: janitor deletes snapshotted inputs before merge; error, no resurrection", async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        let removed = false
        const cleanup = janitor(fixture.cleanup).pipe(
          Effect.provideService(EngineAdapter, engine),
          Effect.provideService(StateStore, store),
        )
        const exit = yield* Effect.exit(
          compact({
            ...fixture.options,
            afterSnapshot: (partition) =>
              partition.startsWith(fixture.oldPrefix)
                ? cleanup.pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        removed = true
                      }),
                    ),
                    Effect.asVoid,
                    Effect.orDie,
                  )
                : Effect.void,
          }),
        )
        expect(removed).toBe(true)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toMatch(/No files|does not exist|not found/)
        expect(existsSync(fixture.oldPrefix)).toBe(false)
        expect(inventory(lake).some((file) => file.endsWith(".tmp"))).toBe(false)
        yield* assertLive(fixture.livePrefix)
      }),
    )
  })

  test("unsupported raw overlap: janitor deletes a completed temp before publication; no resurrection", async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        const cleanup = janitor(fixture.cleanup).pipe(
          Effect.provideService(EngineAdapter, engine),
          Effect.provideService(StateStore, store),
        )
        let removed = false
        const controlled = {
          ...engine,
          query: (sql: string) =>
            engine.query(sql).pipe(
              Effect.tap(() => {
                if (removed || !sql.includes(fixture.oldPrefix) || !sql.includes(".tmp"))
                  return Effect.void
                removed = true
                return cleanup.pipe(Effect.asVoid, Effect.orDie)
              }),
            ),
        }
        const exit = yield* Effect.exit(
          compact(fixture.options).pipe(Effect.provideService(EngineAdapter, controlled)),
        )
        expect(removed).toBe(true)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("ENOENT")
        expect(existsSync(fixture.oldPrefix)).toBe(false)
        expect(inventory(lake).some((file) => file.endsWith(".tmp"))).toBe(false)
        yield* assertLive(fixture.livePrefix)
      }),
    )
  })

  test("unsupported raw overlap: compact publishes after janitor claims state; whole-prefix removal still collects it", async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        const drop = `DROP TABLE IF EXISTS ${physicalRef(fixture.model.name, fixture.old.physicalFingerprint)}`
        let published = false
        const controlled = {
          ...engine,
          execute: (sql: string) =>
            Effect.gen(function* () {
              if (sql === drop && !published) {
                expect(
                  yield* store.getSnapshot(fixture.old.name, fixture.old.fingerprint),
                ).toBeUndefined()
                yield* compact(fixture.options).pipe(Effect.provideService(EngineAdapter, engine))
                expect(inventory(fixture.oldPrefix)).toEqual([
                  "interval=2027-03-08",
                  "interval=2027-03-08/data.parquet",
                  "manifest.json",
                ])
                published = true
              }
              yield* engine.execute(sql)
            }),
        }
        yield* janitor(fixture.cleanup).pipe(Effect.provideService(EngineAdapter, controlled))
        expect(published).toBe(true)
        expect(existsSync(fixture.oldPrefix)).toBe(false)
        yield* assertLive(fixture.livePrefix)
        expect((yield* janitor(fixture.cleanup)).removed).toEqual([])
      }),
    )
  })

  test("a consumed input disappearing before unlink is harmless: merged rows survive", async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const engine = yield* EngineAdapter
        let unlinked = false
        const controlled = {
          ...engine,
          query: (sql: string) =>
            engine.query(sql).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (!unlinked && sql.includes(fixture.oldPrefix) && sql.includes(".tmp")) {
                    rmSync(`${fixture.oldPrefix}/interval=2027-03-08/extra.parquet`)
                    unlinked = true
                  }
                }),
              ),
            ),
        }
        yield* compact(fixture.options).pipe(Effect.provideService(EngineAdapter, controlled))
        expect(unlinked).toBe(true)
        expect(
          yield* engine.query(
            `SELECT id FROM read_parquet('${fixture.oldPrefix}/**/*.parquet', hive_partitioning = false) ORDER BY id`,
          ),
        ).toEqual([{ id: "old" }, { id: "old-extra" }])
        yield* assertLive(fixture.livePrefix)
        yield* janitor(fixture.cleanup)
        expect(existsSync(fixture.oldPrefix)).toBe(false)
      }),
    )
  })

  test("janitor leaves referenced storage intact while raw compact operates on it", async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        yield* janitor(fixture.cleanup)
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        const cleanup = janitor(fixture.cleanup).pipe(
          Effect.provideService(EngineAdapter, engine),
          Effect.provideService(StateStore, store),
        )
        let checked = false
        yield* compact({
          ...fixture.options,
          afterSnapshot: () =>
            cleanup.pipe(
              Effect.tap((report) =>
                Effect.sync(() => {
                  expect(report.removed).toEqual([])
                  checked = true
                }),
              ),
              Effect.asVoid,
              Effect.orDie,
            ),
        })
        expect(checked).toBe(true)
        yield* assertLive(fixture.livePrefix)
      }),
    )
  })
})

describe("CLI maintenance exclusion through the configured state store (#58)", () => {
  test("compact holds the janitor mutex; another store connection refuses cleanup", async () => {
    await scenario((lake, statePath) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const engine = yield* EngineAdapter
        let checked = false
        const competing = Effect.exit(janitor(fixture.cleanup)).pipe(
          Effect.provideService(EngineAdapter, engine),
          Effect.provide(SqliteStateLive({ path: statePath })),
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("lock «janitor»")
              expect(existsSync(fixture.oldPrefix)).toBe(true)
              checked = true
            }),
          ),
          Effect.asVoid,
          Effect.orDie,
        )
        const competingCompact = Effect.exit(compactForCli(fixture.options)).pipe(
          Effect.provideService(EngineAdapter, engine),
          Effect.provide(SqliteStateLive({ path: statePath })),
          Effect.tap((exit) =>
            Effect.sync(() => {
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("lock «janitor»")
            }),
          ),
          Effect.asVoid,
          Effect.orDie,
        )
        yield* compactForCli({
          ...fixture.options,
          afterSnapshot: (partition) =>
            partition.startsWith(fixture.oldPrefix)
              ? competing.pipe(Effect.andThen(competingCompact))
              : Effect.void,
        })
        expect(checked).toBe(true)
        yield* assertLive(fixture.livePrefix)
        const removed = yield* janitor(fixture.cleanup)
        expect(removed.removed).toHaveLength(1)
        expect(existsSync(fixture.oldPrefix)).toBe(false)
      }),
    )
  })

  test("janitor holds its mutex; CLI compact refuses before listing or publishing", async () => {
    await scenario((lake, statePath) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const engine = yield* EngineAdapter
        const drop = `DROP TABLE IF EXISTS ${physicalRef(fixture.model.name, fixture.old.physicalFingerprint)}`
        let checked = false
        const controlled = {
          ...engine,
          execute: (sql: string) =>
            Effect.gen(function* () {
              if (sql === drop && !checked) {
                const before = inventory(fixture.oldPrefix)
                for (const dryRun of [false, true]) {
                  const exit = yield* Effect.exit(
                    compactForCli({ ...fixture.options, dryRun }).pipe(
                      Effect.provideService(EngineAdapter, engine),
                      Effect.provide(SqliteStateLive({ path: statePath })),
                    ),
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                  if (Exit.isFailure(exit))
                    expect(Cause.pretty(exit.cause)).toContain("lock «janitor»")
                  expect(inventory(fixture.oldPrefix)).toEqual(before)
                }
                checked = true
              }
              yield* engine.execute(sql)
            }),
        }
        yield* janitor(fixture.cleanup).pipe(Effect.provideService(EngineAdapter, controlled))
        expect(checked).toBe(true)
        expect(existsSync(fixture.oldPrefix)).toBe(false)
        expect((yield* compactForCli(fixture.options)).compacted).toHaveLength(1)
        yield* assertLive(fixture.livePrefix)
      }),
    )
  })

  test("a failed CLI merge releases the mutex for subsequent janitor cleanup", async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const exit = yield* Effect.exit(
          compactForCli({
            ...fixture.options,
            afterSnapshot: (partition) =>
              Effect.sync(() => {
                if (partition.startsWith(fixture.oldPrefix)) {
                  rmSync(`${partition}/data.parquet`)
                  rmSync(`${partition}/extra.parquet`)
                }
              }),
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* janitor(fixture.cleanup)).removed).toHaveLength(1)
        expect(existsSync(fixture.oldPrefix)).toBe(false)
        yield* assertLive(fixture.livePrefix)
      }),
    )
  })
})

test("real CLI commands refuse the held maintenance lease with exit 1 and empty stdout", async () => {
  const configRoot = mkdtempSync(join(import.meta.dir, "..", "efmesh-maintenance-test-"))
  try {
    await scenario((lake, statePath) =>
      Effect.gen(function* () {
        const fixture = yield* setup(lake)
        const config = join(configRoot, "efmesh.config.ts")
        writeFileSync(
          config,
          `import { defineConfig } from "../src/config.ts"\nexport default defineConfig(${JSON.stringify({ models: [], engine: { path: ":memory:" }, state: { path: statePath }, lake: { path: lake } })})\n`,
        )
        const before = inventory(lake)
        yield* withStateLock(janitorLockName)(
          Effect.promise(async () => {
            for (const args of [["compact"], ["compact", "--dry-run"], ["janitor"]]) {
              const child = Bun.spawn(
                [
                  process.execPath,
                  join(import.meta.dir, "../src/bin.ts"),
                  ...args,
                  "--config",
                  config,
                ],
                { stdout: "pipe", stderr: "pipe" },
              )
              const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
              ])
              expect(code).toBe(1)
              expect(stdout.trim()).toBe("")
              expect(stderr).toContain("lock «janitor»")
              expect(inventory(lake)).toEqual(before)
            }
          }),
        )
        yield* assertLive(fixture.livePrefix)
      }),
    )
  } finally {
    rmSync(configRoot, { recursive: true, force: true })
  }
}, 15000)
