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

describe("efmesh audit — автономный прогон по окружению (SPEC §8, F4)", () => {
  test("ловит деградацию задним числом; warn не считается blocking", async () => {
    await scenario(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const depts = defineModel(
          {
            name: "med.depts",
            kind: kind.full(),
            schema: Schema.Struct({ dept: Schema.NullOr(Schema.String) }),
            audits: [audit.notNull("dept"), audit.warn(audit.accepted("dept", ["ОРИТ"]))],
          },
          (ctx) => ctx.sql`SELECT 'ОРИТ' AS dept`,
        )
        const models = [depts]
        yield* Efmesh.apply("dev", models)

        // сразу после apply — чисто
        const clean = yield* auditEnvironment("dev", models)
        expect(clean.blockingViolations).toBe(0)
        expect(clean.results.map((r) => [r.audit, r.violations])).toEqual([
          ["not_null(dept)", 0],
          ["accepted(dept)", 0],
        ])

        // деградация задним числом: физика испорчена мимо efmesh
        const [physical] = yield* engine.query(
          `SELECT table_name AS t FROM duckdb_tables() WHERE schema_name = '_efmesh'`,
        )
        yield* engine.execute(
          `INSERT INTO "_efmesh"."${String(physical!["t"])}" VALUES (NULL), ('морг')`,
        )
        const dirty = yield* auditEnvironment("dev", models)
        // NULL — blocking-нарушение not_null; «морг» — warn-нарушение accepted
        // (NULL мимо accepted: NULL NOT IN (…) = NULL — это дело not_null)
        expect(dirty.blockingViolations).toBe(1)
        expect(dirty.results).toEqual([
          { model: "med.depts", audit: "not_null(dept)", blocking: true, violations: 1 },
          { model: "med.depts", audit: "accepted(dept)", blocking: false, violations: 1 },
        ])
      }),
    )
  })

  test("фильтр моделей и честная ошибка на неизвестное имя", async () => {
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
