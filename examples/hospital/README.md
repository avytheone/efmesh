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
bun seed.ts                                # raw data: lake/raw/moves.parquet
bun ../../src/bin.ts plan dev              # what would be done
bun ../../src/bin.ts apply dev             # physical tables + backfill + views
bun ../../src/bin.ts audit dev             # audit the view layer
bun ../../src/bin.ts apply prod --yes      # promotion: view swap, no recompute
bun ../../src/bin.ts run dev               # cron tick: catch up on intervals
```

Things worth playing with: change an expression in `med.stays` and look at
`plan` (breaking + cascade), append a column to the end of a SELECT
(non-breaking), edit `departments.csv` (a new seed version by content),
collect old physical storage with the `janitor`.

`efmesh.duckdb`, `efmesh.state.sqlite`, `ducklake.sqlite` and `lake/` are
created at runtime and stay out of git.
