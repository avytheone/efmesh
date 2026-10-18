import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { parquetPrefix, parquetRef, physicalRef } from "../src/plan/naming.ts"
import type { PlanAction } from "../src/plan/planner.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const jan3 = fromIso("2026-01-03T00:00:00Z")
const jan4 = fromIso("2026-01-04T00:00:00Z")
type Target = "native" | "parquet"
const targetOptions = (target: Target) =>
  target === "parquet" ? { target: "parquet" as const } : {}
const raw = defineExternal({
  name: "src.people",
  source: external.table("src.people"),
  schema: Schema.Struct({
    id: Schema.String,
    happened_at: Schema.DateTimeUtc,
    secret: Schema.String,
  }),
})
const seed = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute("CREATE SCHEMA src")
  yield* engine.execute(`CREATE TABLE src.people AS SELECT * FROM (VALUES
    ('p1', TIMESTAMP '2026-01-01 10:00:00', 'sensitive-one'),
    ('p2', TIMESTAMP '2026-01-02 10:00:00', 'sensitive-two'),
    ('p3', TIMESTAMP '2026-01-03 10:00:00', 'sensitive-three')
  ) t(id, happened_at, secret)`)
})
const incremental = (target: Target, wide = false) =>
  defineModel(
    {
      name: "med.people",
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        batchSize: 1,
      }),
      ...targetOptions(target),
      schema: wide
        ? Schema.Struct({
            id: Schema.String,
            happened_at: Schema.DateTimeUtc,
            secret: Schema.String,
            score: Schema.NullOr(Schema.Number),
          })
        : raw.schema,
      redact: ["secret"],
    },
    (ctx) =>
      wide
        ? ctx.sql`SELECT id, happened_at, secret, 100 AS score FROM ${ctx.ref(raw)} WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}`
        : ctx.sql`SELECT id, happened_at, secret FROM ${ctx.ref(raw)} WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}`,
  )
const relation = (model: AnyModel, action: PlanAction, lake: string) =>
  model.target === "parquet"
    ? parquetRef(lake, model.name, action.physicalFingerprint)
    : physicalRef(model.name, action.physicalFingerprint)

const inspectClean = (
  model: AnyModel,
  action: PlanAction,
  lake: string,
  columns: string[],
  count: number,
) =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const physical = relation(model, action, lake)
    expect(
      (yield* engine.describe(`SELECT * FROM ${physical}`)).map((column) => column.name),
    ).toEqual(columns)
    const rows = yield* engine.query(`SELECT * FROM ${physical}`)
    expect(rows).toHaveLength(count)
    expect(
      rows
        .flatMap((row) => Object.values(row))
        .some((value) => typeof value === "string" && value.startsWith("sensitive-")),
    ).toBe(false)
    if (model.target === "parquet") {
      const prefix = parquetPrefix(lake, model.name, action.physicalFingerprint)
      const files = [...new Bun.Glob("**/*.parquet").scanSync(prefix)]
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const path = join(prefix, file).replaceAll("'", "''")
        const fields = yield* engine.describe(
          `SELECT * FROM read_parquet('${path}', hive_partitioning = false)`,
        )
        expect(fields.some((column) => column.name === "secret")).toBe(false)
      }
    }
    const store = yield* StateStore
    expect((yield* store.getSnapshot(action.name, action.fingerprint))?.physicalFp).toBe(
      action.physicalFingerprint,
    )
  })

const scenario = async <A, E>(
  body: (lake: string) => Effect.Effect<A, E, EngineAdapter | StateStore>,
) => {
  const lake = mkdtempSync(join(tmpdir(), "efmesh-redaction-"))
  try {
    return await Effect.runPromise(
      body(lake).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
    )
  } finally {
    rmSync(lake, { recursive: true, force: true })
  }
}

