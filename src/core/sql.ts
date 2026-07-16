/**
 * SQL fragments: a tree of text, model references, and identifiers.
 *
 * A model body is rendered into a fragment once at definition time; the
 * fragment turns into SQL text later — by the reference resolver
 * (canonical rendering for the fingerprint, physical for execution).
 */

export interface SqlFragment {
  readonly _tag: "SqlFragment"
  readonly nodes: ReadonlyArray<SqlNode>
}

export type SqlNode =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Ref"; readonly modelName: string }
  | { readonly _tag: "Idents"; readonly names: ReadonlyArray<string> }
  | { readonly _tag: "Bound"; readonly which: "start" | "end" }
  | { readonly _tag: "Self" }

/** A model reference, obtained from `ctx.ref(model)`. */
export interface RefValue {
  readonly _tag: "RefValue"
  readonly modelName: string
}

/** A list of columns, obtained from `ctx.cols(model, ...)`. */
export interface IdentsValue {
  readonly _tag: "IdentsValue"
  readonly names: ReadonlyArray<string>
}

/** Bound of the interval being processed — `ctx.start` / `ctx.end` (SPEC §3). */
export interface BoundValue {
  readonly _tag: "BoundValue"
  readonly which: "start" | "end"
}

/** The model's own result in an audit query — `ctx.self` (SPEC §8). */
export interface SelfValue {
  readonly _tag: "SelfValue"
}

/** Scalar values are inlined as SQL literals (deterministically). */
export type SqlLiteral = string | number | boolean | bigint | null

export type Interpolation =
  | SqlFragment
  | RefValue
  | IdentsValue
  | BoundValue
  | SelfValue
  | SqlLiteral

const isSqlFragment = (v: unknown): v is SqlFragment =>
  typeof v === "object" && v !== null && (v as any)._tag === "SqlFragment"

const isRefValue = (v: unknown): v is RefValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "RefValue"

const isIdentsValue = (v: unknown): v is IdentsValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "IdentsValue"

const isBoundValue = (v: unknown): v is BoundValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "BoundValue"

const isSelfValue = (v: unknown): v is SelfValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "SelfValue"

export const quoteIdent = (name: string): string => `"${name.replaceAll(`"`, `""`)}"`

export const escapeLiteral = (value: SqlLiteral): string => {
  if (value === null) return "NULL"
  switch (typeof value) {
    case "string":
      return `'${value.replaceAll(`'`, `''`)}'`
    case "number": {
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number in SQL literal: ${value}`)
      return String(value)
    }
    case "bigint":
      return value.toString()
    case "boolean":
      return value ? "TRUE" : "FALSE"
  }
}

export const sql = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<Interpolation>
): SqlFragment => {
  const nodes: Array<SqlNode> = []
  const pushText = (text: string) => {
    if (text === "") return
    const last = nodes[nodes.length - 1]
    if (last !== undefined && last._tag === "Text") {
      nodes[nodes.length - 1] = { _tag: "Text", text: last.text + text }
    } else {
      nodes.push({ _tag: "Text", text })
    }
  }
  for (let i = 0; i < strings.length; i++) {
    pushText(strings[i]!)
    if (i >= values.length) continue
    const value = values[i]!
    if (isSqlFragment(value)) {
      for (const node of value.nodes) {
        if (node._tag === "Text") pushText(node.text)
        else nodes.push(node)
      }
    } else if (isRefValue(value)) {
      nodes.push({ _tag: "Ref", modelName: value.modelName })
    } else if (isIdentsValue(value)) {
      nodes.push({ _tag: "Idents", names: value.names })
    } else if (isBoundValue(value)) {
      nodes.push({ _tag: "Bound", which: value.which })
    } else if (isSelfValue(value)) {
      nodes.push({ _tag: "Self" })
    } else {
      pushText(escapeLiteral(value))
    }
  }
  return { _tag: "SqlFragment", nodes }
}

export interface RenderOptions {
  /** What a model reference turns into (a physical table, an environment view, a logical name…). */
  readonly resolveRef: (modelName: string) => string
  /**
   * Bounds of the interval being processed — ready-made SQL expressions
   * (`TIMESTAMP '…'` at execution time). Without them, `ctx.start`/`ctx.end`
   * render as `$start`/`$end` placeholders — so the canonical text doesn't
   * depend on specific dates and the fingerprint stays stable (SPEC §3, §4).
   */
  readonly interval?: { readonly start: string; readonly end: string }
  /** What `ctx.self` renders to in an audit query (physical table or interval subquery). */
  readonly self?: string
}

export const render = (fragment: SqlFragment, options: RenderOptions): string => {
  let out = ""
  for (const node of fragment.nodes) {
    switch (node._tag) {
      case "Text":
        out += node.text
        break
      case "Ref":
        out += options.resolveRef(node.modelName)
        break
      case "Idents":
        out += node.names.map(quoteIdent).join(", ")
        break
      case "Bound":
        out += options.interval === undefined ? `$${node.which}` : options.interval[node.which]
        break
      case "Self":
        if (options.self === undefined) throw new Error("rendering ctx.self without options.self")
        out += options.self
        break
    }
  }
  return out
}

/**
 * Parser for raw SQL text (SPEC §14.1): `@ref(schema.table)` is a model
 * reference, `@start`/`@end` are interval bounds. Everything else is text
 * as-is. For migrating existing dbt/sqlmesh projects: reference typing is
 * lost, dependencies are declared alongside it (defineSqlModel.refs).
 */
export const parseSqlText = (text: string): SqlFragment => {
  const nodes: Array<SqlNode> = []
  const pattern = /@ref\(\s*([^)\s]+)\s*\)|@start\b|@end\b/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(cursor, match.index)
    if (before !== "") nodes.push({ _tag: "Text", text: before })
    if (match[0].startsWith("@ref")) {
      nodes.push({ _tag: "Ref", modelName: match[1]! })
    } else {
      nodes.push({ _tag: "Bound", which: match[0] === "@start" ? "start" : "end" })
    }
    cursor = match.index + match[0].length
  }
  const tail = text.slice(cursor)
  if (tail !== "") nodes.push({ _tag: "Text", text: tail })
  return { _tag: "SqlFragment", nodes }
}

export const collectRefs = (fragment: SqlFragment): ReadonlySet<string> => {
  const refs = new Set<string>()
  for (const node of fragment.nodes) {
    if (node._tag === "Ref") refs.add(node.modelName)
  }
  return refs
}

/** Whether the fragment uses interval bounds (model-kind validation). */
export const usesBounds = (fragment: SqlFragment): boolean =>
  fragment.nodes.some((node) => node._tag === "Bound")
