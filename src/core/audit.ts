import { Data, type Schema } from "effect"
import type { SelfValue, SqlFragment, SqlLiteral } from "./sql.ts"
import { quoteIdent, sql } from "./sql.ts"

/** Blocking-аудит нашёл нарушения: снапшот/интервал не считается годным. */
export class AuditFailure extends Data.TaggedError("AuditFailure")<{
  readonly model: string
  readonly audit: string
  readonly violations: number
}> {}

/**
 * Аудит (SPEC §8) — SQL-предикат над результатом модели: запрос возвращает
 * НАРУШАЮЩИЕ строки, непустой результат = провал. `ctx.self` рендерится
 * в физику снапшота (у incremental — в подзапрос обработанного интервала,
 * аудит проверяет то, что только что загрузили, а не всю историю).
 *
 * blocking-аудит (по умолчанию) роняет apply: интервал помечается failed,
 * view не промоутится. warn — лог + конвейер едет дальше.
 */
export interface Audit {
  readonly name: string
  readonly blocking: boolean
  /** Запрос нарушений; содержит узел Self. */
  readonly fragment: SqlFragment
}

export interface AuditCtx {
  readonly sql: typeof sql
  readonly self: SelfValue
}

const SELF: SelfValue = { _tag: "SelfValue" }

/** Билдеры типизированы колонками модели через параметр Fields. */
export const audit = {
  notNull: <Fields extends Schema.Struct.Fields>(
    column: Extract<keyof Fields, string>,
  ): Audit => ({
    name: `not_null(${column})`,
    blocking: true,
    fragment: sql`SELECT * FROM ${SELF} WHERE ${idents(column)} IS NULL`,
  }),

  unique: <Fields extends Schema.Struct.Fields>(
    ...columns: ReadonlyArray<Extract<keyof Fields, string>>
  ): Audit => ({
    name: `unique(${columns.join(", ")})`,
    blocking: true,
    fragment: sql`
      SELECT ${idents(...columns)}, count(*) AS duplicates
      FROM ${SELF}
      GROUP BY ${idents(...columns)}
      HAVING count(*) > 1`,
  }),

  accepted: <Fields extends Schema.Struct.Fields>(
    column: Extract<keyof Fields, string>,
    values: ReadonlyArray<SqlLiteral>,
  ): Audit => ({
    name: `accepted(${column})`,
    blocking: true,
    fragment: sql`
      SELECT * FROM ${SELF}
      WHERE ${idents(column)} IS NOT NULL
        AND ${idents(column)} NOT IN (${valuesList(values)})`,
  }),

  custom: (name: string, body: (ctx: AuditCtx) => SqlFragment): Audit => ({
    name,
    blocking: true,
    fragment: body({ sql, self: SELF }),
  }),

  /** Понизить аудит до предупреждения: лог вместо провала. */
  warn: (base: Audit): Audit => ({ ...base, blocking: false }),
} as const

const idents = (...names: ReadonlyArray<string>): SqlFragment => ({
  _tag: "SqlFragment",
  nodes: [{ _tag: "Text", text: names.map(quoteIdent).join(", ") }],
})

const valuesList = (values: ReadonlyArray<SqlLiteral>): SqlFragment =>
  values.reduce<SqlFragment>(
    (acc, value, index) => (index === 0 ? sql`${value}` : sql`${acc}, ${value}`),
    { _tag: "SqlFragment", nodes: [] },
  )