for (const target of ["native", "parquet"] as const) {
  describe(`redaction interactions on ${target} storage (#57)`, () => {
    test("indirect reuse inherits the redacted storage, never the plain environment's storage", async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          yield* seed
          const parent = (wide: boolean) =>
            defineModel(
              {
                name: "med.base",
                kind: kind.full(),
                schema: wide
                  ? Schema.Struct({ ...raw.schema.fields, score: Schema.Number })
                  : raw.schema,
              },
              (ctx) =>
                wide
                  ? ctx.sql`SELECT id, happened_at, secret, 100 AS score FROM ${ctx.ref(raw)}`
                  : ctx.sql`SELECT id, happened_at, secret FROM ${ctx.ref(raw)}`,
            )
          const child = (base: AnyModel) =>
            defineModel(
              {
                name: "med.clean",
                kind: kind.full(),
                schema: raw.schema,
                redact: ["secret"],
                ...targetOptions(target),
              },
              (ctx) => ctx.sql`SELECT id, happened_at, secret FROM ${ctx.ref(base)}`,
            )
          const base = parent(false)
          const model = child(base)
          const models = [raw, base, model]
          const plain = yield* Efmesh.apply("plain", models, { lakePath: lake })
          const safe = yield* Efmesh.apply("safe", models, { lakePath: lake, redacted: true })
          const plainAction = plain.plan.actions.find((a) => a.name === "med.clean")!
          const safeAction = safe.plan.actions.find((a) => a.name === "med.clean")!
          expect(safeAction.physicalFingerprint).not.toBe(plainAction.physicalFingerprint)
          const base2 = parent(true)
          const applied = yield* Efmesh.apply("safe", [raw, base2, child(base2)], {
            lakePath: lake,
            redacted: true,
          })
          expect(applied.plan.actions.find((a) => a.name === "med.base")!.change).toBe(
            "non-breaking",
          )
          const action = applied.plan.actions.find((a) => a.name === "med.clean")!
          expect(action.change).toBe("indirect")
          expect(action.reusedFrom).toBe(safeAction.fingerprint)
          expect(action.physicalFingerprint).toBe(safeAction.physicalFingerprint)
          yield* inspectClean(model, action, lake, ["id", "happened_at"], 3)
        }),
      )
    })

    test("forward-only evolution of already-redacted storage preserves clean history", async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          yield* seed
          const first = yield* Efmesh.apply("safe", [raw, incremental(target)], {
            now: jan3,
            lakePath: lake,
            redacted: true,
          })
          const old = first.plan.actions.find((a) => a.name === "med.people")!
          const model = incremental(target, true)
          const applied = yield* Efmesh.apply("safe", [raw, model], {
            now: jan4,
            lakePath: lake,
            redacted: true,
            forwardOnly: ["med.people"],
          })
          const action = applied.plan.actions.find((a) => a.name === "med.people")!
          expect(action.change).toBe("forward-only")
          expect(action.reusedFrom).toBe(old.fingerprint)
          expect(action.physicalFingerprint).toBe(old.physicalFingerprint)
          expect(action.backfill).toEqual([{ start: jan3, end: jan4 }])
          yield* inspectClean(model, action, lake, ["id", "happened_at", "score"], 3)
          const store = yield* StateStore
          expect(
            (yield* store.listIntervals(action.fingerprint)).filter((row) => row.status === "done"),
          ).toHaveLength(3)
        }),
      )
    })

    test("enabling redaction rebuilds historical storage; old plain storage is retained", async () => {
      await scenario((lake) =>
        Effect.gen(function* () {
          yield* seed
          const model = incremental(target)
          const models = [raw, model]
          const first = yield* Efmesh.apply("dev", models, { now: jan3, lakePath: lake })
          const old = first.plan.actions.find((a) => a.name === "med.people")!
          const applied = yield* Efmesh.apply("dev", models, {
            now: jan4,
            lakePath: lake,
            redacted: true,
          })
          const action = applied.plan.actions.find((a) => a.name === "med.people")!
          expect(action.change).toBe("breaking")
          expect(action.reusedFrom).toBeUndefined()
          expect(action.physicalFingerprint).not.toBe(old.physicalFingerprint)
          expect(action.backfill).toEqual([{ start: fromIso("2026-01-01T00:00:00Z"), end: jan4 }])
          yield* inspectClean(model, action, lake, ["id", "happened_at"], 3)
          const engine = yield* EngineAdapter
          expect(
            (yield* engine.describe(`SELECT * FROM ${relation(model, old, lake)}`)).map(
              (column) => column.name,
            ),
          ).toContain("secret")
          expect(yield* engine.query("SELECT id FROM dev__med.people ORDER BY id")).toEqual([
            { id: "p1" },
            { id: "p2" },
            { id: "p3" },
          ])
          const repeated = yield* Efmesh.plan("dev", models, { now: jan4, redacted: true })
          expect(repeated.actions.find((a) => a.name === "med.people")!.change).toBe("unchanged")
        }),
      )
    })
  })
}

