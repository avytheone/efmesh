import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  API_VERSION,
  applyToJson,
  decideApply,
  EXIT_AWAITING_HUMAN,
  graphToJson,
  isAffirmative,
  janitorToJson,
  lineageToJson,
  migrateToJson,
  parseReclassify,
  planToJson,
  renderToJson,
  restateToJson,
  runToJson,
  scheduleListToJson,
  statusToJson,
  withApiVersion,
} from "../src/cli.ts"

describe("--reclassify — flag parsing (#5)", () => {
  test("model=category pairs; empty — undefined; garbage — an error", async () => {
    expect(await Effect.runPromise(parseReclassify("med.a=non-breaking, med.b=breaking"))).toEqual({
      "med.a": "non-breaking",
      "med.b": "breaking",
    })
    expect(await Effect.runPromise(parseReclassify(""))).toBeUndefined()
    for (const bad of ["med.a", "med.a=indirect", "=breaking", "a=b=c"]) {
      const failure = await Effect.runPromise(Effect.flip(parseReclassify(bad)))
      expect(failure._tag).toBe("ReclassifyError")
    }
  })
})

describe("plan confirmation (F4)", () => {
  test("y/yes — affirmative, case and spaces don't matter", () => {
    for (const answer of ["y", "Y", "yes", " YES "]) {
      expect(isAffirmative(answer)).toBe(true)
    }
  })

  test("empty, null (EOF) and everything else — refusal", () => {
    // cyrillic-ok: Cyrillic answers are deliberate non-affirmative inputs
    for (const answer of [null, "", " ", "n", "no", "д", "да", "ok", "apply"]) {
      expect(isAffirmative(answer)).toBe(false)
    }
  })
})

describe("the plan's fate in apply (F6: non-TTY without --yes = refusal)", () => {
  test("no changes always applies — view-swap is safe", () => {
    expect(decideApply(false, false, false)).toBe("apply")
    expect(decideApply(false, false, true)).toBe("apply")
  })

  test("--yes applies changes anywhere", () => {
    expect(decideApply(true, true, false)).toBe("apply")
    expect(decideApply(true, true, true)).toBe("apply")
  })

  test("changes: TTY asks, non-TTY refuses", () => {
    expect(decideApply(true, false, true)).toBe("ask")
    expect(decideApply(true, false, false)).toBe("refuse")
  })

  test("the 'awaiting a human' code is distinct from an error", () => {
    expect(EXIT_AWAITING_HUMAN).toBe(2)
  })
})

