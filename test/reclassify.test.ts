import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

/**
 * #5: indirect physical reuse and categorization override. A child whose
 * body did not change, while changed parents do not touch existing data
 * (non-breaking/forward-only), inherits the physical table of the old
 * version — scdType2 does not lose history, full is not rebuilt.
 * --reclassify asserts the operator's verdict on top of --explain and thus
 * governs the fate of children.
 */

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.people",
  source: external.table("src.people"),
  schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
})

const base = defineModel(
  {
    name: "med.base",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT id, name FROM ${ctx.ref(raw)}`,
)

/** Same base, but with a column at the tail — non-breaking per the planner's verdict. */
const baseWide = defineModel(
  {
    name: "med.base",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, name: Schema.String, uname: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT id, name, upper(name) AS uname FROM ${ctx.ref(raw)}`,
)

/** Same base with a WHERE edit — an honest breaking. */
const baseFiltered = defineModel(
  {
    name: "med.base",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT id, name FROM ${ctx.ref(raw)} WHERE id <> 'nobody'`,
)

const dimOf = (parent: AnyModel) =>
  defineModel(
    {
      name: "med.dim",
      kind: kind.scdType2({ key: ["id"] }),
      schema: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        valid_from: Schema.NullOr(Schema.DateTimeUtc),
        valid_to: Schema.NullOr(Schema.DateTimeUtc),
      }),
    },
    (ctx) => ctx.sql`SELECT id, name FROM ${ctx.ref(parent)}`,
  )

const martOf = (parent: AnyModel, grain?: ReadonlyArray<"n">) =>
  defineModel(
    {
      name: "med.mart",
      kind: kind.full(),
      schema: Schema.Struct({ n: Schema.Number }),
      ...(grain !== undefined ? { grain } : {}),
    },
    (ctx) => ctx.sql`SELECT count(*)::INT AS n FROM ${ctx.ref(parent)}`,
  )

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(
    `CREATE TABLE src.people AS SELECT * FROM (VALUES ('p1', 'Анна'), ('p2', 'Борис')) t(id, name)`,
  )
})

const physicalFpOf = (name: string, fingerprint: string) =>
  Effect.gen(function* () {
    const store = yield* StateStore
    return (yield* store.getSnapshot(name, fingerprint))?.physicalFp
  })

describe("indirect physical reuse (#5)", () => {
  test("parent suffix: children inherit the physical table, scd keeps its history", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const t1 = fromIso("2026-03-01T00:00:00Z")
        const t2 = fromIso("2026-03-02T00:00:00Z")
        const applied = yield* Efmesh.apply("dev", [raw, base, dimOf(base), martOf(base)], {
          now: t1,
        })
        const oldDim = applied.plan.actions.find((a) => a.name === "med.dim")!
        const oldMart = applied.plan.actions.find((a) => a.name === "med.mart")!

        const models = [raw, baseWide, dimOf(baseWide), martOf(baseWide)]
        const plan = yield* Efmesh.plan("dev", models)
        const dim = plan.actions.find((a) => a.name === "med.dim")!
        const mart = plan.actions.find((a) => a.name === "med.mart")!
        expect(plan.actions.find((a) => a.name === "med.base")!.change).toBe("non-breaking")
        expect(dim.change).toBe("indirect")
        expect(dim.reusedFrom).toBe(oldDim.fingerprint)
        expect(dim.physicalFingerprint).toBe(oldDim.physicalFingerprint)
        expect(dim.explain?.cascadeFrom).toEqual(["med.base"])
        expect(mart.reusedFrom).toBe(oldMart.fingerprint)

        // application: scd history is not replayed — valid_from stays t1,
        // not the t2 of a freshly rebuilt table
        yield* Efmesh.apply("dev", models, { now: t2 })
        const rows = yield* engine.query(
          `SELECT id, CAST(valid_from AS VARCHAR) AS f, valid_to FROM dev__med.dim ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "p1", f: "2026-03-01 00:00:00", valid_to: null },
          { id: "p2", f: "2026-03-01 00:00:00", valid_to: null },
        ])
        // the new version's snapshot points at the old version's physical table
        expect(yield* physicalFpOf("med.dim", dim.fingerprint)).toBe(
          oldDim.physicalFingerprint,
        )
      }),
    )
  })

  test("parent breaking: the child is indirect, but there is no reuse", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, base, dimOf(base)])
        const plan = yield* Efmesh.plan("dev", [raw, baseFiltered, dimOf(baseFiltered)])
        expect(plan.actions.find((a) => a.name === "med.base")!.change).toBe("breaking")
        const dim = plan.actions.find((a) => a.name === "med.dim")!
        expect(dim.change).toBe("indirect")
        expect(dim.reusedFrom).toBeUndefined()
      }),
    )
  })

  test("parent and child metadata diverged at once — no reuse", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, base, martOf(base)])
        // parent suffix + mart grain: "only parents shifted the version" is
        // not confirmed — the physical table is not inherited
        const plan = yield* Efmesh.plan("dev", [raw, baseWide, martOf(baseWide, ["n"])])
        const mart = plan.actions.find((a) => a.name === "med.mart")!
        expect(mart.change).toBe("indirect")
        expect(mart.reusedFrom).toBeUndefined()
      }),
    )
  })
})

describe("--reclassify (#5)", () => {
  test("breaking → non-breaking: the operator's verdict opens reuse to children", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        const applied = yield* Efmesh.apply("dev", [raw, base, dimOf(base)])
        const oldDim = applied.plan.actions.find((a) => a.name === "med.dim")!
        const plan = yield* Efmesh.plan("dev", [raw, baseFiltered, dimOf(baseFiltered)], {
          reclassify: { "med.base": "non-breaking" },
        })
        const parent = plan.actions.find((a) => a.name === "med.base")!
        expect(parent.change).toBe("non-breaking")
        expect(parent.reclassifiedFrom).toBe("breaking")
        expect(parent.explain?.reason).toContain("override")
        const dim = plan.actions.find((a) => a.name === "med.dim")!
        expect(dim.reusedFrom).toBe(oldDim.fingerprint)
      }),
    )
  })

  test("guardrail: dropped columns are never non-breaking", async () => {
    const narrow = defineModel(
      {
        name: "med.base",
        kind: kind.full(),
        schema: Schema.Struct({ id: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT id FROM ${ctx.ref(raw)}`,
    )
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, base])
        const failure = yield* Effect.flip(
          Efmesh.plan("dev", [raw, narrow], { reclassify: { "med.base": "non-breaking" } }),
        )
        expect(failure._tag).toBe("ReclassifyError")
        expect(failure).toMatchObject({ model: "med.base" })
      }),
    )
  })

  test("unknown model — an error; a matching verdict and unchanged — a no-op", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, base])
        const missing = yield* Effect.flip(
          Efmesh.plan("dev", [raw, base], { reclassify: { "med.ghost": "breaking" } }),
        )
        expect(missing._tag).toBe("ReclassifyError")
        // a model with no changes: the override is silently not applied
        const plan = yield* Efmesh.plan("dev", [raw, base], {
          reclassify: { "med.base": "non-breaking" },
        })
        const action = plan.actions.find((a) => a.name === "med.base")!
        expect(action.change).toBe("unchanged")
        expect(action.reclassifiedFrom).toBeUndefined()
      }),
    )
  })
})
