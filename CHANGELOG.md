# Changelog

Format — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning — [SemVer](https://semver.org/) shaped by the `0.x` policy in
[SPEC.md](SPEC.md) §11.1: a minor may break, a patch may not, additive is minor.
Internal development history was tracked in phases F0–F6 (SPEC.md §13);
the first version gathers them in full.

## [Unreleased]

## [0.5.0] — 2026-07-18

### Added

- **The answer honesty passport travels the DAG** (#43). `answerable` and
  `caveats` were already declared on a model and passed through to its manifest;
  they now describe an *answer* rather than a table. A model's effective limits
  are the worst over itself and all of its ancestors, and the passport names the
  ancestor that imposed them: a mart whose source is complete only through
  Tuesday is complete only through Tuesday, whatever its own interval ledger
  says, because it computed Wednesday over data that was not there yet. The
  declared values are reported beside the effective ones — "claims `full`, its
  source makes it `sampled`" is a diagnosis, and collapsing them throws it away.
  Freshness stays derived from the ledger and is never declared.
- `efmesh passport <env> [--json]` — the limits of trust an environment's data
  carries, for *every* model it serves. Until now the passport reached only
  parquet models, through their `manifest.json`; a table-target model had no way
  to state what may be believed about it.
- `manifest.json` gains an `effective` block (the DAG-narrowed passport plus the
  model that limits it). Additive, so `MANIFEST_VERSION` stays 1 and a client
  reading a manifest written by 0.4.0 keeps working; `passportOf` in the
  `efmesh/browser` helper now reports the effective values when they are present
  and falls back to the declared half when they are not.

- **An audit now declares its scope** (#53). The same declaration used to be
  evaluated at two scopes with nothing in the API to say which the author meant:
  `apply` checks the interval it just wrote, `efmesh audit` checks the whole
  environment view. Row-wise predicates agree at both; aggregates need not —
  uniqueness can hold inside every written interval and legitimately fail across
  the table, so a correct model could pass every apply and exit 1 under the
  standalone command. `audit.perInterval(a)` and `audit.whole(a)` say which
  invariant was meant. An unscoped audit runs everywhere, exactly as before, so
  nothing changes for a project that says nothing.
- `efmesh audit` reports interval-scoped audits it skipped, in the human output
  and in `--json` (additive `skipped`). Silence about what was not checked reads
  as coverage, which is the failure mode the scope was introduced to end.
- **Continuity audits** (#42): `audit.assertContiguous(col)` — a sequence column
  covers its range with no holes — and `audit.assertNoGaps(timeColumn, step)` —
  a time column has no missing buckets. Both compute the FACT of coverage from
  the data rather than trusting a flag some other process set, and both refuse
  with the boundaries of the hole (`covered through 41200, resumes at 44007 (and
  2 further gap(s))`) instead of a violation count an operator would have to
  investigate by hand. They look for holes inside the observed range and assume
  neither end of it: a late start or a missing tail is a freshness question, and
  the passport's `completeThrough` already answers it. An extension of the
  existing audit machinery — an audit may now carry a `describe` that turns its
  own violating rows into a sentence, which surfaces in `AuditFailure.detail`,
  in the `efmesh audit` report and in its `--json`.
- A whole-scoped audit on a time-range model is checked in its own pass **before
  promotion**, so an environment never serves data that failed a cross-interval
  invariant — an interval pass cannot catch one by construction.

- **`plan` warns when `batchSize` widens a model's rendered window** (#54). A
  backfill batch renders one `[start, end)` for the whole batch, not one per
  interval, so a model whose correctness depends on that width — any window
  function over it, which is what a de-duplication recipe is — means something
  different while catching up than on the steady tick. A time-range model that
  leaves `batchSize` above 1 with a window function in its body now raises a
  `window-over-batch` warning at plan time, before anything is written; the
  plan's new `warnings` array is additive in `plan --json`. Detection is
  structural over the canonical AST, not a grep for `OVER` — a column named
  `over`, the word in a string literal and the word in a comment are all
  correctly ignored. It is a warning and never a refusal: a wide frame is
  legitimate whenever the result does not depend on it, and refusing would make
  a correct model unbuildable to protect an incorrect one.

### Fixed

- `Answerable` was declared twice — once in the model API, once in the manifest
  module. The two happened to be identical, so nothing ever broke; a contract
  type with two definitions is one careless edit away from breaking silently.

## [0.4.0] — 2026-07-18

### Fixed

- `plan` on a redacted environment now diffs against that environment's own
  physics, as `apply` already did. The flag was read from the config and then
  not passed on, so `plan safe` compared the unredacted graph against redacted
  snapshots and reported changes that `apply` would not make. Caught by the lint
  rule for an unused binding, which is a fair reminder that a value computed and
  dropped is usually a missing wire rather than dead code.
- A parquet model's view no longer serves phantom `fp` and `interval` columns
  (#55). The lake's directory layout (`fp=<fp8>/interval=<key>/`) is efmesh's
  bookkeeping, but `read_parquet` was rendered with hive detection left on, so
  DuckDB read those path segments as data and handed every consumer two columns
  no schema declared. The declared schema stopped being the whole truth about
  what a model serves — the exact promise the DESCRIBE contract exists to keep —
  and a model legitimately declaring a column named `interval` or `fp` collided
  with the injected one. `union_by_name` stays on, so partitions with additively
  different schemas still reconcile. Note this *removes* columns a consumer may
  have been reading by accident; a model that wants the partition key as data
  should compute it in its own SELECT, where it is declared and typed like
  everything else. Found while building `efmesh compact`, which had to disable
  the same detection for the same reason.

### Added

- **`efmesh compact`** (#40) — merges the many small files a micro-batch writer
  leaves in a partition into one, de-duplicating by the declared key. A
  partition of hundreds of tiny files is what destroys the query planner. Scope
  is the project and nothing else: efmesh's own parquet partitions, plus
  `defineExternal` sources that opt in with `maintenance: { compact: {…} }` — it
  cannot be pointed at an arbitrary directory. **The concurrency model is
  cooperative, not transactional**, unlike `janitor`: it never touches today's
  partition, waits a grace period past the newest file's mtime, publishes via
  `.tmp` and an atomic rename, and deletes only the files it listed before
  merging. Those rules are safe against a well-behaved appending writer; they do
  not serialize two compactors and do not survive a writer that rewrites files
  in place (README § Compaction, SPEC §5.5). `--dry-run`, `--model`, `--grace`,
  `--json`.
- **`manifest.json` beside every parquet materialization** (#41). Browsers
  cannot glob over HTTP, so a client otherwise walks a web server's directory
  listings — fragile, slow, and able to catch a partition mid-rewrite. The
  manifest names one version's file set, schema (as contract type families),
  intervals, and the answer passport: declared `answerable`/`caveats`, plus
  `freshness` **derived from the interval ledger** — `contiguousThrough` stops
  at the first gap even when later intervals exist, so a client cannot present a
  partial total as complete. Published temp-file-then-rename. `MANIFEST_VERSION`
  is bumped when a field changes meaning; additive fields do not bump it.
- **`@avytheone/efmesh/browser`** (#41) — `fetchManifest`, `registerModel`,
  `passportOf`: one fetch and a duckdb-wasm relation. A subpath rather than a
  separate package on purpose — the helper and the format are one contract, and
  two packages would let a client pin versions that disagree about the document
  they exchange. It imports nothing else from efmesh and refuses a
  `manifestVersion` newer than it understands.
- **Redacted environments** (#41). Once clients read the files directly, a
  masking view protects nothing — a view is not a security boundary. A model
  declares `redact: ["col"]`, an environment switches it on
  (`environments: { safe: { redacted: true } }`), and that environment
  materializes **its own physics** in which those columns were never written:
  redaction projects the body to the surviving declared columns, which changes
  the AST, the fingerprint and therefore the physical table. Models declaring no
  policy are untouched and keep sharing physics. This is *safe defaults, not
  access control over the storage* — the threat model is stated verbatim in the
  README and SPEC §3.4.

- **Event-lake canonical table recipe** (`examples/eventlake`, #38): a shipped
  example for the first model anyone with an at-least-once archive has to
  write — de-duplication by an explicitly declared key and tie-breakers, typed
  casts and derived columns over hive-partitioned parquet. The guarantee is
  **windowed** and stated exactly rather than implied: a duplicate whose
  original arrived within the model's horizon is eliminated, a later
  redelivery is not, and that residual is surfaced by an ops view with a
  warn-level audit instead of hidden. A global guarantee would need a
  scan-plus-upsert kind and stays a follow-up (SPEC §14.7). The incident that
  motivated it is the test fixture: 950 archived rows against 250 unique ids —
  a 3.8× inflation, the same shape as the 179 095 / 46 875 that was paid for
  in production.
- `external.files(path, format, { unionByName, hivePartitioning })` — the two
  reader options a partitioned lake cannot do without: partitions with
  additively different schemas read as one relation, and `key=value` path
  segments become prunable columns. Both render only when set, so every
  external source defined before them keeps its fingerprint. `ExternalFileOptions`
  joins the public API whitelist.
- `--metrics <path>` on `apply` and `run` writes a Prometheus/OpenMetrics text
  file — the dialect node_exporter's textfile collector parses (#39). A
  deployment that treats a silent process as a defect can now scrape efmesh with
  no wrapper around it. Series: intervals done/failed, snapshots built, audits
  passed/failed, per-model build duration, command duration, planned models by
  change category, and the timestamp of the last finished command by outcome —
  per-model series labelled with `model` and `env`. The timestamp is the one to
  alert on, because a tick that never fired writes nothing and goes stale
  without ever reporting an error. Written through a temp file and renamed, so a
  scraper cannot read it half-written; written on every finished command,
  including a tick that found no work and an `apply` that exited 2, so "ran and
  did nothing" and "did not run" do not look alike; an unwritable path warns
  rather than failing the command. Row counts are deliberately absent — efmesh
  never runs an extra query to count rows. The instrumentation layer is Effect's
  own `Metric` registry (SPEC §10.1), so a library embedder reads the same facts
  with `Metric.snapshot`, and lifecycle events (#29) would attach at the same
  points rather than growing a second bus.

## [0.3.2] — 2026-07-18

### Fixed

- A config whose *contents* refuse no longer hides behind `ConfigLoadError`
  (#52). Importing the config executes your model definitions, so a `define*`
  refusal used to be wrapped as a load failure and rendered with advice to check
  the `--config` path and the default export — both dead ends when the path and
  the export are fine. Definition-time errors now propagate as themselves, with
  their own message and no misleading hint; `ConfigLoadError` keeps the failures
  it was meant for (unresolvable path, missing or malformed default export).
- Model definitions are validated at definition time (#51). Bun executes
  TypeScript without checking it and the CLI loads your config by `import()`, so
  a project with no `tsc` in the loop — an agent-authored config, a plain
  `bunx efmesh` — could reach the engine with a required field simply missing.
  `external.files("…")` without a format used to render as `FROM undefined('…')`
  and fail as a DuckDB catalog error naming neither the config nor the field; it
  now refuses immediately with `ModelDefinitionError` naming the model, the
  argument and the accepted formats. Same for a missing or malformed `source`,
  an empty table name, a seed without a `file` or with a non-seed format, and a
  missing `schema` or `kind` on any model. Found by the #37 integration spike,
  writing a config the way an adopter would.

### Removed

- `README.ru.md`, the Russian README mirror, is gone — and with it the last
  translated artifact. It taxed every README edit with a second edit that had
  to match, for a readership of one bilingual author and AI agents that read
  English regardless; the drift risk was permanent and the benefit theoretical.
  The repository is now English without exception. The file remains in git
  history, and it no longer ships in the npm package.

### Documentation

- A written versioning policy for `0.x` (#50): what a minor may break, what a
  patch may not, and why additive counts as minor rather than patch. `0.x` is
  the steady state here — `1.0` would mean nothing is left to do — so SemVer,
  which promises nothing below `1.0`, needed a rule of our own. It also records
  that the guarantees worth pinning on are the separately versioned contracts
  (`apiVersion`, `STATE_VERSION`, `FINGERPRINT_VERSION`, frozen exit codes),
  not the package number. Full rule in SPEC §11.1, summary in both READMEs.
  Written because its absence already cost us: the BREAKING y/yes-only prompt
  shipped in 0.2.1, a patch, for want of anything saying how to decide.

## [0.3.1] — 2026-07-18

### Fixed

- A `FINGERPRINT_VERSION` bump no longer wedges an environment (#48). A snapshot
  written by an *older* algorithm now categorizes as `breaking` — the same
  treatment as a snapshot with no stored AST — instead of halting the plan, so
  the documented cure (re-plan, re-apply, physics rebuilt under the new
  fingerprints) is actually reachable. Previously `plan` raised
  `FingerprintVersionError` on the first changed model and the hint sent the
  operator to `efmesh migrate`, which cannot help: it moves the store schema,
  not snapshot payloads. The only way out was deleting the state store by hand.
  Such a model may not inherit physics (forward-only and indirect reuse are
  refused for it) — the payload behind the old `physicalFp` was composed
  differently. `FingerprintVersionError` remains for the opposite direction, a
  store written by a *newer* efmesh, where the hint is now "upgrade efmesh".
  Caught by the dogfood timer, which had been red for a day after #17.

## [0.3.0] — 2026-07-17

Theme: the first stranger is an AI agent. The whole surface an agent
reads, develops and operates through — machine-readable `--json` with a
pinnable `apiVersion`, honest contracts, in-repo and packaged skills,
mechanical tooling — is now good end to end.

- `apiVersion` on every `--json` payload (#20). Each shape now carries a
  top-level `apiVersion` integer (currently `1`) — a single field a CI job or
  agent pins on to know the field names it can trust. It is stamped in one
  place (a `withApiVersion` wrapper inside `printJson`, through which every
  `--json` command already prints), so no command can ship an unversioned
  payload; a bump is a breaking SemVer event, additive fields never bump it.
  Shipped alongside a one-time breaking-review pass over the whole `--json`
  surface at this freeze (see the BREAKING `status` note below); `audit`/`diff`
  still echo their reports directly and were reviewed and left as-is.
- `--json` on `apply`, `run` and `graph` (#28) — the last commands an agent
  drives that had no machine-readable output. `apply --json` returns `{env,
  applied, plan, built, promoted}` with the plan nested in the frozen plan
  shape; `run --json` returns `{env, outcome, processed, blockedBy?}`; both
  emit their payload even on exit 2 (a non-TTY `apply` needing `--yes`, a `run`
  blocked by structural changes), so a bot reads *why* nothing ran without
  scraping stderr. `graph --json` returns the DAG as `{models:[{name, kind,
  deps}]}` in topological order. Exit codes are unchanged.
- Structured tick `detail` + `status --check` (#19). Every run tick's journal
  `detail` is now one structured shape (stored JSON-encoded in the existing
  text column — no `STATE_VERSION` bump), keyed by `outcome`: `ok → {built}`,
  `awaiting-human → {blockedBy}`, `lock-held → {lock}`, `error →
  {error, model?, interval?, message?}` — an error tick now names the model and
  carries the human message, not just the error tag. `efmesh status <env>
  --check` turns the report into a health probe: it exits non-zero when the env
  is unhealthy (a stuck backfill, or a last tick that errored), staying `0` for
  the normal awaiting-human / lock-held / lagging states — so it drops straight
  into a systemd `OnFailure=` or a healthchecks.io ping.
- **BREAKING** `status --json` shape (#28). `lastPlan.summary` and each
  `ticks[].detail` were JSON **encoded inside a string** — a caller had to
  `JSON.parse` a second time; they are now structured objects directly. In the
  same one-time break the store's internal row `id` and the redundant per-row
  `env` are dropped from the nested plan and tick records (`env` is already the
  top-level key; the id was never contract). Consumers that double-parsed
  `summary`/`detail`, or read `ticks[].id` / `lastPlan.id`, must update.
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
### Fixed

- Lock heartbeat under a long apply/run (#18). `apply` and `run` now renew the
  environment lock on a background heartbeat (a third of the ttl) while the
  guarded work runs, so a backfill that outlives the raw ttl is no longer
  mistaken for a crashed process and reclaimed under it — closing the one path
  to two writers on a single environment. The renewal is fenced to the holder's
  own lease: if the lock was reclaimed anyway (a stall longer than the ttl), the
  holder aborts loudly with a `LockLostError` instead of writing behind the new
  owner, and its release is a no-op that leaves the reclaimer's lock intact. A
  crashed (SIGKILL) holder still stops heartbeating, so ttl reclaim is unchanged.
- Showcase honesty in the README (#23): a support-tiers table (DuckDB tier 1,
  Postgres tier 2) that names, without hiding it, what the Postgres test suite
  does *not* cover — the DuckDB-federation surface that fails by design, and the
  paths proven only on DuckDB. Recorded **non-goals** with their reasons (Node
  runtime, multi-dialect, cloud DWH, a third engine) so the first evaluator has
  an answer. A "what to back up" note in the hospital example (state store + lake,
  backed up together — there is no backup command). Both READMEs kept in sync.
- Store-backup hygiene: leaked SQLite store backups under `examples/hospital`
  are removed from git and `*.sqlite.backup-v*` is now ignored. The hospital
  example runs via `bunx efmesh`, as a real project would.
### Added

- `efmesh restate <env> --model <m> --from <t> --to <t>` (#21) — replay a past
  time range after bad source data arrives. It clears the range's done-intervals
  for the `incrementalByTimeRange` model and its incrementalByTimeRange
  descendants (the cascade is the planner's ordinary missing-interval logic), so
  the next `apply` or `run` tick recomputes exactly that range; the physics is
  never touched directly. Runs under the environment lock; bounds are ISO UTC
  aligned to the model's grain (a misaligned bound is a typed error) and
  `scdType2` is refused by name. `--dry-run` previews the model, its descendants
  and the affected intervals without changing anything; `--json` emits a stable
  object shape for CI.

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
