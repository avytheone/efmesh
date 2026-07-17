# Example: patient movements across hospital departments

A small but complete project: every model kind and materialization target
on one storyline — a raw HIS export of patient movements becomes
department-load marts.

## DAG

```
raw.moves (external, parquet export)       ref.departments (seed, CSV)
        │
   med.moves (incrementalByTimeRange; notNull/unique/accepted audits)
        │
   med.stays (full: the stay + the moment of the next movement)
        ├── med.dept_load   (view: visits per department)
        ├── mart.stays      (target: "parquet" — a mart in the lake)
        └── mart.dept_daily (target: "ducklake" — a mart in a DuckLake catalog)
```

Models are found by glob discovery (`discovery: "models.ts"` in the
config) — [efmesh.config.ts](./efmesh.config.ts) does not list them.

## Running

```sh
bun seed.ts                    # raw data: lake/raw/moves.parquet
bunx efmesh plan dev           # what would be done
bunx efmesh apply dev          # physical tables + backfill + views
bunx efmesh audit dev          # audit the view layer
bunx efmesh apply prod --yes   # promotion: view swap, no recompute
bunx efmesh run dev            # cron tick: catch up on intervals
```

With efmesh installed as a dependency (`bun add @avytheone/efmesh`), `bunx
efmesh` resolves to the package binary — the same command a real project runs.

Things worth playing with: change an expression in `med.stays` and look at
`plan` (breaking + cascade), append a column to the end of a SELECT
(non-breaking), edit `departments.csv` (a new seed version by content),
collect old physical storage with the `janitor`.

`efmesh.duckdb`, `efmesh.state.sqlite`, `ducklake.sqlite` and `lake/` are
created at runtime and stay out of git.

**What to back up.** There is no backup command — that is your job. Two things
hold all the state: the **state store** (`efmesh.state.sqlite`, or your
`efmesh_state` Postgres schema) and the **lake/physics** (`lake/`, the
`efmesh.duckdb` file, the `ducklake.sqlite` catalog). Back them up *together* so
snapshots and their data stay consistent. `efmesh migrate` takes its own file
backup of a SQLite store before a schema change, but that is not a substitute
for your own backups.
