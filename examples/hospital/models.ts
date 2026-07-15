import { Schema } from "effect"
import { defineModel, kind } from "../../src/index.ts"

/** Сырьё (в F1 станет external поверх parquet/ATTACH; в F0 — full на VALUES). */
export const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.full(),
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      moved_at: Schema.String,
    }),
    description: "Движения пациентов по отделениям",
  },
  (ctx) => ctx.sql`
    SELECT * FROM (VALUES
      ('c1', 'КПП',      '2026-01-01 10:00'),
      ('c1', 'ОРИТ',     '2026-01-01 12:00'),
      ('c1', 'терапия',  '2026-01-03 09:00'),
      ('c2', 'КПП',      '2026-01-02 08:00'),
      ('c2', 'хирургия', '2026-01-02 11:00')
    ) AS t(case_id, dept, moved_at)
  `,
)

export const stays = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({
      case_id: Schema.String,
      dept: Schema.String,
      moved_at: Schema.String,
      next_moved_at: Schema.String,
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
