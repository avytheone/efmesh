import { Data, Effect } from "effect"
import type { AnyModel } from "../core/model.ts"
import type { Engine, EngineError } from "../engine/adapter.ts"

/**
 * Schema contract (SPEC §3.2): the declared Schema is not documentation.
 * Before building a snapshot efmesh runs a DESCRIBE of the query (the engine
 * returns names and types without executing it) and checks it against the
 * declaration. Type drift is caught before the backfill, not after.
 *
 * Checked by type families: an exact match of TS types to engine types is
 * impossible (Number is both INTEGER and DOUBLE), while names are checked
 * strictly. DESCRIBE does not report nullability — that is audit territory (§14.2).
 */

export class SchemaMismatchError extends Data.TaggedError("SchemaMismatchError")<{
  readonly model: string
  readonly problems: ReadonlyArray<string>
}> {
  override get message(): string {
    return `schema contract of model «${this.model}»: ${this.problems.join("; ")}`
  }
}

export type TypeFamily = "text" | "numeric" | "boolean" | "temporal" | "any"

/** Family expected from an Effect Schema field (by AST). Reuse: testModel renders fixtures from it. */
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
      // NullOr(X) and the like: the single recognized family among the members
      const families = new Set(
        (node.types ?? []).map(familyOfAst).filter((family) => family !== "any"),
      )
      return families.size === 1 ? [...families][0]! : "any"
    }
    default:
      return "any"
  }
}

/** Family of an actual DuckDB type from DESCRIBE. */
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
 * Checks the model's declared schema against the query's actual result.
 * `renderedSql` — the executable render of the body (references already point
 * at physical storage/sources). `managed` — columns efmesh maintains itself
 * (scdType2: valid_from/valid_to): declared in the schema — consumers see
 * them — but the query does not return them.
 */
export const checkContract = (
  engine: Engine,
  model: AnyModel,
  renderedSql: string,
  managed?: ReadonlySet<string>,
): Effect.Effect<void, EngineError | SchemaMismatchError> =>
  Effect.gen(function* () {
    const actual = yield* engine.describe(renderedSql)
    const actualByName = new Map(actual.map((column) => [column.name, column.type]))
    const declared = (
      Object.entries(model.schema.fields) as ReadonlyArray<[string, { readonly ast: unknown }]>
    ).filter(([name]) => !(managed?.has(name) ?? false))

    const problems: Array<string> = []
    for (const [name, field] of declared) {
      const engineType = actualByName.get(name)
      if (engineType === undefined) {
        problems.push(`column «${name}» is declared in the schema but the query does not return it`)
        continue
      }
      const expected = familyOfAst(field.ast)
      const got = familyOfEngineType(engineType)
      if (expected !== "any" && got !== "any" && expected !== got) {
        problems.push(`column «${name}»: schema expects ${expected}, query returns ${engineType}`)
      }
    }
    const declaredNames = new Set(declared.map(([name]) => name))
    for (const column of actual) {
      if (!declaredNames.has(column.name)) {
        problems.push(`query returns column «${column.name}» which is not in the schema`)
      }
    }

    if (problems.length > 0) {
      return yield* new SchemaMismatchError({ model: model.name.full, problems })
    }
  })
