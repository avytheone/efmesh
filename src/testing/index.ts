import { Effect } from "effect"
import type { AnyModel } from "../core/model.ts"
import { escapeLiteral, quoteIdent, render, usesBounds } from "../core/sql.ts"
import { fromIso, sqlTimestamp } from "../core/interval.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { DuckDBEngineLive } from "../engine/duckdb.ts"
import { familyOfAst, type TypeFamily } from "../plan/contract.ts"

/**
 * Юнит-тест модели на фикстурах (SPEC §8): `ctx.ref` рендерится в CTE
 * с VALUES из фикстур, валидированных через Schema модели-источника
 * (модель помнит источники значениями — model.refs), запрос выполняется
 * на одноразовом in-memory DuckDB, результат сравнивается с ожидаемым.
 * Живёт в bun test:
 *
 *   test("stays", () => testModel(stays, { inputs: {...}, expect: [...] }))
 */

export interface TestModelSpec {
  /** Фикстуры по полным именам моделей-источников; нужны для всех deps. */
  readonly inputs?: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>
  /** Границы интервала [start, end) — обязательны для incremental-моделей. */
  readonly interval?: readonly [string, string]
  readonly expect: ReadonlyArray<Record<string, unknown>>
  /** Сравнивать порядок строк; по умолчанию порядок не важен. */
  readonly strictOrder?: boolean
}

const DUCK_TYPE: Record<TypeFamily, string> = {
  text: "VARCHAR",
  numeric: "DOUBLE",
  boolean: "BOOLEAN",
  temporal: "TIMESTAMP",
  any: "VARCHAR",
}

/** Литерал фикстуры по семейству колонки (ISO-строки времени → TIMESTAMP). */
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
  throw new Error(`фикстура содержит нерендерируемое значение: ${String(value)}`)
}

/**
 * Фикстура не может врать о форме входа: значения сверяются с семействами
 * типов Schema источника (строки времени — ISO; Schema.DateTimeUtc в v4
 * декодирует готовый DateTime.Utc, не строку, поэтому проверка по семейству,
 * не через decode), лишние ключи — опечатки — отвергаются.
 */
const validateFixture = (
  source: AnyModel,
  fields: ReadonlyArray<[string, { readonly ast: unknown }]>,
  row: Record<string, unknown>,
): void => {
  const known = new Set(fields.map(([name]) => name))
  for (const key of Object.keys(row)) {
    if (!known.has(key)) {
      throw new Error(`фикстура ${source.name.full}: лишняя колонка «${key}»`)
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
        `фикстура ${source.name.full}: колонка «${name}» ждёт ${family}, получено ${JSON.stringify(value)}`,
      )
    }
  }
}

/** CTE источника: VALUES из фикстур или пустой SELECT с типами схемы. */
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

/** DuckDB-значения → сравнимые примитивы (bigint → number, объекты времени → строка). */
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

/** Прогоняет модель на фикстурах, возвращает строки — для нестандартных проверок. */
export const runModel = async (
  model: AnyModel,
  spec: Pick<TestModelSpec, "inputs" | "interval">,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const inputs = spec.inputs ?? {}
  for (const dep of model.deps) {
    if (!(dep in inputs)) {
      throw new Error(`нет фикстуры для источника ${dep} (deps модели ${model.name.full})`)
    }
  }
  for (const name of Object.keys(inputs)) {
    if (!model.deps.has(name)) {
      throw new Error(`фикстура «${name}» не является источником модели ${model.name.full}`)
    }
  }
  if (usesBounds(model.fragment) && spec.interval === undefined) {
    throw new Error(`модель ${model.name.full} использует ctx.start/ctx.end — укажи interval`)
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

/** Прогоняет модель на фикстурах и сверяет результат с ожиданием. */
export const testModel = async (model: AnyModel, spec: TestModelSpec): Promise<void> => {
  const rows = await runModel(model, spec)
  const got = canonical(rows, spec.strictOrder ?? false)
  const want = canonical(spec.expect, spec.strictOrder ?? false)
  if (got.length !== want.length || got.some((row, index) => row !== want[index])) {
    throw new Error(
      [
        `результат модели ${model.name.full} не совпал с ожиданием:`,
        `— получено (${got.length}):`,
        ...got.map((row) => `    ${row}`),
        `— ожидалось (${want.length}):`,
        ...want.map((row) => `    ${row}`),
      ].join("\n"),
    )
  }
}
