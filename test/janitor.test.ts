import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineModel, kind, type AnyModel } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { janitor } from "../src/plan/janitor.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const testLayer = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(testLayer)))

const srcOf = (value: string): AnyModel =>
  defineModel(
    {
      name: "med.src",
      kind: kind.full(),
      schema: Schema.Struct({ a: Schema.String }),
    },
    (ctx) => ctx.sql`SELECT ${value} AS a`,
  )

describe("janitor (SPEC §5.4)", () => {
  test("orphaned physical table older than ttl is removed, referenced and young ones survive", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const v1 = srcOf("один")
        const v2 = srcOf("два")

        // v1 in dev and prod, then dev and prod move to v2 — v1 is an orphan
        yield* Efmesh.apply("dev", [v1])
        yield* Efmesh.apply("prod", [v1])
        const oldPlan = yield* Efmesh.plan("dev", [v1])
        const oldFp = oldPlan.actions[0]!.fingerprint
        yield* Efmesh.apply("dev", [v2])
        yield* Efmesh.apply("prod", [v2])

        const farFuture = fromIso("2027-01-01T00:00:00Z")

        // younger than ttl (ttl is huge) — keep it
        const gentle = yield* janitor({ ttlDays: 10_000, now: farFuture })
        expect(gentle.removed).toEqual([])
        expect(gentle.kept).toEqual([`med.src@${oldFp.slice(0, 8)}`])

        // older than ttl — remove it; the live snapshot is untouched
        const strict = yield* janitor({ ttlDays: 1, now: farFuture })
        expect(strict.removed).toEqual([`med.src@${oldFp.slice(0, 8)}`])
        const table = `"_efmesh"."med__src__${oldFp.slice(0, 8)}"`
        const gone = yield* Effect.flip(engine.query(`SELECT * FROM ${table}`))
        expect(gone._tag).toBe("EngineError")
        const alive = yield* engine.query(`SELECT a FROM med.src`)
        expect(alive).toEqual([{ a: "два" }])

        // a repeated run — already clean
        const again = yield* janitor({ ttlDays: 1, now: farFuture })
        expect(again.removed).toEqual([])
      }),
    )
  })
})
