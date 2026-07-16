import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore, type StateStoreShape } from "../src/state/store.ts"

/**
 * Гонка janitor↔apply (F6): примитивы, на которых держится целостность —
 * claim сироты атомарен с проверками, воскрешение снимает сиротство,
 * промоушен не переключает view на снесённый снапшот.
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

const FUTURE = "9999-01-01T00:00:00.000Z" // deadline, до которого «осиротел» любой

describe("гонка janitor↔apply (F6)", () => {
  test("claim: referenced снапшот не сносится, сирота сносится ровно один раз", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        // referenced — claim проигрывает, даже если по времени «пора»
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", FUTURE)).toBe(false)

        // осиротим: окружение уехало на f2
        yield* store.upsertSnapshot({ ...base, fingerprint: "f2", physicalFp: "f2" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f2" }])
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", FUTURE)).toBe(true)
        // повторный claim — уже нечего
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", FUTURE)).toBe(false)
        expect(yield* store.getSnapshot("med.a", "f1")).toBeUndefined()
      }),
    )
  })

  test("свежая сирота (моложе deadline) не сносится", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        // не referenced, но created_at = сейчас > deadline в прошлом
        const past = "2000-01-01T00:00:00.000Z"
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", past)).toBe(false)
        expect(yield* store.getSnapshot("med.a", "f1")).toBeDefined()
      }),
    )
  })

  test("воскрешение: повторный upsert снимает orphaned_at — claim проигрывает", async () => {
    await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f1" }])
        yield* store.upsertSnapshot({ ...base, fingerprint: "f2", physicalFp: "f2" })
        yield* store.promote("dev", [{ name: "med.a", fingerprint: "f2" }])
        expect((yield* store.getSnapshot("med.a", "f1"))?.orphanedAt).toMatch(/^\d{4}-/)

        const before = yield* store.getSnapshot("med.a", "f1")

        // «apply» воскрешает старую версию: сиротство снято, created_at освежён
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        const revived = yield* store.getSnapshot("med.a", "f1")
        expect(revived?.orphanedAt).toBeNull()

        // janitor, решивший снести её ДО воскрешения (deadline из прошлого),
        // claim проигрывает: COALESCE(orphaned_at, created_at) теперь свежий
        const deadline = new Date(Date.parse(before!.createdAt) - 1).toISOString()
        expect(yield* store.deleteSnapshotIfDoomed("med.a", "f1", deadline)).toBe(false)
        expect(yield* store.getSnapshot("med.a", "f1")).toBeDefined()
      }),
    )
  })

  test("промоушен падает, если janitor унёс снапшот из набора", async () => {
    const failure = await withStore((store) =>
      Effect.gen(function* () {
        yield* store.upsertSnapshot({ ...base, fingerprint: "f1", physicalFp: "f1" })
        yield* store.deleteSnapshot("med.a", "f1") // «janitor успел»
        return yield* Effect.flip(
          store.promote("dev", [
            { name: "med.a", fingerprint: "f1", requireSnapshot: true },
          ]),
        )
      }),
    )
    expect(failure._tag).toBe("StateError")
    expect(String((failure as { cause: unknown }).cause)).toContain("исчез из стора")
  })

  test("промоушен external без снапшота проходит (requireSnapshot: false)", async () => {
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
