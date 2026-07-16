import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const schema = Schema.Struct({ case_id: Schema.String, dept: Schema.String })

describe("external models (SPEC §3.1, §9.3)", () => {
  test("external.table: the consumer reads the engine table directly, external is not built", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(`CREATE SCHEMA src`)
        yield* engine.execute(
          `CREATE TABLE src.raw_moves AS SELECT * FROM (VALUES ('c1','ICU'), ('c2','therapy')) t(case_id, dept)`,
        )

        const raw = defineExternal({ name: "src.moves", source: external.table("src.raw_moves"), schema })
        const stays = defineModel(
          { name: "med.stays", kind: kind.full(), schema },
          (ctx) => ctx.sql`SELECT ${ctx.cols(raw, "case_id", "dept")} FROM ${ctx.ref(raw)}`,
        )

        const applied = yield* Efmesh.apply("dev", [raw, stays])
        // only the consumer is built — external has no physical table
        expect(applied.built).toEqual(["med.stays"])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(rows).toEqual([{ n: 2 }])
        // no view layer exists for external
        const missing = yield* Effect.flip(engine.query(`SELECT * FROM dev__src.moves`))
        expect(missing._tag).toBe("EngineError")

        // a repeated apply: nothing changed, external included
        const again = yield* Efmesh.apply("dev", [raw, stays])
        expect(again.plan.hasChanges).toBe(false)
        expect(again.built).toEqual([])
      }),
    )
  })

  test("external.files: parquet by path; changing the source — breaking for the child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-external-"))
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        yield* engine.execute(
          `COPY (SELECT 'c1' AS case_id, 'ICU' AS dept) TO '${join(dir, "a.parquet")}' (FORMAT PARQUET)`,
        )
        yield* engine.execute(
          `COPY (SELECT * FROM (VALUES ('c2','therapy'), ('c3','surgery')) t(case_id, dept)) TO '${join(dir, "b.parquet")}' (FORMAT PARQUET)`,
        )

        const lake = (path: string) =>
          defineExternal({ name: "src.moves", source: external.files(path, "parquet"), schema })
        const stays = (raw: ReturnType<typeof lake>) =>
          defineModel(
            { name: "med.stays", kind: kind.full(), schema },
            (ctx) => ctx.sql`SELECT case_id, dept FROM ${ctx.ref(raw)}`,
          )

        const rawA = lake(join(dir, "a.parquet"))
        yield* Efmesh.apply("dev", [rawA, stays(rawA)])
        const rows = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(rows).toEqual([{ n: 1 }])

        // changed the source path — the child is rebuilt transitively
        // (its own body did not change — indirect category)
        const rawB = lake(join(dir, "b.parquet"))
        const plan = yield* Efmesh.plan("dev", [rawB, stays(rawB)])
        const changes = new Map(plan.actions.map((a) => [a.name, a.change]))
        expect(changes.get("src.moves")).toBe("breaking")
        expect(changes.get("med.stays")).toBe("indirect")
        const applied = yield* Efmesh.apply("dev", [rawB, stays(rawB)])
        expect(applied.built).toEqual(["med.stays"])
        const rows2 = yield* engine.query(`SELECT count(*)::INT AS n FROM dev__med.stays`)
        expect(rows2).toEqual([{ n: 2 }])
      }),
    )
  })
})
