import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger, References, Schema } from "effect"
import type { LogLevel } from "effect/LogLevel"
import { Efmesh } from "../src/efmesh.ts"
import { audit } from "../src/core/audit.ts"
import { fromIso } from "../src/core/interval.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

/**
 * The detailed execution log (#14) is emitted through Effect's logging system,
 * so an embedder — and this test — controls the sink via a Logger layer. These
 * tests install a collecting logger and assert the level/annotation contract:
 * lifecycle at info, SQL at debug, warn-audits at warn.
 */

interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly annotations: Record<string, unknown>
}

/** A Logger layer that collects entries; `min` gates which levels reach it. */
const collecting = (min: LogLevel) => {
  const entries: Array<LogEntry> = []
  const logger = Logger.make<unknown, void>((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
    const message = Array.isArray(options.message)
      ? options.message.map(String).join(" ")
      : String(options.message)
    entries.push({ level: options.logLevel, message, annotations: { ...annotations } })
  })
  const layer = Logger.layer([logger]).pipe(
    Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, min)),
  )
  return { entries, layer }
}

const engineState = Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())

const seedSource = Effect.gen(function* () {
  const engine = yield* EngineAdapter
  yield* engine.execute(`CREATE SCHEMA IF NOT EXISTS src`)
  yield* engine.execute(`
    CREATE TABLE src.events AS SELECT * FROM (VALUES
      ('e1', TIMESTAMP '2026-01-01 10:00:00'),
      ('e2', TIMESTAMP '2026-01-02 11:00:00'),
      ('e3', TIMESTAMP '2026-01-03 12:00:00')
    ) t(id, happened_at)
  `)
})

const raw = defineExternal({
  name: "src.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const daily = defineModel(
  {
    name: "med.events",
    kind: kind.incrementalByTimeRange({
      timeColumn: "happened_at",
      start: "2026-01-01T00:00:00Z",
      batchSize: 1,
    }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
  },
  (ctx) => ctx.sql`
    SELECT id, happened_at FROM ${ctx.ref(raw)}
    WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
  `,
)

describe("detailed execution log (#14)", () => {
  test("backfill logs per-batch progress at info with model + interval annotations", async () => {
    const { entries, layer } = collecting("Info")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSource
        // now = Jan 4 → three 1-day intervals, one batch each
        yield* Efmesh.apply("dev", [raw, daily], { now: fromIso("2026-01-04T00:00:00Z") })
      }).pipe(Effect.provide(engineState), Effect.provide(layer)),
    )

    const batchLines = entries.filter(
      (e) => e.level === "Info" && e.message.startsWith("backfill batch"),
    )
    expect(batchLines).toHaveLength(3)
    expect(batchLines.map((e) => e.message)).toEqual([
      "backfill batch 1 of 3",
      "backfill batch 2 of 3",
      "backfill batch 3 of 3",
    ])
    // structured fields — grouped by a machine reader without parsing the message
    for (const line of batchLines) {
      expect(line.annotations["model"]).toBe("med.events")
      expect(line.annotations["env"]).toBe("dev")
      expect(String(line.annotations["interval"])).toMatch(/^\[2026-01-\d\dT/)
    }
    // lifecycle start/finish are info too
    expect(entries.some((e) => e.level === "Info" && e.message === "build start")).toBe(true)
    expect(
      entries.some((e) => e.level === "Info" && e.message.startsWith("build done")),
    ).toBe(true)
  })

  test("rendered SQL is emitted at debug, never at info", async () => {
    // at min=Info the debug SQL is filtered out before it reaches the logger
    const info = collecting("Info")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, daily], { now: fromIso("2026-01-04T00:00:00Z") })
      }).pipe(Effect.provide(engineState), Effect.provide(info.layer)),
    )
    expect(info.entries.some((e) => e.message === "rendered SQL")).toBe(false)

    // at min=Debug the SQL surfaces, and only at the debug level
    const debug = collecting("Debug")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedSource
        yield* Efmesh.apply("dev", [raw, daily], { now: fromIso("2026-01-04T00:00:00Z") })
      }).pipe(Effect.provide(engineState), Effect.provide(debug.layer)),
    )
    const sqlLines = debug.entries.filter((e) => e.message === "rendered SQL")
    expect(sqlLines.length).toBeGreaterThan(0)
    for (const line of sqlLines) {
      expect(line.level).toBe("Debug")
      expect(String(line.annotations["sql"])).toContain("SELECT")
    }
  })

  test("a warn-audit logs at warn", async () => {
    const { entries, layer } = collecting("Info")
    await Effect.runPromise(
      Effect.gen(function* () {
        const warned = defineModel(
          {
            name: "med.warned",
            kind: kind.full(),
            schema: Schema.Struct({ dept: Schema.String }),
            audits: [audit.warn(audit.accepted("dept", ["ICU"]))],
          },
          (ctx) => ctx.sql`SELECT 'morgue' AS dept`,
        )
        yield* Efmesh.apply("dev", [warned])
      }).pipe(Effect.provide(engineState), Effect.provide(layer)),
    )
    const warnLines = entries.filter((e) => e.level === "Warn")
    expect(warnLines.length).toBeGreaterThan(0)
    expect(warnLines.some((e) => e.message.includes("audit"))).toBe(true)
  })

  test("plan --json keeps stdout pure JSON while info logs flow to stderr", () => {
    // a real CLI invocation is the only honest check of the stream split; the
    // temp project lives INSIDE the repo so `effect` resolves for the subprocess
    const dir = mkdtempSync(NodePath.join(import.meta.dir, "..", ".tmp-log-json-"))
    try {
      writeFileSync(
        NodePath.join(dir, "efmesh.config.ts"),
        `import { defineConfig } from "${NodePath.join(import.meta.dir, "..", "src", "index.ts")}"
import { m } from "./models.ts"
export default defineConfig({ models: [m] })`,
      )
      writeFileSync(
        NodePath.join(dir, "models.ts"),
        `import { defineModel, kind } from "${NodePath.join(import.meta.dir, "..", "src", "index.ts")}"
import { Schema } from "effect"
export const m = defineModel(
  { name: "med.x", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) },
  (ctx) => ctx.sql\`SELECT 'a' AS id\`,
)`,
      )
      const bin = NodePath.join(import.meta.dir, "..", "src", "bin.ts")
      // apply first so a plan against dev has a promotion to diff (and logs fire)
      spawnSync("bun", [bin, "apply", "dev", "--yes"], { cwd: dir, encoding: "utf8" })
      const result = spawnSync("bun", [bin, "plan", "dev", "--json"], {
        cwd: dir,
        encoding: "utf8",
      })
      expect(result.status).toBe(0)
      // stdout parses cleanly — no log bytes leaked into it
      const parsed = JSON.parse(result.stdout)
      expect(parsed.env).toBe("dev")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
