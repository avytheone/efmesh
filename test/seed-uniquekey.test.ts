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
  test("a CSV reference table is materialized; editing the file = a new version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-seed-"))
    const file = join(dir, "departments.csv")
    writeFileSync(file, "code,title\noric,ICU\nther,therapy\n")

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

        // without editing the file — no changes
        const same = yield* Efmesh.apply("dev", [departments])
        expect(same.plan.hasChanges).toBe(false)

        // appended a row — the version changed, a rebuild
        writeFileSync(file, "code,title\noric,ICU\nther,therapy\nsurg,surgery\n")
        const plan = yield* Efmesh.plan("dev", [departments])
        expect(plan.actions[0]?.change).toBe("breaking")
        yield* Efmesh.apply("dev", [departments])
        const rows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__ref.departments`)
        expect(rows2).toEqual([{ n: 3 }])
      }),
    )
  })

  test("a missing file — SeedReadError at plan time", async () => {
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
  test("upsert by key: new rows are added, changed ones replaced, old ones live on", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA src`)
        yield* engine.execute(
          `CREATE TABLE src.people AS SELECT * FROM (VALUES ('p1','Anna'), ('p2','Boris')) t(id, name)`,
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
          { id: "p1", name: "Anna" },
          { id: "p2", name: "Boris" },
        ])

        // the source changed: p2 renamed, p3 added, p1 dropped from the selection
        yield* engine.execute(`DELETE FROM src.people WHERE id = 'p1'`)
        yield* engine.execute(`UPDATE src.people SET name = 'Boris I.' WHERE id = 'p2'`)
        yield* engine.execute(`INSERT INTO src.people VALUES ('p3', 'Vera')`)

        const applied = yield* Efmesh.apply("dev", [people])
        expect(applied.built).toEqual(["med.people"]) // refresh on every apply
        const after = yield* engine.query(`SELECT * FROM dev__med.people ORDER BY id`)
        expect(after).toEqual([
          { id: "p1", name: "Anna" }, // upsert does not delete rows absent from the selection
          { id: "p2", name: "Boris I." },
          { id: "p3", name: "Vera" },
        ])
      }),
    )
  })
})
