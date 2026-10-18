import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Layer, Schema } from "effect"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { fromIso } from "../src/core/interval.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import type { Manifest } from "../src/plan/manifest.ts"
import { parquetPrefix } from "../src/plan/naming.ts"
import { environmentPassport } from "../src/plan/passport.ts"
import { restate } from "../src/plan/restate.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const day = (n: number) => `2026-01-0${n}T00:00:00.000Z`
const now = fromIso(day(7))
const schema = Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc })
const raw = defineExternal({ name: "raw.events", source: external.table("src.events"), schema })
const modelsFor = (target: "table" | "parquet") => {
  const incremental = (name: string, upstream: AnyModel) =>
    defineModel(
      {
        name,
        schema,
        target,
        kind: kind.incrementalByTimeRange({
          timeColumn: "happened_at",
          start: day(1),
          batchSize: 1,
        }),
      },
      (ctx) =>
        ctx.sql`SELECT id, happened_at FROM ${ctx.ref(upstream)} WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}`,
    )
  const source = incremental("staging.events", raw)
  const child = incremental("mart.events", source)
  const leaf = incremental("report.events", child)
  const full = defineModel(
    { name: "summary.events", schema, target, kind: kind.full() },
    (ctx) => ctx.sql`SELECT id, happened_at FROM ${ctx.ref(leaf)}`,
  )
  return [raw, source, child, leaf, full]
}
const scenario = async <A, E>(
  body: (lake: string) => Effect.Effect<A, E, EngineAdapter | StateStore>,
) => {
  const root = mkdtempSync(join(tmpdir(), "efmesh-restate-passport-"))
  try {
    return await Effect.runPromise(
      body(join(root, "lake")).pipe(
        Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())),
      ),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const setup = (lake: string, target: "table" | "parquet") =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const models = modelsFor(target)
    yield* engine.execute("CREATE SCHEMA src")
    yield* engine.execute(
      "CREATE TABLE src.events AS SELECT 'event' AS id, TIMESTAMP '2026-01-03 12:00:00' AS happened_at",
    )
    const applied = yield* Efmesh.apply("dev", models, { now, lakePath: lake })
    const paths = new Map(
      applied.plan.actions
        .filter((a) => a.name !== "raw.events")
        .map((a) => [
          a.name,
          `${parquetPrefix(lake, models.find((m) => m.name.full === a.name)!.name, a.physicalFingerprint)}/manifest.json`,
        ]),
    )
    return { models, paths, options: { now, lakePath: lake } }
  })
const passports = (models: AnyModel[]) =>
  environmentPassport("dev", models).pipe(
    Effect.map((report) => new Map(report.models.map((p) => [p.model, p]))),
  )
const ledger = Effect.gen(function* () {
  const store = yield* StateStore
  const env = yield* store.getEnvironment("dev")
  const intervals = yield* Effect.forEach(env, (r) => store.listIntervals(r.fingerprint))
  return {
    env,
    intervals,
    snapshots: yield* store.listSnapshots(),
    plans: yield* store.listPlans("dev"),
    runs: yield* store.listRuns("dev", 10),
    lock: yield* store.lockExpiry("env:dev"),
  }
})
const manifest = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"))
const artifacts = (lake: string) =>
  readdirSync(lake, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      return [path, readFileSync(path).toString("base64")]
    })
    .sort(([a], [b]) => a!.localeCompare(b!))

