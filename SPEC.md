# EFMESH — specification

**efmesh** is a data transformation framework in the spirit of sqlmesh, but on TypeScript, Bun and Effect v4.
It is not a port of sqlmesh, but a transfer of its *ideas* onto different ground: where sqlmesh leans on Python macros
and Jinja, efmesh leans on the TypeScript type system and on Effect as its runtime.

This is an architecture document: decisions, invariants and open questions.
An introduction to the project and the user's guide are in the [README](./README.md),
the change history is in the [CHANGELOG](./CHANGELOG.md).

Status: v0.2 — implementation has passed phases F0–F6 (§13), published as
`@avytheone/efmesh` (npm, dist-tag `beta`); what is implemented is marked
in the text with "*Implemented in Fn*" notes.

---

## 1. Why

dbt and sqlmesh solve a real problem — versioned SQL transformations with dependencies,
incrementality and cheap dev environments. But both live in the Python ecosystem:
Jinja templates, Python macros, no types, integration into a TypeScript backend through a subprocess.

efmesh does the same for a team that already lives in TypeScript and Effect:

- **A model is a TypeScript module.** No Jinja. A macro is an ordinary function.
  A reference to another model is an import: rename the model and the compiler shows you every place.
- **A model's schema is an Effect Schema.** Columns are typed, references to columns
  are checked at compile time, and the agreement between the declared schema and the actual
  query result is checked at plan time.
- **Everything is Effect.** Typed errors, Layer for swapping engines, Stream for backfill,
  Metric/Tracer out of the box. efmesh can be embedded into an existing Effect application
  as a library — the CLI is only a thin wrapper.
- **Bun.** Instant CLI startup, `bun test` for model tests, `bun build --compile`
  for a single binary.
