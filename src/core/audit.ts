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
 * What an audit's `self` is allowed to mean (#53).
 *
 * The same declaration used to be evaluated at two scopes with nothing in the
 * API to say which the author meant: `apply` checks the interval it just wrote,
 * `efmesh audit` checks the whole environment view. For a ROW-WISE predicate
 * (`notNull`, `accepted`) the two agree by construction — a row either violates
 * it or does not, and the surrounding rows are irrelevant. For an AGGREGATE one
 * (`unique`, and anything counting or windowing) they can return opposite
 * verdicts on correct data: uniqueness can hold inside every written interval
 * and fail across the table, and an author had no way to say which they wanted.
 *
 * - `any` (default) — the invariant is scope-free; every runner may check it.
 *   Correct for row-wise predicates, and it is what every audit did before this
 *   existed, so nothing changes for a project that says nothing.
 * - `interval` — only meaningful over one written interval; `efmesh audit`
 *   reports it as skipped rather than evaluating it over data it was never
 *   about.
 * - `whole` — only meaningful over the complete relation; checked before
 *   promotion and by `efmesh audit`, never against a single interval.
 */
export type AuditScope = "any" | "interval" | "whole"

/**
 * Audit (SPEC §8) — a SQL predicate over a model's result: the query returns
 * the VIOLATING rows, a non-empty result means failure. `ctx.self` renders to
 * the relation the audit's scope names: the interval just written, or the
 * model's complete physics.
 *
 * A blocking audit (the default) fails apply: the interval is marked failed,
 * the view is not promoted. warn — logs and lets the pipeline continue.
 */
export interface Audit {
  readonly name: string
  readonly blocking: boolean
  readonly scope: AuditScope
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
    scope: "any",
    fragment: sql`SELECT * FROM ${SELF} WHERE ${idents(column)} IS NULL`,
  }),

  unique: <Fields extends Schema.Struct.Fields>(
    ...columns: ReadonlyArray<Extract<keyof Fields, string>>
  ): Audit => ({
    name: `unique(${columns.join(", ")})`,
    blocking: true,
    // aggregate, so genuinely scope-sensitive — but the default stays `any`, or
    // an existing project would silently stop checking uniqueness on apply
    scope: "any",
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
    scope: "any",
    fragment: sql`
      SELECT * FROM ${SELF}
      WHERE ${idents(column)} IS NOT NULL
        AND ${idents(column)} NOT IN (${valuesList(values)})`,
  }),

  custom: (name: string, body: (ctx: AuditCtx) => SqlFragment): Audit => ({
    name,
    blocking: true,
    scope: "any",
    fragment: body({ sql, self: SELF }),
  }),

  /** Downgrade an audit to a warning: log instead of failing. */
  warn: (base: Audit): Audit => ({ ...base, blocking: false }),

  /**
   * "Check this against one written interval, nothing wider" (#53). A windowed
   * guarantee — deduplication over a lookback, a per-batch invariant — holds
   * inside the window it was computed in and may legitimately fail across the
   * whole table. Without this, the only way to stop `efmesh audit` from failing
   * on correct data was to downgrade the audit to a warning, which gives up
   * blocking on apply too.
   */
  perInterval: (base: Audit): Audit => ({ ...base, scope: "interval" }),

  /**
   * "Check this against the complete relation, never a slice of it" (#53).
   * Evaluated before promotion, so a violation still stops the environment from
   * serving it, and by `efmesh audit` afterwards.
   */
  whole: (base: Audit): Audit => ({ ...base, scope: "whole" }),
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
