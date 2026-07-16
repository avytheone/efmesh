import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, kind, type AnyModel } from "../src/core/model.ts"
import type { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

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

const changeOf = async (before: ReadonlyArray<AnyModel>, after: ReadonlyArray<AnyModel>) =>
  scenario(
    Effect.gen(function* () {
      yield* Efmesh.apply("dev", before)
      const plan = yield* Efmesh.plan("dev", after)
      return new Map(plan.actions.map((a) => [a.name, a.change]))
    }),
  )

describe("change categorization by AST (SPEC §5.2)", () => {
  test("a column appended to the end of SELECT — non-breaking", async () => {
    const widened = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String, c: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b, 'z' AS c`,
    )
    const changes = await changeOf([src], [widened])
    expect(changes.get("med.src")).toBe("non-breaking")
  })

  test("changing the expression of an existing column — breaking", async () => {
    const reworked = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'CHANGED' AS a, 'y' AS b`,
    )
    const changes = await changeOf([src], [reworked])
    expect(changes.get("med.src")).toBe("breaking")
  })

  test("dropping a column and inserting into the middle — breaking", async () => {
    const dropped = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a`,
    )
    const middle = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, mid: Schema.String, b: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'm' AS mid, 'y' AS b`,
    )
    expect((await changeOf([src], [dropped])).get("med.src")).toBe("breaking")
    expect((await changeOf([src], [middle])).get("med.src")).toBe("breaking")
  })

  test("changing WHERE — breaking; a child with an untouched body — indirect", async () => {
    const filtered = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b WHERE 1 = 1`,
    )
    const changes = await changeOf([src, consumerOf(src)], [filtered, consumerOf(filtered)])
    expect(changes.get("med.src")).toBe("breaking")
    expect(changes.get("med.consumer")).toBe("indirect")
  })

  test("a parent's non-breaking cascades to the child as indirect", async () => {
    const widened = defineModel(
      {
        name: "med.src",
        kind: kind.full(),
        schema: Schema.Struct({ a: Schema.String, b: Schema.String, c: Schema.String }),
      },
      (ctx) => ctx.sql`SELECT 'x' AS a, 'y' AS b, 'z' AS c`,
    )
    const changes = await changeOf([src, consumerOf(src)], [widened, consumerOf(widened)])
    expect(changes.get("med.src")).toBe("non-breaking")
    expect(changes.get("med.consumer")).toBe("indirect")
  })
})
