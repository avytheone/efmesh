import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { renderFailure, wantsTrace } from "../src/cli.ts"
import { causeText, sqlSnippet } from "../src/error-text.ts"
import { AuditFailure } from "../src/core/audit.ts"
import { UnknownModelError } from "../src/core/errors.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter, EngineError, type Engine } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { EnvironmentAuditError } from "../src/plan/audit-run.ts"
import { LockHeldError } from "../src/plan/lock.ts"
import { SchemaMismatchError } from "../src/plan/contract.ts"
import { StateSchemaError } from "../src/state/store.ts"

const withEngine = <A, E>(body: (engine: Engine) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineAdapter
      return yield* body(engine)
    }).pipe(Effect.provide(DuckDBEngineLive())),
  )

describe("error-text helpers (#13)", () => {
  test("causeText surfaces the underlying layer's own message, never swallows it", () => {
    expect(causeText(new Error("Catalog Error: no such table"))).toBe("Catalog Error: no such table")
    expect(causeText("transient")).toBe("transient")
    expect(causeText({ message: "syscall EACCES" })).toBe("syscall EACCES")
    expect(causeText(new Error())).toBe("Error") // empty message falls back to the name
    expect(causeText(undefined)).toBe("unknown cause")
  })

  test("sqlSnippet collapses whitespace and truncates", () => {
    expect(sqlSnippet("SELECT\n  a,\n  b\nFROM t")).toBe("SELECT a, b FROM t")
    const long = sqlSnippet("x".repeat(500))
    expect(long.length).toBe(200)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("tagged error messages name the culprit and carry the cause (#13)", () => {
  test("EngineError: model + engine text + SQL context, none of it only in a string", () => {
    const error = new EngineError({
      sql: "DESCRIBE (SELECT no_col FROM t)",
      cause: new Error("Binder Error: column no_col not found"),
      model: "mart.daily_revenue",
    })
    // fields are the source of truth; the message is derived from them
    expect(error.model).toBe("mart.daily_revenue")
    expect(error.message).toContain("mart.daily_revenue")
    expect(error.message).toContain("Binder Error: column no_col not found")
    expect(error.message).toContain("DESCRIBE")
    expect(error.message).not.toBe("") // constructively impossible
  })

  test("EngineError without a model still surfaces the engine's text", () => {
    const error = new EngineError({ sql: "SELECT 1", cause: "boom" })
    expect(error.message).toContain("boom")
    expect(error.message).not.toContain("[model")
  })

  test("other errors name their culprit in the derived message", () => {
    expect(new AuditFailure({ model: "mart.x", audit: "not_null(a)", violations: 3 }).message)
      .toContain("mart.x")
    expect(new SchemaMismatchError({ model: "mart.y", problems: ["column «a» missing"] }).message)
      .toContain("mart.y")
    expect(new EnvironmentAuditError({ env: "prod", blockingViolations: 2 }).message).toContain("prod")
    expect(new StateSchemaError({ found: 3, wanted: 5 }).message).toContain("v5")
    expect(new LockHeldError({ name: "env:dev" }).message).toContain("env:dev")
    expect(new UnknownModelError({ model: "no.such" }).message).toContain("no.such")
  })
})

describe("EngineError derives its message from a REAL engine failure (#13)", () => {
  test("a broken build carries DuckDB's own binder message", async () => {
    const error = await withEngine((engine) =>
      Effect.flip(engine.describe("SELECT no_such_column FROM (SELECT 1 AS a) t")),
    )
    expect(error._tag).toBe("EngineError")
    expect(error.message).toContain("no_such_column")
    // the cause field still holds the raw engine error, not just a string
    expect(String(error.cause)).toContain("no_such_column")
  })
})

describe("renderFailure — one screen, cause first, trace only under --log-level debug (#13)", () => {
  const engineFailureInBuild = Cause.fail(
    new EngineError({
      sql: "INSERT INTO mart.daily_revenue SELECT ...",
      cause: new Error("Binder Error: column no_such_column not found"),
      model: "mart.daily_revenue",
    }),
  )

  test("default screen shows the model and the cause, and NO fiber trace", () => {
    const screen = renderFailure(engineFailureInBuild, { debug: false })
    expect(screen).toContain("EngineError")
    expect(screen).toContain("mart.daily_revenue") // the culprit
    expect(screen).toContain("no_such_column") // the underlying cause
    expect(screen).not.toContain("── trace") // no fiber trace at default level
    expect(screen).toContain("--log-level debug") // points the way to more detail
  })

  test("debug screen appends the fiber trace", () => {
    const screen = renderFailure(engineFailureInBuild, { debug: true })
    expect(screen).toContain("── trace")
    expect(screen).toContain("mart.daily_revenue")
  })

  test("a missing model reference renders cleanly (no bare defect)", async () => {
    const error = await Effect.runPromise(Effect.flip(Efmesh.render([], "mart.nope")))
    expect(error._tag).toBe("UnknownModelError")
    const screen = renderFailure(Cause.fail(error), { debug: false })
    expect(screen).toContain("UnknownModelError")
    expect(screen).toContain("mart.nope")
    expect(screen).not.toContain("── trace")
  })

  test("a store-schema mismatch renders an actionable migrate hint", () => {
    const screen = renderFailure(Cause.fail(new StateSchemaError({ found: 3, wanted: 5 })), {
      debug: false,
    })
    expect(screen).toContain("StateSchemaError")
    expect(screen).toContain("→") // a hint is present
    expect(screen).toContain("efmesh migrate")
  })

  test("an audit failure names the environment", () => {
    const screen = renderFailure(
      Cause.fail(new EnvironmentAuditError({ env: "prod", blockingViolations: 4 })),
      { debug: false },
    )
    expect(screen).toContain("EnvironmentAuditError")
    expect(screen).toContain("prod")
    expect(screen).toContain("4 blocking audit")
  })

  test("a bare defect (thrown Error) still renders a headline, not an empty line", () => {
    const screen = renderFailure(Cause.die(new Error("invariant violated: reference outside plan")), {
      debug: false,
    })
    expect(screen).toContain("invariant violated")
  })
})

describe("wantsTrace — reuses the global --log-level flag (#13)", () => {
  test("trace/debug/all mean 'show me everything'; others do not", () => {
    expect(wantsTrace(["apply", "dev", "--log-level", "debug"])).toBe(true)
    expect(wantsTrace(["apply", "dev", "--log-level=trace"])).toBe(true)
    expect(wantsTrace(["apply", "dev", "--log-level", "all"])).toBe(true)
    expect(wantsTrace(["apply", "dev", "--log-level", "info"])).toBe(false)
    expect(wantsTrace(["apply", "dev"])).toBe(false)
  })
})
