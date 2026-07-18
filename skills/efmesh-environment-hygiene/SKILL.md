---
name: efmesh-environment-hygiene
description: >-
  Keep efmesh environments clean and verify a dev environment before promoting
  it to prod. Use before promoting/deploying dev → prod, when asked to compare
  two environments, to reclaim disk from orphaned physics, or to set up backups.
  Covers diff / diff --data, janitor and compact cadence, and what to back up.
---

# efmesh environment-hygiene

Compare environments and reclaim storage using `--json` only. An environment is
a set of virtual views over shared physical storage; two envs can point at
different versions of the same model.

Every `--json` shape below also carries a top-level `apiVersion` (currently
`1`) — the wire-contract version; pin on it, a bump means field names may have
changed. It is elided from the example bodies for brevity.

## Verify before promotion (dev → prod)

### 1. Version diff (which model versions differ)

```
efmesh diff <dev> <prod> --json
```

Shape:

```json
{ "onlyInA": [], "onlyInB": [], "different": [ { "name": "mart.x", "a": "abc12345", "b": "def67890" } ], "same": ["…"] }
```

- `a`/`b` are 8-char fingerprint prefixes of each side's version.
- All-empty `onlyInA`/`onlyInB`/`different` → the environments are identical at
  the version level; promotion is a pure view-swap.

### 2. Data diff (do the rows actually match)

```
efmesh diff <dev> <prod> --data --json
```

Shape (per model):

```json
{
  "envA": "dev", "envB": "prod",
  "models": [
    { "model": "mart.daily_revenue", "rowsA": 6, "rowsB": 6,
      "key": ["day","region"], "onlyInA": 0, "onlyInB": 0, "matched": 6,
      "columns": [ { "column": "revenue", "mismatches": 2, "rate": 0.33 } ],
      "columnsOnlyInA": ["…"], "columnsOnlyInB": ["…"], "sampledPercent": 10 }
  ]
}
```

- `rowsA`/`rowsB` — full counts (unaffected by sampling).
- With a matchable `key` (grain or the kind's key): `onlyInA`/`onlyInB` are
  unmatched keys, `matched` is the overlap, `columns[]` lists only the columns
  that drifted (`rate` = mismatches / matched). No `key` → row counts only.
- `columnsOnlyInA` / `columnsOnlyInB` — schema drift between the sides.
- Large tables: `--sample P` (1–99) compares a deterministic md5-bucket share,
  aligned across both sides (never fabricates only-in rows); `sampledPercent`
  echoes it. `--model a,b` narrows the set.
- Promotion readiness: expect `onlyIn* === 0` and an empty `columns[]` for the
  models you intend to promote. Unexpected drift means dev and prod diverged —
  investigate before promoting via **efmesh-safe-apply**.

## Janitor — reclaim orphaned physics

Physical storage no environment references (superseded versions) is removed by
the janitor after a ttl.

```
efmesh janitor --ttl 7 --json
```

Shape: `{ "removed": ["fp…"], "kept": ["fp…"] }` — `removed` were deleted;
`kept` are orphaned but younger than the ttl.

- Cadence: run on a schedule (daily/weekly) with a ttl comfortably longer than
  your rollback window — the ttl is the grace period during which a just-orphaned
  version can still be brought back by re-pointing an env.
- The janitor holds its **own** lock (separate from apply/run), so it is safe to
  schedule alongside ticks. Exit `0` on success.

## Compact — merge a partition's small files

A micro-batch writer leaves hundreds of tiny files per partition; the query
planner pays for every one of them long before disk does.

```
efmesh compact --dry-run --json     # what would be merged
efmesh compact --json               # merge it
```

Shape: `{ "dryRun": bool, "compacted": [{model, partition, files, rows,
published}], "skipped": [{model, partition, reason}] }`. `reason` is a closed
set — `current-day`, `grace-period`, `already-compact`, `undated`.

- Scope is the project: efmesh's own parquet partitions, plus `defineExternal`
  sources whose declaration carries `maintenance: { compact: {…} }`. There is no
  flag that points it at a directory; if a lake is not being compacted, the
  declaration is missing, not the flag.
- **Cooperative, NOT transactional — the difference from janitor.** Janitor
  claims a snapshot in the state store; compact has no claim. It relies on
  conventions: it never touches a partition dated today or later, waits a grace
  period past the newest file's mtime (`--grace N` overrides), publishes via
  `.tmp` + atomic rename, and deletes only the files it listed before merging.
  Safe against an appending writer; NOT safe against one that rewrites files in
  place, and it does not serialize two concurrent compactors — schedule one.
- Cadence: daily, off the hour a writer is busiest. Run `--dry-run` first on a
  lake you have not compacted before, and read the `skipped` reasons: "all
  `undated`" means the declared `partitionKey` does not match the layout.
- A `uniqueKey` in the policy means compaction de-duplicates *within* a
  partition, so raw row counts drop. That is the point, but say so before
  running it against a lake someone counts rows in.

## What to back up

State lives in two places (SPEC §6, §3.3) — back up both together so they stay
consistent:

1. **The state store** — the source of truth for versions, environments,
   intervals and journals.
   - Default SQLite: a file next to the project, `efmesh.state.sqlite` (or
     `state.path` in `efmesh.config.ts`). Back up the file (or snapshot it).
   - Postgres (`state: { url: … }`): the `efmesh_state` schema — back up via
     your normal Postgres backups.
2. **The lake / physical storage** — the materialized data the views point at:
   - `target: "parquet"` → the `lake.path` directory (local dir or S3).
   - `target: "ducklake"` → the `ducklake.catalog` (and its `dataPath`).
   - Native DuckDB tables → the `.duckdb` database file.

`efmesh migrate` already takes a file backup of a SQLite store before a schema
change; that is not a substitute for your own backups.

## Guard rails

- Never delete files under the lake / physics directory by hand to "clean up" —
  `janitor` (ttl + env references) and `compact` (settled partitions only) are
  the only two writers that may remove anything there.
- Never hand-edit or hand-restore only one of the two stores; a state store
  restored without its matching physics (or vice versa) points views at data
  that isn't there.
- Read diffs from `--json`; do not eyeball the text output for a go/no-go.
