import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { migrateSqliteState, SqliteStateLive } from "../src/state/sqlite.ts"
import { STATE_VERSION, StateStore } from "../src/state/store.ts"

const openStore = (path: string) =>
  Effect.gen(function* () {
    return yield* StateStore
  }).pipe(Effect.provide(SqliteStateLive({ path })))

/** Стор времён F0: без canonical_ast/orphaned_at/physical_fp и без meta. */
const createLegacyStore = (path: string): void => {
  const db = new Database(path, { create: true })
  db.exec(`
    CREATE TABLE snapshots (
      name TEXT NOT NULL, fingerprint TEXT NOT NULL, rendered_sql TEXT NOT NULL,
      kind TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (name, fingerprint)
    );
    CREATE TABLE environments (
      env TEXT NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL,
      promoted_at TEXT NOT NULL, PRIMARY KEY (env, name)
    );
  `)
  db.query(
    `INSERT INTO snapshots VALUES ('med.a', 'f1', 'SELECT 1', 'full', '2026-01-01T00:00:00.000Z')`,
  ).run()
  db.close()
}

describe("версия схемы state store + migrate (SPEC §6, F4)", () => {
  test("свежий стор бутстрапится сам; migrate по нему — уже на версии", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "efmesh-migrate-")), "state.sqlite")
    const store = await Effect.runPromise(openStore(path))
    expect(store).toBeDefined()
    const report = await Effect.runPromise(migrateSqliteState({ path }))
    expect(report).toEqual({ from: STATE_VERSION, to: STATE_VERSION })
  })

  test("старый стор: открытие — StateSchemaError, после migrate данные живы", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "efmesh-migrate-")), "state.sqlite")
    createLegacyStore(path)

    const failure = await Effect.runPromise(Effect.flip(openStore(path)))
    expect(failure._tag).toBe("StateSchemaError")
    expect(failure).toMatchObject({ found: 0, wanted: STATE_VERSION })

    const report = await Effect.runPromise(migrateSqliteState({ path }))
    expect(report).toEqual({ from: 0, to: STATE_VERSION })

    // старый снапшот читается: physical_fp пуст → fallback на fingerprint
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        return yield* store.getSnapshot("med.a", "f1")
      }).pipe(Effect.provide(SqliteStateLive({ path }))),
    )
    expect(snapshot).toMatchObject({
      name: "med.a",
      fingerprint: "f1",
      physicalFp: "f1",
      canonicalAst: "",
      orphanedAt: null,
    })
  })
})
