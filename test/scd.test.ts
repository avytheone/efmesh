import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const raw = defineExternal({
  name: "src.depts",
  source: external.table("src.depts"),
  schema: Schema.Struct({ id: Schema.String, head: Schema.String }),
})

const dim = defineModel(
  {
    name: "med.dim_depts",
    kind: kind.scdType2({ key: ["id"] }),
    schema: Schema.Struct({
      id: Schema.String,
      head: Schema.String,
      valid_from: Schema.NullOr(Schema.DateTimeUtc),
      valid_to: Schema.NullOr(Schema.DateTimeUtc),
    }),
  },
  (ctx) => ctx.sql`SELECT id, head FROM ${ctx.ref(raw)}`,
)

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(`
    CREATE TABLE src.depts AS SELECT * FROM (VALUES
      ('icu', 'Иванов'), ('therapy', 'Петрова')
    ) t(id, head)
  `)
})

const snapshotRows = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  return yield* engine.query(`
    SELECT id, head, CAST(valid_from AS VARCHAR) AS f, CAST(valid_to AS VARCHAR) AS t
    FROM dev__med.dim_depts ORDER BY id, valid_from
  `)
})

describe("scdType2 (SPEC §3.1)", () => {
  test("история версий: закрытие изменившихся/исчезнувших, вставка новых, идемпотентность", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* seedSource
        const models = [raw, dim]
        const t1 = fromIso("2026-02-01T00:00:00Z")
        const t2 = fromIso("2026-02-02T00:00:00Z")
        const t3 = fromIso("2026-02-03T00:00:00Z")

        // первая загрузка: все строки открыты с valid_from = t1
        yield* Efmesh.apply("dev", models, { now: t1 })
        expect(yield* snapshotRows).toEqual([
          { id: "icu", head: "Иванов", f: "2026-02-01 00:00:00", t: null },
          { id: "therapy", head: "Петрова", f: "2026-02-01 00:00:00", t: null },
        ])

        // сменился зав. ОРИТ, терапия закрылась, появилась хирургия
        yield* engine.execute(`UPDATE src.depts SET head = 'Сидоров' WHERE id = 'icu'`)
        yield* engine.execute(`DELETE FROM src.depts WHERE id = 'therapy'`)
        yield* engine.execute(`INSERT INTO src.depts VALUES ('surgery', 'Козлов')`)

        yield* Efmesh.apply("dev", models, { now: t2 })
        expect(yield* snapshotRows).toEqual([
          { id: "icu", head: "Иванов", f: "2026-02-01 00:00:00", t: "2026-02-02 00:00:00" },
          { id: "icu", head: "Сидоров", f: "2026-02-02 00:00:00", t: null },
          { id: "surgery", head: "Козлов", f: "2026-02-02 00:00:00", t: null },
          { id: "therapy", head: "Петрова", f: "2026-02-01 00:00:00", t: "2026-02-02 00:00:00" },
        ])

        // без изменений источника: ничего не дрожит (valid_from не переписаны)
        yield* Efmesh.apply("dev", models, { now: t3 })
        expect(yield* snapshotRows).toEqual([
          { id: "icu", head: "Иванов", f: "2026-02-01 00:00:00", t: "2026-02-02 00:00:00" },
          { id: "icu", head: "Сидоров", f: "2026-02-02 00:00:00", t: null },
          { id: "surgery", head: "Козлов", f: "2026-02-02 00:00:00", t: null },
          { id: "therapy", head: "Петрова", f: "2026-02-01 00:00:00", t: "2026-02-02 00:00:00" },
        ])
      }),
    )
  })

  test("валидации: valid-колонки объявлены в схеме и не входят в key", () => {
    let error: unknown
    try {
      defineModel(
        {
          name: "med.bad",
          kind: kind.scdType2({ key: ["id"] }),
          schema: Schema.Struct({ id: Schema.String }),
        },
        (ctx) => ctx.sql`SELECT 'x' AS id`,
      )
    } catch (caught) {
      error = caught
    }
    expect((error as { _tag?: string })._tag).toBe("ModelDefinitionError")
    expect((error as { reason?: string }).reason).toContain("valid_from")
  })
})
