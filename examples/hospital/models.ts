import { Schema } from "effect"
import { audit, defineExternal, defineModel, defineSeed, external, kind } from "../../src/index.ts"

/** Departments reference from CSV: editing the file = a new version and a rebuild. */
export const departments = defineSeed({
  name: "ref.departments",
  file: "departments.csv",
  schema: Schema.Struct({ code: Schema.String, title: Schema.String }),
  description: "Отделения больницы",
})

/** Raw data: a parquet dump from the HIS (see seed.ts). Not materialized — read directly. */
export const rawMoves = defineExternal({
  name: "raw.moves",
  source: external.files("lake/raw/moves.parquet", "parquet"),
  schema: Schema.Struct({
    case_id: Schema.String,
    dept: Schema.String,
    moved_at: Schema.DateTimeUtc,
  }),
  description: "Движения пациентов по отделениям — выгрузка КИС",
})

/** Incremental feed of moves: recomputed by day, topped up on every apply. */
export const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.incrementalByTimeRange({
      timeColumn: "moved_at",
      start: "2026-01-01T00:00:00Z",
      lookback: 1,
    }),
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      moved_at: Schema.DateTimeUtc,
    }),
    grain: ["case_id", "moved_at"],
    description: "Лента движений, очищенная и порезанная по дням",
    audits: [
      audit.notNull("case_id"),
      audit.unique("case_id", "moved_at"),
      audit.warn(audit.accepted("dept", ["КПП", "ОРИТ", "терапия", "хирургия"])),
    ],
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(rawMoves, "case_id", "dept", "moved_at")}
    FROM ${ctx.ref(rawMoves)}
    WHERE moved_at >= ${ctx.start} AND moved_at < ${ctx.end}
  `,
)

export const stays = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      moved_at: Schema.DateTimeUtc,
      next_moved_at: Schema.NullOr(Schema.DateTimeUtc),
    }),
    grain: ["case_id", "moved_at"],
    description: "Пребывания: движение + момент следующего движения",
  },
  (ctx) => ctx.sql`
    SELECT
      ${ctx.cols(moves, "case_id", "dept", "moved_at")},
      lead(moved_at) OVER (PARTITION BY case_id ORDER BY moved_at) AS next_moved_at
    FROM ${ctx.ref(moves)}
  `,
)

export const deptLoad = defineModel(
  {
    name: "med.dept_load",
    kind: kind.view(),
    schema: Schema.Struct({ dept: Schema.String, visits: Schema.Number }),
    description: "Нагрузка на отделения — сколько заходов",
  },
  (ctx) => ctx.sql`
    SELECT dept, count(*)::INT AS visits
    FROM ${ctx.ref(stays)}
    GROUP BY dept
    ORDER BY visits DESC
  `,
)

/** Mart in the DuckLake catalog: a table-per-fingerprint, catalog snapshots — a bonus. */
export const deptDaily = defineModel(
  {
    name: "mart.dept_daily",
    kind: kind.full(),
    target: "ducklake",
    schema: Schema.Struct({
      dept: Schema.String,
      day: Schema.DateTimeUtc,
      arrivals: Schema.Number,
    }),
    description: "Заходы в отделения по дням — в DuckLake",
  },
  (ctx) => ctx.sql`
    SELECT dept, date_trunc('day', moved_at) AS day, count(*)::INT AS arrivals
    FROM ${ctx.ref(stays)}
    GROUP BY dept, day
  `,
)

/** Mart into the lake: physical storage is parquet files, a view over read_parquet. */
export const staysMart = defineModel(
  {
    name: "mart.stays",
    kind: kind.full(),
    target: "parquet",
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      moved_at: Schema.DateTimeUtc,
    }),
    description: "Витрина пребываний для внешних потребителей озера",
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(stays, "case_id", "dept", "moved_at")} FROM ${ctx.ref(stays)}
  `,
)
