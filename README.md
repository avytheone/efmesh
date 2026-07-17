# efmesh

> Data transformation in the spirit of [sqlmesh](https://sqlmesh.com) — on TypeScript, [Bun](https://bun.sh) and [Effect](https://effect.website).

[![ci](https://github.com/avytheone/efmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/avytheone/efmesh/actions/workflows/ci.yml) ![status](https://img.shields.io/badge/status-beta-orange) ![npm](https://img.shields.io/npm/v/%40avytheone%2Fefmesh) ![license](https://img.shields.io/badge/license-MIT-green) ![runtime](https://img.shields.io/badge/runtime-bun-black) ![effect](https://img.shields.io/badge/effect-v4-5C4EE5)

*Русская версия: [README.ru.md](https://github.com/avytheone/efmesh/blob/main/README.ru.md).*

Models are plain TypeScript modules: SQL bodies, imports as dependencies, Effect Schema as the data shape. efmesh fingerprints every model by its canonical AST, keeps versions as snapshots, computes a plan as the diff between your project and an environment, and applies exactly that plan: physical tables are rebuilt only where something actually changed, while environments (dev/prod/…) are virtual views over shared physical storage — promoting to prod costs zero recomputation.

<p align="center"><img src="https://raw.githubusercontent.com/avytheone/efmesh/main/docs/demo.svg" alt="efmesh demo: a ref typo is a compile error; a plan rebuilds exactly the changed branch; promotion is a view swap" width="840"></p>

```ts
import { Schema } from "effect"
import { defineModel, kind } from "@avytheone/efmesh"
import { rawMoves } from "./sources.ts"

export const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.incrementalByTimeRange({
      timeColumn: "moved_at",
      start: "2026-01-01T00:00:00Z",
      lookback: 1, // the tail is re-read — late-arriving data catches up
    }),
    schema: Schema.Struct({ case_id: Schema.String, moved_at: Schema.DateTimeUtc }),
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(rawMoves, "case_id", "moved_at")}
    FROM ${ctx.ref(rawMoves)}
    WHERE moved_at >= ${ctx.start} AND moved_at < ${ctx.end}
  `,
)
```

## Why not dbt / sqlmesh

|                     | dbt                   | sqlmesh                | efmesh |
|---------------------|-----------------------|------------------------|--------|
| Model language      | SQL + Jinja           | SQL + Jinja/Python     | SQL inside TypeScript |
| Dependencies        | `ref('string')`       | SQL parsing            | module imports — checked by the compiler |
| Column typing       | no                    | contracts (runtime)    | Effect Schema: compile-time + a contract before every build |
| Versioning          | none (state-less)     | snapshots + fingerprint | snapshots + fingerprint |
| Dev environments    | table copies          | virtual (views)        | virtual (views) |
| Incrementality      | hand-rolled `is_incremental()` | intervals, tracked | intervals, tracked, resumable |
| Parquet lake        | adapters              | adapters               | native: `target: "parquet"`, interval = partition |
| Multi-dialect       | yes                   | yes (sqlglot)          | **no** — your engine's dialect (DuckDB or Postgres) |

A typo in a `ref` is a compile error, not an empty run; renaming a parent's column breaks the child's build before any SQL reaches the database.

## Why this exists: small data lakes

Most analytics in the world is not a cloud warehouse — it is DuckDB-class data: gigabytes to a terabyte on one machine. Product analytics of a startup, the marts of one department, on-prem and edge deployments, a pipeline living inside a SaaS app. dbt and sqlmesh were born in the cloud-DWH world and carry that weight with them (Python, adapters, infrastructure). efmesh is the sqlmesh approach that is `bun add` and go — and the lake is a folder of parquet files.

Honestly placed: the **core** is the same class of system as sqlmesh — snapshots, AST fingerprints, plans as diffs, virtual environments. The **breadth** is not: no cloud engines, no multi-dialect, no web UI, no ecosystem of packages — and no ambition to catch up on all of it. Compared to dbt-core the trade is reversed: dbt has an industry around it, but no state-based plans, no virtual environments, no fingerprint versioning — every team reinvents "how not to rebuild everything". Our four honest advantages: **types as the DAG contract** (a typo breaks the build, not the nightly run), **library before CLI** (embed `Efmesh.apply(...)` in your app), **one language for the whole stack** (models, app, tests), and a **codebase you can read in an evening** (~5.5k lines).

## Who this is for (and who it isn't)

**For you**, if you are a TypeScript team on Bun, want a typed dbt/sqlmesh-style workflow on top of DuckDB or Postgres, and are fine living on a beta (efmesh is 0.2.x; Effect v4 is beta, pinned exactly as a peer dependency).

**Not for you**, if you need: a Node runtime (Bun-only for now), multi-dialect or cloud DWHs (Snowflake/BigQuery are out of scope), 1.0-grade stability, or the Python ecosystem — take sqlmesh instead, honestly.

## Features

**Models.** `full`, `view`, `embedded` (inlined subquery, no materialization), `incrementalByTimeRange` (interval ledger, batched backfill, lookback), `incrementalByUniqueKey` (upsert), `scdType2` (row history, `valid_from`/`valid_to` managed by efmesh), `defineExternal` (tables, parquet/csv/json files, URLs), `defineSeed` (CSV/JSON reference data, content hash in the fingerprint), `defineSqlModel` (raw `.sql` files with `@ref`/`@start`/`@end`).

**Materialization targets.** Native engine tables, `parquet` (a lake, local or s3://, interval = partition, views over `read_parquet`), `ducklake` (table-per-fingerprint in a [DuckLake](https://ducklake.select) catalog — catalog snapshots and time travel come as a bonus).

**Plans and versions.** Fingerprints over canonical ASTs (reformatting SQL never triggers a rebuild — frozen by golden tests), change categorization breaking / non-breaking / indirect / forward-only with `plan --explain` reasoning and a `--reclassify` operator override, indirect physics reuse (descendants of a non-breaking change are not rebuilt — scdType2 keeps its history), `--forward-only` applies a change without replaying history (the new version inherits physical storage and done-intervals; new columns via `ALTER`), plan confirmation in a TTY, an applied-plans journal with `applied_by`.

**Data quality.** A schema contract before every build (`DESCRIBE` of the query against the declared Schema), `notNull` / `unique` / `accepted` audits (blocking fails the apply, `warn` logs), a standalone `efmesh audit` over an environment's view layer, and `testModel` — unit tests for models on fixtures in in-memory DuckDB.

**Operations.** `run` — an idempotent scheduler tick for cron/systemd; `apply` and `run` of an environment share one cross-process lock (stale locks of crashed processes are reclaimed by ttl); DAG concurrency `--jobs` (a model starts as soon as its parents are ready); batch retries `--retries`; a janitor for orphaned physical storage (removal is a transactional claim — the race against a concurrent apply is closed); Metric counters and spans on operations; a versioned state-store schema + `efmesh migrate` (with a store file backup).

**Engines.** DuckDB (default, including httpfs/ATTACH federation) and Postgres (`Bun.SQL` pool, canonicalization via libpg_query, parallel backfill). State store: SQLite next to the project, or a schema in Postgres.

## Quickstart

```sh
bun add -d @avytheone/efmesh
bunx efmesh init my-warehouse && cd my-warehouse
bunx efmesh plan dev    # what would be done
bunx efmesh apply dev   # physical tables, backfill, view layer
```

`init` scaffolds a working skeleton: `efmesh.config.ts`, example models, a seed. From there, edit models and iterate with `plan`/`apply`; the full lifecycle:

```sh
bunx efmesh apply dev            # apply changes to dev
bunx efmesh audit dev            # audit what the environment serves right now
bunx efmesh apply prod --yes     # promotion: view swap, no recomputation
bunx efmesh run prod             # cron tick: catch up on new intervals
```

Live example: [examples/hospital](https://github.com/avytheone/efmesh/tree/main/examples/hospital) — patient movements across hospital departments, every model kind and target.

## How it works

```
models (TS modules)  ──►  DAG + fingerprints over canonical ASTs
                               │
                     plan = diff against the state store
                               │
      apply: physical tables ── interval backfill ── audits ── view layer
                               │
          state store: snapshots, intervals, environments, journal
```

- **Physical layer** — tables `_efmesh.<model>__<fp8>` (or parquet prefixes / DuckLake): a version is a table; the old one lives until the janitor collects it.
- **Virtual layer** — views `<env>__<schema>.<table>` (prod is just `<schema>.<table>`) pointing at physical storage. An environment is a set of pointers; promotion and rollback are view swaps.
- **The interval ledger** is the single source of truth about what has been computed: an interrupted backfill resumes where it stopped; recomputing an interval is a transactional DELETE+INSERT of the range — no duplicates.

Full architecture, invariants and decisions: [SPEC.md](https://github.com/avytheone/efmesh/blob/main/SPEC.md).

## Data quality

```ts
// an audit is a SQL predicate over violations; blocking fails the apply, warn logs
audits: [
  audit.notNull("case_id"),
  audit.unique("case_id", "moved_at"),
  audit.warn(audit.accepted("dept", ["ICU", "surgery", "therapy"])),
]
```

```ts
// a model unit test: fixtures → CTEs → in-memory DuckDB → comparison (bun test)
import { testModel } from "@avytheone/efmesh/testing"

test("stays", () =>
  testModel(stays, {
    inputs: { [moves.name.full]: [{ case_id: "c1", moved_at: "2026-01-01T10:00:00Z" }] },
    expect: [{ case_id: "c1", duration: null }],
  }))
```

The declared `schema` is a contract, not documentation: before every build efmesh runs `DESCRIBE` on the query and fails with `SchemaMismatchError` if column names or types diverge. NULL guarantees are expressed with the `notNull` audit.

## Configuration

`efmesh.config.ts` is a typed TS module — no YAML:

```ts
import { defineConfig } from "@avytheone/efmesh"

export default defineConfig({
  discovery: "models/**/*.ts",      // every model export by glob; duplicate names = load error
  // models: [a, b, c],             // …or by value (can be combined with discovery)

  // engine: a DuckDB file by default; Postgres is one line
  engine: { path: "efmesh.duckdb" },          // or { url: "postgres://…", max: 8 }
  state: { path: "efmesh.state.sqlite" },     // or { url: "postgres://…" }

  lake: { path: "lake" },                     // for target: "parquet"; local or s3://
  ducklake: { catalog: "ducklake.sqlite", dataPath: "lake/ducklake" },
  attach: { reporting: { url: "reporting.duckdb" } },  // export targets by alias
})
```

## CLI

| Command | What it does |
|---|---|
| `efmesh init [dir]` | scaffold a project: config, example models, a seed |
| `efmesh plan <env>` | diff the project against an environment + missing intervals; changes nothing |
| `efmesh apply <env>` | plan → confirmation (TTY) → physical tables, backfill, view layer; `--json` |
| `efmesh run <env>` | scheduler tick: new intervals only, under the lock; for cron; `--json` |
| `efmesh restate <env> --model m --from t --to t` | replay a past range for a model and its descendants; `--dry-run`, `--json` |
| `efmesh status <env>` | what is going on: last plan, interval lag, recent run ticks; `--json`, `--check` |
| `efmesh audit <env>` | audit the environment's view layer — catches after-the-fact degradation |
| `efmesh diff <envA> <envB>` | how two environments differ; `--data` compares the actual data |
| `efmesh render <model> [--env] [--json]` | the final SQL of a model |
| `efmesh lineage <model[.col]> [--json]` | column lineage down to the raw sources |
| `efmesh graph [--html] [--json]` | the model DAG as text, an HTML page, or JSON |
| `efmesh janitor [--ttl 7] [--json]` | remove orphaned physical storage older than ttl |
| `efmesh migrate [--json]` | bring the state-store schema up to the current version |
| `efmesh schedule <env>` | register `run <env>` in the OS scheduler via `Bun.cron` (`--list [--json]`) |

`apply`/`run` share `--jobs N` — DAG concurrency (always 1 on DuckDB — single connection) — and `--retries N` — retries for transient batch failures (exponential backoff). `apply` also takes `--yes`/`-y` — skip confirmation (required in a non-TTY when the plan has changes) — and `--forward-only <model>,…` — reuse physical storage and history.

`plan`/`apply` take `--reclassify <model>=breaking|non-breaking[,…]` — the
operator's verdict on top of `--explain`, journaled with `applied_by`. A
non-breaking parent lets unchanged descendants reuse their previous physical
tables instead of rebuilding (scdType2 keeps its row history); an override
that plainly contradicts the AST (dropped columns) is refused.

`restate <env> --model <m> --from <t> --to <t>` replays a past time range when
bad source data arrived after the fact: it clears the range's done-intervals
for the `incrementalByTimeRange` model **and its incrementalByTimeRange
descendants** (the cascade is the planner's ordinary missing-interval logic),
so the next `apply` — or a `run` tick — recomputes exactly that range. It
mutates only the interval ledger, under the environment lock, and never touches
the physics directly (the ensuing backfill's DELETE+INSERT does). Bounds are
ISO UTC and must be aligned to the model's grain (a misaligned bound is a typed
error); `scdType2` is refused by name (no time-range semantics over version
history). `--dry-run` prints what would be recomputed and changes nothing;
`--json` for CI.

Every command with something to report speaks `--json` — `plan`, `apply`,
`run`, `audit`, `status`, `diff`, `graph`, `janitor`, `migrate`, `lineage`,
`render` and `schedule --list` — a stable machine-readable shape (a contract
under semver) for CI and bots; exit codes are unchanged, stdout stays pure
JSON (logs go to stderr). `apply --json` returns `{env, applied, plan, built,
promoted}` and `run --json` returns `{env, outcome, processed, blockedBy?}` —
both emit their payload even on exit 2 (a non-TTY `apply` that needs `--yes`,
or a `run` blocked by structural changes), so a bot always reads *why* nothing
ran. `status --json` returns `lastPlan.summary` and each `ticks[].detail` as
structured objects, not JSON encoded inside a string. Each shape is a JSON
object carrying a top-level `apiVersion` (currently `1`) — a single integer a
reader pins on, bumped only when a field breaks; new fields stay additive.

`plan --explain` adds the reasoning to every change: which canonical-AST
nodes diverged (`where_clause`, `select_list[2] (added)`, …) and why the
category followed — including cascade sources for `indirect`. The same
data ships in `--json` as `explain`; the AST paths are a debugging hint,
not part of the contract.

`diff <envA> <envB> --data` compares the actual data of two environments:
row counts, key overlap (grain or the kind's key), per-column mismatch
rates among matched keys, schema drift between sides. `--sample P` (1–99)
compares a deterministic share of keys — md5 buckets aligned across both
sides, so sampling never fabricates only-in rows. `--model a,b` narrows,
`--json` for CI.

`schedule <env> [--cron '@hourly']` registers the `run` tick in the OS
scheduler (crontab / launchd / Task Scheduler) via `Bun.cron` — idempotent
by title, `--remove` unregisters, `--list` shows what's there. Honest
caveats: OS cron runs in the local timezone and does not catch up on missed
runs, and Arch-family Linux ships no cron daemon at all — `--print-systemd`
emits user-unit files instead (`Persistent=true` catches up). Overlapping
ticks are safe by construction: `run` takes the env lock and exits `2` when
changes await a human.

### Exit codes

The single contract for headless callers (CI, cron, agents); changing it is a
SemVer event. Referenced from the CLI's own `--help` and by every command:

| Code | Meaning | When |
|---|---|---|
| `0` | success | the command did its job |
| `1` | error | any failure — bad config, an engine/state error, a blocking audit violation |
| `2` | awaiting a human | not a failure: `apply` has changes but no `--yes` in a non-TTY, or `run` met unapplied structural changes |

Nothing ever blocks waiting for input without announcing it: the only prompt is
`apply`'s confirmation, and it appears solely at an interactive TTY — a non-TTY
`apply` with changes refuses with code `2` instead of hanging. efmesh will not
silently roll out a plan nobody has seen.

### Alerting

`status <env> --check` turns the report into a health probe: it exits non-zero
when the environment is **unhealthy** — a stuck backfill (failed intervals) or
a last tick that ended in `error`. Normal states never trip it: `awaiting-human`
/ `lock-held` ticks, plain lag (a tick simply hasn't caught up yet), and a
never-applied environment all stay exit `0`. It still prints the report, so an
operator paged by it sees the reason.

It composes with a scheduled `run` and systemd `OnFailure=`: point the timer's
failure handler at a check, and let a dead-man's-switch service (e.g.
[healthchecks.io](https://healthchecks.io)) page when the check itself stops
reporting.

```ini
# efmesh-run@.service — the hourly tick
[Service]
ExecStart=/usr/bin/env efmesh run %i
OnFailure=efmesh-alert@%i.service      # fires on a run that exits 1

# efmesh-alert@.service — probe health, then ping the dead-man's switch
[Service]
Type=oneshot
ExecStart=/usr/bin/env efmesh status %i --check
ExecStart=/usr/bin/curl -fsS https://hc-ping.com/<uuid>/${EXIT_STATUS}
```

Exit `2` (a `run` blocked by structural changes) is *not* a failure and does
not fire `OnFailure`; it means a human must `apply` — see [exit codes](#exit-codes).

## Logging

`apply` and `run` narrate what they do. Logs go to **stderr** — stdout stays
reserved for the plan screen, summaries and `--json`, which stays byte-clean.
Levels, set by the built-in `--log-level` flag (minimum level, default `info`):

- **info** — lifecycle a human watches: per-model build start/finish with
  duration, backfill batch progress (`batch 3 of 7` with the interval bounds),
  promotion.
- **warn** — warn-audits (violations that do not block) and retries.
- **debug** — the rendered SQL about to run, lock acquire/release, and other
  internals. `--log-level debug` also prints the full fiber trace on a failure.

Each line carries structured fields as annotations (`model`, `env`, `interval`,
…). At a TTY the output is pretty and colored; piped to a file or the systemd
journal it is one-line [logfmt](https://brandur.org/logfmt) with no ANSI, so a
log reader (or an AI agent post-morteming a 3am tick) can group by field.

Embedding efmesh as a library? Logging is Effect's `Effect.log*` — provide your
own `Logger` layer (sink, format, minimum level) and the CLI's choices do not
apply. Row counts are not logged: efmesh never runs an extra query just to count.

## Performance

The framework overhead is negligible for any realistic project (in-memory DuckDB, `bun bench/plan-bench.ts N`):

| models | cold plan | apply (all physical) | no-op plan | promote to prod |
|---|---|---|---|---|
| 100 | 54 ms | 158 ms | 3 ms | 51 ms |
| 500 | 228 ms | 759 ms | 11 ms | 197 ms |
| 2000 | 0.9 s | 2.9 s | 50 ms | 1.3 s |

## Postgres

```ts
engine: { url: "postgres://…" },  // canonicalization via libpg_query
state:  { url: "postgres://…" },  // schema efmesh_state
```

Backfill runs batches in parallel (connection pool); independent DAG branches build concurrently. DuckDB federation (seeds, parquet, external files, export, ducklake) fails honestly on Postgres with `EngineFeatureError` — no silent degradation.

### Support tiers

Two engines, two levels of coverage — stated plainly so you can judge the risk before you adopt.

| Tier | Engine | State store | What the test suite exercises |
|---|---|---|---|
| **1** | DuckDB | SQLite (or Postgres) | Everything: all model kinds and targets, the parquet/DuckLake lake, seeds and `external` federation, audits, the janitor, `--forward-only` / `--reclassify`, `testModel`, and golden fingerprint freezing. |
| **2** | Postgres | Postgres schema `efmesh_state` | State store (snapshots, promote/orphaning, intervals, ttl lock, `migrate`), libpg_query canonicalization, `describe`, and e2e `full` / `view` / `incrementalByTimeRange` backfill, `incrementalByUniqueKey` upsert and `scdType2` — with parallel batches and DAG concurrency. |

**Not covered by tests on Postgres**, without hiding it:

- **Structurally unavailable** — the DuckDB-federation surface: `target: "parquet"`, `target: "ducklake"`, CSV/JSON seeds, and `external` file/parquet/URL sources. These raise `EngineFeatureError` on Postgres by design; the suite asserts they *fail honestly*, never that they work.
- **Works, but proven only on DuckDB** — audits (`notNull` / `unique` / `accepted`), the janitor, `--forward-only` / `--reclassify`, and `testModel` (which always runs on in-memory DuckDB, whatever your project engine).

## Non-goals

Decided, not deferred — the ready answer to "why not just…":

- **A Node runtime.** efmesh is Bun-first to the core — `Bun.SQL`, `Bun.cron`, `bun test`, single-file config loading. Node would mean a second runtime matrix maintained for an audience we are not chasing; the target is TypeScript teams already on Bun.
- **Multi-dialect SQL (transpilation).** sqlglot's killer feature, and we admit reproducing it in TypeScript is unrealistic. Dialect is a property of the *project*, not the model: you write for your engine (DuckDB or Postgres), and a `ref` typo stays a compile error either way.
- **Cloud data warehouses** (Snowflake / BigQuery / Redshift). The whole thesis is small data lakes — DuckDB-class data, gigabytes to a terabyte on one machine. Cloud DWH is dbt/sqlmesh's home turf and carries the weight (adapters, infra) we deliberately shed.
- **A third engine.** Each engine costs a full adapter *and* a canonicalization backend, and multiplies the test matrix. We would rather keep two engines honest — DuckDB tier 1, Postgres tier 2 — than three shallow.

The architectural non-goals (heavy ingest, general orchestration, BI) live in [SPEC.md](https://github.com/avytheone/efmesh/blob/main/SPEC.md) §1.

## Status

**0.2.2** (beta). The core is built and exercised on a live example: phases F0–F6 ([SPEC.md §13](https://github.com/avytheone/efmesh/blob/main/SPEC.md), [CHANGELOG](https://github.com/avytheone/efmesh/blob/main/CHANGELOG.md)), 187 tests including a live Postgres cluster and golden tests freezing fingerprint stability. Effect v4 is a beta dependency: pinned exactly (peerDependencies); a weekly CI job tracks drift against fresh betas.

Next up: making efmesh legible to an evaluating AI agent — broader `--json` coverage and an agent-oriented `llms.txt` map (milestone 0.3.0). Known limitation: a single `bun build --compile` binary builds, but standalone Bun executables can't resolve the `"efmesh"` import from a runtime-loaded config — distribution is via the package (SPEC §10).

## Documentation

- [SPEC.md](https://github.com/avytheone/efmesh/blob/main/SPEC.md) — the architecture spec: decisions, invariants, open questions;
- [CHANGELOG.md](https://github.com/avytheone/efmesh/blob/main/CHANGELOG.md) — release history;
- [examples/hospital](https://github.com/avytheone/efmesh/tree/main/examples/hospital) — a live example with every model kind;
- [CONTRIBUTING.md](https://github.com/avytheone/efmesh/blob/main/CONTRIBUTING.md) — build, test and PR guide;
- [llms.txt](https://github.com/avytheone/efmesh/blob/main/llms.txt) — a machine-oriented map of the repo for an evaluating AI agent.

### Agent skills

efmesh expects most of its *operation* to run through AI agents, so it ships
[Claude Code skills](https://github.com/avytheone/efmesh/tree/main/skills) that
teach an operating agent the safe procedures — each drives `--json` outputs and
[exit codes](#exit-codes) only, never scraped text:

- `efmesh-triage` — read `status --json` + the tick journal; tell awaiting-human
  (exit 2) from lock-held from a real error, and what to do for each;
- `efmesh-safe-apply` — preview `plan --explain --json`, then apply; when
  `--reclassify` / `--forward-only` are appropriate and when they are forbidden;
- `efmesh-backfill-recovery` — find failed/missing intervals and rerun with `run`;
- `efmesh-environment-hygiene` — `diff` / `diff --data` before promotion, janitor
  cadence, and what to back up;
- `efmesh-upgrade` — bump the package, `efmesh migrate`, verify with `status --json`.

Wire them into your project by pointing your agent at the installed package —
`node_modules/@avytheone/efmesh/skills/` — or copy/symlink the ones you want into
your project's `.claude/skills/`:

```sh
ln -s ../../node_modules/@avytheone/efmesh/skills/efmesh-safe-apply .claude/skills/
```

## License

[MIT](https://github.com/avytheone/efmesh/blob/main/LICENSE) © Alexey Yakimanskiy
