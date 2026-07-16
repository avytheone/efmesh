import { Effect } from "effect"
import type { AnyModel } from "../core/model.ts"
import { escapeLiteral, quoteIdent, render, usesBounds } from "../core/sql.ts"
import { fromIso, sqlTimestamp } from "../core/interval.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { DuckDBEngineLive } from "../engine/duckdb.ts"
import { familyOfAst, type TypeFamily } from "../plan/contract.ts"

/**
 * Unit-tests a model against fixtures (SPEC §8): `ctx.ref` is rendered into a
 * CTE with VALUES from the fixtures, validated against the source model's
 * Schema (the model remembers its sources by value — model.refs); the query
 * runs on a throwaway in-memory DuckDB, and the result is compared to the
 * expectation. Lives in bun test:
 *
 *   test("stays", () => testModel(stays, { inputs: {...}, expect: [...] }))
 */

export interface TestModelSpec {
  /** Fixtures keyed by source models' full names; required for every dep. */
  readonly inputs?: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>
  /** Interval bounds [start, end) — required for incremental models. */
  readonly interval?: readonly [string, string]
  readonly expect: ReadonlyArray<Record<string, unknown>>
  /** Whether row order matters; unordered by default. */
  readonly strictOrder?: boolean
}

const DUCK_TYPE: Record<TypeFamily, string> = {
  text: "VARCHAR",
  numeric: "DOUBLE",
  boolean: "BOOLEAN",
  temporal: "TIMESTAMP",
  any: "VARCHAR",
}

/** Fixture literal by column family (ISO time strings → TIMESTAMP). */
const fixtureLiteral = (value: unknown, family: TypeFamily): string => {
  if (value === null || value === undefined) return "NULL"
  if (family === "temporal") return sqlTimestamp(fromIso(String(value)))
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return escapeLiteral(value)
  }
  throw new Error(`fixture contains a non-renderable value: ${String(value)}`)
}

/**
 * A fixture cannot lie about the shape of its input: values are checked
 * against the source Schema's type families (time strings are ISO; in v4
 * Schema.DateTimeUtc decodes to a ready DateTime.Utc, not a string, so the
 * check is by family rather than via decode), and extra keys — typos — are
 * rejected.
 */
const validateFixture = (
  source: AnyModel,
  fields: ReadonlyArray<[string, { readonly ast: unknown }]>,
  row: Record<string, unknown>,
): void => {
  const known = new Set(fields.map(([name]) => name))
  for (const key of Object.keys(row)) {
    if (!known.has(key)) {
      throw new Error(`fixture ${source.name.full}: extra column «${key}»`)
    }
  }
  for (const [name, field] of fields) {
    const value = row[name]
    if (value === null || value === undefined) continue
    const family = familyOfAst(field.ast)
    const ok =
      family === "text"
        ? typeof value === "string"
        : family === "numeric"
          ? typeof value === "number" || typeof value === "bigint"
          : family === "boolean"
            ? typeof value === "boolean"
            : family === "temporal"
              ? typeof value === "string" && !Number.isNaN(Date.parse(value))
              : true
    if (!ok) {
      throw new Error(
        `fixture ${source.name.full}: column «${name}» expects ${family}, got ${JSON.stringify(value)}`,
      )
    }
  }
}

/** Source CTE: VALUES from fixtures, or an empty SELECT typed by the schema. */
const fixtureCte = (source: AnyModel, rows: ReadonlyArray<Record<string, unknown>>): string => {
  const fields = Object.entries(source.schema.fields) as ReadonlyArray<
    [string, { readonly ast: unknown }]
  >
  const columns = fields.map(([name]) => quoteIdent(name)).join(", ")
  if (rows.length === 0) {
    const empty = fields
      .map(([name, field]) => `NULL::${DUCK_TYPE[familyOfAst(field.ast)]} AS ${quoteIdent(name)}`)
      .join(", ")
    return `SELECT ${empty} WHERE FALSE`
  }
  const tuples = rows.map((row) => {
    validateFixture(source, fields, row)
    return `(${fields
      .map(([name, field]) => fixtureLiteral(row[name], familyOfAst(field.ast)))
      .join(", ")})`
  })
  return `SELECT * FROM (VALUES ${tuples.join(", ")}) AS t(${columns})`
}

/** DuckDB values → comparable primitives (bigint → number, time objects → string). */
const normalize = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === "bigint") return [key, Number(value)]
      if (value !== null && typeof value === "object") return [key, String(value)]
      return [key, value]
    }),
  )

const sortKeys = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)))

const canonical = (
  rows: ReadonlyArray<Record<string, unknown>>,
  strictOrder: boolean,
): ReadonlyArray<string> => {
  const normalized = rows.map(normalize).map((row) => JSON.stringify(sortKeys(row)))
  return strictOrder ? normalized : [...normalized].sort()
}

/** Runs the model against fixtures, returning rows — for non-standard checks. */
export const runModel = async (
  model: AnyModel,
  spec: Pick<TestModelSpec, "inputs" | "interval">,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const inputs = spec.inputs ?? {}
  for (const dep of model.deps) {
    if (!(dep in inputs)) {
      throw new Error(`no fixture for source ${dep} (deps of model ${model.name.full})`)
    }
  }
  for (const name of Object.keys(inputs)) {
    if (!model.deps.has(name)) {
      throw new Error(`fixture «${name}» is not a source of model ${model.name.full}`)
    }
  }
  if (usesBounds(model.fragment) && spec.interval === undefined) {
    throw new Error(`model ${model.name.full} uses ctx.start/ctx.end — provide interval`)
  }

  const ctes = [...model.deps]
    .sort()
    .map((dep) => `${quoteIdent(dep)} AS (${fixtureCte(model.refs.get(dep)!, inputs[dep] ?? [])})`)
  const body = render(model.fragment, {
    resolveRef: (ref) => quoteIdent(ref),
    ...(spec.interval !== undefined
      ? {
          interval: {
            start: sqlTimestamp(fromIso(spec.interval[0])),
            end: sqlTimestamp(fromIso(spec.interval[1])),
          },
        }
      : {}),
  })
  const query = ctes.length > 0 ? `WITH ${ctes.join(", ")} ${body}` : body

  return Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* EngineAdapter
      return yield* engine.query(query)
    }).pipe(Effect.provide(DuckDBEngineLive())),
  )
}

/** Runs the model against fixtures and checks the result against the expectation. */
export const testModel = async (model: AnyModel, spec: TestModelSpec): Promise<void> => {
  const rows = await runModel(model, spec)
  const got = canonical(rows, spec.strictOrder ?? false)
  const want = canonical(spec.expect, spec.strictOrder ?? false)
  if (got.length !== want.length || got.some((row, index) => row !== want[index])) {
    throw new Error(
      [
        `result of model ${model.name.full} did not match the expectation:`,
        `— got (${got.length}):`,
        ...got.map((row) => `    ${row}`),
        `— expected (${want.length}):`,
        ...want.map((row) => `    ${row}`),
      ].join("\n"),
    )
  }
}
