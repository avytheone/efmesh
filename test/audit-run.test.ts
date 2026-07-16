import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import { audit } from "../src/core/audit.ts"
import { defineModel, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { auditEnvironment } from "../src/plan/audit-run.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import type { StateStore } from "../src/state/store.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, EngineAdapter | StateStore>) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
  )

describe("efmesh audit — standalone run over an environment (SPEC §8, F4)", () => {
  test("catches degradation after the fact; warn does not count as blocking", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const depts = defineModel(
          {
            name: "med.depts",
            kind: kind.full(),
            schema: Schema.Struct({ dept: Schema.NullOr(Schema.String) }),
            audits: [audit.notNull("dept"), audit.warn(audit.accepted("dept", ["ICU"]))],
          },
          (ctx) => ctx.sql`SELECT 'ICU' AS dept`,
        )
        const models = [depts]
        yield* Efmesh.apply("dev", models)

        // right after apply — clean
        const clean = yield* auditEnvironment("dev", models)
        expect(clean.blockingViolations).toBe(0)
        expect(clean.results.map((r) => [r.audit, r.violations])).toEqual([
          ["not_null(dept)", 0],
          ["accepted(dept)", 0],
        ])

        // degradation after the fact: the physical table is corrupted outside efmesh
        const [physical] = yield* engine.query(
          `SELECT table_name AS t FROM duckdb_tables() WHERE schema_name = '_efmesh'`,
        )
        yield* engine.execute(
          `INSERT INTO "_efmesh"."${String(physical!["t"])}" VALUES (NULL), ('morgue')`,
        )
        const dirty = yield* auditEnvironment("dev", models)
        // NULL — a blocking not_null violation; the unaccepted dept — a warn accepted violation
        // (NULL bypasses accepted: NULL NOT IN (…) = NULL — that is not_null's job)
        expect(dirty.blockingViolations).toBe(1)
        expect(dirty.results).toEqual([
          { model: "med.depts", audit: "not_null(dept)", blocking: true, violations: 1 },
          { model: "med.depts", audit: "accepted(dept)", blocking: false, violations: 1 },
        ])
      }),
    )
  })

  test("model filter and an honest error on an unknown name", async () => {
    await scenario(
      Effect.gen(function* () {
        const a = defineModel(
          {
            name: "med.a",
            kind: kind.full(),
            schema: Schema.Struct({ n: Schema.Number }),
            audits: [audit.notNull("n")],
          },
          (ctx) => ctx.sql`SELECT 1 AS n`,
        )
        const b = defineModel(
          {
            name: "med.b",
            kind: kind.full(),
            schema: Schema.Struct({ n: Schema.Number }),
            audits: [audit.notNull("n")],
          },
          (ctx) => ctx.sql`SELECT 2 AS n`,
        )
        const models = [a, b]
        yield* Efmesh.apply("dev", models)
        const report = yield* auditEnvironment("dev", models, ["med.b"])
        expect(report.results.map((r) => r.model)).toEqual(["med.b"])

        const failure = yield* Effect.flip(auditEnvironment("dev", models, ["med.nope"]))
        expect(failure._tag).toBe("AuditTargetError")
      }),
    )
  })
})
