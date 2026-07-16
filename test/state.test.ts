import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore, type StateStoreShape } from "../src/state/store.ts"

const withStore = <A, E>(body: (store: StateStoreShape) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* StateStore
      return yield* body(store)
    }).pipe(Effect.provide(SqliteStateLive())),
  )

describe("SqliteState", () => {
  test("снапшот: upsert идемпотентен, читается обратно", async () => {
    const snapshot = await withStore((store) =>
      Effect.gen(function* () {
        const record = {
          name: "med.stays",
          fingerprint: "abc123",
          renderedSql: "SELECT 1",
          canonicalAst: `{"statements":[]}`,
          physicalFp: "abc123",
          kind: "full",
          fingerprintVersion: 1,
        }
        yield* store.upsertSnapshot(record)
        yield* store.upsertSnapshot(record) // повтор — no-op
        return yield* store.getSnapshot("med.stays", "abc123")
      }),
    )
    expect(snapshot?.renderedSql).toBe("SELECT 1")
    expect(snapshot?.createdAt).toMatch(/^\d{4}-/)
  })

  test("promote заменяет весь набор окружения", async () => {
    const envs = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.promote("dev", [
          { name: "med.a", fingerprint: "f1" },
          { name: "med.b", fingerprint: "f2" },
        ])
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f3" }])
        return yield* store.getEnvironment("dev")
      }),
    )
    expect(envs.map((e) => [e.name, e.fingerprint])).toEqual([["med.a", "f3"]])
  })

  test("окружения независимы; referenced fingerprints — объединение", async () => {
    const { prod, referenced } = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        yield* store.promote("prod", [{ name: "med.a", fingerprint: "f2" }])
        return {
          prod: yield* store.getEnvironment("prod"),
          referenced: yield* store.listReferencedFingerprints(),
        }
      }),
    )
    expect(prod[0]?.fingerprint).toBe("f2")
    expect(referenced).toEqual(new Set(["f1", "f2"]))
  })

  test("интервалы: upsert по (fp, start), статус обновляется, изоляция по fp", async () => {
    const { mine, other } = await withStore((store) =>
      Effect.gen(function* () {
        const jan1 = { startTs: "2026-01-01T00:00:00Z", endTs: "2026-01-02T00:00:00Z" }
        const jan2 = { startTs: "2026-01-02T00:00:00Z", endTs: "2026-01-03T00:00:00Z" }
        yield* store.markIntervals("fp_a", [jan1, jan2], "failed")
        yield* store.markIntervals("fp_a", [jan2], "done") // ретрай успешен
        yield* store.markIntervals("fp_b", [jan1], "done")
        return {
          mine: yield* store.listIntervals("fp_a"),
          other: yield* store.listIntervals("fp_b"),
        }
      }),
    )
    expect(mine.map((i) => [i.startTs, i.status])).toEqual([
      ["2026-01-01T00:00:00Z", "failed"],
      ["2026-01-02T00:00:00Z", "done"],
    ])
    expect(other).toHaveLength(1)
  })

  test("orphaned_at: промоушен ставит отметку сироте и снимает при возврате", async () => {
    const phases = await withStore((store) =>
      Effect.gen(function* () {
        const base = { name: "med.a", renderedSql: "SELECT 1", canonicalAst: "{}", kind: "full", fingerprintVersion: 1 }
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        const referenced = yield* store.getSnapshot("med.a", "f1")

        yield* store.upsertSnapshot({ ...base, fingerprint: "f2", physicalFp: "f2" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f2" }])
        const orphaned = yield* store.getSnapshot("med.a", "f1")

        // откат на старую версию — отметка снимается, счётчик ttl обнулён
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        const restored = yield* store.getSnapshot("med.a", "f1")
        return { referenced, orphaned, restored }
      }),
    )
    expect(phases.referenced?.orphanedAt).toBeNull()
    expect(phases.orphaned?.orphanedAt).toMatch(/^\d{4}-/)
    expect(phases.restored?.orphanedAt).toBeNull()
  })

  test("журнал планов пишется и читается по порядку", async () => {
    const plans = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.recordPlan("dev", `{"changes":1}`, "avy")
        yield* store.recordPlan("dev", `{"changes":2}`, "cron")
        return yield* store.listPlans("dev")
      }),
    )
    expect(plans.map((p) => p.summary)).toEqual([`{"changes":1}`, `{"changes":2}`])
    expect(plans.map((p) => p.appliedBy)).toEqual(["avy", "cron"])
  })
})
