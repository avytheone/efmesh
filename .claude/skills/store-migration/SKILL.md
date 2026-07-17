---
name: store-migration
description: Change the efmesh state-store schema safely — bump STATE_VERSION and ship migrations for BOTH the SQLite and Postgres backends with tests. Use when adding/altering a state-store table or column, or when a change would otherwise make an old store unreadable.
---

# State-store schema migration

`STATE_VERSION` (`src/state/store.ts`) is a contract. A fresh store bootstraps
directly at the current version; an older store **refuses to open**
(`StateSchemaError`) until `efmesh migrate` upgrades it. Any schema change must
land in both backends or the two stores diverge.

## The two backends (keep them in lockstep)

- `src/state/sqlite.ts` — `bun:sqlite`. `SCHEMA` (`CREATE TABLE IF NOT
  EXISTS …`) + `applyMigrations(db)` (an idempotent list of
  `ALTER TABLE … ADD COLUMN`, each wrapped so "column already exists" is a no-op).
- `src/state/postgres.ts` — `Bun.SQL`, schema `efmesh_state`. `SCHEMA` +
  `applyMigrations(pool)` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS …`).

Both `applyMigrations` end by writing `STATE_VERSION` into the `meta` table.
A store with no `meta` table reads as version `0` (pre-versioning, F0–F3).

## Checklist

1. **Bump `STATE_VERSION`** in `src/state/store.ts` and extend the doc comment
   above it (the per-version legend: `1 — base layout … 5 — canon_cache …`).
   Add your line describing what version N introduces.
2. **SQLite** (`src/state/sqlite.ts`):
   - Add the new table/column to the `SCHEMA` string (so a fresh store gets it).
   - For an added column, append the `ALTER TABLE … ADD COLUMN … DEFAULT …` to
     the loop in `applyMigrations` (the `try/catch` makes it a no-op on a store
     that already has it). A new table goes via `CREATE TABLE IF NOT EXISTS` in
     `SCHEMA` (already re-run by `applyMigrations`).
   - Wire any new column through the affected `StateStoreShape` methods and the
     `SnapshotRecord`/etc. interface in `store.ts`, plus the `SELECT … AS …`
     projections.
3. **Postgres** (`src/state/postgres.ts`): mirror step 2 — add to `SCHEMA`, add
   the matching `ALTER TABLE efmesh_state.… ADD COLUMN IF NOT EXISTS …` to
   `applyMigrations`, mirror the `SNAPSHOT_COLUMNS`/projection changes.
4. **Backup semantics (SQLite only):** `migrateSqliteState` already copies the
   file to `<path>.backup-v<from>` before upgrading when `from !== STATE_VERSION`.
   Do not remove this. Postgres has no file backup (server-managed).
5. **Tests** (`test/migrate.test.ts`, `test/state.test.ts`):
   - Add/extend a legacy-store fixture that builds the *previous* version's
     layout (see `createLegacyStore` and the "version 1 store" fixture — they
     hand-craft old tables and `INSERT INTO meta (version) VALUES (n)`).
   - Assert: opening the old store → `StateSchemaError` with
     `{ found: <old>, wanted: STATE_VERSION }`; after `migrateSqliteState` the
     report is `{ from: <old>, to: STATE_VERSION }`; old rows read back with the
     new column defaulted; the backup file exists at `<path>.backup-v<from>`.
   - Fresh-store test: `migrate` reports `{ from: STATE_VERSION, to: STATE_VERSION }`
     and spawns no backup.
6. **Green:** `bun test` (Postgres tests self-skip if `initdb` is not on PATH —
   install `postgresql` to exercise the Postgres migration path) and
   `bun run check`.
7. **CHANGELOG** `## [Unreleased]`: note the schema bump and that
   `efmesh migrate` is required (with the SQLite backup).

## Invariants

- Migrations are **additive and idempotent** — re-running `applyMigrations` on a
  current store is a no-op; never drop or rewrite existing user data on open.
- A schema change **without** a `STATE_VERSION` bump is a silent corruption bug:
  old binaries would read a store they cannot understand.
- Never hand-edit a real store; `efmesh migrate` and the CLI are the only writers.