describe("plan --json — the shape contract (#3)", () => {
  test("intervals — ISO UTC, fields are stable", async () => {
    const { planToJson } = await import("../src/cli.ts")
    const json = planToJson({
      env: "dev",
      hasChanges: true,
      actions: [
        {
          name: "med.moves",
          change: "added",
          fingerprint: "abc",
          physicalFingerprint: "abc",
          canonicalAst: null,
          build: true,
          refresh: false,
          backfill: [{ start: 1767225600000, end: 1767312000000 }],
        },
        {
          name: "med.daily",
          change: "breaking",
          fingerprint: "def",
          physicalFingerprint: "def",
          canonicalAst: "{}",
          build: true,
          refresh: false,
          backfill: [],
          explain: { diverged: ["where_clause"], reason: "tree diverged" },
        },
      ],
      warnings: [],
    } as never)
    expect(json).toEqual({
      env: "dev",
      hasChanges: true,
      warnings: [],
      actions: [
        {
          name: "med.moves",
          change: "added",
          fingerprint: "abc",
          build: true,
          backfill: [{ start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" }],
        },
        {
          name: "med.daily",
          change: "breaking",
          fingerprint: "def",
          build: true,
          backfill: [],
          explain: { diverged: ["where_clause"], reason: "tree diverged" },
        },
      ],
    })
  })
})

describe("--json shapes for headless commands (#16)", () => {
  test("janitor — { removed, kept }, nothing else leaks", () => {
    expect(janitorToJson({ removed: ["med.a@abc12345"], kept: ["med.b@def67890"] })).toEqual({
      removed: ["med.a@abc12345"],
      kept: ["med.b@def67890"],
    })
  })

  test("migrate — from/to always, backup only when present", () => {
    expect(migrateToJson({ from: 3, to: 4 })).toEqual({ from: 3, to: 4 })
    expect(migrateToJson({ from: 3, to: 4, backup: "s.sqlite.backup-v3" })).toEqual({
      from: 3,
      to: 4,
      backup: "s.sqlite.backup-v3",
    })
  })

  test("render — sql wrapped in an object; env null for logical names", () => {
    expect(renderToJson("med.stays", "", "SELECT 1")).toEqual({
      model: "med.stays",
      env: null,
      sql: "SELECT 1",
    })
    expect(renderToJson("med.stays", "prod", "SELECT 1")).toEqual({
      model: "med.stays",
      env: "prod",
      sql: "SELECT 1",
    })
  })

  test("lineage — { model, lineage: trees } carrying the node shape", () => {
    const tree = { model: "med.stays", column: "dept", kind: "full", sources: [] }
    expect(lineageToJson("med.stays", [tree])).toEqual({
      model: "med.stays",
      lineage: [tree],
    })
  })

  test("schedule --list — entries wrapped in an object", () => {
    expect(scheduleListToJson(["efmesh-proj-dev"])).toEqual({ entries: ["efmesh-proj-dev"] })
  })
})

describe("apply/run/status/graph --json — the shape contract (#28)", () => {
  const plan = {
    env: "dev",
    hasChanges: true,
    actions: [
      {
        name: "med.daily",
        change: "breaking",
        fingerprint: "def",
        physicalFingerprint: "def",
        canonicalAst: "{}",
        build: true,
        refresh: false,
        backfill: [],
      },
    ],
    warnings: [],
  } as never

  test("apply — env/applied/plan/built/promoted; plan rides the planToJson shape", () => {
    expect(
      applyToJson({ env: "dev", applied: true, plan, built: ["med.daily"], promoted: true }),
    ).toEqual({
      env: "dev",
      applied: true,
      plan: {
        env: "dev",
        hasChanges: true,
        warnings: [],
        actions: [
          { name: "med.daily", change: "breaking", fingerprint: "def", build: true, backfill: [] },
        ],
      },
      built: ["med.daily"],
      promoted: true,
    })
  })

  test("apply — a refused non-TTY plan is applied:false, nothing built or promoted", () => {
    expect(
      applyToJson({ env: "dev", applied: false, plan, built: [], promoted: false }),
    ).toMatchObject({
      applied: false,
      built: [],
      promoted: false,
    })
  })

  test("run — ok carries processed; awaiting-human adds blockedBy, drops it otherwise", () => {
    expect(runToJson({ env: "dev", outcome: "ok", processed: ["med.daily"] })).toEqual({
      env: "dev",
      outcome: "ok",
      processed: ["med.daily"],
    })
    expect(
      runToJson({
        env: "dev",
        outcome: "awaiting-human",
        processed: [],
        blockedBy: ["med.daily: breaking"],
      }),
    ).toEqual({
      env: "dev",
      outcome: "awaiting-human",
      processed: [],
      blockedBy: ["med.daily: breaking"],
    })
  })

  test("status — lastPlan.summary and ticks[].detail are objects, not JSON-in-a-string", () => {
    const report = {
      env: "dev",
      storeVersion: 5,
      models: 2,
      promotedAt: "2026-01-02T00:00:00.000Z",
      lastPlan: {
        id: 7,
        env: "dev",
        appliedAt: "2026-01-02T00:00:00.000Z",
        appliedBy: "avy",
        summary: JSON.stringify({ actions: [{ name: "med.daily", change: "breaking" }] }),
      },
      lag: [{ model: "med.daily", doneUpTo: "2026-01-02T00:00:00.000Z", missing: 1, failed: 0 }],
      ticks: [
        {
          id: 3,
          env: "dev",
          startedAt: "2026-01-03T00:00:00.000Z",
          finishedAt: "2026-01-03T00:00:01.000Z",
          outcome: "ok",
          detail: JSON.stringify({ built: ["med.daily"] }),
        },
      ],
    } as never
    // the store's internal row ids and the redundant per-row env are dropped (#28)
    expect(statusToJson(report)).toEqual({
      env: "dev",
      storeVersion: 5,
      models: 2,
      promotedAt: "2026-01-02T00:00:00.000Z",
      lastPlan: {
        appliedAt: "2026-01-02T00:00:00.000Z",
        appliedBy: "avy",
        summary: { actions: [{ name: "med.daily", change: "breaking" }] },
      },
      lag: [{ model: "med.daily", doneUpTo: "2026-01-02T00:00:00.000Z", missing: 1, failed: 0 }],
      ticks: [
        {
          startedAt: "2026-01-03T00:00:00.000Z",
          finishedAt: "2026-01-03T00:00:01.000Z",
          outcome: "ok",
          detail: { built: ["med.daily"] },
        },
      ],
    })
  })

  test("status — an unparseable legacy detail falls back to { raw } rather than throwing", () => {
    const report = {
      env: "dev",
      storeVersion: 5,
      models: 0,
      promotedAt: null,
      lastPlan: null,
      lag: [],
      ticks: [
        {
          id: 1,
          env: "dev",
          startedAt: "2026-01-03T00:00:00.000Z",
          finishedAt: "2026-01-03T00:00:00.000Z",
          outcome: "error",
          detail: "EngineError",
        },
      ],
    } as never
    expect(
      (statusToJson(report) as { ticks: Array<{ detail: unknown }> }).ticks[0]!.detail,
    ).toEqual({ raw: "EngineError" })
  })

  test("graph — models in topological order with kind and sorted deps", () => {
    const graph = {
      order: ["med.a", "med.b"],
      models: new Map([
        ["med.a", { kind: { _tag: "full" }, deps: new Set<string>() }],
        ["med.b", { kind: { _tag: "view" }, deps: new Set(["med.a"]) }],
      ]),
    } as never
    expect(graphToJson(graph)).toEqual({
      models: [
        { name: "med.a", kind: "full", deps: [] },
        { name: "med.b", kind: "view", deps: ["med.a"] },
      ],
    })
  })
})

describe("apiVersion — one wrapper stamps every --json payload (#20)", () => {
  const plan = { env: "dev", hasChanges: false, actions: [], warnings: [] } as never
  const restate = {
    env: "dev",
    model: "med.a",
    from: 0,
    to: 0,
    interval: "day",
    dryRun: true,
    targets: [],
  } as never

  test("withApiVersion prepends apiVersion and preserves every field", () => {
    expect(withApiVersion({ env: "dev", hasChanges: false })).toEqual({
      apiVersion: API_VERSION,
      env: "dev",
      hasChanges: false,
    })
  })

  test("it rides on top of the actual transformers — plan/apply/run/status/janitor/restate", () => {
    for (const payload of [
      planToJson(plan),
      applyToJson({ env: "dev", applied: true, plan, built: [], promoted: true }),
      runToJson({ env: "dev", outcome: "ok", processed: [] }),
      statusToJson({
        env: "dev",
        storeVersion: 5,
        models: 0,
        promotedAt: null,
        lastPlan: null,
        lag: [],
        ticks: [],
      } as never),
      janitorToJson({ removed: [], kept: [] } as never),
      restateToJson(restate),
    ]) {
      expect((withApiVersion(payload) as { apiVersion: number }).apiVersion).toBe(API_VERSION)
    }
  })

  test("API_VERSION is the frozen integer 1 (a bump is a breaking SemVer event)", () => {
    expect(API_VERSION).toBe(1)
  })
})
