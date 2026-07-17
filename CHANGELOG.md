# Changelog

Format — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning — [SemVer](https://semver.org/).
Internal development history was tracked in phases F0–F6 (SPEC.md §13);
the first version gathers them in full.

## [Unreleased]

- Column types now participate in the model fingerprint (#17). Previously the
  fingerprint hashed column *names* only, so a schema type change (e.g.
  `Number`→`String`) categorized as `unchanged` — the plan lied about "types
  as the DAG contract". The payload now folds in each column's type *family*
  (reusing the same `familyOfAst` map as the DESCRIBE contract check), so a
  cross-family retype rebuilds the model and its descendants. `FINGERPRINT_VERSION`
  bumps to **2**: an environment whose snapshots were fingerprinted under v1
  halts with `FingerprintVersionError` (model named) on the first changed model
  — re-plan and re-apply to rebuild physics under the v2 fingerprints.
- Library polish (#22): the canonical renderer (`canonicalSql`, behind
  `Efmesh.render`) now fails an unknown model through the Effect error channel
  with `UnknownModelError` instead of a bare `throw`, keeping the library
  surface all-Effects (SPEC §10). The public API whitelist in `src/index.ts` is
  frozen by a golden test — an accidental export or removal now fails CI, the way
  the fingerprint golden freezes canonicalization.

## [0.2.2] — 2026-07-17

Theme: the repo an AI agent can develop and operate — skills, full
machine-readable CLI coverage, mechanical guard rails.

- In-repo agent skills (#26) under `.claude/skills/` make the CLAUDE.md culture
  executable: `release`, `store-migration`, `fingerprint-change`,
  `add-model-kind` and `issue-workflow` — each a checklist of the exact commands
  and invariants for a recurring, mistake-prone procedure; referenced from
  CONTRIBUTING.md.
- Operator skills for AI agents (#27). Five [Claude Code skills](https://github.com/avytheone/efmesh/tree/main/skills)
  ship in the package (`skills/`, added to `files`) that teach an operating agent
  the safe procedures — `efmesh-triage` (classify awaiting-human vs lock-held vs
  a real error from `status --json`), `efmesh-safe-apply` (preview `plan
  --explain --json`, then apply; the guard rails on `--reclassify` /
  `--forward-only`), `efmesh-backfill-recovery`, `efmesh-environment-hygiene`
  (`diff` / `diff --data`, janitor, backups), `efmesh-upgrade` (`efmesh
  migrate`). Each drives `--json` outputs and the exit-code contract only, never
  scraped text. README documents how to wire them into a project (symlink into
  `.claude/skills/` or point the agent at `node_modules`); mirrored in the
  Russian README.
- Full `--json` and exit-code coverage for headless operation (#16). `janitor`,
  `migrate`, `lineage`, `render` and `schedule --list` now take `--json`,
  joining `plan`/`audit`/`status`/`diff` — every reporting command speaks a
  stable machine-readable shape (a SemVer-frozen contract for CI and agents).
  Each shape is a JSON object (never a bare array or string), so a future
  `apiVersion` stays additive; `--json` stdout is byte-clean (logs to stderr).
  The exit-code contract (`0` ok, `1` error, `2` awaiting a human) is now
  documented once as a table in the README and referenced from the CLI's own
  `--help`. No command blocks on input without announcing it: the sole prompt
  is `apply`'s confirmation, shown only at an interactive TTY — a non-TTY
  `apply` with changes refuses with `2` rather than hanging.
- AI-agent onboarding (#15). A root `llms.txt` (the [llmstxt.org](https://llmstxt.org)
  convention) maps the repo for an evaluating AI agent: what efmesh is and is
  NOT, what is a contract (fingerprints, `STATE_VERSION`, `--json` shapes, exit
  codes 0/1/2) versus a hint, where things live, and how to run it. Shipped with
  the package (`files`).
- README links are now absolute `github.com` URLs so they resolve on the npm
  package page (the demo image, SPEC/CHANGELOG/CONTRIBUTING/LICENSE, the hospital
  example, the Russian mirror); the stale Status block is corrected (0.2.1, 182
  tests, current roadmap). Applied to `README.ru.md` in sync.
- `apply`/`run` `--help` now state their exit-2 semantics ("awaiting a human"),
  and `--yes` explains it is required in a non-TTY when the plan has changes.

## [0.2.1] — 2026-07-16

Theme: hygiene for the first stranger — the whole surface is English,
failures explain themselves, execution is visible.

- Detailed execution log (#14). `apply` and `run` now narrate their work
  through Effect's logging system: per-model build start/finish with duration,
  backfill batch progress (`batch n of m` with interval bounds), warn-audits
  and promotion. Levels — **info** for lifecycle (visible by default), **warn**
  for warn-audits/retries, **debug** for the rendered SQL and lock internals;
  the existing `--log-level` flag sets the minimum. Every line carries
  structured fields (`model`, `env`, `interval`) as annotations. Logs go to
  **stderr** (stdout and `--json` stay byte-clean); a TTY gets pretty colored
  output, a pipe/journal gets one-line logfmt with no ANSI. Embedders provide
  their own `Logger` layer to redirect sinks and levels. Exit codes unchanged.
- Human-readable, precise errors everywhere (#13). Every tagged error now
  derives its `message` from its typed fields, so the culprit (model, env,
  file, interval) and the underlying engine/system text are always present —
  an empty `EngineError:` is constructively impossible. `EngineError` carries
  the failing model and the engine's own message; a failing `apply` names the
  model, quotes DuckDB/Postgres verbatim, and shows the SQL context. The CLI
  now renders one failure screen (cause first, an actionable hint where one
  exists) and prints the Effect fiber trace only under `--log-level debug`.
  Exit codes (0/1/2) and `--json` shapes are unchanged. New exported error
  `UnknownModelError` (render/lineage against a name not in the project).
- The entire user-facing surface is English: CLI output and help, error
  messages, `--json` string values (key names and exit codes unchanged),
  the `init` scaffold, the hospital example data (#11). Source comments
  and test names too (#12).
- **Breaking:** the `apply` confirmation prompt accepts only `y`/`yes`
  (case-insensitive); the Cyrillic tokens are no longer recognized.
- `efmesh init` scaffold now teaches the core lifecycle: a seed feeding
  an incremental-by-time-range model with a blocking audit and a full
  rollup on top, runnable immediately after `init` (#11).

## [0.2.0] — 2026-07-16

Theme: "operator and team" — efmesh in the hands of a non-author: the
operator of the nightly cron and a team with CI.

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
- `plan --explain`: for every change — which canonical-AST nodes diverged
  and why the category followed (cascade sources for `indirect`, inherited
  physics for `forward-only`); also shipped in `--json` as `explain`
  (`PlanAction.explain` in the library API). AST paths are a debugging
  hint, not a contract (#4).
- Indirect physics reuse — the sqlmesh "indirect non-breaking" class: a
  descendant whose own AST did not change and whose changed parents are all
  non-breaking/forward-only inherits the previous version's physical table
  and interval accounting instead of a full rebuild (scdType2 keeps its row
  history). Safety is proven, not assumed: the fingerprint recomputed with
  the parents' old fingerprints must reproduce the old version, so
  simultaneous metadata drift disables reuse (#5).
- `--reclassify model=breaking|non-breaking` on `plan`/`apply`: the
  operator's verdict as a flag on top of `--explain` (no interactive
  dialog — works in CI), journaled with `applied_by`
  (`PlanAction.reclassifiedFrom`); governs descendants' physics reuse.
  Guard rail: dropped columns declared non-breaking are refused (#5).
- `diff --data` — compare the DATA of two environments: full row counts,
  key overlap (grain or the kind's key), per-column mismatch rates among
  matched keys, schema drift between sides. `--sample P` compares a
  deterministic share of keys (md5 buckets aligned across both sides — no
  false only-in rows); `--json` for CI (`dataDiffEnvironments` in the
  library API) (#6).
- `efmesh schedule <env>` — register the `run` tick in the OS scheduler via
  `Bun.cron` (crontab/launchd/Task Scheduler; `engines.bun >= 1.3.11`).
  Idempotent by title; `--remove`, `--list`; on cron-less Linux
  (Arch family) it detects the missing daemon and `--print-systemd` emits
  user units with `Persistent=true` instead (#10).

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
