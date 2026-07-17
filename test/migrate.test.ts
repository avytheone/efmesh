import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { migrateSqliteState, SqliteStateLive } from "../src/state/sqlite.ts"
import { STATE_VERSION, StateStore } from "../src/state/store.ts"

const openStore = (path: string) =>
  Effect.gen(function* () {
    return yield* StateStore
  }).pipe(Effect.provide(SqliteStateLive({ path })))

/** An F0-era store: without canonical_ast/orphaned_at/physical_fp and without meta. */
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

describe("state store schema version + migrate (SPEC §6, F4)", () => {
  test("a fresh store bootstraps itself; migrate on it — already at the version", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "efmesh-migrate-")), "state.sqlite")
    const store = await Effect.runPromise(openStore(path))
    expect(store).toBeDefined()
    const report = await Effect.runPromise(migrateSqliteState({ path }))
    expect(report).toEqual({ from: STATE_VERSION, to: STATE_VERSION })
  })

  test("old store: opening — StateSchemaError, after migrate the data is alive", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "efmesh-migrate-")), "state.sqlite")
    createLegacyStore(path)

    const failure = await Effect.runPromise(Effect.flip(openStore(path)))
    expect(failure._tag).toBe("StateSchemaError")
    expect(failure).toMatchObject({ found: 0, wanted: STATE_VERSION })

    const report = await Effect.runPromise(migrateSqliteState({ path }))
    expect(report).toMatchObject({ from: 0, to: STATE_VERSION })

    // the old snapshot reads back: physical_fp is empty → fallback to fingerprint
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

  test("version 1 store (F4): opening — StateSchemaError, migrate backfills applied_by", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "efmesh-migrate-")), "state.sqlite")
    // version 1 layout: plans still without applied_by, meta already present;
    // snapshots is required — it distinguishes the store from a fresh one (bootstrap)
    const db = new Database(path, { create: true })
    db.exec(`
      CREATE TABLE snapshots (
        name TEXT NOT NULL, fingerprint TEXT NOT NULL, rendered_sql TEXT NOT NULL,
        canonical_ast TEXT NOT NULL DEFAULT '', physical_fp TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL, created_at TEXT NOT NULL, orphaned_at TEXT,
        PRIMARY KEY (name, fingerprint)
      );
      CREATE TABLE plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, env TEXT NOT NULL,
        summary TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      CREATE TABLE meta (version INTEGER NOT NULL);
      INSERT INTO meta (version) VALUES (1);
      INSERT INTO plans (env, summary, applied_at) VALUES ('dev', '{}', '2026-01-01T00:00:00.000Z');
    `)
    db.close()

    const failure = await Effect.runPromise(Effect.flip(openStore(path)))
    expect(failure._tag).toBe("StateSchemaError")
    expect(failure).toMatchObject({ found: 1, wanted: STATE_VERSION })

    const report = await Effect.runPromise(migrateSqliteState({ path }))
    expect(report).toMatchObject({ from: 1, to: STATE_VERSION })

    const plans = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        yield* store.recordPlan("dev", "{}", "avy")
        return yield* store.listPlans("dev")
      }).pipe(Effect.provide(SqliteStateLive({ path }))),
    )
    // the journal ascribes an empty author to the old record, a real one to the new
    expect(plans.map((plan) => plan.appliedBy)).toEqual(["", "avy"])
  })

  test("migrate takes a store backup before upgrading; on a current one — none", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "efmesh-migrate-")), "state.sqlite")
    createLegacyStore(path)

    const report = await Effect.runPromise(migrateSqliteState({ path }))
    expect(report.backup).toBe(`${path}.backup-v0`)
    expect(existsSync(`${path}.backup-v0`)).toBe(true)
    // the backup holds the pre-version layout: the efmesh version can be rolled back
    const backup = new Database(`${path}.backup-v0`)
    expect(backup.query(`SELECT 1 FROM sqlite_master WHERE name = 'meta'`).get()).toBeNull()
    backup.close()

    // a repeated migrate on a current store does not spawn a backup
    const idle = await Effect.runPromise(migrateSqliteState({ path }))
    expect(idle.backup).toBeUndefined()
  })
})
