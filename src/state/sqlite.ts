import { Database } from "bun:sqlite"
import { Clock, Effect, Layer } from "effect"
import type {
  EnvironmentRecord,
  IntervalRecord,
  PlanRecord,
  SnapshotRecord,
  StateStoreShape,
} from "./store.ts"
import { StateError, StateStore } from "./store.ts"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  name          TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  rendered_sql  TEXT NOT NULL,
  canonical_ast TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
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
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intervals (
  snapshot_fp TEXT NOT NULL,
  start_ts    TEXT NOT NULL,
  end_ts      TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_fp, start_ts)
);
CREATE TABLE IF NOT EXISTS locks (
  name        TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`

export interface SqliteStateOptions {
  /** Путь к файлу состояния; по умолчанию in-memory (тесты). */
  readonly path?: string
}

const isoNow = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))

export const SqliteStateLive = (
  options?: SqliteStateOptions,
): Layer.Layer<StateStore, StateError> =>
  Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const db = new Database(options?.path ?? ":memory:", { create: true })
            db.exec("PRAGMA journal_mode = WAL;")
            db.exec(SCHEMA)
            // миграция баз, созданных до появления canonical_ast (F2)
            try {
              db.exec(`ALTER TABLE snapshots ADD COLUMN canonical_ast TEXT NOT NULL DEFAULT ''`)
            } catch {
              // колонка уже есть
            }
            return db
          },
          catch: (cause) => new StateError({ operation: "open", cause }),
        }),
        (db) => Effect.sync(() => db.close()),
      )

      const attempt = <A>(operation: string, body: () => A) =>
        Effect.try({ try: body, catch: (cause) => new StateError({ operation, cause }) })

      const service: StateStoreShape = {
        upsertSnapshot: (snapshot) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("upsertSnapshot", () => {
                db.query(
                  `INSERT INTO snapshots (name, fingerprint, rendered_sql, canonical_ast, kind, created_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                   ON CONFLICT (name, fingerprint) DO NOTHING`,
                ).run(
                  snapshot.name,
                  snapshot.fingerprint,
                  snapshot.renderedSql,
                  snapshot.canonicalAst,
                  snapshot.kind,
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
                        canonical_ast AS canonicalAst, kind, created_at AS createdAt
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
                        canonical_ast AS canonicalAst, kind, created_at AS createdAt
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
                  db.query(`DELETE FROM environments WHERE env = ?1`).run(env)
                  const insert = db.query(
                    `INSERT INTO environments (env, name, fingerprint, promoted_at)
                     VALUES (?1, ?2, ?3, ?4)`,
                  )
                  for (const entry of entries) {
                    insert.run(env, entry.name, entry.fingerprint, now)
                  }
                })
                replace()
              }),
            ),
          ),

        recordPlan: (env, summary) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("recordPlan", () => {
                db.query(`INSERT INTO plans (env, summary, applied_at) VALUES (?1, ?2, ?3)`).run(
                  env,
                  summary,
                  now,
                )
              }),
            ),
          ),

        listPlans: (env) =>
          attempt("listPlans", () => {
            return db
              .query(
                `SELECT id, env, summary, applied_at AS appliedAt
                 FROM plans WHERE env = ?1 ORDER BY id`,
              )
              .all(env) as ReadonlyArray<PlanRecord>
          }),

        acquireLock: (name, ttlMs) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              attempt("acquireLock", () => {
                const now = new Date(nowMs).toISOString()
                const expires = new Date(nowMs + ttlMs).toISOString()
                const acquire = db.transaction(() => {
                  // протухший лок упавшего процесса перехватывается;
                  // <= — лок, истёкший в момент T, свободен с T (ttl=0 в ту же мс)
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
      }
      return service
    }),
  )