for (const target of ["native", "parquet"] as const) {
  test(`${target}: enabling redaction cannot inherit plain storage through forward-only`, async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        yield* seed
        const model = incremental(target)
        const models = [raw, model]
        const first = yield* Efmesh.apply("dev", models, { now: jan3, lakePath: lake })
        const old = first.plan.actions.find((action) => action.name === "med.people")!
        const options = { now: jan4, lakePath: lake, redacted: true, forwardOnly: ["med.people"] }
        const plan = yield* Efmesh.plan("dev", models, options)
        const action = plan.actions.find((entry) => entry.name === "med.people")!
        const outcome = yield* Efmesh.apply("dev", models, options).pipe(
          Effect.map(() => "applied"),
          Effect.catchTag("SchemaMismatchError", () => Effect.succeed("refused")),
        )
        const engine = yield* EngineAdapter
        const physical = relation(model, old, lake)
        const physicalColumns = (yield* engine.describe(`SELECT * FROM ${physical}`)).map(
          (column) => column.name,
        )
        const rows = (yield* engine.query(`SELECT * FROM ${physical}`)).length
        expect({ outcome, physicalColumns, rows }).toEqual({
          outcome: "refused",
          physicalColumns: ["id", "happened_at", "secret"],
          rows: 2,
        })
        const store = yield* StateStore
        expect(
          (yield* store.getEnvironment("dev")).find((entry) => entry.name === "med.people")!
            .fingerprint,
        ).toBe(old.fingerprint)
        expect(yield* store.getSnapshot(action.name, action.fingerprint)).toBeUndefined()
        expect(yield* store.listIntervals(action.fingerprint)).toEqual([])
      }),
    )
  })
}

for (const target of ["native", "parquet"] as const) {
  test(`${target}: a cached snapshot with plain storage cannot be promoted as redacted`, async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        yield* seed
        const model = incremental(target)
        const models = [raw, model]
        const first = yield* Efmesh.apply("plain", models, { now: jan3, lakePath: lake })
        const old = first.plan.actions.find((entry) => entry.name === "med.people")!
        const plan = yield* Efmesh.plan("safe", models, { now: jan3, redacted: true })
        const candidate = plan.actions.find((entry) => entry.name === "med.people")!
        const store = yield* StateStore
        const previous = (yield* store.getSnapshot(old.name, old.fingerprint))!
        // Isolated legacy-state fixture: the old forward-only path could publish this mapping.
        yield* store.upsertSnapshot({
          name: model.name.full,
          fingerprint: candidate.fingerprint,
          physicalFp: old.physicalFingerprint,
          canonicalAst: candidate.canonicalAst!,
          renderedSql: previous.renderedSql,
          kind: previous.kind,
          fingerprintVersion: previous.fingerprintVersion,
        })
        yield* store.markIntervals(
          candidate.fingerprint,
          (yield* store.listIntervals(old.fingerprint)).map((entry) => ({
            startTs: entry.startTs,
            endTs: entry.endTs,
          })),
          "done",
        )
        const cached = yield* Efmesh.plan("safe", models, { now: jan3, redacted: true })
        expect(cached.actions.find((entry) => entry.name === "med.people")!.build).toBe(false)
        const outcome = yield* Efmesh.apply("safe", models, {
          now: jan3,
          lakePath: lake,
          redacted: true,
        }).pipe(
          Effect.map(() => "applied"),
          Effect.catchTag("SchemaMismatchError", () => Effect.succeed("refused")),
        )
        expect(outcome).toBe("refused")
        expect(yield* store.getEnvironment("safe")).toEqual([])
        const engine = yield* EngineAdapter
        expect(
          (yield* engine.describe(`SELECT * FROM ${relation(model, old, lake)}`)).map(
            (column) => column.name,
          ),
        ).toContain("secret")
      }),
    )
  })

  test(`${target}: removing a redacted model does not inspect a removed graph node`, async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        yield* seed
        yield* Efmesh.apply("safe", [raw, incremental(target)], {
          now: jan3,
          lakePath: lake,
          redacted: true,
        })
        yield* Efmesh.apply("safe", [raw], { now: jan3, lakePath: lake, redacted: true })
        const store = yield* StateStore
        expect(
          (yield* store.getEnvironment("safe")).some((entry) => entry.name === "med.people"),
        ).toBe(false)
      }),
    )
  })
}

