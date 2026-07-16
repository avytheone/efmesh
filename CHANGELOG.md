# Changelog

Format — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning — [SemVer](https://semver.org/).
Internal development history was tracked in phases F0–F6 (SPEC.md §13);
the first version gathers them in full.

## [Unreleased]

- `efmesh status <env>` — what is going on in one command: the last applied
  plan, interval lag per incremental model, failed intervals, recent run
  ticks (#1).
- Run tick journal in the state store (`runs`, schema v4 — `efmesh migrate`
  with a store backup): every tick records its outcome, including
  unsuccessful ones (#2).
- `--json` on `plan`, `audit` and `status`: a stable machine-readable shape
  for CI and bots; exit codes unchanged (#3).
- Canonicalization cache in the state store (schema v5): a no-op plan on
  2000 models drops from ~0.6 s to ~50 ms; the cache key includes the
  dialect and `FINGERPRINT_VERSION`, so canon drift can never be masked (#8).
- Integration test: stale lock reclaim under a real `kill -9` (#7).

## [0.1.0-beta.2] — 2026-07-16

- Release pipeline: publishing to npmjs.org from GitHub Actions on a `v*`
  tag via Trusted Publishing (OIDC, no tokens) with provenance.
  The package contents did not change — the release verifies the pipeline itself.

## [0.1.0-beta.1] — 2026-07-16

First public beta. Everything below is new.

### Models and plans (F0–F1)

- `defineModel`/`defineExternal`: models are TypeScript modules, references
  are imports, data shape is Effect Schema; the DAG is built from values.
- Fingerprint over the canonical AST (`json_serialize_sql` in DuckDB):
  reformatting SQL does not trigger a rebuild.
- Version snapshots, virtual environments (views over physical storage),
  a plan as a diff, promotion without recomputation.
- `kind.incrementalByTimeRange`: interval ledger in the state store, backfill
  in DELETE+INSERT batches within a transaction, resume from where it stopped, `lookback`.
- A schema contract before a build (`DESCRIBE` against the declared Schema).
- `target: "parquet"`: a lake locally or on S3 (httpfs), interval = partition.

### Quality and operations (F2)

- `notNull`/`unique`/`accepted` audits, blocking/warn.
- `testModel` (`efmesh/testing`): unit tests for models on fixtures
  in in-memory DuckDB.
- Change categorization breaking / non-breaking / indirect by AST.
- `efmesh run`: an idempotent scheduler tick with a cross-process lock;
  `Runner.daemon` for embedding.
- `efmesh janitor`, `efmesh diff`, `defineSeed`,
  `kind.incrementalByUniqueKey` (upsert), export of marts to ATTACH databases,
  metrics and spans.

### Breadth (F3)

- Postgres: an engine on `Bun.SQL` (pool, parallel backfill batches),
  canonicalize via libpg_query, state store in the `efmesh_state` schema.
- `--forward-only`: a change without replaying history — the new version
  inherits physical storage and done-intervals, new columns via `ALTER`.
- `kind.scdType2` (row history), `kind.embedded` (subquery without
  materialization), `defineSqlModel` (raw `.sql` with `@ref`/`@start`/`@end`).
- Column-level `efmesh lineage`, `efmesh graph --html`.

### Operational maturity (F4)

- Cross-model DAG concurrency for apply (`--jobs`): a model starts
  as soon as its parents are ready; on DuckDB it is honestly 1 (a single connection).
- `target: "ducklake"`: physical storage in a DuckLake catalog, catalog
  snapshots and time travel come as a bonus.
- Standalone `efmesh audit <env>` over an environment's view layer.
- `efmesh init` (scaffold), state-store schema version + `efmesh migrate`.
- Plan confirmation in a TTY (`--yes` skips it, a non-TTY proceeds without asking).

### Beta gate (F5)

- Cross-process lock on `apply` — a shared env lock with `run`: parallel
  mutations of an environment from different processes are mutually exclusive
  (`LockHeldError`); the janitor has its own global lock.
- Model discovery by glob: `discovery: "models/**/*.ts"` in the config.
- Backfill batch retries: `--retries N`, `Schedule.exponential`;
  audits are not retried.
- `applied_by` in the plans journal (store schema version 2).
- MIT license.

### Beta gate, part 2 (F6)

- effect is a peerDependency with an exact beta pin; a weekly CI job against
  a fresh beta (an early signal of v4 drift).
- Fingerprint as a contract: `FINGERPRINT_VERSION` in snapshots (store
  schema 3), golden tests freeze DuckDB and libpg_query canonicalization;
  a snapshot of a foreign version is a loud `FingerprintVersionError`.
- The janitor↔apply race is closed transactionally: claiming an orphan is
  atomic with the checks, resurrection clears the orphan status, promotion
  checks snapshot liveness — a view never switches to removed physical storage.
- Parquet partitions are written atomically (temp + rename); `migrate` takes
  a copy of the SQLite store before upgrading the schema.
- **Breaking:** `apply` in a non-TTY with changes requires `--yes`;
  exit code `2` = "awaiting a human" (confirmation refused,
  `RunBlockedByChangesError`).
- The public API is narrowed to a deliberate whitelist (`index.ts`).
- README in English (the Russian mirror is README.ru.md), a
  "who this is for (and who it isn't)" section.

### Known limitations

- Effect v4 is a beta dependency; the efmesh API sticks to a stable
  subset.
- A single `bun build --compile` binary builds, but standalone Bun
  cannot resolve the `"efmesh"` import from a runtime config — distribution is via the package.
- Nullability is not part of the schema contract (DuckDB `DESCRIBE` does not report it) —
  it is expressed with the `notNull` audit.
