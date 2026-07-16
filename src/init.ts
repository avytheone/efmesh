import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Data, Effect } from "effect"

/**
 * `efmesh init` (SPEC §12): scaffold a minimal, runnable project — config, a
 * seed, an incremental model with a backfill and a blocking audit, and a full
 * rollup on top. `efmesh plan dev && efmesh apply dev` works immediately, with
 * no data-generation step: the seed carries its own timestamped rows.
 *
 * The example is written to *teach* the plan/apply lifecycle to a first
 * reader (often an evaluating agent): a seed whose content is versioned, an
 * incrementalByTimeRange model that backfills day by day, and an audit that
 * gates each interval. Overwrites nothing: an existing file is an honest error.
 */

export class InitError extends Data.TaggedError("InitError")<{
  readonly path: string
  readonly reason: string
}> {}

const MODELS_TS = `import { Schema } from "effect"
import { audit, defineModel, defineSeed, kind } from "@avytheone/efmesh"

// A seed is reference data loaded from a file. Its *content* feeds the
// fingerprint, so editing events.csv mints a new version and forces a rebuild
// of everything downstream — that is the guarantee the fingerprint buys you.
export const events = defineSeed({
  name: "raw.events",
  file: "seeds/events.csv",
  schema: Schema.Struct({
    event_at: Schema.DateTimeUtc,
    region: Schema.String,
    amount: Schema.Number,
  }),
  description: "Raw revenue events, one row per transaction",
})

// An incrementalByTimeRange model owns an interval ledger: apply backfills one
// day at a time from \`start\`, DELETE+INSERT per interval, and records which
// days are done. Re-running only fills the gaps — that is backfill. \`lookback: 1\`
// re-reads the most recent done day so late-arriving events still land.
//
// \`timeColumn\` names the OUTPUT column intervals are sliced by (here \`day\`); the
// body filters its source with ctx.start/ctx.end, the half-open bounds
// [start, end) of the interval being built. The blocking audit runs against
// each freshly loaded interval and, on a violation, fails apply for that day.
export const dailyRevenue = defineModel(
  {
    name: "mart.daily_revenue",
    kind: kind.incrementalByTimeRange({
      timeColumn: "day",
      start: "2026-01-01T00:00:00Z",
      interval: "day",
      lookback: 1,
    }),
    schema: Schema.Struct({
      day: Schema.DateTimeUtc,
      region: Schema.String,
      revenue: Schema.Number,
    }),
    grain: ["day", "region"],
    description: "Revenue per region per day, backfilled interval by interval",
    audits: [audit.notNull("revenue")],
  },
  (ctx) => ctx.sql\`
    SELECT
      date_trunc('day', event_at) AS day,
      region,
      sum(amount)::BIGINT AS revenue
    FROM \${ctx.ref(events)}
    WHERE event_at >= \${ctx.start} AND event_at < \${ctx.end}
    GROUP BY day, region
  \`,
)

// A full model rebuilds in one shot from the whole physical table of its
// parent. It depends on the incremental above via ctx.ref, so it sits
// downstream in the DAG and rebuilds when that parent's fingerprint changes.
export const regionRevenue = defineModel(
  {
    name: "mart.region_revenue",
    kind: kind.full(),
    schema: Schema.Struct({
      region: Schema.String,
      revenue: Schema.Number,
      days: Schema.Number,
    }),
    description: "Lifetime revenue and active days per region",
  },
  (ctx) => ctx.sql\`
    SELECT region, sum(revenue)::BIGINT AS revenue, count(*)::BIGINT AS days
    FROM \${ctx.ref(dailyRevenue)}
    GROUP BY region
    ORDER BY revenue DESC
  \`,
)
`

const CONFIG_TS = `import { defineConfig } from "@avytheone/efmesh"
import { dailyRevenue, events, regionRevenue } from "./models.ts"

// The project config is typed TypeScript, not YAML. The CLI imports it and
// assembles the engine and state layers. Defaults target a local DuckDB file
// (efmesh.duckdb) and a SQLite state store (efmesh.state.sqlite) next to it.
export default defineConfig({
  models: [events, dailyRevenue, regionRevenue],
  // engine: { url: "postgres://…" },   // Postgres instead of the DuckDB file
  // lake: { path: "lake" },            // enables target: "parquet" on a model
})
`

// Timestamps in plain \`YYYY-MM-DD HH:MM:SS\` so DuckDB's read_csv autodetects a
// TIMESTAMP column; two regions across three days give the backfill several
// non-empty intervals to fill.
const SEED_CSV = `event_at,region,amount
2026-01-01 08:30:00,north,100
2026-01-01 14:00:00,north,150
2026-01-01 16:45:00,south,90
2026-01-02 09:10:00,north,120
2026-01-02 11:20:00,south,200
2026-01-02 18:00:00,south,60
2026-01-03 07:50:00,north,80
2026-01-03 13:30:00,south,140
`

export const scaffold = (dir: string): Effect.Effect<ReadonlyArray<string>, InitError> =>
  Effect.gen(function* () {
    const root = NodePath.resolve(dir)
    const files: ReadonlyArray<readonly [string, string]> = [
      ["efmesh.config.ts", CONFIG_TS],
      ["models.ts", MODELS_TS],
      ["seeds/events.csv", SEED_CSV],
    ]
    for (const [relative] of files) {
      if (existsSync(NodePath.join(root, relative))) {
        return yield* new InitError({
          path: NodePath.join(root, relative),
          reason: "file already exists — init overwrites nothing",
        })
      }
    }
    return yield* Effect.try({
      try: () => {
        const created: Array<string> = []
        for (const [relative, content] of files) {
          const path = NodePath.join(root, relative)
          mkdirSync(NodePath.dirname(path), { recursive: true })
          writeFileSync(path, content)
          created.push(relative)
        }
        return created
      },
      catch: (cause) => new InitError({ path: root, reason: String(cause) }),
    })
  })
