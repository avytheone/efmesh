# efmesh

> Data transformation in the spirit of [sqlmesh](https://sqlmesh.com) — on TypeScript, [Bun](https://bun.sh) and [Effect](https://effect.website).

[![ci](https://github.com/avytheone/efmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/avytheone/efmesh/actions/workflows/ci.yml) ![status](https://img.shields.io/badge/status-beta-orange) ![version](https://img.shields.io/badge/version-0.1.0--beta.1-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![runtime](https://img.shields.io/badge/runtime-bun-black) ![effect](https://img.shields.io/badge/effect-v4-5C4EE5)

*Русская версия: [README.ru.md](./README.ru.md).*

Models are plain TypeScript modules: SQL bodies, imports as dependencies, Effect Schema as the data shape. efmesh fingerprints every model by its canonical AST, keeps versions as snapshots, computes a plan as the diff between your project and an environment, and applies exactly that plan: physical tables are rebuilt only where something actually changed, while environments (dev/prod/…) are virtual views over shared physical storage — promoting to prod costs zero recomputation.

```ts
import { Schema } from "effect"
import { defineModel, kind } from "efmesh"
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

## Who this is for (and who it isn't)

**For you**, if you are a TypeScript team on Bun, want a typed dbt/sqlmesh-style workflow on top of DuckDB or Postgres, and are fine living on a beta (efmesh is 0.1.x; Effect v4 is beta, pinned exactly as a peer dependency).

**Not for you**, if you need: a Node runtime (Bun-only for now), multi-dialect or cloud DWHs (Snowflake/BigQuery are out of scope), 1.0-grade stability, or the Python ecosystem — take sqlmesh instead, honestly.

## Features

**Models.** `full`, `view`, `embedded` (inlined subquery, no materialization), `incrementalByTimeRange` (interval ledger, batched backfill, lookback), `incrementalByUniqueKey` (upsert), `scdType2` (row history, `valid_from`/`valid_to` managed by efmesh), `defineExternal` (tables, parquet/csv/json files, URLs), `defineSeed` (CSV/JSON reference data, content hash in the fingerprint), `defineSqlModel` (raw `.sql` files with `@ref`/`@start`/`@end`).

**Materialization targets.** Native engine tables, `parquet` (a lake, local or s3://, interval = partition, views over `read_parquet`), `ducklake` (table-per-fingerprint in a [DuckLake](https://ducklake.select) catalog — catalog snapshots and time travel come as a bonus).

**Plans and versions.** Fingerprints over canonical ASTs (reformatting SQL never triggers a rebuild — frozen by golden tests), change categorization breaking / non-breaking / indirect / forward-only, `--forward-only` applies a change without replaying history (the new version inherits physical storage and done-intervals; new columns via `ALTER`), plan confirmation in a TTY, an applied-plans journal with `applied_by`.

**Data quality.** A schema contract before every build (`DESCRIBE` of the query against the declared Schema), `notNull` / `unique` / `accepted` audits (blocking fails the apply, `warn` logs), a standalone `efmesh audit` over an environment's view layer, and `testModel` — unit tests for models on fixtures in in-memory DuckDB.

**Operations.** `run` — an idempotent scheduler tick for cron/systemd; `apply` and `run` of an environment share one cross-process lock (stale locks of crashed processes are reclaimed by ttl); DAG concurrency `--jobs` (a model starts as soon as its parents are ready); batch retries `--retries`; a janitor for orphaned physical storage (removal is a transactional claim — the race against a concurrent apply is closed); Metric counters and spans on operations; a versioned state-store schema + `efmesh migrate` (with a store file backup).

**Engines.** DuckDB (default, including httpfs/ATTACH federation) and Postgres (`Bun.SQL` pool, canonicalization via libpg_query, parallel backfill). State store: SQLite next to the project, or a schema in Postgres.

## Quickstart

Not yet published to a registry — install from git:

```sh
bun add -d efmesh@git+https://github.com/avytheone/efmesh.git
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

Live example: [examples/hospital](./examples/hospital/) — patient movements across hospital departments, every model kind and target.

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

Full architecture, invariants and decisions: [SPEC.md](./SPEC.md) (in Russian).

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
import { testModel } from "efmesh/testing"

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
import { defineConfig } from "efmesh"

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
| `efmesh apply <env>` | plan → confirmation (TTY) → physical tables, backfill, view layer |
| `efmesh run <env>` | scheduler tick: new intervals only, under the lock; for cron |
| `efmesh audit <env>` | audit the environment's view layer — catches after-the-fact degradation |
| `efmesh diff <envA> <envB>` | how two environments differ |
| `efmesh render <model> [--env]` | the final SQL of a model |
| `efmesh lineage <model[.col]>` | column lineage down to the raw sources |
| `efmesh graph [--html]` | the model DAG as text or a page |
| `efmesh janitor [--ttl 7]` | remove orphaned physical storage older than ttl |
| `efmesh migrate` | bring the state-store schema up to the current version |

`apply`/`run` flags: `--jobs N` — DAG concurrency (always 1 on DuckDB — single connection), `--retries N` — retries for transient batch failures (exponential backoff), `--yes`/`-y` — skip confirmation, `--forward-only <model>,…` — reuse physical storage and history.

Exit codes: `0` — success, `1` — error, `2` — "awaiting a human": the plan needs confirmation in a non-TTY (add `--yes`), or `run` hit unapplied changes. In a non-TTY, `apply` with changes and no `--yes` refuses — efmesh will not silently roll out a plan nobody has seen.

## Postgres

```ts
engine: { url: "postgres://…" },  // canonicalization via libpg_query
state:  { url: "postgres://…" },  // schema efmesh_state
```

Backfill runs batches in parallel (connection pool); independent DAG branches build concurrently. DuckDB federation (seeds, parquet, external files, export, ducklake) fails honestly on Postgres with `EngineFeatureError` — no silent degradation.

## Status

**0.1.0-beta.1.** The core is built and exercised on a live example: phases F0–F6 ([SPEC.md §13](./SPEC.md), [CHANGELOG](./CHANGELOG.md)), 138 tests including a live Postgres cluster and golden tests freezing fingerprint stability. Effect v4 is a beta dependency: pinned exactly (peerDependencies); a weekly CI job tracks drift against fresh betas.

Next up: categorization override in the plan dialog, non-time-based intervals. Known limitation: a single `bun build --compile` binary builds, but standalone Bun executables can't resolve the `"efmesh"` import from a runtime-loaded config — distribution is via the package (SPEC §10).

## Documentation

- [SPEC.md](./SPEC.md) — the architecture spec: decisions, invariants, open questions (in Russian);
- [CHANGELOG.md](./CHANGELOG.md) — release history (in Russian);
- [examples/hospital](./examples/hospital/) — a live example with every model kind;
- [CONTRIBUTING.md](./CONTRIBUTING.md) — build, test and PR guide (in Russian; PRs and issues in English are welcome).

## License

[MIT](./LICENSE) © Alexey Yakimanskiy
