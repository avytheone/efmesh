import { Database } from "bun:sqlite"
import { copyFileSync, existsSync } from "node:fs"
import { Clock, Effect, Layer } from "effect"
import type {
  EnvironmentRecord,
  IntervalRecord,
  MigrationReport,
  PlanRecord,
  RunRecord,
  SnapshotRecord,
  StateStoreShape,
} from "./store.ts"
import { STATE_VERSION, StateError, StateSchemaError, StateStore } from "./store.ts"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  name          TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  rendered_sql  TEXT NOT NULL,
  canonical_ast TEXT NOT NULL DEFAULT '',
  physical_fp   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  fingerprint_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  orphaned_at   TEXT,
  PRIMARY KEY (name, fingerprint)
);
CREATE TABLE IF NOT EXISTS environments (
  env         TEXT NOT NULL,
  name        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  PRIMARY KEY (env, name)
);
CREATE TABLE IF NOT EXISTS plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  env        TEXT NOT NULL,
  summary    TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  applied_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS intervals (
  snapshot_fp TEXT NOT NULL,
  start_ts    TEXT NOT NULL,
  end_ts      TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_fp, start_ts)
);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  env         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS canon_cache (
  key       TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  name        TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`

export interface SqliteStateOptions {
  /** Path to the state file; defaults to in-memory (tests). */
  readonly path?: string
}

const isoNow = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))

const tableExists = (db: Database, name: string): boolean =>
  db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1`).get(name) !== null

/** 0 — a store with no meta table (created before versioning existed, F0–F3). */
const readVersion = (db: Database): number => {
  if (!tableExists(db, "meta")) return 0
  const row = db.query(`SELECT version FROM meta`).get() as { version: number } | null
  return row?.version ?? 0
}

/**
 * Catches the schema up to STATE_VERSION. Version 1 = base layout F4,
 * version 2 = applied_by in the plan journal (F5); the ALTERs below pick up
 * stores created before the corresponding columns existed (canonical_ast —
 * F2, orphaned_at/physical_fp — F3, applied_by — F5) — on a fresh store
 * they are a no-op via try/catch. Future versions get new entries right here.
 */