for (const target of ["table", "parquet"] as const) {
  describe(`restate × live passport on ${target} (#59)`, () => {
    test("middle-range hole retreats coverage while later done intervals remain", async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          const f = yield* setup(lake, target)
          expect((yield* passports(f.models)).get("report.events")!.effective.completeThrough).toBe(
            day(7),
          )
          yield* restate("dev", "report.events", day(3), day(4), f.models)
          const after = yield* passports(f.models)
          expect(after.get("report.events")!.freshness).toEqual({
            contiguousThrough: day(3),
            latestInterval: day(7),
            failedIntervals: 0,
          })
          expect(after.get("report.events")!.effective.completeThrough).toBe(day(3))
          expect(after.get("report.events")!.effective.limitedBy).toBe("report.events")
          expect(after.get("mart.events")!.effective.completeThrough).toBe(day(7))
          expect(after.get("summary.events")!.effective.completeThrough).toBe(day(3))
          expect(after.get("summary.events")!.effective.limitedBy).toBe("report.events")
        }),
      )
    })
    test("restated source limits every descendant, including full models without a ledger", async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          const f = yield* setup(lake, target)
          const plan = yield* restate("dev", "staging.events", day(3), day(4), f.models)
          expect(plan.targets.map((t) => t.name)).toEqual([
            "staging.events",
            "mart.events",
            "report.events",
          ])
          const after = yield* passports(f.models)
          for (const name of ["staging.events", "mart.events", "report.events", "summary.events"]) {
            expect(after.get(name)!.effective.completeThrough).toBe(day(3))
            expect(after.get(name)!.effective.limitedBy).toBe("staging.events")
          }
          expect(after.get("summary.events")!.freshness.contiguousThrough).toBeNull()
          yield* Efmesh.apply("dev", f.models, f.options)
          const recovered = yield* passports(f.models)
          for (const name of ["staging.events", "mart.events", "report.events", "summary.events"])
            expect(recovered.get(name)!.effective.completeThrough).toBe(day(7))
        }),
      )
    })
    test("dry-run preserves every ledger, promoted pointer, passport and published byte", async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          const f = yield* setup(lake, target)
          const before = yield* ledger
          const beforePassports = yield* passports(f.models)
          const engine = yield* EngineAdapter
          const beforeRows = yield* engine.query("SELECT * FROM dev__summary.events")
          const beforeFiles = target === "parquet" ? artifacts(lake) : []
          expect(
            (yield* restate("dev", "staging.events", day(3), day(4), f.models, { dryRun: true }))
              .dryRun,
          ).toBe(true)
          expect(yield* ledger).toEqual(before)
          expect(yield* passports(f.models)).toEqual(beforePassports)
          expect(yield* engine.query("SELECT * FROM dev__summary.events")).toEqual(beforeRows)
          if (target === "parquet") expect(artifacts(lake)).toEqual(beforeFiles)
        }),
      )
    })
  })
}

test("published manifests stay stale after restate; tested successful recomputation restores coverage", async () => {
  await scenario((lake) =>
    Effect.gen(function* () {
      const f = yield* setup(lake, "parquet")
      const before = artifacts(lake)
      yield* restate("dev", "staging.events", day(3), day(4), f.models)
      expect(artifacts(lake)).toEqual(before)
      const live = yield* passports(f.models)
      for (const [name, path] of f.paths) {
        expect(manifest(path).effective.completeThrough).toBe(day(7))
        expect(live.get(name)!.effective.completeThrough).toBe(day(3))
      }
      yield* Efmesh.apply("dev", f.models, f.options)
      const recovered = yield* passports(f.models)
      for (const [name, path] of f.paths) {
        expect(manifest(path).effective).toEqual(recovered.get(name)!.effective)
        expect(manifest(path).effective.completeThrough).toBe(day(7))
      }
    }),
  )
})

test("failed recomputation does not close the manifest staleness window", async () => {
  await scenario((lake) =>
    Effect.gen(function* () {
      const f = yield* setup(lake, "parquet")
      const engine = yield* EngineAdapter
      yield* restate("dev", "staging.events", day(3), day(4), f.models)
      yield* engine.execute("DROP TABLE src.events")
      expect(Exit.isFailure(yield* Effect.exit(Efmesh.apply("dev", f.models, f.options)))).toBe(
        true,
      )
      const live = yield* passports(f.models)
      for (const [name, path] of f.paths) {
        expect(manifest(path).effective.completeThrough).toBe(day(7))
        expect(live.get(name)!.effective.completeThrough).toBe(day(3))
      }
    }),
  )
})

test("successful apply alone is not proof that every affected manifest was published", async () => {
  await scenario((lake) =>
    Effect.gen(function* () {
      const f = yield* setup(lake, "parquet")
      yield* restate("dev", "staging.events", day(3), day(4), f.models)
      // Local publication failure is a warning, so an apply may still succeed.
      mkdirSync(`${f.paths.get("staging.events")!}.tmp`)
      yield* Efmesh.apply("dev", f.models, { ...f.options, now: fromIso(day(8)) })
      const live = yield* passports(f.models)
      expect(live.get("staging.events")!.effective.completeThrough).toBe(day(8))
      expect(manifest(f.paths.get("staging.events")!).effective.completeThrough).toBe(day(7))
      expect(manifest(f.paths.get("mart.events")!).effective.completeThrough).toBe(day(8))
      // An unchanged full model need not be materialized by the catch-up apply.
      expect(live.get("summary.events")!.effective.completeThrough).toBe(day(8))
      expect(manifest(f.paths.get("summary.events")!).effective.completeThrough).toBe(day(7))
      rmSync(`${f.paths.get("staging.events")!}.tmp`, { recursive: true })
      yield* Efmesh.apply("dev", f.models, { ...f.options, now: fromIso(day(8)) })
      expect(manifest(f.paths.get("staging.events")!).effective.completeThrough).toBe(day(7))
    }),
  )
})
