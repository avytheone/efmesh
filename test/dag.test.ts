import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { audit } from "../src/core/audit.ts"
import { defineModel, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
  )

describe("DAG concurrency of apply (SPEC §5.3)", () => {
  test("diamond: branches converge, the child sees the physical tables of both parents", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const root = defineModel(
          { name: "dag.root", kind: kind.full(), schema: Schema.Struct({ n: Schema.Number }) },
          (ctx) => ctx.sql`SELECT 1 AS n`,
        )
        const left = defineModel(
          { name: "dag.left", kind: kind.full(), schema: Schema.Struct({ n: Schema.Number }) },
          (ctx) => ctx.sql`SELECT n + 10 AS n FROM ${ctx.ref(root)}`,
        )
        const right = defineModel(
          { name: "dag.right", kind: kind.full(), schema: Schema.Struct({ n: Schema.Number }) },
          (ctx) => ctx.sql`SELECT n + 100 AS n FROM ${ctx.ref(root)}`,
        )
        const bottom = defineModel(
          { name: "dag.bottom", kind: kind.full(), schema: Schema.Struct({ n: Schema.Number }) },
          (ctx) => ctx.sql`
            SELECT l.n + r.n AS n FROM ${ctx.ref(left)} l CROSS JOIN ${ctx.ref(right)} r
          `,
        )
        const applied = yield* Efmesh.apply("dev", [root, left, right, bottom], {
          modelConcurrency: 4,
        })
        // built — in topological order regardless of the actual start
        expect(applied.built).toEqual(["dag.root", "dag.left", "dag.right", "dag.bottom"])
        const rows = yield* engine.query(`SELECT n FROM dev__dag.bottom`)
        expect(rows).toEqual([{ n: 112 }])
      }),
    )
  })

  test("a failed parent does not open the gate: the child is not built", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const store = yield* StateStore
        const dirty = defineModel(
          {
            name: "dag.dirty",
            kind: kind.full(),
            schema: Schema.Struct({ id: Schema.NullOr(Schema.String) }),
            audits: [audit.notNull("id")],
          },
          (ctx) => ctx.sql`SELECT * FROM (VALUES ('a'), (NULL)) t(id)`,
        )
        const child = defineModel(
          { name: "dag.child", kind: kind.full(), schema: Schema.Struct({ id: Schema.NullOr(Schema.String) }) },
          (ctx) => ctx.sql`SELECT id FROM ${ctx.ref(dirty)}`,
        )
        const models = [dirty, child]
        const error = yield* Effect.flip(Efmesh.apply("dev", models, { modelConcurrency: 4 }))
        expect(error._tag).toBe("AuditFailure")
        // neither the child's physical table, nor a view layer, nor a snapshot
        const missing = yield* Effect.flip(engine.query(`SELECT * FROM dev__dag.child`))
        expect(missing._tag).toBe("EngineError")
        const plan = yield* Efmesh.plan("dev", models)
        const childFp = plan.actions.find((a) => a.name === "dag.child")!.fingerprint
        expect(yield* store.getSnapshot("dag.child", childFp)).toBeUndefined()
      }),
    )
  })
})
