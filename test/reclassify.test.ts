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
 * #5: indirect-реюз физики и override категоризации. Потомок, чьё тело не
 * менялось, а изменившиеся родители не трогают существующие данные
 * (non-breaking/forward-only), наследует физику старой версии — scdType2 не
 * теряет историю, full не пересобирается. --reclassify заявляет вердикт
 * оператора поверх --explain и этим управляет судьбой потомков.
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

/** Та же base, но с колонкой в хвосте — non-breaking по вердикту планировщика. */
const baseWide = defineModel(
  {
    name: "med.base",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, name: Schema.String, uname: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT id, name, upper(name) AS uname FROM ${ctx.ref(raw)}`,
)

/** Та же base с правкой WHERE — честный breaking. */
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

describe("indirect-реюз физики (#5)", () => {
  test("suffix родителя: потомки наследуют физику, scd не теряет историю", async () => {
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

        // применение: scd-история не переигрывается — valid_from остаётся t1,
        // а не t2 свежепересобранной таблицы
        yield* Efmesh.apply("dev", models, { now: t2 })
        const rows = yield* engine.query(
          `SELECT id, CAST(valid_from AS VARCHAR) AS f, valid_to FROM dev__med.dim ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "p1", f: "2026-03-01 00:00:00", valid_to: null },
          { id: "p2", f: "2026-03-01 00:00:00", valid_to: null },
        ])
        // снапшот новой версии указывает на физику старой
        expect(yield* physicalFpOf("med.dim", dim.fingerprint)).toBe(
          oldDim.physicalFingerprint,
        )
      }),
    )
  })

  test("breaking родителя: потомок indirect, но реюза нет", async () => {
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

  test("родитель и метаданные потомка разошлись разом — реюза нет", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, base, martOf(base)])
        // suffix у родителя + grain у витрины: «версию сдвинули только
        // родители» не подтверждается — физика не наследуется
        const plan = yield* Efmesh.plan("dev", [raw, baseWide, martOf(baseWide, ["n"])])
        const mart = plan.actions.find((a) => a.name === "med.mart")!
        expect(mart.change).toBe("indirect")
        expect(mart.reusedFrom).toBeUndefined()
      }),
    )
  })
})

describe("--reclassify (#5)", () => {
  test("breaking → non-breaking: вердикт оператора открывает потомкам реюз", async () => {
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

  test("гвардрейл: удалённые колонки не бывают non-breaking", async () => {
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

  test("незнакомая модель — ошибка; совпадающий вердикт и unchanged — no-op", async () => {
    await scenario(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, base])
        const missing = yield* Effect.flip(
          Efmesh.plan("dev", [raw, base], { reclassify: { "med.ghost": "breaking" } }),
        )
        expect(missing._tag).toBe("ReclassifyError")
        // модель без изменений: override молча не применяется
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
