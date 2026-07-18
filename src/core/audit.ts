import { Data, type Schema } from "effect"
import type { SelfValue, SqlFragment, SqlLiteral } from "./sql.ts"
import { quoteIdent, sql } from "./sql.ts"

/** A blocking audit found violations: the snapshot/interval is considered unfit. */
export class AuditFailure extends Data.TaggedError("AuditFailure")<{
  readonly model: string
  readonly audit: string
  readonly violations: number
  /**
   * What the violating rows actually SAY, when the audit can put it in words
   * (#42) — the boundaries of a hole, not merely its existence. A count tells an
   * operator that something is wrong; the numbers tell them what to restate.
   */
  readonly detail?: string
}> {
  override get message(): string {
    const head = `audit ${this.audit} on model «${this.model}»: ${this.violations} violating row(s)`
    return this.detail === undefined ? head : `${head} — ${this.detail}`
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
  /**
   * Turns the violating rows into an actionable sentence (#42). Optional: for
   * `notNull` the row count IS the message, but a coverage gate that only says
   * "3 violations" makes an operator write the query themselves to learn where
   * the hole is. Runs on rows the audit itself shaped, so it may read its own
   * column names.
   */
  readonly describe?: (rows: ReadonlyArray<Record<string, unknown>>) => string
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

  /**
   * A sequence column covers its range with no holes (#42).
   *
   * Computes the FACT of coverage instead of trusting a flag: it compares each
   * distinct value with its predecessor and reports every place the sequence
   * jumps. That distinction is the whole point — a "loaded" marker says what
   * some other process believed, the data says what is there.
   *
   * Interior holes only, over the observed range. A missing TAIL is not a gap
   * but a freshness question, and the answer passport already derives it from
   * the interval ledger (`completeThrough`); an audit that also guessed at an
   * expected maximum would be inventing a bound nobody declared.
   */
  assertContiguous: <Fields extends Schema.Struct.Fields>(
    column: Extract<keyof Fields, string>,
  ): Audit => ({
    name: `contiguous(${column})`,
    blocking: true,
    // by construction a statement about the whole sequence: inside one written
    // interval every sequence looks contiguous with itself
    scope: "whole",
    fragment: sql`
      SELECT prev_value AS covered_through, value AS resumes_at,
             value - prev_value - 1 AS missing
      FROM (
        SELECT value, lag(value) OVER (ORDER BY value) AS prev_value
        FROM (SELECT DISTINCT ${idents(column)} AS value FROM ${SELF}
              WHERE ${idents(column)} IS NOT NULL) distinct_values
      ) neighbours
      WHERE prev_value IS NOT NULL AND value > prev_value + 1`,
    describe: (rows) => gapSentence(rows, "covered_through", "resumes_at", (value) => `${value}`),
  }),

  /**
   * A time column has no missing buckets of `step` (#42). Same computed-not-
   * declared rule as assertContiguous; values are bucketed first, so several
   * rows within one bucket are one bucket and not a false gap.
   */
  assertNoGaps: <Fields extends Schema.Struct.Fields>(
    column: Extract<keyof Fields, string>,
    step: "hour" | "day",
  ): Audit => ({
    name: `no_gaps(${column}, ${step})`,
    blocking: true,
    scope: "whole",
    fragment: sql`
      SELECT prev_bucket AS covered_through, bucket AS resumes_at
      FROM (
        SELECT bucket, lag(bucket) OVER (ORDER BY bucket) AS prev_bucket
        FROM (SELECT DISTINCT date_trunc('${literalText(step)}', ${idents(column)}) AS bucket
              FROM ${SELF} WHERE ${idents(column)} IS NOT NULL) distinct_buckets
      ) neighbours
      WHERE prev_bucket IS NOT NULL
        AND bucket > prev_bucket + INTERVAL '1 ${literalText(step)}'`,
    describe: (rows) => gapSentence(rows, "covered_through", "resumes_at", isoOf),
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

/**
 * A closed-vocabulary word spliced into SQL text (a bucket unit). Never reaches
 * here from user input — the type restricts it to the units efmesh knows — but
 * it is filtered anyway, because a fragment builder that trusts a string is one
 * refactor away from trusting the wrong one.
 */
const literalText = (word: string): SqlFragment => ({
  _tag: "SqlFragment",
  nodes: [{ _tag: "Text", text: word.replaceAll(/[^a-z]/g, "") }],
})

const isoOf = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : `${value as string}`

/**
 * The refusal, in numbers: where coverage stops, where it resumes, and how many
 * holes there are in total. "Refuse with numbers before the first write, rather
 * than succeed with silently lost history" — an operator reading this knows the
 * range to restate without writing a query of their own.
 */
const gapSentence = (
  rows: ReadonlyArray<Record<string, unknown>>,
  fromKey: string,
  toKey: string,
  render: (value: unknown) => string,
): string => {
  const first = rows[0]
  if (first === undefined) return "no gaps"
  const head = `covered through ${render(first[fromKey])}, resumes at ${render(first[toKey])}`
  // the first hole is the one to fix first; the rest are counted, not listed,
  // so a badly broken table does not produce an unreadable wall of text
  return rows.length === 1 ? head : `${head} (and ${rows.length - 1} further gap(s))`
}

const idents = (...names: ReadonlyArray<string>): SqlFragment => ({
  _tag: "SqlFragment",
  nodes: [{ _tag: "Text", text: names.map(quoteIdent).join(", ") }],
})

const valuesList = (values: ReadonlyArray<SqlLiteral>): SqlFragment =>
  values.reduce<SqlFragment>(
    (acc, value, index) => (index === 0 ? sql`${value}` : sql`${acc}, ${value}`),
    { _tag: "SqlFragment", nodes: [] },
  )
