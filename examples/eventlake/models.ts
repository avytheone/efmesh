import { Schema } from "effect"
import { audit, defineExternal, defineModel, external, kind } from "../../src/index.ts"

/**
 * The dedup horizon, in days — THE design decision of this recipe (issue #38).
 *
 * An at-least-once archiver makes duplicates legal in the lake, and the
 * canonical layer is what makes `count(*)` mean something again. Under
 * incremental materialization that de-duplication can only be **windowed**:
 * each recompute renders `[start, end)` and DELETE+INSERTs exactly that range,
 * so a query that looked only at its own interval would never see the original
 * of a redelivery that arrived a day later. Reading `HORIZON_DAYS` back beyond
 * `start` and keeping the FIRST copy makes the suppression work across
 * intervals without ever rewriting a settled one: the original stays put, the
 * late copy is dropped in the interval it arrived in.
 *
 * What that buys, stated exactly: **a duplicate whose original arrived within
 * HORIZON_DAYS is eliminated; a duplicate that arrives later is not.** Widening
 * the horizon costs a wider scan per tick and nothing else; eliminating the
 * remaining class entirely needs a scan-plus-upsert materialization efmesh does
 * not have yet, so cross-horizon redeliveries stay the source's responsibility
 * and are surfaced, not hidden, by `ops.cross_horizon_duplicates` below.
 */
const HORIZON_DAYS = 3

/**
 * Slack on the partition predicate. `arrival_date` prunes files, `arrived_at`
 * decides rows — the two agree only as long as the archiver's partition key
 * comes off the same clock as its arrival timestamp. A day of slack keeps the
 * pruning a safe superset if the archiver ever closes a partition late.
 */
const PRUNE_SLACK_DAYS = 1

/**
 * The raw archive: hive-partitioned parquet, one directory per arrival day.
 *
 * `unionByName` is not optional here — the archiver appends columns over time
 * (`source_node` exists only in the newer partitions), and a positional scan
 * would either fail or silently shear the columns of the older ones.
 * `hivePartitioning` exposes `arrival_date`, which is what makes a tick read
 * four directories instead of the whole lake.
 */
export const rawEvents = defineExternal({
  name: "raw.events",
  source: external.files(
    // resolved against this file, not the process cwd: the same project must
    // work under `bunx efmesh` from here and under the test that imports it
    `${new URL("./archive", import.meta.url).pathname}/**/*.parquet`,
    "parquet",
    { unionByName: true, hivePartitioning: true },
  ),
  /**
   * The archive is a FOREIGN lake — efmesh reads it, the archiver writes it —
   * so `efmesh compact` touches it only because this declaration says so. An
   * at-least-once micro-batch writer leaves a partition full of tiny files, and
   * hundreds of them cost the planner far more than they cost disk.
   *
   * The concurrency model is cooperative, not transactional (README §
   * Compaction): the archiver keeps writing while this runs, and the only
   * things standing between the two are the rules compaction obeys — today's
   * partition is never touched, a partition is left alone until its newest file
   * has been still for the grace period, the merged file appears by rename, and
   * only the files listed before the merge are deleted.
   *
   * `orderBy` matters as much as `uniqueKey`: keeping the FIRST arrival makes
   * compaction agree with the canonical layer below, which resolves duplicates
   * the same way. A dedup that kept an arbitrary copy would quietly disagree
   * with the table built on top of it.
   */
  maintenance: {
    compact: {
      partitionKey: "arrival_date",
      uniqueKey: ["event_id"],
      orderBy: ["arrived_at", "archiver_offset"],
    },
  },
  schema: Schema.Struct({
    event_id: Schema.String,
    event_type: Schema.String,
    occurred_at: Schema.DateTimeUtc,
    arrived_at: Schema.DateTimeUtc,
    archiver_offset: Schema.Number,
    /** Written by the archiver as text — the canonical layer is where it gets a type. */
    metric_value: Schema.String,
    /** Absent from the older partitions; `unionByName` reads it as NULL there. */
    source_node: Schema.NullOr(Schema.String),
    /** Hive partition key, not a stored column. */
    arrival_date: Schema.DateTimeUtc,
  }),
  description: "Raw event archive — at-least-once, so duplicates are legal here",
})

/**
 * The canonical table: one row per event id within the horizon, typed, with
 * the derived columns every reader would otherwise recompute.
 *
 * Incremented by ARRIVAL time, not by occurrence time: arrival is the only
 * clock the archiver controls and the only one that moves forward
 * monotonically, so it is the one an interval ledger can trust.
 *
 * `batchSize: 1` is deliberate. A batch renders one `[start, end)` for the
 * whole batch, so a larger batch would silently de-duplicate across a wider
 * range during backfill than during a steady tick — the guarantee would depend
 * on how the work happened to be chunked. With one interval per statement,
 * HORIZON_DAYS is the whole story.
 */
