import { SQL } from "bun"
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

/**
 * State store on Postgres (SPEC §6, F3) — for team/production work: state
 * survives concurrent runs from different processes and machines.
 * Schema `efmesh_state`, semantics identical to the bun:sqlite implementation;
 * timestamps are ISO UTC text (lexicographically sortable), same as in
 * SQLite: the store's contents are portable between backends.
 */

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS efmesh_state;
CREATE TABLE IF NOT EXISTS efmesh_state.snapshots (
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
CREATE TABLE IF NOT EXISTS efmesh_state.environments (
  env         TEXT NOT NULL,
  name        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  PRIMARY KEY (env, name)
);
CREATE TABLE IF NOT EXISTS efmesh_state.plans (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  env        TEXT NOT NULL,
  summary    TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  applied_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS efmesh_state.intervals (
  snapshot_fp TEXT NOT NULL,
  start_ts    TEXT NOT NULL,
  end_ts      TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_fp, start_ts)
);
CREATE TABLE IF NOT EXISTS efmesh_state.runs (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  env         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS efmesh_state.canon_cache (
  key       TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS efmesh_state.locks (
  name        TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`

export interface PostgresStateOptions {
  /** postgres://… or a unix socket via ?host=/path. */
  readonly url: string
  /** Pool size; a couple of connections are enough for state. */
  readonly max?: number
}

const regclass = async (pool: SQL, table: string): Promise<boolean> => {
  const rows = (await pool.unsafe(
    `SELECT to_regclass('efmesh_state.${table}') AS r`,
  )) as ReadonlyArray<{ r: string | null }>
  return rows[0]?.r != null
}

/** 0 — a store with no meta table (created before versioning existed, F0–F3). */
const readVersion = async (pool: SQL): Promise<number> => {
  if (!(await regclass(pool, "meta"))) return 0
  const rows = (await pool.unsafe(`SELECT version FROM efmesh_state.meta`)) as ReadonlyArray<{
    version: number
  }>
  return rows[0]?.version ?? 0
}

/** Catches the schema up to STATE_VERSION (see the sqlite implementation — same semantics). */
const applyMigrations = async (pool: SQL): Promise<void> => {
  await pool.unsafe(SCHEMA)
  await pool.unsafe(`
    ALTER TABLE efmesh_state.snapshots ADD COLUMN IF NOT EXISTS canonical_ast TEXT NOT NULL DEFAULT '';
    ALTER TABLE efmesh_state.snapshots ADD COLUMN IF NOT EXISTS orphaned_at TEXT;
    ALTER TABLE efmesh_state.snapshots ADD COLUMN IF NOT EXISTS physical_fp TEXT NOT NULL DEFAULT '';
    ALTER TABLE efmesh_state.plans ADD COLUMN IF NOT EXISTS applied_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE efmesh_state.snapshots ADD COLUMN IF NOT EXISTS fingerprint_version INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS efmesh_state.meta (version INTEGER NOT NULL);
  `)
  await pool.begin(async (tx) => {
    await tx.unsafe(`DELETE FROM efmesh_state.meta`)
    await tx.unsafe(`INSERT INTO efmesh_state.meta (version) VALUES ($1)`, [STATE_VERSION])
  })
}

/** `efmesh migrate`: an explicit schema upgrade of an existing store. */
export const migratePostgresState = (
  options: PostgresStateOptions,
): Effect.Effect<MigrationReport, StateError> =>
  Effect.tryPromise({
    try: async () => {
      const pool = new SQL({ url: options.url, max: 1 })
      try {
        const from = await readVersion(pool)
        await applyMigrations(pool)
        return { from, to: STATE_VERSION }
      } finally {
        await pool.end()
      }
    },
    catch: (cause) => new StateError({ operation: "migrate", cause }),
  })

const SNAPSHOT_COLUMNS = `
  name, fingerprint, rendered_sql AS "renderedSql",
  canonical_ast AS "canonicalAst", kind, created_at AS "createdAt",
  orphaned_at AS "orphanedAt",
  fingerprint_version AS "fingerprintVersion",
  CASE WHEN physical_fp = '' THEN fingerprint ELSE physical_fp END AS "physicalFp"
`

export const PostgresStateLive = (
  options: PostgresStateOptions,
): Layer.Layer<StateStore, StateError | StateSchemaError> =>
  Layer.scoped(
    StateStore,
    Effect.gen(function* () {
      const sql = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => new SQL({ url: options.url, max: options.max ?? 4 }),
          catch: (cause) => new StateError({ operation: "open", cause }),
        }),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.ignore),
      )
      // a fresh store bootstraps at the current version; an existing store
      // with an older schema requires an explicit `efmesh migrate` (SPEC §6)
      const fresh = yield* Effect.tryPromise({
        try: async () => !(await regclass(sql, "snapshots")),
        catch: (cause) => new StateError({ operation: "open", cause }),
      })
      if (fresh) {
        yield* Effect.tryPromise({
          try: () => applyMigrations(sql),
          catch: (cause) => new StateError({ operation: "migrate", cause }),
        })
      } else {
        const version = yield* Effect.tryPromise({
          try: () => readVersion(sql),
          catch: (cause) => new StateError({ operation: "open", cause }),
        })
        if (version !== STATE_VERSION) {
          return yield* new StateSchemaError({ found: version, wanted: STATE_VERSION })
        }
      }

      const attempt = <A>(operation: string, body: () => Promise<A>) =>
        Effect.tryPromise({
          try: body,
          catch: (cause) => new StateError({ operation, cause }),
        })

      const isoNow = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))

      const service: StateStoreShape = {
        upsertSnapshot: (snapshot) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("upsertSnapshot", async () => {
                await sql.unsafe(
                  // reviving clears orphan status and refreshes created_at — same as sqlite (race, F6)
                  `INSERT INTO efmesh_state.snapshots
                     (name, fingerprint, rendered_sql, canonical_ast, physical_fp, kind, fingerprint_version, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                   ON CONFLICT (name, fingerprint)
                   DO UPDATE SET orphaned_at = NULL, created_at = excluded.created_at`,
                  [
                    snapshot.name,
                    snapshot.fingerprint,
                    snapshot.renderedSql,
                    snapshot.canonicalAst,
                    snapshot.physicalFp,
                    snapshot.kind,
                    snapshot.fingerprintVersion,
                    now,
                  ],
                )
              }),
            ),
          ),

        getSnapshot: (name, fingerprint) =>
          attempt("getSnapshot", async () => {
            const rows = (await sql.unsafe(
              `SELECT ${SNAPSHOT_COLUMNS} FROM efmesh_state.snapshots
               WHERE name = $1 AND fingerprint = $2`,
              [name, fingerprint],
            )) as ReadonlyArray<SnapshotRecord>
            return rows[0]
          }),

        listReferencedFingerprints: () =>
          attempt("listReferencedFingerprints", async () => {
            const rows = (await sql.unsafe(
              `SELECT DISTINCT fingerprint FROM efmesh_state.environments`,
            )) as ReadonlyArray<{ fingerprint: string }>
            return new Set(rows.map((row) => row.fingerprint))
          }),

        listSnapshots: () =>
          attempt("listSnapshots", async () => {
            return (await sql.unsafe(
              `SELECT ${SNAPSHOT_COLUMNS} FROM efmesh_state.snapshots ORDER BY name, created_at`,
            )) as ReadonlyArray<SnapshotRecord>
          }),

        deleteSnapshot: (name, fingerprint) =>
          attempt("deleteSnapshot", () =>
            sql.begin(async (tx) => {
              await tx.unsafe(
                `DELETE FROM efmesh_state.snapshots WHERE name = $1 AND fingerprint = $2`,
                [name, fingerprint],
              )
              await tx.unsafe(`DELETE FROM efmesh_state.intervals WHERE snapshot_fp = $1`, [
                fingerprint,
              ])
            }),
          ).pipe(Effect.asVoid),

        deleteSnapshotIfDoomed: (name, fingerprint, deadline) =>
          attempt(
            "deleteSnapshotIfDoomed",
            () =>
              sql.begin(async (tx) => {
                const deleted = (await tx.unsafe(
                  `DELETE FROM efmesh_state.snapshots
                 WHERE name = $1 AND fingerprint = $2
                   AND COALESCE(orphaned_at, created_at) <= $3
                   AND NOT EXISTS (
                     SELECT 1 FROM efmesh_state.environments e WHERE e.fingerprint = $2
                   )
                 RETURNING 1`,
                  [name, fingerprint, deadline],
                )) as ReadonlyArray<unknown>
                if (deleted.length === 0) return false
                await tx.unsafe(`DELETE FROM efmesh_state.intervals WHERE snapshot_fp = $1`, [
                  fingerprint,
                ])
                return true
              }) as Promise<boolean>,
          ),

        getEnvironment: (env) =>
          attempt("getEnvironment", async () => {
            return (await sql.unsafe(
              `SELECT env, name, fingerprint, promoted_at AS "promotedAt"
               FROM efmesh_state.environments WHERE env = $1 ORDER BY name`,
              [env],
            )) as ReadonlyArray<EnvironmentRecord>
          }),

        promote: (env, entries) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("promote", () =>
                sql.begin(async (tx) => {
                  // snapshot liveness — in the same transaction (race, F6):
                  // janitor removed the version → loud error, the view is left alone
                  for (const entry of entries) {
                    if (entry.requireSnapshot !== true) continue
                    const alive = (await tx.unsafe(
                      `SELECT 1 FROM efmesh_state.snapshots WHERE name = $1 AND fingerprint = $2`,
                      [entry.name, entry.fingerprint],
                    )) as ReadonlyArray<unknown>
                    if (alive.length === 0) {
                      throw new Error(
                        `promotion "${env}": snapshot ${entry.name}@${entry.fingerprint.slice(0, 8)} vanished from the store (removed by janitor?) — retry apply`,
                      )
                    }
                  }
                  await tx.unsafe(`DELETE FROM efmesh_state.environments WHERE env = $1`, [env])
                  for (const entry of entries) {
                    await tx.unsafe(
                      `INSERT INTO efmesh_state.environments (env, name, fingerprint, promoted_at)
                       VALUES ($1, $2, $3, $4)`,
                      [env, entry.name, entry.fingerprint, now],
                    )
                  }
                  // orphan bookkeeping — same as the sqlite implementation (SPEC §5.4)
                  await tx.unsafe(
                    `UPDATE efmesh_state.snapshots SET orphaned_at = $1
                     WHERE orphaned_at IS NULL
                       AND fingerprint NOT IN (SELECT fingerprint FROM efmesh_state.environments)`,
                    [now],
                  )
                  await tx.unsafe(
                    `UPDATE efmesh_state.snapshots SET orphaned_at = NULL
                     WHERE orphaned_at IS NOT NULL
                       AND fingerprint IN (SELECT fingerprint FROM efmesh_state.environments)`,
                  )
                }),
              ).pipe(Effect.asVoid),
            ),
          ),

        recordPlan: (env, summary, appliedBy) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("recordPlan", async () => {
                await sql.unsafe(
                  `INSERT INTO efmesh_state.plans (env, summary, applied_at, applied_by) VALUES ($1, $2, $3, $4)`,
                  [env, summary, now, appliedBy],
                )
              }),
            ),
          ),

        listPlans: (env) =>
          attempt("listPlans", async () => {
            return (await sql.unsafe(
              `SELECT id, env, summary, applied_at AS "appliedAt", applied_by AS "appliedBy"
               FROM efmesh_state.plans WHERE env = $1 ORDER BY id`,
              [env],
            )) as ReadonlyArray<PlanRecord>
          }),

        getCanon: (key) =>
          attempt("getCanon", async () => {
            const rows = (await sql.unsafe(
              `SELECT canonical FROM efmesh_state.canon_cache WHERE key = $1`,
              [key],
            )) as ReadonlyArray<{ canonical: string }>
            return rows[0]?.canonical
          }),

        putCanon: (key, canonical) =>
          attempt("putCanon", async () => {
            await sql.unsafe(
              `INSERT INTO efmesh_state.canon_cache (key, canonical) VALUES ($1, $2)
               ON CONFLICT (key) DO NOTHING`,
              [key, canonical],
            )
          }),

        recordRun: (record) =>
          attempt("recordRun", async () => {
            await sql.unsafe(
              `INSERT INTO efmesh_state.runs (env, started_at, finished_at, outcome, detail)
               VALUES ($1, $2, $3, $4, $5)`,
              [record.env, record.startedAt, record.finishedAt, record.outcome, record.detail],
            )
          }),

        listRuns: (env, limit) =>
          attempt("listRuns", async () => {
            return (await sql.unsafe(
              `SELECT id, env, started_at AS "startedAt", finished_at AS "finishedAt", outcome, detail
               FROM efmesh_state.runs WHERE env = $1 ORDER BY id DESC LIMIT $2`,
              [env, limit],
            )) as ReadonlyArray<RunRecord>
          }),

        acquireLock: (name, ttlMs) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              attempt("acquireLock", () =>
                sql.begin(async (tx) => {
                  const now = new Date(nowMs).toISOString()
                  const expires = new Date(nowMs + ttlMs).toISOString()
                  // a stale lock from a crashed process is reclaimed;
                  // <= — a lock that expires at instant T is free as of T
                  await tx.unsafe(
                    `DELETE FROM efmesh_state.locks WHERE name = $1 AND expires_at <= $2`,
                    [name, now],
                  )
                  const rows = (await tx.unsafe(
                    `INSERT INTO efmesh_state.locks (name, acquired_at, expires_at)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (name) DO NOTHING
                     RETURNING name`,
                    [name, now, expires],
                  )) as ReadonlyArray<unknown>
                  return rows.length > 0
                }),
              ),
            ),
          ),

        releaseLock: (name) =>
          attempt("releaseLock", async () => {
            await sql.unsafe(`DELETE FROM efmesh_state.locks WHERE name = $1`, [name])
          }),

        markIntervals: (snapshotFp, intervals, status) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("markIntervals", () =>
                sql.begin(async (tx) => {
                  for (const interval of intervals) {
                    await tx.unsafe(
                      `INSERT INTO efmesh_state.intervals (snapshot_fp, start_ts, end_ts, status, updated_at)
                       VALUES ($1, $2, $3, $4, $5)
                       ON CONFLICT (snapshot_fp, start_ts)
                       DO UPDATE SET end_ts = $3, status = $4, updated_at = $5`,
                      [snapshotFp, interval.startTs, interval.endTs, status, now],
                    )
                  }
                }),
              ).pipe(Effect.asVoid),
            ),
          ),

        listIntervals: (snapshotFp) =>
          attempt("listIntervals", async () => {
            return (await sql.unsafe(
              `SELECT snapshot_fp AS "snapshotFp", start_ts AS "startTs", end_ts AS "endTs",
                      status, updated_at AS "updatedAt"
               FROM efmesh_state.intervals WHERE snapshot_fp = $1 ORDER BY start_ts`,
              [snapshotFp],
            )) as ReadonlyArray<IntervalRecord>
          }),
      }
      return service
    }),
  )
