import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { defineModel, kind } from "../src/index.ts"
// внутренности графа и рендера — не публичное API, тестируются напрямую
import { buildGraph, transitiveDependents } from "../src/core/graph.ts"
import { render } from "../src/core/sql.ts"

const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.full(),
    schema: Schema.Struct({
      move_id: Schema.String,
      case_id: Schema.String,
      dept: Schema.String,
    }),
  },
  (ctx) => ctx.sql`SELECT 'm1' AS move_id, 'c1' AS case_id, 'ОРИТ' AS dept`,
)

const stays = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({ stay_id: Schema.String, dept: Schema.String }),
    grain: ["stay_id"],
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(moves, "move_id", "dept")}
    FROM ${ctx.ref(moves)}
    WHERE dept = ${"ОРИТ"}
  `,
)

describe("defineModel", () => {
  test("собирает зависимости из ref", () => {
    expect([...stays.deps]).toEqual(["med.moves"])
    expect(moves.deps.size).toBe(0)
  })

  test("рендер: ref резолвится, cols квотируются, литералы экранируются", () => {
    const text = render(stays.fragment, { resolveRef: (n) => `<${n}>` })
    expect(text).toContain(`FROM <med.moves>`)
    expect(text).toContain(`"move_id", "dept"`)
    expect(text).toContain(`dept = 'ОРИТ'`)
  })

  test("битое имя модели — ModelDefinitionError", () => {
    try {
      defineModel(
        { name: "плохое имя", kind: kind.full(), schema: Schema.Struct({}) },
        (ctx) => ctx.sql`SELECT 1`,
      )
      expect.unreachable()
    } catch (error) {
      expect((error as { _tag?: string })._tag).toBe("ModelDefinitionError")
    }
  })

  test("экранирование кавычки в строковом литерале", () => {
    const m = defineModel(
      { name: "t.q", kind: kind.full(), schema: Schema.Struct({ x: Schema.String }) },
      (ctx) => ctx.sql`SELECT ${"o'brien"} AS x`,
    )
    expect(render(m.fragment, { resolveRef: (n) => n })).toContain("'o''brien'")
  })
})

describe("buildGraph", () => {
  test("топологический порядок: родители раньше детей", () => {
    const graph = Effect.runSync(buildGraph([stays, moves]))
    expect(graph.order.indexOf("med.moves")).toBeLessThan(graph.order.indexOf("med.stays"))
    expect(transitiveDependents(graph, "med.moves")).toEqual(new Set(["med.stays"]))
  })

  test("неизвестная зависимость — UnknownDependencyError", () => {
    const error = Effect.runSync(Effect.flip(buildGraph([stays])))
    expect(error._tag).toBe("UnknownDependencyError")
  })

  test("дубликат имени — DuplicateModelError", () => {
    const error = Effect.runSync(Effect.flip(buildGraph([moves, moves])))
    expect(error._tag).toBe("DuplicateModelError")
  })
})
