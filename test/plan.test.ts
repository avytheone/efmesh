import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`
    SELECT * FROM (VALUES ('c1', 'ОРИТ'), ('c2', 'терапия')) AS t(case_id, dept)
  `,
)

const staysV1 = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT ${ctx.cols(moves, "case_id", "dept")} FROM ${ctx.ref(moves)}`,
)

/** Та же модель, изменённое тело — «правка кода» между планами. */
const staysV2 = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(moves, "case_id", "dept")} FROM ${ctx.ref(moves)} WHERE dept = ${"ОРИТ"}
  `,
)

/**
 * Один живой стенд на весь сценарий: общий DuckDB + общий state store,
 * как в реальном проекте между вызовами CLI.
 */
const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | import("../src/state/store.ts").StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

describe("F0: стоп-условие SPEC §13", () => {
  test("plan→apply→изменение→plan→apply; prod не пересчитывается", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const v1: ReadonlyArray<AnyModel> = [moves, staysV1]
        const v2: ReadonlyArray<AnyModel> = [moves, staysV2]

        // — первый план в dev: обе модели added, обе собираются
        const plan1 = yield* Efmesh.plan("dev", v1)
        expect(plan1.actions.map((a) => a.change)).toEqual(["added", "added"])
        const applied1 = yield* Efmesh.apply("dev", v1)
        expect(applied1.built).toEqual(["med.moves", "med.stays"])
        const devRows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(devRows).toEqual([{ n: 2 }])

        // — повторный apply в dev: изменений нет, ничего не собирается
        const applied2 = yield* Efmesh.apply("dev", v1)
        expect(applied2.plan.hasChanges).toBe(false)
        expect(applied2.built).toEqual([])

        // ★ промоушен в prod: снапшоты уже собраны dev'ом — только view-swap
        const appliedProd = yield* Efmesh.apply("prod", v1)
        expect(appliedProd.built).toEqual([]) // prod НЕ пересчитывает
        const prodRows = yield* engine.query(`SELECT count(*)::INT AS n FROM med.stays`)
        expect(prodRows).toEqual([{ n: 2 }])

        // — правка stays: в dev пересобирается только stays, moves не тронут
        const plan2 = yield* Efmesh.plan("dev", v2)
        const changes = new Map(plan2.actions.map((a) => [a.name, a.change]))
        expect(changes.get("med.moves")).toBe("unchanged")
        expect(changes.get("med.stays")).toBe("breaking")
        const applied3 = yield* Efmesh.apply("dev", v2)
        expect(applied3.built).toEqual(["med.stays"])
        const devRows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(devRows2).toEqual([{ n: 1 }])

        // prod живёт на старой версии, пока его не промоутнули
        const prodStill = yield* engine.query(`SELECT count(*)::INT AS n FROM med.stays`)
        expect(prodStill).toEqual([{ n: 2 }])

        // ★ промоушен правки в prod: снова без сборки
        const appliedProd2 = yield* Efmesh.apply("prod", v2)
        expect(appliedProd2.built).toEqual([])
        const prodRows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM med.stays`)
        expect(prodRows2).toEqual([{ n: 1 }])
      }),
    )
  })

  test("удаление модели из проекта сносит view при промоушене", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* Efmesh.apply("dev", [moves, staysV1])
        const applied = yield* Efmesh.apply("dev", [moves])
        expect(applied.plan.actions.find((a) => a.name === "med.stays")?.change).toBe("removed")
        const error = yield* Effect.flip(engine.query(`SELECT * FROM dev__med.stays`))
        expect(error._tag).toBe("EngineError")
      }),
    )
  })

  test("view-модель материализуется как view поверх физики родителя", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const wards = defineModel(
          {
            name: "med.wards",
            kind: kind.view(),
            schema: Schema.Struct({ dept: Schema.String }),
          },
          (ctx) => ctx.sql`SELECT DISTINCT dept FROM ${ctx.ref(moves)}`,
        )
        yield* Efmesh.apply("dev", [moves, wards])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.wards`)
        expect(rows).toEqual([{ n: 2 }])
      }),
    )
  })
})
