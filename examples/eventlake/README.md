# Example: the canonical table over an event lake

An at-least-once archiver writes events into a hive-partitioned parquet lake.
At-least-once means duplicates are **legal** there: the same event id can appear
two, three, five times, and no reader may take `count(*)` over the raw files at
face value. In the incident this example is drawn from, that count was inflated
**3.8×** — 179 095 rows against 46 875 distinct event ids, and redeliveries
looked like data for as long as nobody checked.

The fix is a canonical layer: one row per event id, columns actually typed,
the derived values computed once instead of in every reader's prologue. This is
that layer as an efmesh project.

## DAG

```
raw.events (external: hive-partitioned parquet, union_by_name)
        │
   core.events (incrementalByTimeRange on arrival time; dedup + casts + derived)
        ├── analytics.daily_volume        (view: a count that means what it says)
        └── ops.cross_horizon_duplicates  (view: what the guarantee does NOT cover)
```

## The guarantee, stated exactly

This is the decision the recipe is built around, and a reader has to know it
before trusting the table.

`core.events` is materialized incrementally: each tick renders one `[start,
end)` window and DELETE+INSERTs exactly that range. A window function inside
that query therefore sees only what the query reads — so the model deliberately
reads **three days back beyond `start`** and keeps the *first* copy of every
event id, while emitting only the rows whose arrival falls inside the interval
being written. The earlier rows are there to shadow late copies, not to be
written twice.

> **Duplicates are eliminated when the original arrived within the horizon
> (here: 3 days). A duplicate that arrives after the horizon has passed is not
> eliminated — it enters the canonical table as a second row for that id.
> Cross-horizon redeliveries are the source's responsibility.**

That is the honest half-guarantee, and it is bought cheaply: keeping the *first*
copy means a settled interval never has to be rewritten, so widening the horizon
costs a wider scan per tick and nothing else. Nothing here silently pretends to
be a global uniqueness guarantee.

What it does *not* do is covered on purpose rather than hidden:

- `ops.cross_horizon_duplicates` lists every id that survived more than once. It
  is empty in a lake whose redeliveries stay inside the horizon; a warn-level
  audit puts any row in the log of every `apply` and `audit` run.
- `unique(event_id)` on `core.events` is a **warning**, and that is a
  consequence of the guarantee rather than laziness. The same audit is read at
  two scopes: `apply` runs it over the interval just written — where the window
  function makes it hold by construction — and `efmesh audit` runs it over the
  whole environment view, where the cross-horizon residual is present by design.
  Blocking would fail the environment on every run for a property the recipe
  documents and accepts.

A genuinely global guarantee would need a time-range scan combined with an
upsert by key — a materialization efmesh does not have today. It stays a
follow-up, deliberately not this recipe.

## The shipped fixture

`archive/` is committed and deliberately dirty:

| | |
|---|---|
| rows in the archive | **16** |
| distinct event ids | **9** |
| rows in `core.events` | **10** |

Nine of the ten canonical rows are the nine distinct ids. The tenth is
`ev-004`, whose redelivery arrived four days after the original — past the
three-day horizon, exactly the case the guarantee excludes. It shows up in
`ops.cross_horizon_duplicates`, which is the point: the recipe makes the
residual visible instead of pretending it does not exist.

The archive also has two schema generations — the `2026-03-03` and `2026-03-05`
partitions carry a `source_node` column the earlier ones never had. That is why
`external.files(…, { unionByName: true })` is not optional: a positional scan
would either fail or shear the columns of the older files. `hivePartitioning`
exposes `arrival_date`, which is what lets a tick read a few directories instead
of the whole lake.

`test/eventlake.test.ts` asserts those numbers, and separately reproduces the
incident at scale: 950 archived rows over 250 distinct ids — the same 3.8× —
collapsing to exactly 250 canonical rows.

## Running

```sh
bunx efmesh plan dev           # what would be done
bunx efmesh apply dev --yes    # backfill by arrival day, then the views
bunx efmesh audit dev          # green, with the two cross-horizon warnings
bunx efmesh run dev            # cron tick: catch up on new arrival days
bunx efmesh compact --dry-run  # which archive partitions have small files to merge
bun seed.ts                    # rewrite archive/ from the readable source data
```

## Compaction of the archive

`raw.events` opts into `maintenance.compact`, which is what lets `efmesh
compact` touch a lake efmesh does not own. The shipped fixture has one file per
partition, so a run here reports `already-compact` and changes nothing — the
declaration is there to show the shape a real archive needs, where a micro-batch
writer leaves hundreds of files per day and the planner pays for every one.

Read the concurrency note in the main README before pointing it at a live
archive: compaction is **cooperative**, not transactional. It never touches
today's partition, waits out a grace period on the newest file's mtime,
publishes by atomic rename, and deletes only what it listed before merging —
which is safe against an appending archiver and is *not* the transactional
claim `janitor` takes.

Things worth playing with: widen `HORIZON_DAYS` in `models.ts` and watch
`ops.cross_horizon_duplicates` go empty (a `plan` will call it a breaking change
and rebuild — the dedup window is part of what the data *means*); change the
tie-breakers in the `row_number()` and see the plan classify it the same way;
add a partition to `archive/` with another new column and confirm
`union_by_name` absorbs it.

## Two knobs that are not decoration

- **`batchSize: 1`.** A batch renders one `[start, end)` for the whole batch, so
  a larger batch would de-duplicate across a wider range during backfill than
  during a steady tick — the guarantee would depend on how the work happened to
  be chunked. With one interval per statement, the horizon is the whole story.
- **The `arrival_date` predicate.** It prunes files; `arrived_at` decides rows.
  The two agree only as long as the archiver's partition key comes off the same
  clock as its arrival timestamp, so the predicate carries a day of slack. If
  your archiver can close a partition late, widen the slack — a pruning
  predicate that is not a safe superset drops data silently.

`efmesh.duckdb`, `efmesh.state.sqlite` and `lake/` are created at runtime and
stay out of git. `archive/` is the *input* and is committed.
