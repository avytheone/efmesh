import { Data, Effect } from "effect"
import type { AnyModel } from "../core/model.ts"
import type { Engine, EngineError } from "../engine/adapter.ts"

/**
 * Контракт схемы (SPEC §3.2): объявленная Schema — не документация.
 * Перед сборкой снапшота efmesh делает DESCRIBE запроса (движок отдаёт
 * имена и типы, не выполняя его) и сверяет с объявлением. Дрейф типов
 * ловится до бэкфилла, а не после.
 *
 * Сверка по семействам типов: точное соответствие TS-типов типам движка
 * невозможно (Number — это и INTEGER, и DOUBLE), а имена проверяются
 * строго. Nullability DESCRIBE не отдаёт — это территория аудитов (§14.2).
 */

export class SchemaMismatchError extends Data.TaggedError("SchemaMismatchError")<{
  readonly model: string
  readonly problems: ReadonlyArray<string>
}> {}

export type TypeFamily = "text" | "numeric" | "boolean" | "temporal" | "any"

/** Семейство, ожидаемое от поля Effect Schema (по AST). Реюз: testModel рендерит фикстуры по нему. */
export const familyOfAst = (ast: unknown): TypeFamily => {
  const node = ast as {
    readonly _tag: string
    readonly types?: ReadonlyArray<unknown>
    readonly annotations?: { readonly typeConstructor?: { readonly _tag?: string } }
  }
  switch (node._tag) {
    case "String":
      return "text"
    case "Number":
    case "BigInt":
      return "numeric"
    case "Boolean":
      return "boolean"
    case "Declaration": {
      const constructorTag = node.annotations?.typeConstructor?._tag ?? ""
      return constructorTag.startsWith("effect/DateTime") ? "temporal" : "any"
    }
    case "Union": {
      // NullOr(X) и подобные: единственное распознанное семейство среди членов
      const families = new Set(
        (node.types ?? [])
          .map(familyOfAst)
          .filter((family) => family !== "any"),
      )
      return families.size === 1 ? [...families][0]! : "any"
    }
    default:
      return "any"
  }
}

/** Семейство фактического типа DuckDB из DESCRIBE. */
const familyOfEngineType = (engineType: string): TypeFamily => {
  const base = engineType.toUpperCase()
  if (base === "VARCHAR" || base.startsWith("VARCHAR(")) return "text"
  if (base === "BOOLEAN") return "boolean"
  if (
    /^(U?(TINY|SMALL|BIG|HUGE)INT|INTEGER|UINTEGER|FLOAT|DOUBLE|REAL)$/.test(base) ||
    base.startsWith("DECIMAL")
  ) {
    return "numeric"
  }
  if (base === "DATE" || base === "TIME" || base.startsWith("TIMESTAMP")) return "temporal"
  return "any"
}

/**
 * Сверяет объявленную схему модели с фактическим результатом запроса.
 * `renderedSql` — исполнимый рендер тела (ссылки уже в физике/источниках).
 */
export const checkContract = (
  engine: Engine,
  model: AnyModel,
  renderedSql: string,
): Effect.Effect<void, EngineError | SchemaMismatchError> =>
  Effect.gen(function* () {
    const actual = yield* engine.describe(renderedSql)
    const actualByName = new Map(actual.map((column) => [column.name, column.type]))
    const declared = Object.entries(model.schema.fields) as ReadonlyArray<
      [string, { readonly ast: unknown }]
    >

    const problems: Array<string> = []
    for (const [name, field] of declared) {
      const engineType = actualByName.get(name)
      if (engineType === undefined) {
        problems.push(`колонка «${name}» объявлена в схеме, но запрос её не возвращает`)
        continue
      }
      const expected = familyOfAst(field.ast)
      const got = familyOfEngineType(engineType)
      if (expected !== "any" && got !== "any" && expected !== got) {
        problems.push(`колонка «${name}»: схема ждёт ${expected}, запрос отдаёт ${engineType}`)
      }
    }
    const declaredNames = new Set(declared.map(([name]) => name))
    for (const column of actual) {
      if (!declaredNames.has(column.name)) {
        problems.push(`запрос возвращает колонку «${column.name}», которой нет в схеме`)
      }
    }

    if (problems.length > 0) {
      return yield* new SchemaMismatchError({ model: model.name.full, problems })
    }
  })