for (const target of ["native", "parquet"] as const) {
  test(`${target}: disabling redaction cannot pollute storage still shared by a safe environment`, async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        yield* seed
        const model = incremental(target)
        const models = [raw, model]
        const first = yield* Efmesh.apply("safe", models, {
          now: jan3,
          lakePath: lake,
          redacted: true,
        })
        const safe = first.plan.actions.find((entry) => entry.name === "med.people")!
        const second = yield* Efmesh.apply("dev", models, {
          now: jan3,
          lakePath: lake,
          redacted: true,
        })
        expect(
          second.plan.actions.find((entry) => entry.name === "med.people")!.physicalFingerprint,
        ).toBe(safe.physicalFingerprint)
        const options = { now: jan4, lakePath: lake, redacted: false, forwardOnly: ["med.people"] }
        const plan = yield* Efmesh.plan("dev", models, options)
        const candidate = plan.actions.find((entry) => entry.name === "med.people")!
        expect(candidate.reusedFrom).toBe(safe.fingerprint)
        expect(candidate.physicalFingerprint).toBe(safe.physicalFingerprint)
        const outcome = yield* Efmesh.apply("dev", models, options).pipe(
          Effect.map(() => "applied"),
          Effect.catchTag("SchemaMismatchError", () => Effect.succeed("refused")),
        )
        const engine = yield* EngineAdapter
        const physical = relation(model, safe, lake)
        const physicalColumns = (yield* engine.describe(`SELECT * FROM ${physical}`)).map(
          (column) => column.name,
        )
        const rows = (yield* engine.query(`SELECT * FROM ${physical}`)).length
        expect({ outcome, physicalColumns, rows }).toEqual({
          outcome: "refused",
          physicalColumns: ["id", "happened_at"],
          rows: 2,
        })
        yield* inspectClean(model, safe, lake, ["id", "happened_at"], 2)
        const store = yield* StateStore
        for (const env of ["safe", "dev"]) {
          expect(
            (yield* store.getEnvironment(env)).find((entry) => entry.name === "med.people")!
              .fingerprint,
          ).toBe(safe.fingerprint)
        }
        expect(yield* store.getSnapshot(candidate.name, candidate.fingerprint)).toBeUndefined()
        expect(yield* store.listIntervals(candidate.fingerprint)).toEqual([])
        // A regular apply forks clean and plain storage instead of mutating the shared prefix/table.
        const plain = yield* Efmesh.apply("dev", models, {
          now: jan4,
          lakePath: lake,
          redacted: false,
        })
        const plainAction = plain.plan.actions.find((entry) => entry.name === "med.people")!
        expect(plainAction.physicalFingerprint).not.toBe(safe.physicalFingerprint)
        expect(
          (yield* engine.describe(`SELECT * FROM ${relation(model, plainAction, lake)}`)).map(
            (column) => column.name,
          ),
        ).toContain("secret")
        yield* inspectClean(model, safe, lake, ["id", "happened_at"], 2)
      }),
    )
  })

  test(`${target}: forward-only may evolve already-plain storage with a retained redaction policy`, async () => {
    await scenario((lake) =>
      Effect.gen(function* () {
        yield* seed
        const first = yield* Efmesh.apply("dev", [raw, incremental(target)], {
          now: jan3,
          lakePath: lake,
        })
        const old = first.plan.actions.find((entry) => entry.name === "med.people")!
        const model = incremental(target, true)
        const applied = yield* Efmesh.apply("dev", [raw, model], {
          now: jan4,
          lakePath: lake,
          redacted: false,
          forwardOnly: ["med.people"],
        })
        const action = applied.plan.actions.find((entry) => entry.name === "med.people")!
        expect(action.change).toBe("forward-only")
        expect(action.physicalFingerprint).toBe(old.physicalFingerprint)
        const engine = yield* EngineAdapter
        expect(
          (yield* engine.describe(`SELECT * FROM ${relation(model, action, lake)}`)).map(
            (column) => column.name,
          ),
        ).toEqual(["id", "happened_at", "secret", "score"])
        expect(yield* engine.query(`SELECT * FROM ${relation(model, action, lake)}`)).toHaveLength(
          3,
        )
      }),
    )
  })
}
