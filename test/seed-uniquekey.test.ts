import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineModel, defineSeed, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

describe("seed (SPEC §3.1)", () => {
  test("CSV-справочник материализуется; правка файла = новая версия", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-seed-"))
    const file = join(dir, "departments.csv")
    writeFileSync(file, "code,title\noric,ОРИТ\nther,терапия\n")

    const departments = defineSeed({
      name: "ref.departments",
      file,
      schema: Schema.Struct({ code: Schema.String, title: Schema.String }),
    })

    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const applied = yield* Efmesh.apply("dev", [departments])
        expect(applied.built).toEqual(["ref.departments"])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__ref.departments`)
        expect(rows).toEqual([{ n: 2 }])

        // без правки файла — изменений нет
        const same = yield* Efmesh.apply("dev", [departments])
        expect(same.plan.hasChanges).toBe(false)

        // дописали строку — версия сменилась, пересборка
        writeFileSync(file, "code,title\noric,ОРИТ\nther,терапия\nsurg,хирургия\n")
        const plan = yield* Efmesh.plan("dev", [departments])
        expect(plan.actions[0]?.change).toBe("breaking")
        yield* Efmesh.apply("dev", [departments])
        const rows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__ref.departments`)
        expect(rows2).toEqual([{ n: 3 }])
      }),
    )
  })

  test("отсутствующий файл — SeedReadError на этапе плана", async () => {
    const ghost = defineSeed({
      name: "ref.ghost",
      file: "/nonexistent/ghost.csv",
      schema: Schema.Struct({ x: Schema.String }),
    })
    const error = await scenario(Effect.flip(Efmesh.plan("dev", [ghost])))
    expect(error._tag).toBe("SeedReadError")
  })
})

describe("incrementalByUniqueKey (SPEC §3.1)", () => {
  test("upsert по ключу: новые строки добавляются, изменённые заменяются, старые живут", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA src`)
        yield* engine.execute(
          `CREATE TABLE src.people AS SELECT * FROM (VALUES ('p1','Анна'), ('p2','Борис')) t(id, name)`,
        )
        const people = defineModel(
          {
            name: "med.people",
            kind: kind.incrementalByUniqueKey({ key: ["id"] }),
            schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
          },
          (ctx) => ctx.sql`SELECT id, name FROM src.people`,
        )

        yield* Efmesh.apply("dev", [people])
        const initial = yield* engine.query(`SELECT * FROM dev__med.people ORDER BY id`)
        expect(initial).toEqual([
          { id: "p1", name: "Анна" },
          { id: "p2", name: "Борис" },
        ])

        // источник изменился: p2 переименован, p3 добавлен, p1 исчез из выборки
        yield* engine.execute(`DELETE FROM src.people WHERE id = 'p1'`)
        yield* engine.execute(`UPDATE src.people SET name = 'Борис И.' WHERE id = 'p2'`)
        yield* engine.execute(`INSERT INTO src.people VALUES ('p3', 'Вера')`)

        const applied = yield* Efmesh.apply("dev", [people])
        expect(applied.built).toEqual(["med.people"]) // refresh при каждом apply
        const after = yield* engine.query(`SELECT * FROM dev__med.people ORDER BY id`)
        expect(after).toEqual([
          { id: "p1", name: "Анна" }, // upsert не удаляет отсутствующих в выборке
          { id: "p2", name: "Борис И." },
          { id: "p3", name: "Вера" },
        ])
      }),
    )
  })
})