export const events = defineModel(
  {
    name: "core.events",
    kind: kind.incrementalByTimeRange({
      timeColumn: "arrived_at",
      start: "2026-03-01T00:00:00Z",
      interval: "day",
      batchSize: 1,
      // late files land under an arrival day already computed; the horizon
      // handles duplicates, this handles rows that simply were not there yet
      lookback: 1,
    }),
    schema: Schema.Struct({
      event_id: Schema.String,
      event_type: Schema.String,
      occurred_at: Schema.DateTimeUtc,
      arrived_at: Schema.DateTimeUtc,
      metric_value: Schema.Number,
      source_node: Schema.NullOr(Schema.String),
      transit_seconds: Schema.Number,
      /** Copies this row's own horizon contained — a backward look, so 1 is not proof of uniqueness. */
      copies_in_horizon: Schema.Number,
    }),
    grain: ["event_id"],
    description: "Canonical events: de-duplicated within the horizon, typed, enriched",
    audits: [
      audit.notNull("event_id"),
      /*
       * Uniqueness is a warning here, not a gate, and the reason is the
       * windowed guarantee itself. The same audit is read at two scopes:
       * `apply` runs it over the interval just written (where the window
       * function makes it hold by construction), `efmesh audit` runs it over
       * the whole environment view — where the cross-horizon residual is
       * present BY DESIGN. Blocking would make a documented, accepted property
       * of the data fail the environment on every run.
       */
      audit.warn(audit.unique("event_id")),
    ],
  },
  (ctx) => ctx.sql`
    SELECT
      event_id,
      event_type,
      occurred_at,
      arrived_at,
      metric_value,
      source_node,
      transit_seconds,
      copies_in_horizon
    FROM (
      SELECT
        ${ctx.cols(rawEvents, "event_id", "event_type", "occurred_at", "arrived_at")},
        CAST(metric_value AS DOUBLE) AS metric_value,
        source_node,
        date_diff('second', occurred_at, arrived_at)::INT AS transit_seconds,
        count(*) OVER (PARTITION BY event_id)::INT AS copies_in_horizon,
        -- the dedup key and its tie-breakers, spelled out: first arrival wins,
        -- and archiver_offset breaks a tie between copies of the same instant
        -- so the choice is total and the same on every recompute
        row_number() OVER (
          PARTITION BY event_id
          ORDER BY arrived_at ASC, archiver_offset ASC
        ) AS copy_rank
      FROM ${ctx.ref(rawEvents)}
      WHERE arrival_date >= CAST(${ctx.start} - INTERVAL ${HORIZON_DAYS + PRUNE_SLACK_DAYS} DAY AS DATE)
        AND arrival_date <= CAST(${ctx.end} AS DATE)
        AND arrived_at >= ${ctx.start} - INTERVAL ${HORIZON_DAYS} DAY
        AND arrived_at < ${ctx.end}
    ) horizon
    WHERE copy_rank = 1
      -- the horizon is read, but only this interval is written: the earlier
      -- rows are here to shadow their late copies, not to be emitted twice
      AND arrived_at >= ${ctx.start}
  `,
)

/**
 * The detector for what the windowed guarantee does not cover. Empty in a lake
 * whose redeliveries stay inside the horizon; a row here is a real
 * cross-horizon duplicate, and the warn-level audit puts it in the log of every
 * apply instead of leaving it for a reader to trip over.
 */
export const crossHorizonDuplicates = defineModel(
  {
    name: "ops.cross_horizon_duplicates",
    kind: kind.view(),
    schema: Schema.Struct({
      event_id: Schema.String,
      copies: Schema.Number,
      first_arrived_at: Schema.DateTimeUtc,
      last_arrived_at: Schema.DateTimeUtc,
    }),
    description: "Event ids that survived de-duplication more than once",
    audits: [
      audit.warn(
        audit.custom("no_cross_horizon_duplicates", (a) => a.sql`SELECT * FROM ${a.self}`),
      ),
    ],
  },
  (ctx) => ctx.sql`
    SELECT
      event_id,
      count(*)::INT AS copies,
      min(arrived_at) AS first_arrived_at,
      max(arrived_at) AS last_arrived_at
    FROM ${ctx.ref(events)}
    GROUP BY event_id
    HAVING count(*) > 1
  `,
)

/** What the canonical layer is for: a count that means what it says. */
export const dailyVolume = defineModel(
  {
    name: "analytics.daily_volume",
    kind: kind.view(),
    schema: Schema.Struct({
      arrival_day: Schema.DateTimeUtc,
      events: Schema.Number,
      metric_total: Schema.Number,
    }),
    description: "Events and metric total per arrival day",
  },
  (ctx) => ctx.sql`
    SELECT
      date_trunc('day', arrived_at) AS arrival_day,
      count(*)::INT AS events,
      sum(metric_value) AS metric_total
    FROM ${ctx.ref(events)}
    GROUP BY arrival_day
    ORDER BY arrival_day
  `,
)
