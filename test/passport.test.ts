import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { buildGraph } from "../src/core/graph.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import type { AnyModel } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import type { ManifestFreshness } from "../src/plan/passport.ts"
import { environmentPassport, passportsOver } from "../src/plan/passport.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

/**
 * The answer honesty passport (#43). The declared half is a passthrough and is
 * covered by the manifest golden test; what needs proving here is the part a
 * hand-maintained convention always gets wrong — that limits travel the DAG.
 */

const day = (n: number) => `2026-01-0${n}T00:00:00.000Z`

const through = (n: number): ManifestFreshness => ({
  contiguousThrough: day(n),
  latestInterval: day(n),
  failedIntervals: 0,
})

const NOTHING: ManifestFreshness = {
  contiguousThrough: null,
  latestInterval: null,
  failedIntervals: 0,
}

const source = defineExternal({
  name: "raw.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const incremental = (name: string, upstream: AnyModel, options?: Record<string, unknown>) =>
  defineModel(
    {
      name,
      kind: kind.incrementalByTimeRange({
        timeColumn: "happened_at",
        start: "2026-01-01T00:00:00Z",
        interval: "day",
      }),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      ...options,
    },
    (ctx) => ctx.sql`
      SELECT ${ctx.cols(upstream, "id", "happened_at")} FROM ${ctx.ref(upstream)}
      WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
    `,
  )

const fullRefresh = (name: string, upstream: AnyModel, options?: Record<string, unknown>) =>
  defineModel(
    {
      name,
      kind: kind.full(),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      ...options,
    },
    (ctx) => ctx.sql`SELECT ${ctx.cols(upstream, "id", "happened_at")} FROM ${ctx.ref(upstream)}`,
  )

const passports = (models: ReadonlyArray<AnyModel>, own: Record<string, ManifestFreshness>) =>
  passportsOver(Effect.runSync(buildGraph(models)), new Map(Object.entries(own)))

describe("freshness is the minimum over the DAG (#43)", () => {
  test("a mart is no fresher than its source, and the passport names the source", () => {
    const staging = incremental("staging.events", source)
    const mart = incremental("mart.events", staging)
    const result = passports([source, staging, mart], {
      "staging.events": through(2),
      // the mart computed a day its source never filled — its own ledger is not
      // evidence that the day is complete
      "mart.events": through(5),
    })
    expect(result.get("mart.events")!.effective.completeThrough).toBe(day(2))
    expect(result.get("mart.events")!.effective.limitedBy).toBe("staging.events")
    // the model's own ledger is still reported, unchanged — the difference
    // between the two is the diagnosis
    expect(result.get("mart.events")!.freshness.contiguousThrough).toBe(day(5))
  })

  test("a source that has computed nothing bounds its children at nothing, and is named", () => {
    const staging = incremental("staging.events", source)
    const mart = incremental("mart.events", staging)
    const result = passports([source, staging, mart], {
      "staging.events": NOTHING,
      "mart.events": through(5),
    })
    expect(result.get("mart.events")!.effective.completeThrough).toBeNull()
    expect(result.get("mart.events")!.effective.limitedBy).toBe("staging.events")
  })

  test("a full-refresh model contributes no limit of its own — it is as complete as what it reads", () => {
    const staging = incremental("staging.events", source)
    const mart = fullRefresh("mart.events", staging)
    const result = passports([source, staging, mart], { "staging.events": through(3) })
    // the mart has no intervals at all; without the exemption it would report
    // null and claim a staleness that does not exist
    expect(result.get("mart.events")!.effective.completeThrough).toBe(day(3))
    expect(result.get("mart.events")!.effective.limitedBy).toBe("staging.events")
  })

  test("no time-range semantics anywhere is not staleness — limitedBy stays null", () => {
    const mart = fullRefresh("mart.events", source)
    const result = passports([source, mart], {})
    expect(result.get("mart.events")!.effective.completeThrough).toBeNull()
    expect(result.get("mart.events")!.effective.limitedBy).toBeNull()
  })

  test("the tighter of two parents wins", () => {
    const left = incremental("staging.left", source)
    const right = incremental("staging.right", source)
    const mart = defineModel(
      {
        name: "mart.joined",
        kind: kind.full(),
        schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      },
      (ctx) => ctx.sql`
        SELECT ${ctx.cols(left, "id", "happened_at")} FROM ${ctx.ref(left)}
        UNION ALL SELECT ${ctx.cols(right, "id", "happened_at")} FROM ${ctx.ref(right)}
      `,
    )
    const result = passports([source, left, right, mart], {
      "staging.left": through(4),
      "staging.right": through(2),
    })
    expect(result.get("mart.joined")!.effective.limitedBy).toBe("staging.right")
  })
})

describe("declared limits travel the DAG too (#43)", () => {
  test("a mart over a sampled source is sampled, however confidently it declares itself", () => {
    const sampled = defineExternal({
      name: "raw.sampled",
      source: external.table("src.sampled"),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      answerable: "sampled",
    })
    const mart = fullRefresh("mart.events", sampled, { answerable: "full" })
    const result = passports([sampled, mart], {})
    expect(result.get("mart.events")!.effective.answerable).toBe("sampled")
    // the declaration is kept beside it: "claims full, source makes it sampled"
    // is the diagnosis, and collapsing them would throw it away
    expect(result.get("mart.events")!.declared.answerable).toBe("full")
  })

  test("an inherited caveat carries the model that declared it", () => {
    const noted = defineExternal({
      name: "raw.noted",
      source: external.table("src.noted"),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      caveats: ["observation starts on 2026-01-01"],
    })
    const mart = fullRefresh("mart.events", noted, { caveats: ["rounded to the minute"] })
    const caveats = passports([noted, mart], {}).get("mart.events")!.effective.caveats
    // own first, then inherited — a reader meets the model's own terms before
    // the ones it merely carries
    expect(caveats).toEqual([
      { model: "mart.events", text: "rounded to the minute" },
      { model: "raw.noted", text: "observation starts on 2026-01-01" },
    ])
  })

  test("a diamond states an ancestor's caveat once, not once per path", () => {
    const noted = defineExternal({
      name: "raw.noted",
      source: external.table("src.noted"),
      schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      caveats: ["observation starts on 2026-01-01"],
    })
    const left = fullRefresh("staging.left", noted)
    const right = fullRefresh("staging.right", noted)
    const mart = defineModel(
      {
        name: "mart.joined",
        kind: kind.full(),
        schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
      },
      (ctx) => ctx.sql`
        SELECT ${ctx.cols(left, "id", "happened_at")} FROM ${ctx.ref(left)}
        UNION ALL SELECT ${ctx.cols(right, "id", "happened_at")} FROM ${ctx.ref(right)}
      `,
    )
    expect(
      passports([noted, left, right, mart], {}).get("mart.joined")!.effective.caveats,
    ).toHaveLength(1)
  })
})

describe("the passport of a live environment (#43)", () => {
  test("it reads what the environment serves, and is empty for one that does not exist", async () => {
    const staging = incremental("staging.events", source, {
      caveats: ["observation starts on 2026-01-01"],
    })
    const mart = fullRefresh("mart.events", staging)
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const absent = yield* environmentPassport("never-applied", [source, staging, mart])
        expect(absent.models).toEqual([])
        const engine = yield* EngineAdapter
        yield* engine.execute("CREATE SCHEMA IF NOT EXISTS src")
        yield* engine.execute(
          `CREATE OR REPLACE TABLE src.events AS
             SELECT * FROM (VALUES ('r1', TIMESTAMP '2026-01-01 10:00:00')) t(id, happened_at)`,
        )
        yield* Efmesh.apply("dev", [source, staging, mart], {
          now: Date.parse("2026-01-03T00:00:00Z"),
        })
        return yield* environmentPassport("dev", [source, staging, mart])
      }).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
    )
    const of = (name: string) => report.models.find((entry) => entry.model === name)!
    expect(of("staging.events").effective.completeThrough).toBe("2026-01-03T00:00:00.000Z")
    // the full-refresh mart inherits the limit and says whose it is
    expect(of("mart.events").effective.limitedBy).toBe("staging.events")
    expect(of("mart.events").effective.caveats).toEqual([
      { model: "staging.events", text: "observation starts on 2026-01-01" },
    ])
  })
})
