import { Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "../../src/index.ts"

/** Сырьё: parquet-выгрузка из КИС (см. seed.ts). Не материализуется — читается напрямую. */
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

/** Инкрементальная лента движений: пересчёт по дням, дозагрузка при каждом apply. */
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

/** Витрина в озеро: физика — parquet-файлы, view поверх read_parquet. */
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
