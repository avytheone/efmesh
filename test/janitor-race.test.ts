import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore, type StateStoreShape } from "../src/state/store.ts"

/**
 * The janitor↔apply race (F6): the primitives that integrity rests on —
 * an orphan claim is atomic with its checks, resurrection clears orphaning,
 * promotion does not switch a view to a swept-away snapshot.
 */

const withStore = <A, E>(body: (store: StateStoreShape) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* StateStore
      return yield* body(store)
    }).pipe(Effect.provide(SqliteStateLive())),
  )

const base = {
  name: "med.a",
  renderedSql: "SELECT 1",
  canonicalAst: "{}",
  kind: "full",
  fingerprintVersion: 1,
} as const

const FUTURE = "9999-01-01T00:00:00.000Z" // deadline before which anything is "orphaned"

describe("the janitor↔apply race (F6)", () => {
  test("claim: a referenced snapshot is not swept, an orphan is swept exactly once", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        // referenced — the claim loses, even if by time it is "due"
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", FUTURE)).toBe(false)

        // orphan it: the environment moved on to f2
        yield* store.upsertSnapshot({ ...base, fingerprint: "f2", physicalFp: "f2" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f2" }])
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", FUTURE)).toBe(true)
        // a repeated claim — nothing left
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", FUTURE)).toBe(false)
        expect(yield* store.getSnapshot("med.a", "f1")).toBeUndefined()
      }),
    )
  })

  test("a fresh orphan (younger than the deadline) is not swept", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        // not referenced, but created_at = now > a deadline in the past
        const past = "2000-01-01T00:00:00.000Z"
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", past)).toBe(false)
        expect(yield* store.getSnapshot("med.a", "f1")).toBeDefined()
      }),
    )
  })

  test("resurrection: a repeated upsert clears orphaned_at — the claim loses", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        yield* store.upsertSnapshot({ ...base, fingerprint: "f2", physicalFp: "f2" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f2" }])
        expect((yield* store.getSnapshot("med.a", "f1"))?.orphanedAt).toMatch(/^\d{4}-/)

        const before = yield* store.getSnapshot("med.a", "f1")

        // "apply" resurrects the old version: orphaning cleared, created_at refreshed
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        const revived = yield* store.getSnapshot("med.a", "f1")
        expect(revived?.orphanedAt).toBeNull()

        // a janitor that decided to sweep it BEFORE resurrection (deadline in the past),
        // the claim loses: COALESCE(orphaned_at, created_at) is now fresh
        const deadline = new Date(Date.parse(before!.createdAt) - 1).toISOString()
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", deadline)).toBe(false)
        expect(yield* store.getSnapshot("med.a", "f1")).toBeDefined()
      }),
    )
  })

  test("promotion fails if the janitor took a snapshot out of the set", async () => {
    const failure = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.deleteSnapshot("med.a", "f1") // "the janitor got there first"
        return yield* Effect.flip(
          store.promote("dev", [
            { name: "med.a", fingerprint: "f1", requireSnapshot: true },
          ]),
        )
      }),
    )
    expect(failure._tag).toBe("StateError")
    expect(String((failure as { cause: unknown }).cause)).toContain("vanished from the store")
  })

  test("promoting an external without a snapshot succeeds (requireSnapshot: false)", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.promote("dev", [
          { name: "raw.src", fingerprint: "ext1", requireSnapshot: false },
        ])
        expect((yield* store.getEnvironment("dev")).map((e) => e.name)).toEqual(["raw.src"])
      }),
    )
  })
})