const applyMigrations = (db: Database): void => {
  db.exec(SCHEMA)
  for (const alter of [
    `ALTER TABLE snapshots ADD COLUMN canonical_ast TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE snapshots ADD COLUMN orphaned_at TEXT`,
    `ALTER TABLE snapshots ADD COLUMN physical_fp TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN applied_by TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE snapshots ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1`,
  ]) {
    try {
      db.exec(alter)
    } catch {
      // column already exists
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta (version INTEGER NOT NULL)`)
  db.exec(`DELETE FROM meta`)
  db.query(`INSERT INTO meta (version) VALUES (?1)`).run(STATE_VERSION)
}

/**
 * `efmesh migrate`: an explicit schema upgrade of an existing store.
 * Before the upgrade, the file is copied to `<path>.backup-v<from>` —
 * otherwise rolling back to an older efmesh version would be a one-way trip (F6).
 */
export const migrateSqliteState = (
  options?: SqliteStateOptions,
): Effect.Effect<MigrationReport, StateError> =>
  Effect.try({
    try: () => {
      const path = options?.path ?? ":memory:"
      const db = new Database(path, { create: true })
      try {
        const from = readVersion(db)
        let backup: string | undefined
        if (path !== ":memory:" && from !== STATE_VERSION && existsSync(path)) {
          backup = `${path}.backup-v${from}`
          copyFileSync(path, backup)
        }
        applyMigrations(db)
        return { from, to: STATE_VERSION, ...(backup !== undefined ? { backup } : {}) }
      } finally {
        db.close()
      }
    },
    catch: (cause) => new StateError({ operation: "migrate", cause }),
  })

export const SqliteStateLive = (
  options?: SqliteStateOptions,
): Layer.Layer<StateStore, StateError | StateSchemaError> =>
  Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const db = new Database(options?.path ?? ":memory:", { create: true })
            db.exec("PRAGMA journal_mode = WAL;")
            return db
          },
          catch: (cause) => new StateError({ operation: "open", cause }),
        }),
        (db) => Effect.sync(() => db.close()),
      )
      // a fresh store bootstraps at the current version; an existing store
      // with an older schema requires an explicit `efmesh migrate` — silently
      // rewriting someone else's data on open is not allowed (SPEC §6)
      const fresh = yield* Effect.try({
        try: () => !tableExists(db, "snapshots"),
        catch: (cause) => new StateError({ operation: "open", cause }),
      })
      if (fresh) {
        yield* Effect.try({
          try: () => applyMigrations(db),
          catch: (cause) => new StateError({ operation: "migrate", cause }),
        })
      } else {
        const version = yield* Effect.try({
          try: () => readVersion(db),
          catch: (cause) => new StateError({ operation: "open", cause }),
        })
        if (version !== STATE_VERSION) {
          return yield* new StateSchemaError({ found: version, wanted: STATE_VERSION })
        }
      }

      const attempt = <A>(operation: string, body: () => A) =>
        Effect.try({ try: body, catch: (cause) => new StateError({ operation, cause }) })

      const service: StateStoreShape = {
        upsertSnapshot: (snapshot) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("upsertSnapshot", () => {
                // reviving a version (a repeated apply of an old fingerprint)
                // clears orphan status AND refreshes created_at IMMEDIATELY: between
                // the upsert and promotion, the janitor won't judge it doomed by
                // either orphaned_at or a stale created_at (race, F6)
                db.query(
                  `INSERT INTO snapshots (name, fingerprint, rendered_sql, canonical_ast, physical_fp, kind, fingerprint_version, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                   ON CONFLICT (name, fingerprint)
                   DO UPDATE SET orphaned_at = NULL, created_at = excluded.created_at`,
                ).run(
                  snapshot.name,
                  snapshot.fingerprint,
                  snapshot.renderedSql,
                  snapshot.canonicalAst,
                  snapshot.physicalFp,
                  snapshot.kind,
                  snapshot.fingerprintVersion,
                  now,
                )
              }),
            ),
          ),

        getSnapshot: (name, fingerprint) =>
          attempt("getSnapshot", () => {
            const row = db
              .query(
                `SELECT name, fingerprint, rendered_sql AS renderedSql,
                        canonical_ast AS canonicalAst, kind, created_at AS createdAt,
                        orphaned_at AS orphanedAt, fingerprint_version AS fingerprintVersion,
                        CASE WHEN physical_fp = '' THEN fingerprint ELSE physical_fp END AS physicalFp
                 FROM snapshots WHERE name = ?1 AND fingerprint = ?2`,
              )
              .get(name, fingerprint) as SnapshotRecord | null
            return row ?? undefined
          }),

        listReferencedFingerprints: () =>
          attempt("listReferencedFingerprints", () => {
            const rows = db
              .query(`SELECT DISTINCT fingerprint FROM environments`)
              .all() as ReadonlyArray<{ fingerprint: string }>
            return new Set(rows.map((r) => r.fingerprint))
          }),

        listSnapshots: () =>
          attempt("listSnapshots", () => {
            return db
              .query(
                `SELECT name, fingerprint, rendered_sql AS renderedSql,
                        canonical_ast AS canonicalAst, kind, created_at AS createdAt,
                        orphaned_at AS orphanedAt, fingerprint_version AS fingerprintVersion,
                        CASE WHEN physical_fp = '' THEN fingerprint ELSE physical_fp END AS physicalFp
                 FROM snapshots ORDER BY name, created_at`,
              )
              .all() as ReadonlyArray<SnapshotRecord>
          }),

        deleteSnapshot: (name, fingerprint) =>
          attempt("deleteSnapshot", () => {
            const remove = db.transaction(() => {
              db.query(`DELETE FROM snapshots WHERE name = ?1 AND fingerprint = ?2`).run(
                name,
                fingerprint,
              )
              db.query(`DELETE FROM intervals WHERE snapshot_fp = ?1`).run(fingerprint)
            })
            remove()
          }),

        deleteSnapshotIfDoomed: (name, fingerprint, deadline) =>
          attempt("deleteSnapshotIfDoomed", () => {
            const claim = db.transaction((): boolean => {
              const referenced =
                db
                  .query(`SELECT 1 FROM environments WHERE fingerprint = ?1 LIMIT 1`)
                  .get(fingerprint) !== null
              if (referenced) return false
              const result = db
                .query(
                  `DELETE FROM snapshots
                   WHERE name = ?1 AND fingerprint = ?2
                     AND COALESCE(orphaned_at, created_at) <= ?3`,
                )
                .run(name, fingerprint, deadline)
              if (result.changes === 0) return false
              db.query(`DELETE FROM intervals WHERE snapshot_fp = ?1`).run(fingerprint)
              return true
            })
            return claim() as boolean
          }),

        getEnvironment: (env) =>
          attempt("getEnvironment", () => {
            return db
              .query(
                `SELECT env, name, fingerprint, promoted_at AS promotedAt
                 FROM environments WHERE env = ?1 ORDER BY name`,
              )
              .all(env) as ReadonlyArray<EnvironmentRecord>
          }),

        promote: (env, entries) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("promote", () => {
                const replace = db.transaction(() => {
                  // snapshot liveness — in the same transaction: if the janitor
                  // already removed the version, promotion fails loudly, and the
                  // view never switches to demolished physics (race, F6)
                  const alive = db.query(
                    `SELECT 1 FROM snapshots WHERE name = ?1 AND fingerprint = ?2`,
                  )
                  for (const entry of entries) {
                    if (
                      entry.requireSnapshot === true &&
                      alive.get(entry.name, entry.fingerprint) === null
                    ) {
                      throw new Error(
                        `promotion "${env}": snapshot ${entry.name}@${entry.fingerprint.slice(0, 8)} vanished from the store (removed by janitor?) — retry apply`,
                      )
                    }
                  }
                  db.query(`DELETE FROM environments WHERE env = ?1`).run(env)
                  const insert = db.query(
                    `INSERT INTO environments (env, name, fingerprint, promoted_at)
                     VALUES (?1, ?2, ?3, ?4)`,
                  )
                  for (const entry of entries) {
                    insert.run(env, entry.name, entry.fingerprint, now)
                  }
                  // referencing changes only here — so orphan bookkeeping happens
                  // right here too: those losing their last reference get marked,
                  // those returning (rollback to an old version) lose the mark (SPEC §5.4)
                  db.query(
                    `UPDATE snapshots SET orphaned_at = ?1
                     WHERE orphaned_at IS NULL
                       AND fingerprint NOT IN (SELECT fingerprint FROM environments)`,
                  ).run(now)
                  db.query(
                    `UPDATE snapshots SET orphaned_at = NULL
                     WHERE orphaned_at IS NOT NULL
                       AND fingerprint IN (SELECT fingerprint FROM environments)`,
                  ).run()
                })
                replace()
              }),
            ),
          ),

        recordPlan: (env, summary, appliedBy) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("recordPlan", () => {
                db.query(
                  `INSERT INTO plans (env, summary, applied_at, applied_by) VALUES (?1, ?2, ?3, ?4)`,
                ).run(env, summary, now, appliedBy)
              }),
            ),
          ),

        listPlans: (env) =>
          attempt("listPlans", () => {
            return db
              .query(
                `SELECT id, env, summary, applied_at AS appliedAt, applied_by AS appliedBy
                 FROM plans WHERE env = ?1 ORDER BY id`,
              )
              .all(env) as ReadonlyArray<PlanRecord>
          }),

        getCanon: (key) =>
          attempt("getCanon", () => {
            const row = db.query(`SELECT canonical FROM canon_cache WHERE key = ?1`).get(key) as {
              canonical: string
            } | null
            return row?.canonical ?? undefined
          }),

        putCanon: (key, canonical) =>
          attempt("putCanon", () => {
            db.query(
              `INSERT INTO canon_cache (key, canonical) VALUES (?1, ?2)
               ON CONFLICT (key) DO NOTHING`,
            ).run(key, canonical)
          }),

        recordRun: (record) =>
          attempt("recordRun", () => {
            db.query(
              `INSERT INTO runs (env, started_at, finished_at, outcome, detail)
               VALUES (?1, ?2, ?3, ?4, ?5)`,
            ).run(record.env, record.startedAt, record.finishedAt, record.outcome, record.detail)
          }),

        listRuns: (env, limit) =>
          attempt("listRuns", () => {
            return db
              .query(
                `SELECT id, env, started_at AS startedAt, finished_at AS finishedAt, outcome, detail
                 FROM runs WHERE env = ?1 ORDER BY id DESC LIMIT ?2`,
              )
              .all(env, limit) as ReadonlyArray<RunRecord>
          }),

        acquireLock: (name, ttlMs) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              attempt("acquireLock", () => {
                const now = new Date(nowMs).toISOString()
                const expires = new Date(nowMs + ttlMs).toISOString()
                const acquire = db.transaction(() => {
                  // a stale lock from a crashed process is reclaimed;
                  // <= — a lock that expires at instant T is free as of T (ttl=0 in the same ms)
                  db.query(`DELETE FROM locks WHERE name = ?1 AND expires_at <= ?2`).run(name, now)
                  const result = db
                    .query(
                      `INSERT INTO locks (name, acquired_at, expires_at)
                       VALUES (?1, ?2, ?3)
                       ON CONFLICT (name) DO NOTHING`,
                    )
                    .run(name, now, expires)
                  return result.changes > 0
                })
                return acquire()
              }),
            ),
          ),

        releaseLock: (name) =>
          attempt("releaseLock", () => {
            db.query(`DELETE FROM locks WHERE name = ?1`).run(name)
          }),

        markIntervals: (snapshotFp, intervals, status) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("markIntervals", () => {
                const upsert = db.query(
                  `INSERT INTO intervals (snapshot_fp, start_ts, end_ts, status, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5)
                   ON CONFLICT (snapshot_fp, start_ts)
                   DO UPDATE SET end_ts = ?3, status = ?4, updated_at = ?5`,
                )
                const all = db.transaction(() => {
                  for (const interval of intervals) {
                    upsert.run(snapshotFp, interval.startTs, interval.endTs, status, now)
                  }
                })
                all()
              }),
            ),
          ),

        listIntervals: (snapshotFp) =>
          attempt("listIntervals", () => {
            return db
              .query(
                `SELECT snapshot_fp AS snapshotFp, start_ts AS startTs, end_ts AS endTs,
                        status, updated_at AS updatedAt
                 FROM intervals WHERE snapshot_fp = ?1 ORDER BY start_ts`,
              )
              .all(snapshotFp) as ReadonlyArray<IntervalRecord>
          }),

        clearIntervals: (snapshotFp, from, to) =>
          attempt("clearIntervals", () => {
            db.query(
              `DELETE FROM intervals
               WHERE snapshot_fp = ?1 AND start_ts >= ?2 AND start_ts < ?3`,
            ).run(snapshotFp, from, to)
          }),
      }
      return service
    }),
  )
