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
          kind: "full",
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

  test("журнал планов пишется и читается по порядку", async () => {
    const plans = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.recordPlan("dev", `{"changes":1}`)
        yield* store.recordPlan("dev", `{"changes":2}`)
        return yield* store.listPlans("dev")
      }),
    )
    expect(plans.map((p) => p.summary)).toEqual([`{"changes":1}`, `{"changes":2}`])
  })
})
