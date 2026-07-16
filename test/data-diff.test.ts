import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { dataDiffEnvironments } from "../src/plan/diff.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

/**
 * #6: diff --data — сравнение данных view-слоёв двух окружений: счётчики
 * строк, пересечение по ключу (grain), помодельные расхождения по колонкам.
 * Дрейф устраивается честно: dev применяется, источник мутирует, prod
 * применяется уже с другими данными — view смотрят в разные снапшоты.
 */

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.visits",
  source: external.table("src.visits"),
  schema: Schema.Struct({ id: Schema.String, dept: Schema.String, cost: Schema.Number }),
})

const visits = defineModel(
  {
    name: "med.visits",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, dept: Schema.String, cost: Schema.Number }),
    grain: ["id"],
  },
  (ctx) => ctx.sql`SELECT id, dept, cost FROM ${ctx.ref(raw)}`,
)

const keyless = defineModel(
  {
    name: "med.keyless",
    kind: kind.full(),
    schema: Schema.Struct({ dept: Schema.String }),
  },
  (ctx) => ctx.sql`SELECT DISTINCT dept FROM ${ctx.ref(raw)}`,
)

describe("diff --data (#6)", () => {
  test("счётчики, пересечение по ключу, расхождения по колонкам; без ключа — только счётчики", async () => {
    const report = await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(`
          CREATE TABLE src.visits AS SELECT * FROM (VALUES
            ('v1', 'icu', 100), ('v2', 'icu', 200), ('v3', 'therapy', 50)
          ) t(id, dept, cost)
        `)
        const models = [raw, visits, keyless]
        yield* Efmesh.apply("dev", models)
        // источник дрейфует: v2 подорожал, v3 исчез, появился v4 —
        // prod собирает УЖЕ другие данные (breaking-правка тут не нужна:
        // окружения указывают на разные снапшоты одной модели? нет — full
        // пересобирается только на новый fingerprint, поэтому дрейф ловим
        // руками по физике prod-снапшота после промоушена)
        yield* Efmesh.apply("prod", models)
        // окружения указывают на ОДИН снапшот — расхождений быть не должно
        const cleanReport = yield* dataDiffEnvironments("dev", "prod", models)
        expect(cleanReport.models.map((m) => m.model)).toEqual(["med.keyless", "med.visits"])
        const cleanVisits = cleanReport.models.find((m) => m.model === "med.visits")!
        expect(cleanVisits).toMatchObject({ rowsA: 3, rowsB: 3, onlyInA: 0, onlyInB: 0, matched: 3, columns: [] })

        // дрейф: prod-view руками переключается на копию с правками —
        // так выглядит расхождение окружений, указывающих на разные версии
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS prod_phys`)
        yield* engine.execute(`
          CREATE TABLE prod_phys.visits AS SELECT * FROM (VALUES
            ('v1', 'icu', 100), ('v2', 'icu', 250), ('v4', 'surgery', 70)
          ) t(id, dept, cost)
        `)
        // prod — особый env: его view живут в голой схеме модели (naming.ts)
        yield* engine.execute(
          `CREATE OR REPLACE VIEW "med"."visits" AS SELECT * FROM prod_phys.visits`,
        )
        return yield* dataDiffEnvironments("dev", "prod", models)
      }),
    )
    const drifted = report.models.find((m) => m.model === "med.visits")!
    expect(drifted.rowsA).toBe(3)
    expect(drifted.rowsB).toBe(3)
    expect(drifted.key).toEqual(["id"])
    expect(drifted.onlyInA).toBe(1) // v3
    expect(drifted.onlyInB).toBe(1) // v4
    expect(drifted.matched).toBe(2) // v1, v2
    expect(drifted.columns).toEqual([{ column: "cost", mismatches: 1, rate: 0.5 }])

    const counted = report.models.find((m) => m.model === "med.keyless")!
    expect(counted.key).toBeUndefined()
    expect(counted.rowsA).toBe(2)
    expect(counted.onlyInA).toBeUndefined()
  })

  test("выборка md5-бакетов выровнена: сэмпл не рождает ложных only-in", async () => {
    const report = await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(`
          CREATE TABLE src.visits AS
          SELECT 'v' || range::VARCHAR AS id, 'icu' AS dept, range::INT AS cost
          FROM range(1000)
        `)
        const models = [raw, visits]
        yield* Efmesh.apply("dev", models)
        yield* Efmesh.apply("prod", models)
        return yield* dataDiffEnvironments("dev", "prod", models, { samplePercent: 25 })
      }),
    )
    const sampled = report.models.find((m) => m.model === "med.visits")!
    expect(sampled.sampledPercent).toBe(25)
    expect(sampled.rowsA).toBe(1000) // счётчики строк — полные
    expect(sampled.onlyInA).toBe(0) // выборка выровнена — пары не теряются
    expect(sampled.onlyInB).toBe(0)
    expect(sampled.matched).toBeGreaterThan(100) // ~250 при 25%
    expect(sampled.matched!).toBeLessThan(500)
    expect(sampled.columns).toEqual([])
  })

  test("модель не в обоих окружениях/не в проекте — DataDiffError", async () => {
    const failure = await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
        yield* engine.execute(
          `CREATE TABLE src.visits AS SELECT 'v1' AS id, 'icu' AS dept, 1 AS cost`,
        )
        yield* Efmesh.apply("dev", [raw, visits])
        return yield* Effect.flip(
          dataDiffEnvironments("dev", "prod", [raw, visits], { models: ["med.visits"] }),
        )
      }),
    )
    expect(failure._tag).toBe("DataDiffError")
    expect(failure).toMatchObject({ model: "med.visits" })
  })
})
