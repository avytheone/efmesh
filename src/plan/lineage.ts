import { Data, Effect } from "effect"
import type { ModelGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import type { EngineError, SqlParseError } from "../engine/adapter.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { canonicalSql } from "./fingerprint.ts"

/**
 * Column-level lineage (SPEC §9.4): the chain from a model's column down to
 * the raw columns of external/seed models. Precision is best-effort — a
 * column's expression is taken from the canonical AST (the engine's native
 * parser), column references are matched to parents' schemas by name,
 * qualifiers and CTE aliases are not resolved. The model graph itself is
 * always exact: dependencies are known from `ctx.ref`, not from text parsing.
 */

export class LineageError extends Data.TaggedError("LineageError")<{
  readonly model: string
  readonly reason: string
}> {
  override get message(): string {
    return `lineage «${this.model}»: ${this.reason}`
  }
}

export interface LineageNode {
  readonly model: string
  readonly column: string
  /** Model kind — external/seed are leaves (raw sources). */
  readonly kind: string
  readonly sources: ReadonlyArray<LineageNode>
}

/** All COLUMN_REFs in the expression subtree — column names without qualifiers. */
const collectColumnRefs = (node: unknown, out: Set<string>): void => {
  if (Array.isArray(node)) {
    for (const item of node) collectColumnRefs(item, out)
    return
  }
  if (node === null || typeof node !== "object") return
  const record = node as Record<string, unknown>
  if (record.class === "COLUMN_REF" && Array.isArray(record.column_names)) {
    const names = record.column_names as ReadonlyArray<string>
    if (names.length > 0) out.add(names[names.length - 1]!)
  }
  for (const value of Object.values(record)) collectColumnRefs(value, out)
}

const selectItems = (ast: unknown): ReadonlyArray<Record<string, unknown>> => {
  const statements = (ast as { statements?: ReadonlyArray<{ node?: unknown }> }).statements
  const node = statements?.[0]?.node as { select_list?: ReadonlyArray<unknown> } | undefined
  return (node?.select_list ?? []) as ReadonlyArray<Record<string, unknown>>
}

/**
 * The columns `column` depends on in select_list: an aliased expression or a
 * same-named COLUMN_REF; `SELECT *` — a pass-through of the name.
 * undefined — the column's expression was not found (engine sugar) — best-effort.
 */
const sourceColumnsOf = (ast: unknown, column: string): ReadonlySet<string> | undefined => {
  const items = selectItems(ast)
  const named =
    items.find((item) => item.alias === column) ??
    items.find((item) => {
      if (item.alias !== "" && item.alias !== undefined) return false
      if (item.class !== "COLUMN_REF" || !Array.isArray(item.column_names)) return false
      const names = item.column_names as ReadonlyArray<string>
      return names[names.length - 1] === column
    })
  if (named !== undefined) {
    const out = new Set<string>()
    collectColumnRefs(named, out)
    return out
  }
  if (items.some((item) => item.class === "STAR" || item.type === "STAR")) {
    return new Set([column])
  }
  return undefined
}

export const lineage = (
  graph: ModelGraph,
  modelName: string,
  column: string,
): Effect.Effect<LineageNode, LineageError | EngineError | SqlParseError, EngineAdapter> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const root = graph.models.get(modelName)
    if (root === undefined) {
      return yield* new LineageError({ model: modelName, reason: "model is not in the project" })
    }
    if (!(column in root.schema.fields)) {
      return yield* new LineageError({
        model: modelName,
        reason: `column «${column}» is not in the schema`,
      })
    }

    const asts = new Map<string, unknown>()
    const astOf = (model: AnyModel): Effect.Effect<unknown, EngineError | SqlParseError> =>
      Effect.gen(function* () {
        const cached = asts.get(model.name.full)
        if (cached !== undefined) return cached
        const ast = JSON.parse(
          yield* engine.canonicalize(canonicalSql(graph, model.name.full)),
        ) as unknown
        asts.set(model.name.full, ast)
        return ast
      })

    const trace = (
      model: AnyModel,
      wanted: string,
    ): Effect.Effect<LineageNode, EngineError | SqlParseError> =>
      Effect.gen(function* () {
        const leaf: LineageNode = {
          model: model.name.full,
          column: wanted,
          kind: model.kind._tag,
          sources: [],
        }
        // raw source: beyond here the chain hits the outside world
        if (model.kind._tag === "external" || model.kind._tag === "seed" || model.deps.size === 0) {
          return leaf
        }
        const columns = sourceColumnsOf(yield* astOf(model), wanted)
        if (columns === undefined) return leaf
        const sources: Array<LineageNode> = []
        for (const source of columns) {
          for (const parent of model.refs.values()) {
            if (!(source in parent.schema.fields)) continue
            sources.push(yield* trace(parent, source))
          }
        }
        return { ...leaf, sources }
      })

    return yield* trace(root, column)
  })

/** Flat printout of the lineage tree for the CLI. */
export const formatLineage = (node: LineageNode, indent = ""): ReadonlyArray<string> => {
  const marker = node.kind === "external" || node.kind === "seed" ? `  [${node.kind}]` : ""
  const line = `${indent}${node.model}.${node.column}${marker}`
  return [line, ...node.sources.flatMap((source) => formatLineage(source, `${indent}  `))]
}
