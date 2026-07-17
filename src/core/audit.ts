import { Data, type Schema } from "effect"
import type { SelfValue, SqlFragment, SqlLiteral } from "./sql.ts"
import { quoteIdent, sql } from "./sql.ts"

/** A blocking audit found violations: the snapshot/interval is considered unfit. */
export class AuditFailure extends Data.TaggedError("AuditFailure")<{
  readonly model: string
  readonly audit: string
  readonly violations: number
}> {
  override get message(): string {
    return `audit ${this.audit} on model «${this.model}»: ${this.violations} violating row(s)`
  }
}

/**
 * Audit (SPEC §8) — a SQL predicate over a model's result: the query returns
 * the VIOLATING rows, a non-empty result means failure. `ctx.self` renders
 * to the snapshot's physical table (for incremental, to a subquery of the
 * processed interval — the audit checks what was just loaded, not the whole history).
 *
 * A blocking audit (the default) fails apply: the interval is marked failed,
 * the view is not promoted. warn — logs and lets the pipeline continue.
 */
export interface Audit {
  readonly name: string
  readonly blocking: boolean
  /** The violations query; contains a Self node. */
  readonly fragment: SqlFragment
}

export interface AuditCtx {
  readonly sql: typeof sql
  readonly self: SelfValue
}

const SELF: SelfValue = { _tag: "SelfValue" }

/** Builders are typed by the model's columns via the Fields type parameter. */
export const audit = {
  notNull: <Fields extends Schema.Struct.Fields>(column: Extract<keyof Fields, string>): Audit => ({
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

  /** Downgrade an audit to a warning: log instead of failing. */
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
