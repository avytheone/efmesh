import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, kind, type AnyModel } from "../src/core/model.ts"
import type { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"
import type { PlanAction } from "../src/plan/planner.ts"

/**
 * #4: plan --explain. Категорию замораживает categorize.test.ts; здесь —
 * что к каждой категории приложено правдивое обоснование: КАКИЕ узлы
 * канонического AST разошлись и откуда каскад.
 */

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const src = defineModel(
  {
    name: "med.src",
    kind: kind.full(),
    schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b`,
)

const consumerOf = (parent: AnyModel) =>
  defineModel(
    {
      name: "med.consumer",
      kind: kind.full(),
      schema: Schema.Struct({ a: Schema.String }),
    },
    (ctx) => ctx.sql`SELECT a FROM ${ctx.ref(parent)}`,
  )

const actionsAfter = async (
  before: ReadonlyArray<AnyModel>,
  after: ReadonlyArray<AnyModel>,
): Promise<ReadonlyMap<string, PlanAction>> =>
  scenario(
    Effect.gen(function* () {
      yield* Efmesh.apply("dev", before)
      const plan = yield* Efmesh.plan("dev", after)
      return new Map(plan.actions.map((a) => [a.name, a]))
    }),
  )

describe("plan --explain (#4)", () => {
  test("суффикс SELECT: non-breaking, разошёлся только хвост списка", async () => {
    const widened = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String, c: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b, 'z' AS c`,
    )
    const action = (await actionsAfter([src], [widened])).get("med.src")!
    expect(action.change).toBe("non-breaking")
    expect(action.explain?.reason).toContain("в конец")
    expect(action.explain?.diverged).toEqual(["select_list[2] (добавлен)"])
  })

  test("правка выражения колонки: breaking, путь указывает в её значение", async () => {
    const reworked = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'CHANGED' AS a, 'y' AS b`,
    )
    const action = (await actionsAfter([src], [reworked])).get("med.src")!
    expect(action.change).toBe("breaking")
    expect(action.explain?.reason).toContain("не только хвостом")
    expect(
      action.explain?.diverged.some((path) => path.startsWith("select_list[0]")),
    ).toBe(true)
  })

  test("удаление колонки: breaking с причиной про удаление", async () => {
    const dropped = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a`,
    )
    const action = (await actionsAfter([src], [dropped])).get("med.src")!
    expect(action.change).toBe("breaking")
    expect(action.explain?.reason).toContain("удалены")
    expect(action.explain?.diverged).toContain("select_list[1] (удалён)")
  })

  test("правка WHERE: breaking, дерево разошлось вне списка SELECT", async () => {
    const filtered = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b WHERE 1 = 1`,
    )
    const action = (await actionsAfter([src], [filtered])).get("med.src")!
    expect(action.change).toBe("breaking")
    expect(action.explain?.reason).toContain("вне списка SELECT")
    expect(
      action.explain?.diverged.some((path) => path.includes("where_clause")),
    ).toBe(true)
  })

  test("потомок с нетронутым телом: indirect с cascadeFrom на родителя", async () => {
    const filtered = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b WHERE 1 = 1`,
    )
    const action = (
      await actionsAfter([src, consumerOf(src)], [filtered, consumerOf(filtered)])
    ).get("med.consumer")!
    expect(action.change).toBe("indirect")
    expect(action.explain?.cascadeFrom).toEqual(["med.src"])
    expect(action.explain?.reason).toContain("med.src")
  })

  test("смена метаданных (grain): indirect с причиной про метаданные", async () => {
    const regrained = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
        grain: ["a"],
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b`,
    )
    const action = (await actionsAfter([src], [regrained])).get("med.src")!
    expect(action.change).toBe("indirect")
    expect(action.explain?.cascadeFrom).toBeUndefined()
    expect(action.explain?.reason).toContain("метаданные")
  })

  test("unchanged и added — без explain (сравнивать не с чем)", async () => {
    const actions = await actionsAfter([src], [src, consumerOf(src)])
    expect(actions.get("med.src")!.change).toBe("unchanged")
    expect(actions.get("med.src")!.explain).toBeUndefined()
    expect(actions.get("med.consumer")!.change).toBe("added")
    expect(actions.get("med.consumer")!.explain).toBeUndefined()
  })
})
