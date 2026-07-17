import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { decideApply, EXIT_AWAITING_HUMAN, isAffirmative, parseReclassify } from "../src/cli.ts"

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
    } as never)
    expect(json).toEqual({
      env: "dev",
      hasChanges: true,
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