- **DuckDB as the first engine.** Not just "local analytics": httpfs and ATTACH
  turn it into a lightweight federation (parquet on S3, someone else's Postgres, JSON over HTTPS),
  and materialization into parquet files gives you a lake without separate infrastructure (§3.3, §9.3).

### Non-goals

- Heavy ingest (EL): queues, CDC, retries against third-party APIs — not our concern.
  But lightweight reading of the outside world through DuckDB federation (parquet/S3, ATTACH databases,
  JSON over HTTPS) is a legitimate source for `external` models: the raw material does not have to
  already sit "in the database".
- General-purpose orchestration: not a replacement for Airflow/Temporal. There is our own scheduler
  by cron, but it is about model intervals, not arbitrary pipelines.
- BI and visualization. At most — `efmesh graph --html` for debugging the DAG.
- Transpilation between SQL dialects (sqlglot's killer feature). We admit it honestly:
  reproducing sqlglot in TS is unrealistic. Dialect is a property of the project, not the model (§9).

---

## 2. Conceptual core

Five concepts, everything else is derived:

| Concept | What it is |
|---|---|
| **Model** | A named transformation: a SQL query + metadata (kind, cron, schema, audits). Materialized into a table or view. |
| **Snapshot** | A version of a model, identified by a fingerprint — a hash of the canonicalized SQL and metadata. Each snapshot has its own physical table. |
| **Interval** | A half-open time interval `[start, end)` for which the snapshot's data has been computed. Tracking filled intervals is the basis of incrementality and backfill. |
| **Environment** | A named set of views (`dev`, `prod`, `feature_x`) pointing at the physical tables of snapshots. Virtual: creating an environment means creating views, not copying data. |
| **Plan** | The diff between local model definitions and the state of an environment + the list of intervals to recompute. Reviewed → applied. |

The key mechanic (taken from sqlmesh unchanged, because it is right):

```
physical layer:  _efmesh.med__stays__a3f9c1            ← table by fingerprint
                 lake/med/stays/fp=a3f9c1/…/*.parquet  ← or parquet partitions (§3.3)
virtual layer:   dev__med.stays → view → physical a3f9c1
                 med.stays      → view → physical 88b2e0   (prod = native schemas)
```

If you did not change a model — dev and prod look at the **same** physical table.
If you did — a new physical table appears in dev, prod is untouched.
Promotion to prod is a view swap, with no data copying and no recomputation.

---

## 3. Model definition

A model is a TS module exporting the result of `defineModel`:

```ts
import { defineModel, kind, audit } from "efmesh"
import { Schema } from "effect"
import { moves } from "./moves"

export const stays = defineModel({
  name: "med.stays",
  kind: kind.incrementalByTimeRange({ timeColumn: "moved_at" }),
  cron: "@daily",
  grain: ["stay_id"],                       // logical primary key
  schema: Schema.Struct({
    stay_id:  Schema.String,
    dept:     Schema.String,
    moved_at: Schema.DateTimeUtc,
    duration: Schema.Number,
  }),
  audits: [audit.notNull("stay_id"), audit.unique("stay_id")],
  description: "Patient stays in a department, stitched together from movements",
}, (ctx) => ctx.sql`
  SELECT
    ${ctx.cols(moves, "move_id", "dept")},
    moved_at,
    extract(epoch FROM lead(moved_at) OVER w - moved_at) AS duration
  FROM ${ctx.ref(moves)}
  WHERE moved_at >= ${ctx.start} AND moved_at < ${ctx.end}
  WINDOW w AS (PARTITION BY case_id ORDER BY moved_at)
`)
```

What matters here:

- **`ctx.ref(moves)`** — a reference to a model as a value, not a string.
  It renders into the view name of the current environment (or into a CTE in tests).
  From these references efmesh assembles the DAG — no parsing of names out of the query
  text is needed to build dependencies.
- **`ctx.cols(moves, ...)`** — columns are checked by the compiler against `moves.schema`.
  A typo in a column name is a type error, not a production failure.
- **`ctx.start` / `ctx.end`** — the bounds of the interval being processed. They are substituted
  as *bound parameters* at execution time, and into the canonicalized SQL text they go
  as placeholders — so the fingerprint does not depend on concrete dates.
- **The body is a pure function.** The render must be deterministic: `Date.now()`,
  `Math.random()`, reading env inside the body are forbidden (they break fingerprint stability).
  Everything mutable arrives through `ctx`.

### 3.1 Model kinds (kind)

| Kind | Semantics | Phase |
|---|---|---|
| `full` | Full recomputation of the table on every run | F0 |
| `view` | Not materialized, only a view over the query | F0 |
| `incrementalByTimeRange({ timeColumn, batchSize?, lookback? })` | Recomputation by time intervals; `lookback` — how many past intervals to recompute (late-arriving data) | F1 |
| `incrementalByUniqueKey({ key })` | Upsert by key | F2 |
| `seed({ file })` | Data from a CSV/JSON file, validated via `schema` | F2 |
| `external` | An external source (raw material): an engine table, a parquet/CSV/JSON file by path or URL, a table in an ATTACH database. Not materialized, but participates in the DAG and lineage, its schema is declared | F1 |
| `embedded` | Inlined into consumers as a CTE, without materialization | F3 |
| `scdType2({ key, validFrom, validTo })` | Slowly changing dimensions | F3 |

### 3.2 Schema contract check

The declared `schema` is not documentation but a contract. Before building each
snapshot (at apply, when the physical storage of the parents already exists) efmesh runs
`DESCRIBE <query>` (DuckDB returns names and types without executing the query), compares
the actual column types with the declared ones and fails with `SchemaMismatchError` if
they diverge. Names are checked strictly (missing and extra columns), types — by
families (`Schema.Number` covers both INTEGER and DOUBLE; `DateTimeUtc` — all
TIMESTAMP variants). This catches type drift before the backfill, not after.

### 3.3 Materialization target

Where to put the physical layer is a property of the model (by default taken from the config):

- **`target: "table"`** — a native engine table.
- **`target: "parquet"`** — a lake: the snapshot is materialized into parquet files
  (`<lake>/med/stays/fp=a3f9c1/interval=2026-01-01/*.parquet`), a view over
  `read_parquet('…/fp=a3f9c1/**')`. The lake path is a local directory or S3 (httpfs).
- **`target: "ducklake"`** *(F4, §14.5)* — a table-per-fingerprint in a DuckLake catalog
  (`ATTACH 'ducklake:sqlite:<catalog>'` under the alias `_efmesh_ducklake`,
  config `ducklake: { catalog, dataPath? }`). Versioning stays ours
  (fingerprint + interval tracking); DuckLake's snapshots and time travel are a bonus,
  not a second owner of history. DELETE+INSERT, ALTER (forward-only) and
  transactions work in the catalog as is; the janitor cleans it too. DuckDB-only.
  Consumers outside efmesh must ATTACH themselves — the environments' views
  reference the catalog's tables by alias.

efmesh's incrementality maps onto a parquet lake without a single new concept:
**an interval = a partition**. Recomputing an interval means rewriting its partition's files;
interval tracking (§6) remains the source of truth here too, so the non-atomicity
of overwriting an S3 prefix is not scary — an under-written interval is simply not marked
`done` and will be recomputed.

---

## 4. Snapshots and fingerprint

A snapshot's fingerprint = a hash of:

1. **the canonicalized SQL** — the query is rendered with placeholders instead of intervals,
   parsed into an AST, the AST is normalized (keyword case, whitespace, order of
   unordered elements) and deparsed back. Reformatting the query
   does not change the fingerprint;
2. metadata affecting the data: `kind`, `grain`, `timeColumn`, and the
   declared `schema` — both column **names** and column **type families**
   (#17). The family of each column comes from `familyOfAst` (the same map the
   DESCRIBE contract check uses, §3.2): `text` / `numeric` / `boolean` /
   `temporal` / `any`. A type change that crosses a family boundary
   (`Number`→`String`) shifts the fingerprint, so "types as the DAG contract"
   is honest — the plan no longer reports `unchanged` when the physical shape
   moved. **Mechanic (a), chosen over revalidating via DESCRIBE:** hashing the
   declared family is cheap, deterministic and reuses existing machinery; the
   price is coarseness — an annotation swap that stays within one family
   (`Int` vs `Double`, both `numeric`) does not rebuild, and sub-family drift
   is caught by the DESCRIBE contract check at build time, not by the
   fingerprint;
3. the fingerprints of direct dependencies (transitivity: changing a parent
   changes the child's version — if the change is breaking, see §5.2).

`cron`, `description`, `owner`, audits are **not** part of the fingerprint — changing them
is a metadata-only change without recomputation.

Physical table: `_efmesh.<schema>__<name>__<fp8>`, where `fp8` is the first
8 characters of the fingerprint. The service schema is exactly `_efmesh` with an underscore:
DuckDB names the catalog after the database file name, and for `efmesh.duckdb` the reference
`efmesh.x` is ambiguous (catalog or schema) — a Binder Error.

**Fingerprint stability is a contract (F6).** The fingerprint depends on
the engine's canonicalization (DuckDB's json_serialize_sql / libpg_query) and the
composition of the payload: changing them silently re-fingerprints all of the user's models and
forces a full rebuild of the warehouse. Therefore: (1) canonicalization is frozen
by golden tests (`test/fingerprint-golden.test.ts`) — a red test on an
upgrade of `@duckdb/node-api`/`libpg-query` means canon drift, and that is
grounds for a decision, not for updating the hashes; (2) a snapshot carries
`fingerprint_version` (state store schema version 3); (3) a deliberate change
of the algorithm = an increment of `FINGERPRINT_VERSION` + a migration history,
and the two directions of a version mismatch are **not** symmetric (#48):

- **older snapshot** (written by an earlier algorithm) — its canonical form is
  incomparable with the current one, exactly like a snapshot that stored no AST:
  the model categorizes as `breaking`, with an explain reason naming the version
  gap, and it may not inherit physics (no forward-only or indirect reuse — the
  payload behind the old `physicalFp` was composed differently). The plan
  renders, the apply re-fingerprints. This is the migration path, and it is the
  only one: `efmesh migrate` moves the store *schema*, never snapshot payloads,
  so an environment must never depend on it to escape an algorithm bump.
- **newer snapshot** (written by a later efmesh than the one reading) — nothing
  can be inferred from a canonical form this binary does not know:
  `FingerprintVersionError`, cured by upgrading efmesh.

`FINGERPRINT_VERSION` is **2** (bumped from 1 for #17, which folded column type
families into the payload). An environment fingerprinted under v1 therefore
re-plans as a set of breaking changes and rebuilds physics under v2 on the next
apply. There are no persisted v1 stores in the wild (zero users), so the
re-fingerprint costs nobody.

Note that `FINGERPRINT_VERSION` itself is *not* part of the fingerprint payload
(it keys the canon cache only). Bumps so far changed the payload, so v1 and v2
fingerprints cannot collide; a future bump that leaves the payload untouched
(e.g. pure canonicalization drift) would need to enter the payload, or an
unchanged model would read as `unchanged` across versions.

---

## 5. Plan: diff and application

### 5.1 What `efmesh plan <env>` does

1. Loads all project models (importing TS modules via Bun), builds the DAG.
2. Computes each model's fingerprint, compares it with the environment's state.
3. Categorizes the changes (§5.2).
4. Computes the missing intervals: for new snapshots — from the project's `start`
   (or the model's) to the current moment; for existing ones — the holes in tracking.
5. Shows the human: which models changed, how they were categorized,
   how many intervals will be recomputed, a textual SQL diff.
6. `efmesh apply` shows the same plan and applies it: creates physical
   tables, runs the backfill, swaps the views. *Implemented in F4: in a TTY the plan
   is applied only after an explicit "y" (y/yes, case-insensitive; `--yes`/`-y` skips the
   question), exactly the shown plan is applied without recomputation; non-TTY (CI,
   pipes) proceeds without asking.*

### 5.2 Change categories

| Category | How it is determined | What gets recomputed |
|---|---|---|
| **breaking** | By the AST diff: dropped/renamed a column, changed an existing expression, changed WHERE/JOIN | The model + all descendants |
| **non-breaking** | Added a column, added an independent CTE | Only the model itself |
| **forward-only** | An explicit user flag (`--forward-only <model>,…`) or a cascade: the model's own AST did not change, and all changed parents are themselves forward-only | Nothing retroactively: the new version inherits the physical table and done-intervals of the old one (the snapshot's `physical_fp`), new columns are added via `ALTER` (history gets NULL), dropping columns cannot be expressed by reuse — an error. Only `incrementalByTimeRange` — for the other kinds "retroactively" does not exist by construction |
| **metadata-only** | Fields outside the fingerprint changed | Nothing |

**Indirect physics reuse (0.2.0, #5 — the sqlmesh "indirect non-breaking"
class).** A descendant whose own AST did not change (indirect) inherits the
physical table and interval accounting of its previous version when it is
safe by construction: (1) the version was moved ONLY by parents — verified by
recomputing the fingerprint with the parents' old fingerprints, which must
reproduce the old one (so a simultaneous metadata drift of kind/grain/
columns/target disables reuse); (2) every changed direct parent guarantees
identical data in the existing columns: non-breaking (strictly suffix
columns), forward-only, or an ancestor that itself reuses physics. Applies to
materialized kinds (full, incrementalByTimeRange, incrementalByUniqueKey,
scdType2) — scdType2 keeps its accumulated row history instead of losing it
to a rebuild. Reused physics is shared with the old version: refresh-style
kinds mutate it in place before promotion — the same trade-off forward-only
already makes.

Categorization is automatic (comparison of AST expressions by column), with a
manual override as a flag, not a dialog (0.2.0, #5): `--reclassify
model=breaking|non-breaking` on `plan`/`apply` states the operator's verdict
on top of `--explain`, is journaled with `applied_by`
(`PlanAction.reclassifiedFrom`), and thereby governs whether descendants may
reuse physics. It does not exempt the model itself from a rebuild — that is
`--forward-only`'s job. Guard rail: an override that plainly contradicts the
AST (dropped columns declared non-breaking) is refused. It only applies to
breaking/non-breaking verdicts; on unchanged/added/removed/indirect it is
silently inert. When in doubt efmesh is conservative: if it could not
prove non-breaking — then it is breaking. *Clarification in F2/F3: non-breaking
is recognized as a strictly suffix extension of the select_list with the rest of
the tree untouched (the descendants' INSERT is positional); physical reuse is not
automatic non-breaking, but an explicit forward-only.*

The verdict is explainable (`plan --explain`, 0.2.0 #4): every changed model
carries which canonical-AST nodes diverged (paths like `where_clause`,
`select_list[2] (added)`) and why the category followed — cascade sources for
indirect, inherited physics for forward-only. The AST paths follow the
engine's canon and are a debugging hint, not a versioned contract.

### 5.3 Backfill

- Intervals to recompute are grouped into batches (the model's `batchSize`).
- Execution — parallel batches within a model (`concurrency`, default 4):
  intervals do not overlap, each batch is its own transaction
  on its own pool connection. Meaningful on Postgres (F3); DuckDB holds one
  connection — there the backfill is sequential, transactions are serialized
  by the adapter's semaphore.
- **Inter-model DAG concurrency (F4):** building and backfilling models proceed
  not as a sequential topological loop, but by readiness — each
  model in the plan gets a Deferred gate and starts as soon as its
  parents from this same plan are ready; independent branches are built in parallel
  (`modelConcurrency`, default 4; CLI `--jobs`). A failed parent
  does not open the gate — descendants are not built. On DuckDB the concurrency is
  honestly = 1: one connection, other statements would wedge into the
  BEGIN/COMMIT of a transaction.
- Each interval is a transaction: `DELETE` of the range + `INSERT` (or `MERGE` for
  unique-key). A failed interval does not poison its neighbors; retries via `Schedule`
  with exponential backoff, after exhaustion — the interval is marked `failed`,
  the plan ends with an error listing them. *Implemented in F5: opt-in —
  `ApplyOptions.retry {attempts, baseDelayMs}` / CLI `--retries N`;
  only the transactional write of a batch is retried (a repeat is safe),
  audits are not retried — their failure is deterministic.*
- Progress is written to the state store per interval: an interrupted backfill resumes
  from where it stopped, not from scratch.
- **Restate (#21).** When bad source data arrives after the fact, `efmesh
  restate <env> --model <m> --from <t> --to <t>` replays a past range. It does
  not rebuild anything itself: under the environment lock it CLEARS the
  done-intervals of the target `incrementalByTimeRange` model — and, by
  cascade, of its `incrementalByTimeRange` descendants present in the
  environment — in `[from, to)`, so the very next `apply` (or a `run` tick)
  picks them up through the ordinary missing-interval logic above. The cascade
  is the DAG's descendants, not a second mechanism; non-time-range kinds have
  no interval ledger, and `scdType2` is refused by name (no time-range
  semantics over its accumulated version history). Bounds are ISO UTC aligned
  to the model's grain (a misaligned bound is a typed error). `--dry-run`
  reports the model, its descendants and the intervals that would be recomputed,
  taking no lock and changing nothing.

### 5.4 Promotion and janitor

Promoting an environment is a transactional swap of a set of views (`CREATE OR REPLACE VIEW`).
Physical storage (tables and parquet prefixes) that no environment references any more lives another
`ttl` (default 7 days — so you can instantly roll back by swapping the
views) and is then removed by the `efmesh janitor` command. The ttl is counted from
`orphaned_at` — a mark that promotion sets when the last reference is lost
and clears when it returns (a rollback resets the counter). Physical storage shared by
several versions (forward-only) is removed only together with the last
snapshot using it.

---

## 6. State

All state is in the state store (by default — a SQLite file via `bun:sqlite` next
to the project; for team/production work — the `efmesh_state` schema in Postgres,
`state: { url: "postgres://…" }` in the config; the semantics and layout are identical,
timestamps are ISO UTC text in both backends). DuckDB itself
is not fit for the state store role: it is single-writer, and the state must survive
concurrent runs from different processes. Tables:

```
snapshots     (name, fingerprint, definition_json, created_at)
intervals     (snapshot_fp, start_ts, end_ts, status: done|failed, updated_at)
environments  (env, name, snapshot_fp, promoted_at)
plans         (id, env, summary_json, applied_at, applied_by)   -- audit journal
runs          (id, env, started_at, finished_at, outcome, detail) -- run tick journal (0.2.0)
meta          (version)                                          -- schema version (F4)
```

`applied_by` (F5, schema version 2) — who applied the plan: `ApplyOptions.appliedBy`
or the OS user; pre-versioned journal records are read with an empty author.

The store schema is versioned (F4): a fresh store bootstraps itself to the current
`STATE_VERSION`; an existing one with an older schema (including pre-versioned) fails
to open — `StateSchemaError` with a hint. An explicit
`efmesh migrate` catches it up — silently changing someone else's data on open is not allowed.

Invariants:

- Interval tracking is the single source of truth about what has been computed.
  A physical table with no records in `intervals` is considered empty.
- Writing to the state store — only through state store transactions; efmesh never
  mixes data and state in one transaction if the data engine
  and the state store are different databases (there is no two-phase commit, there is idempotency:
  recomputing an interval is always safe).

---

## 7. Scheduled runs

`efmesh run <env>` — a single scheduler tick:

1. For each model that has a new interval due — compute it
   (plus `lookback` past ones). *Clarification in F2: there is no separate `cron` field —
   the role of the schedule is played by the interval's grain (`interval: "day" | "hour"`);
   `run` never applies model changes (that is plan/apply with a human
   at the wheel) and refuses to work when there are structural changes.*
2. Order and concurrency — as in the backfill (§5.3).
3. Audits — after each computed interval (§8).

`run` is idempotent and safe for a cron/systemd timer: a parallel run
is cut off by a lock in the state store — a `locks` table with a ttl (a stale lock
of a crashed process is reclaimed), the same in SQLite and Postgres.
*Clarification in F5 (§14.6 closed): the lock is one per environment (`env:<name>`) and shared
between `run` and `apply` — mutations of an environment from different processes mutually
exclude each other; the `janitor` has its own global lock.*
*Implemented in 0.2.2 (#18): a live holder renews its lease on a heartbeat
(a third of the ttl) while the guarded work runs, so a backfill outliving the raw
ttl is not reclaimed under it. The renewal is fenced to the holder's own lease
(the `expires_at` it last wrote); if the lock was reclaimed anyway the holder
aborts with a `LockLostError` rather than write behind the new owner. A SIGKILLed
holder stops heartbeating, so ttl reclaim of a truly dead process is unchanged.*

*Implemented in 0.2.0 (#1, #2):* every run tick writes its outcome to the
`runs` journal in the state store — `ok` (with the list of built models),
`awaiting-human` (unapplied changes), `lock-held`, `error` (the error tag) —
including unsuccessful ones: a 3 a.m. cron failure is debuggable after the
fact. `efmesh status <env>` reads it back: the last applied plan, interval
lag per incremental model (computed against the environment's pointers —
what consumers actually see), failed intervals, recent ticks. A journal
write failure never masks the tick's real outcome (logged and ignored).
A long-lived daemon is not needed,
but for embedding into an Effect application there is `Runner.daemon` — an `Effect` that spins
ticks by `Schedule.cron` inside your runtime.

---

## 8. Quality: audits and tests

An **audit** is a SQL predicate over the result, run after an interval is loaded.
It returns the violating rows; a non-empty result = `AuditFailure`.

```ts
audits: [
  audit.notNull("stay_id"),
  audit.unique("stay_id"),
  audit.accepted("dept", ["ICU", "therapy", "surgery"]),
  audit.custom("positive duration", (ctx) => ctx.sql`
    SELECT * FROM ${ctx.self} WHERE duration < 0
  `),
]
```

An audit is either `blocking` (default: the interval is marked failed, the view is not
promoted) or `warn` (a metric + a log, the pipeline moves on).

Besides running at apply, there is a standalone `efmesh audit <env>` (F4): it checks
what the environment serves to consumers RIGHT NOW — the whole view layer, not the
freshly loaded interval. It catches after-the-fact degradation (late data,
edits to physical storage bypassing efmesh, external drift); it changes and marks nothing,
the report is complete, a non-zero exit on blocking violations.

A **test** is a unit test of the query on fixtures, living in `bun test`:

```ts
import { testModel } from "efmesh/testing"

testModel(stays, {
  inputs: { [moves.name]: [
    { move_id: "1", case_id: "c1", dept: "ICU", moved_at: "2026-01-01T10:00Z" },
    { move_id: "2", case_id: "c1", dept: "therapy", moved_at: "2026-01-02T10:00Z" },
  ]},
  interval: ["2026-01-01", "2026-01-03"],
  expect: [{ stay_id: "1", dept: "ICU", duration: 86400 }],
})
```

The mechanics: `ctx.ref` in test mode renders into a CTE with `VALUES` from the fixtures
(validated via the source model's Schema!), the query runs on a
throwaway in-memory DuckDB — instantly, without docker or external infrastructure — and the
result is compared with the expected one. Fixtures with data invalid by Schema
do not compile — a test cannot lie about the shape of the input.

---

## 9. Engines and SQL parsing

### 9.1 The engine adapter — an Effect service

```ts
interface Engine {
  readonly dialect: "duckdb" | "postgres"
  readonly query: (sql: string) => Effect<Rows, EngineError>
  readonly execute: (sql: string) => Effect<void, EngineError>
  /** A set of statements in one transaction: on a connection pool, BEGIN/COMMIT
      via separate execute calls would scatter across different connections. */
  readonly transaction: (statements: ReadonlyArray<string>) => Effect<void, EngineError>
  readonly describe: (sql: string) => Effect<ColumnTypes, EngineError>       // for §3.2
  readonly canonicalize: (sql: string) => Effect<string, EngineError | SqlParseError> // for §9.2
}
```

It is wired in through a `Layer`. The first engine is **DuckDB** (on top of `@duckdb/node-api`),
the second is **Postgres** (F3, on top of the built-in `Bun.SQL` with a pool;
`describe` — a temporary view + `pg_attribute` on one connection).
DuckDB specifics (seed, parquet target, external by files/URL, export to
ATTACH) fail honestly on other engines with `EngineFeatureError` before any
action. DuckDB was chosen first not only for speed and zero
infrastructure: httpfs, ATTACH and parquet make it simultaneously an engine,
a federator and a lake (§9.3). The state store is a separate service with the same pattern.

### 9.2 Parsing

For canonicalization (§4), diff categorization (§5.2) and lineage a real parser is needed —
and that is the adapter's responsibility: each engine parses its own dialect itself,
there is no home-grown "parser of all SQL" in efmesh.

- **DuckDB** returns an AST with its own parser: `json_serialize_sql()` /
  `json_deserialize_sql()`. Canonicalization is a round-trip of serialization: hundred-percent
  dialect accuracy, including its extensions (`read_parquet`, `GROUP BY ALL`,
  list types), zero third-party dependencies. Limitation: only
  SELECT statements are serialized — and a model's body is exactly that.
- **Postgres** (F3, implemented) — libpg_query in WASM, the parser of Postgres itself:
  a parse tree with `location`s stripped out is format-invariant; the placeholders
  `$start`/`$end` of the canonical render are deterministically replaced with `$1`/`$2`
  (bare `$name` is not Postgres syntax).

There is **no** transpilation between dialects (a non-goal): a project is written for the dialect
of its engine. This is an honest narrowing relative to sqlmesh (sqlglot) in exchange
for accuracy and simplicity.

### 9.3 Federation: reading and writing outward

DuckDB covers the three scenarios for which it was chosen as the first engine:

- **A lake on parquet.** The `parquet` materialization target (§3.3): the physical layer is
  files locally or on S3, a view over `read_parquet`. A warehouse without a warehouse.
- **Reading other systems.** `external` models over `read_parquet`/`read_csv`/
  `read_json` — including over HTTPS, so "hit a REST API returning JSON"
  fits here too — and over the tables of ATTACH databases (Postgres, MySQL, SQLite).
  On determinism: an external source changes between runs, and that is normal
  (like any raw material) — only the *definition* of the source enters the fingerprint,
  not its content; freshness is governed by intervals and cron.
- **Writing outward.** Exporting a model's result into an ATTACH database — for example, a finished
  mart heads into the application's working Postgres:
  `export: { attach: "app_pg", table: "public.stays" }`. The export runs
  after the audits and only for a promoted snapshot — nothing unverified can head
  outward. Phase F2.

### 9.4 Lineage

From the AST + resolved `ctx.ref`s a column-level lineage is built (F3, implemented):
`efmesh lineage med.stays.duration` → the chain down to the raw columns
of `external`/`seed` models. Accuracy is best-effort: a column's expression is taken
from the canonical AST, `COLUMN_REF`s are matched to the parents' schemas by name
(qualifiers and CTE aliases are not unfolded), `SELECT *` — a pass-through
propagation. Since model dependencies are known from `ref`, not from parsing
names, the model graph is always exact — only the column level is approximate.

---

## 10. The Effect architecture

Layers (bottom to top):

```
EngineAdapter (DuckDB | Postgres)        StateStore (SQLite | PG)
        └──────────────┬──────────────────────┘
                   Snapshotter  (fingerprint, canonicalization)
                   IntervalLedger (interval tracking)
                        │
                     Planner   (diff, categorization, plan)
                     Executor  (backfill: Stream + DAG concurrency)
                     Auditor
                        │
                  Efmesh (facade: plan / apply / run / test)
                        │
              CLI (thin wrapper)   |   your Effect code (library embedding)
```

Principles:

- **Typed errors** at every level: `ParseError | SchemaMismatchError |
  PlanConflictError | AuditFailure | IntervalFailure | EngineError`. No
  `throw`s — all handling goes through Effect's error channel.
- **A single lifecycle owner**: resources (connection pools, the parser's WASM
  instance) — `Scope`/`Layer`, teardown is guaranteed.
- **Observability out of the box**: a span per model/interval, `Metric`s —
  `efmesh_intervals_done_total`, `efmesh_interval_duration`, `efmesh_audit_failures_total`.
- **Library before CLI.** `Efmesh.plan(env)` is an ordinary `Effect` that can be
  run inside any application by supplying it with layers. The public surface is a
  whitelist (`src/index.ts`), frozen by a golden test
  (`test/public-api-golden.test.ts`) so an accidental export or removal fails CI
  the way `FINGERPRINT_VERSION` freezes canonicalization; even the canonical
  renderer `canonicalSql` fails an unknown model through the error channel
  (`UnknownModelError`), never a `throw`. The CLI is built on
  the Effect CLI module and is compiled with `bun build --compile` into a single binary.
  *Clarification in F5: the binary builds and works (`--external` for other
  platforms' `@duckdb/node-bindings-*`), but standalone Bun executables
  do not resolve the bare import `"efmesh"` from a runtime-loaded
  `efmesh.config.ts` even with a live node_modules — a Bun limitation,
  not ours. Beta distribution is by package (`bun add -d efmesh`), the binary
  waits for upstream.*

The target version is **Effect v4**: one `effect` package, services via
`ServiceMap`/`Layer`, `Schema` out of the box. While v4 is in motion, efmesh's API
surface is laid on the stable subset (Effect/Layer/Schema/Stream/
Schedule/Metric/Scope), with point adaptations — at the finalization of v4.

---

## 11. CLI

```
efmesh init [dir]               — scaffold a project (config, example models, seed)
efmesh plan <env> [--forward-only <model>,…] [--reclassify m=cat,…] [--explain] [--json]
efmesh apply <env> [--yes] [--jobs N] [--retries N] [--forward-only …] [--reclassify …] [--json]  — plan + confirmation + application
efmesh run  <env> [--jobs N] [--retries N] [--json]  — a scheduler tick
efmesh restate <env> --model <m> --from <t> --to <t> [--dry-run] [--json] — replay a past range (§5.3)
efmesh audit <env> [--model a,b] [--json] — audits of the environment's view layer, changing nothing
efmesh render <model> [--env] [--json]   — show the final SQL (for debugging)
efmesh diff <envA> <envB> [--data [--model a,b] [--sample P] [--json]] — how the environments differ
efmesh status <env> [--json] [--check]  — last plan, interval lag, recent run ticks (--check: exit non-zero when unhealthy)
efmesh lineage <model[.column]> [--json]
efmesh graph [--html] [--json]  — the model DAG
efmesh janitor [--ttl 7] [--json]  — cleanup of orphaned physical tables
efmesh migrate [--json]         — catch the state store schema up to the current version
efmesh schedule <env> [--cron '@hourly'] [--remove] [--list [--json]] [--print-systemd]
```

**Headless contract (0.3.0, #16, #28).** efmesh is operated non-interactively
by agents, so every command with something to report exposes `--json` —
`plan`, `apply`, `run`, `audit`, `status`, `diff`, `graph`, `janitor`,
`migrate`, `lineage`, `render` and `schedule --list`. Each shape is a stable
JSON **object** (never a bare array or string) carrying a top-level
`apiVersion` (#20, currently **1**) — a single integer, stamped in one place
(`withApiVersion` inside `printJson`, through which every `--json` command
prints, so none can forget it) and bumped only on a breaking shape change;
additive fields never bump it. Intervals are ISO UTC, and `--json` stdout
stays byte-clean (logs go to stderr). `apply --json` reports `{env, applied, plan,
built, promoted}` (the plan rides the plan shape; `applied:false` with exit 2
when a non-TTY refuses), `run --json` reports `{env, outcome, processed,
blockedBy?}`, `graph --json` reports `{models:[{name, kind, deps}]}` in
topological order, and `status --json` carries `lastPlan.summary` and
`ticks[].detail` as structured objects — never JSON encoded inside a string
(#28, #19). One deliberate cleanup at that break: the store's internal row
`id` and the redundant per-row `env` are dropped from `status`'s nested plan
and tick records (`env` is the top-level key; the id is a store detail, never
contract). The shapes and the exit codes are one frozen contract (a SemVer
event to change): `0` = ok, `1` = error, `2` = awaiting a human — the plan
needs confirmation in a non-TTY (add `--yes`), or `run` met unapplied changes.
No command ever blocks on input silently: the only prompt is `apply`'s
confirmation, shown solely at an interactive TTY; a non-TTY `apply` with
changes refuses with `2` rather than hanging. The full exit-code table lives
once in the README (§ Exit codes) and the CLI's own `--help`.

The frozen field contract for the commands added in this cluster (#28), each
also carrying `apiVersion`: `plan → {env, hasChanges, actions[]}`; `apply →
{env, applied, plan, built[], promoted}` (plan in the plan shape); `run →
{env, outcome: "ok"|"awaiting-human", processed[], blockedBy?}`; `graph →
{models:[{name, kind, deps[]}]}`; `status → {env, storeVersion, models,
promotedAt, lastPlan:{appliedAt, appliedBy, summary}|null, lag[], ticks[]}`
with each `ticks[].detail` the structured `TickDetail` (§7). The **one-time
breaking review** at this `apiVersion: 1` freeze: `status` dropped the store's
internal row `id` and the redundant per-row `env` from its nested plan/tick
records; the tick `detail` and plan `summary` stopped being JSON-inside-a-string.
`audit --json` and `diff --json` still echo their report objects directly
(no transformer) — reviewed and left as-is; tightening them behind a transformer
(as janitor/migrate already are) is a follow-up, not a silent break here.

**Tick detail + `status --check` (0.3.0, #19).** The tick journal's `detail`
is one structured shape, stored JSON-encoded in the existing text column (no
`STATE_VERSION` bump), discriminated by `outcome`: `ok → {built}`,
`awaiting-human → {blockedBy}`, `lock-held → {lock}`, `error →
{error,model?,interval?,message?}` (the error case names the model/interval it
died on when the tagged error carries them). `status <env> --check` turns the
report into a health probe for a monitoring timer: it exits **non-zero** when
the env is unhealthy — a stuck backfill (`lag[].failed > 0`) or a last tick
that ended in `error`. Deliberately NOT unhealthy: `awaiting-human` / `lock-held`
ticks and plain missing lag (normal states), and a never-applied env; a store
behind the schema version never gets that far — `status` fails to open it (exit
1), which is already the non-zero a check wants. It composes with systemd
`OnFailure=` and healthchecks.io; it prints the usual report alongside so an
operator sees the reason. No new `--json` surface — just the flag.

`schedule` (0.2.0, #10) registers the `run` tick in the OS scheduler via
`Bun.cron` (>= 1.3.11; `engines.bun` pins it): crontab on Linux, launchd on
macOS, Task Scheduler on Windows. A generated worker in `.efmesh/` shells out
to this package's own CLI with absolute paths (no npm-name guessing), so the
tick keeps the `run` semantics: env lock, exit 2 = awaiting a human, the tick
journal. Idempotent by title `efmesh-<project>-<env>`. Caveats: OS cron uses
the local timezone and never catches up on missed runs; Arch-family Linux
ships no cron daemon — the command detects a missing `crontab` and points to
`--print-systemd`, which emits user units with `Persistent=true` instead.

The config is `efmesh.config.ts` (not YAML): typed, it assembles the `Layer` of the engine
and the state store, defines environments, the project's `start`, the ttl, concurrency.

`diff --data` (0.2.0, #6 — the sqlmesh table_diff class) compares the DATA of
two environments' view layers: full row counts, key overlap (grain, or the
kind's key for uniqueKey/scdType2) via a FULL OUTER JOIN with presence
markers, and per-column mismatch counts among matched keys. Models without a
key get honest row counts only; columns existing on one side only are
reported as schema drift. `--sample P` (1–99) compares a deterministic share
of keys — both sides are filtered by the same md5 buckets of the key, so the
sample stays aligned and produces no false only-in rows (row counts remain
full). Works on DuckDB and Postgres; ducklake marts are visible via the same
ATTACH `apply` uses.

---

## 12. The user's project structure

```
my-warehouse/
  efmesh.config.ts
  models/
    sources.ts          — external models (raw material) with their Schema
    med/
      moves.ts
      stays.ts
  seeds/
    departments.csv
  tests/
    stays.test.ts       — bun test
```

Model discovery — by glob from the config + a check that each `defineModel`
export is reachable; duplicate names are a load error. *Implemented (F5):
`discovery: glob | glob[]` in the config (masks relative to the config), all
model exports of the found files enter the project; re-exporting the same
object is not a duplicate, two different definitions with one name —
`DiscoveryConflictError` with both files; compatible with an explicit `models`.*

---

## 13. Phases

- **F0 — the skeleton (vertical slice).** `defineModel`, `full`/`view`, render and
  `ctx.ref`, the DuckDB adapter (native tables), the state store on `bun:sqlite`,
  `plan`/`apply` without categorization (everything breaking), the physical+virtual layer,
  `render`, `graph`.
  Stop condition: two related models pass plan→apply→change→plan→apply,
  prod is not recomputed on promotion.
- **F1 — incrementality and the lake.** `incrementalByTimeRange`, interval tracking,
  backfill with Stream and DAG concurrency, fingerprint over the canonicalized AST
  (`json_serialize_sql`), `external` (tables, files/URLs, ATTACH reading),
  the schema contract (§3.2), the `parquet` materialization target — locally and on S3 (httpfs),
  interruption/resumption of backfill.
- **F2 — quality and operations.** Audits, `testModel` (in-memory DuckDB),
  `run` by cron + a lock + `Runner.daemon`, breaking/non-breaking categorization
  by AST, `janitor` (tables and parquet prefixes), `diff`,
  metrics/spans, `seed`, `incrementalByUniqueKey`, export to ATTACH databases (§9.3).
- **F3 — breadth.** The Postgres adapter (libpg_query, state store in PG,
  a pool → parallel backfill batches), column lineage, `forward-only`
  (+ orphaned_at for the janitor), `scdType2`, `embedded`, `graph --html`,
  raw `.sql` models (`defineSqlModel`, §14.1 closed). *Built.*
- **F4 — operational maturity.** Inter-model DAG concurrency for
  apply (Deferred gates, `--jobs`, §5.3), `target: "ducklake"` (§14.5
  closed), a standalone `efmesh audit` (§8), `efmesh init`, a state store schema
  version + `efmesh migrate` (§6), interactive plan confirmation
  (§5.1). *Built.*
- **F5 — the beta gate.** A cross-process lock on `apply` — a shared env lock with `run`
  (§14.6 closed), model discovery by glob (§12), backfill batch retries
  with `Schedule.exponential` (§5.3), `applied_by` in the plan journal (store
  schema version 2), a decision on nullability (§14.2 closed: the contract is names
  and types, NULL is the audit's job), version 0.1.0-beta; the single binary
  hit a Bun limitation (§10) — distribution by package. *Built.*
- **F6 — the beta gate, part 2 (before the quiet publish).** Pinning effect
  (peerDependency + drift CI), fingerprint as a contract
  (`FINGERPRINT_VERSION`, golden tests, store schema 3), transactionally
  closing the janitor↔apply race (claim + a liveness check in promotion),
  atomic parquet partitions, a store backup before migrate, non-TTY apply
  requiring `--yes` (exit code 2 = "awaiting a human"), a whitelist of the public
  API, an English README. *Built. Published: npm
  `@avytheone/efmesh` (dist-tag beta) + github.com/avytheone/efmesh,
  releases by tag via Trusted Publishing (OIDC, provenance).*
- **0.2.0 — "operator and team".** Theme: efmesh in the hands of a non-author —
  the operator of the nightly cron and a team with CI. (1) `efmesh status <env>`:
  the last apply/tick, interval lag, store version; (2) a journal of
  `run` ticks in the store (outcome, duration — schema v4); (3) `--json`
  on plan/audit/status for CI and bots; (4) `plan --explain` — which AST
  node changed and why that category; (5) a categorization override by
  flag on top of explain (not interactive — testable and works in CI);
  (6) `diff --data` — a comparison of the data of two environments (cheap on
  DuckDB); (7) an integration test of lock reclaim under kill -9;
  (8) a canonicalization cache by the model text hash (a repeat plan on 2000
  models — 0.6 s, almost entirely canonicalize). The project one is in GitHub
  Issues (milestone "0.2.0 — operator & team"); SPEC remains an
  architecture document. Deferred: non-time-based intervals (§14.3) —
  by the first real consumer.

---

## 14. Open questions

1. **Raw `.sql` files.** *Closed (F3):* `defineSqlModel({ file, refs })` —
   the body in a `.sql` file with `@ref(name)`/`@start`/`@end`, dependencies declared
   by values in `refs` (each `@ref` must be declared, extra ones are an error),
   so the DAG, fingerprint and testModel work as for ordinary models.
   Column typing is still lost — the honest price of migration.
2. **Nullability in the contract.** *Closed (F5) by a decision:* `DESCRIBE <query>`
   in DuckDB gives names and types, but not nullability — the contract checks
   names and types (families), the promise "not NULL" is expressed by the
   `audit.notNull` audit (blocking by default). `Schema.NullOr` in a model is
   documentation of the data's shape, not a runtime guarantee.
3. **Non-time-based intervals.** sqlmesh can do `INCREMENTAL_BY_PARTITION`.
   Whether to generalize tracking from time intervals to arbitrary partitions —
   to be decided by the first real consumer.
4. **Multi-engine in one project.** ATTACH covers the typical case without a second
   adapter (read from PG, export to PG, computing everything in DuckDB); a full-fledged
   multi-engine is out of scope, but the per-model `EngineAdapter` layer does not contradict it.
5. **DuckLake.** *Closed (F4):* the third materialization target
   `target: "ducklake"` (§3.3) is implemented — a table-per-fingerprint in an ATTACH catalog,
   versioning stays ours, DuckLake's snapshots/time travel are a bonus.
   Exactly per the conclusions of the 2026-07-15 probe: DuckLake is not a replacement for our
   versioning (a second owner of history), but an additional place for
   physical storage; DELETE+INSERT, ALTER and transactions work in the catalog as is.
   A SQLite catalog adds no infrastructure; multiprocess use
   would honestly require a Postgres catalog — deferred until a real consumer.
6. **DuckDB write concurrency.** *Closed (F5):* the lock in the state
   store covers apply too — `run` and `apply` of an environment go under one
   lock `env:<name>` (a stale one is reclaimed by ttl), the `janitor` has its own
   global lock; in the CLI the lock spans plan→confirmation→application.
   The janitor↔apply race (resurrecting an orphaned snapshot at the moment of removal)
   is mitigated by the ttl of the orphaned physical storage.

---

## 15. Comparison (cheat sheet)

| | dbt | sqlmesh | efmesh |
|---|---|---|---|
| Model language | SQL + Jinja | SQL + Jinja/Python | SQL inside TypeScript |
| Dependencies | `ref('string')` | SQL parsing | module import, checked by the compiler |
| Column typing | none | contracts (runtime) | Effect Schema (compile-time + plan) |
| Versioning | none (state-less) | snapshots + fingerprint | snapshots + fingerprint |
| Dev environments | table copies | virtual (views) | virtual (views) |
| Incrementality | hand-rolled `is_incremental()` | intervals, auto-tracked | intervals, auto-tracked |
| Multi-dialect | yes | yes (sqlglot) | no — the engine's dialect (DuckDB first) |
| Parquet lake | adapters | adapters | native: `target: "parquet"`, interval = partition |
| Embedding | subprocess | Python API | Effect library |
