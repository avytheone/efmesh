import { SQL } from "bun"
import { Clock, Effect, Layer } from "effect"
import type {
  EnvironmentRecord,
  IntervalRecord,
  PlanRecord,
  SnapshotRecord,
  StateStoreShape,
} from "./store.ts"
import { StateError, StateStore } from "./store.ts"

/**
 * State store в Postgres (SPEC §6, F3) — для командной/прод-работы:
 * состояние переживает конкурентные запуски из разных процессов и машин.
 * Схема `efmesh_state`, семантика один в один с bun:sqlite-реализацией;
 * временные метки — ISO UTC текстом (лексикографически сортируемы),
 * как и в SQLite: содержимое стора переносимо между бэкендами.
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
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS efmesh_state.intervals (
  snapshot_fp TEXT NOT NULL,
  start_ts    TEXT NOT NULL,
  end_ts      TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_fp, start_ts)
);
CREATE TABLE IF NOT EXISTS efmesh_state.locks (
  name        TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`

export interface PostgresStateOptions {
  /** postgres://… или unix-сокет через ?host=/путь. */
  readonly url: string
  /** Размер пула; состоянию хватает пары соединений. */
  readonly max?: number
}

const SNAPSHOT_COLUMNS = `
  name, fingerprint, rendered_sql AS "renderedSql",
  canonical_ast AS "canonicalAst", kind, created_at AS "createdAt",
  orphaned_at AS "orphanedAt",
  CASE WHEN physical_fp = '' THEN fingerprint ELSE physical_fp END AS "physicalFp"
`

export const PostgresStateLive = (
  options: PostgresStateOptions,
): Layer.Layer<StateStore, StateError> =>
  Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const sql = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const pool = new SQL({ url: options.url, max: options.max ?? 4 })
            await pool.unsafe(SCHEMA)
            return pool
          },
          catch: (cause) => new StateError({ operation: "open", cause }),
        }),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.ignore),
      )

      const attempt = <A>(operation: string, body: () => Promise<A>) =>
        Effect.tryPromise({
          try: body,
          catch: (cause) => new StateError({ operation, cause }),
        })

      const isoNow = Clock.currentTimeMillis.pipe(
        Effect.map((ms) => new Date(ms).toISOString()),
      )

      const service: StateStoreShape = {
        upsertSnapshot: (snapshot) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("upsertSnapshot", async () => {
                await sql.unsafe(
                  `INSERT INTO efmesh_state.snapshots
                     (name, fingerprint, rendered_sql, canonical_ast, physical_fp, kind, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)
                   ON CONFLICT (name, fingerprint) DO NOTHING`,
                  [
                    snapshot.name,
                    snapshot.fingerprint,
                    snapshot.renderedSql,
                    snapshot.canonicalAst,
                    snapshot.physicalFp,
                    snapshot.kind,
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
                  await tx.unsafe(`DELETE FROM efmesh_state.environments WHERE env = $1`, [env])
                  for (const entry of entries) {
                    await tx.unsafe(
                      `INSERT INTO efmesh_state.environments (env, name, fingerprint, promoted_at)
                       VALUES ($1, $2, $3, $4)`,
                      [env, entry.name, entry.fingerprint, now],
                    )
                  }
                  // учёт сиротства — как в sqlite-реализации (SPEC §5.4)
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

        recordPlan: (env, summary) =>
          isoNow.pipe(
            Effect.flatMap((now) =>
              attempt("recordPlan", async () => {
                await sql.unsafe(
                  `INSERT INTO efmesh_state.plans (env, summary, applied_at) VALUES ($1, $2, $3)`,
                  [env, summary, now],
                )
              }),
            ),
          ),

        listPlans: (env) =>
          attempt("listPlans", async () => {
            return (await sql.unsafe(
              `SELECT id, env, summary, applied_at AS "appliedAt"
               FROM efmesh_state.plans WHERE env = $1 ORDER BY id`,
              [env],
            )) as ReadonlyArray<PlanRecord>
          }),

        acquireLock: (name, ttlMs) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              attempt("acquireLock", () =>
                sql.begin(async (tx) => {
                  const now = new Date(nowMs).toISOString()
                  const expires = new Date(nowMs + ttlMs).toISOString()
                  // протухший лок упавшего процесса перехватывается;
                  // <= — лок, истёкший в момент T, свободен с T
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
