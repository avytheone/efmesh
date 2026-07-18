import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { buildManifest, freshnessOf, MANIFEST_VERSION } from "../src/plan/manifest.ts"
import { redactModel } from "../src/plan/redact.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { fetchManifest, passportOf, SUPPORTED_MANIFEST_VERSION } from "../src/browser/index.ts"

/**
 * Golden tests on the manifest (#41): browser clients and agents parse this
 * document, so its shape is frozen here. A field may be added without a bump;
 * changing what one MEANS bumps MANIFEST_VERSION.
 */

const raw = defineExternal({
  name: "raw.events",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtc, secret: Schema.String }),
})

const model = defineModel(
  {
    name: "core.events",
    kind: kind.full(),
    schema: Schema.Struct({ id: Schema.String, at: Schema.DateTimeUtc, secret: Schema.String }),
    grain: ["id"],
    redact: ["secret"],
    answerable: "sampled",
    caveats: ["observation starts on 2026-01-01"],
  },
  (ctx) => ctx.sql`SELECT ${ctx.cols(raw, "id", "at", "secret")} FROM ${ctx.ref(raw)}`,
)

describe("manifest format (#41)", () => {
  test("the document is frozen", () => {
    expect(
      buildManifest({
        model,
        fingerprint: "abc123",
        files: ["./interval=2026-01-02/data.parquet", "./interval=2026-01-01/data.parquet"],
        done: [
          { startTs: "2026-01-01T00:00:00.000Z", endTs: "2026-01-02T00:00:00.000Z" },
          { startTs: "2026-01-02T00:00:00.000Z", endTs: "2026-01-03T00:00:00.000Z" },
        ],
        failed: 0,
        generatedAt: "2026-01-03T00:00:00.000Z",
        redacted: ["secret"],
      }),
    ).toEqual({
      manifestVersion: MANIFEST_VERSION,
      model: "core.events",
      fingerprint: "abc123",
      generatedAt: "2026-01-03T00:00:00.000Z",
      intervals: [
        { start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" },
        { start: "2026-01-02T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z" },
      ],
      schema: [
        { name: "id", type: "text" },
        { name: "at", type: "temporal" },
        { name: "secret", type: "text" },
      ],
      // sorted: a byte-stable document across runs, so a diff of two manifests
      // shows what changed rather than how the filesystem happened to iterate
      files: ["./interval=2026-01-01/data.parquet", "./interval=2026-01-02/data.parquet"],
      answerable: "sampled",
      caveats: ["observation starts on 2026-01-01"],
      freshness: {
        contiguousThrough: "2026-01-03T00:00:00.000Z",
        latestInterval: "2026-01-03T00:00:00.000Z",
        failedIntervals: 0,
      },
      redacted: ["secret"],
    })
  })

  test("column types are families, not Effect AST tags", () => {
    const manifest = buildManifest({
      model,
      fingerprint: "f",
      files: [],
      done: [],
      failed: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
      redacted: [],
    })
    expect(manifest.schema.map((column) => column.type)).toEqual(["text", "temporal", "text"])
  })

  test("a model that declares nothing answers `full` with no caveats", () => {
    const plain = defineModel(
      { name: "mart.plain", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) },
      (ctx) => ctx.sql`SELECT ${ctx.cols(raw, "id")} FROM ${ctx.ref(raw)}`,
    )
    const manifest = buildManifest({
      model: plain,
      fingerprint: "f",
      files: [],
      done: [],
      failed: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
      redacted: [],
    })
    expect(manifest.answerable).toBe("full")
    expect(manifest.caveats).toEqual([])
  })
})

describe("freshness is derived from the ledger, never declared (#41, #43)", () => {
  const interval = (day: number) => ({
    startTs: `2026-01-0${day}T00:00:00.000Z`,
    endTs: `2026-01-0${day + 1}T00:00:00.000Z`,
  })

  test("contiguous coverage stops at the first gap, even when later data exists", () => {
    const freshness = freshnessOf([interval(1), interval(2), interval(5)], 0)
    // day 4→5 exists but 3→4 is missing: a consumer may trust the prefix only
    expect(freshness.contiguousThrough).toBe("2026-01-03T00:00:00.000Z")
    expect(freshness.latestInterval).toBe("2026-01-06T00:00:00.000Z")
  })

  test("no intervals — nulls, not a fabricated timestamp", () => {
    expect(freshnessOf([], 0)).toEqual({
      contiguousThrough: null,
      latestInterval: null,
      failedIntervals: 0,
    })
  })

  test("failed intervals are counted — missing on purpose is not the same as absent", () => {
    expect(freshnessOf([interval(1)], 2).failedIntervals).toBe(2)
  })
})

describe("redacted materialization (#41)", () => {
  test("a redacted model drops the columns from its schema and projects its body", () => {
    const redacted = redactModel(model)
    expect(Object.keys(redacted.schema.fields)).toEqual(["id", "at"])
    expect(redacted.grain).toEqual(["id"])
  })

  test("a model without a policy is returned untouched — physics stays shared", () => {
    const plain = defineModel(
      { name: "mart.plain", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) },
      (ctx) => ctx.sql`SELECT ${ctx.cols(raw, "id")} FROM ${ctx.ref(raw)}`,
    )
    expect(redactModel(plain)).toBe(plain)
  })

  test("redaction changes the fingerprint — separate physics, not a hidden column", async () => {
    const fingerprints = await Effect.runPromise(
      Effect.gen(function* () {
        const plain = yield* Efmesh.plan("dev", [raw, model])
        const hidden = yield* Efmesh.plan("safe", [raw, model], { redacted: true })
        return {
          plain: plain.actions.find((a) => a.name === "core.events")!.fingerprint,
          hidden: hidden.actions.find((a) => a.name === "core.events")!.fingerprint,
        }
      }).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
    )
    expect(fingerprints.hidden).not.toBe(fingerprints.plain)
  })
})

describe("the browser helper (#41)", () => {
  test("a newer manifestVersion is refused, not best-guessed", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ manifestVersion: SUPPORTED_MANIFEST_VERSION + 1, files: [] }), {
        status: 200,
      })) as unknown as typeof fetch
    try {
      await expect(fetchManifest("https://example.test/manifest.json")).rejects.toThrow(
        /newer than the/,
      )
    } finally {
      globalThis.fetch = original
    }
  })

  test("the passport reports gaps, so a client cannot present a partial total as complete", () => {
    const withGap = passportOf({
      manifestVersion: 1,
      model: "core.events",
      fingerprint: "f",
      generatedAt: "2026-01-01T00:00:00.000Z",
      intervals: [],
      schema: [],
      files: [],
      answerable: "full",
      caveats: [],
      freshness: {
        contiguousThrough: "2026-01-03T00:00:00.000Z",
        latestInterval: "2026-01-06T00:00:00.000Z",
        failedIntervals: 0,
      },
      redacted: [],
    })
    expect(withGap.hasGaps).toBe(true)
    expect(withGap.completeThrough).toBe("2026-01-03T00:00:00.000Z")
  })
})
