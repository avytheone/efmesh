/**
 * SQL-фрагменты: дерево из текста, ссылок на модели и идентификаторов.
 *
 * Тело модели рендерится в фрагмент один раз при определении; в текст SQL
 * фрагмент превращается позже — резолвером ссылок (canonical-рендер для
 * fingerprint, физический — для исполнения).
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

/** Ссылка на модель, полученная из `ctx.ref(model)`. */
export interface RefValue {
  readonly _tag: "RefValue"
  readonly modelName: string
}

/** Список колонок, полученный из `ctx.cols(model, ...)`. */
export interface IdentsValue {
  readonly _tag: "IdentsValue"
  readonly names: ReadonlyArray<string>
}

/** Граница обрабатываемого интервала — `ctx.start` / `ctx.end` (SPEC §3). */
export interface BoundValue {
  readonly _tag: "BoundValue"
  readonly which: "start" | "end"
}

/** Скалярные значения инлайнятся как SQL-литералы (детерминированно). */
export type SqlLiteral = string | number | boolean | bigint | null

export type Interpolation = SqlFragment | RefValue | IdentsValue | BoundValue | SqlLiteral

const isSqlFragment = (v: unknown): v is SqlFragment =>
  typeof v === "object" && v !== null && (v as any)._tag === "SqlFragment"

const isRefValue = (v: unknown): v is RefValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "RefValue"

const isIdentsValue = (v: unknown): v is IdentsValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "IdentsValue"

const isBoundValue = (v: unknown): v is BoundValue =>
  typeof v === "object" && v !== null && (v as any)._tag === "BoundValue"

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
    } else {
      pushText(escapeLiteral(value))
    }
  }
  return { _tag: "SqlFragment", nodes }
}

export interface RenderOptions {
  /** Во что превращается ссылка на модель (physical-таблица, view окружения, логическое имя…). */
  readonly resolveRef: (modelName: string) => string
  /**
   * Границы обрабатываемого интервала — готовые SQL-выражения
   * (`TIMESTAMP '…'` при исполнении). Без них `ctx.start`/`ctx.end`
   * рендерятся плейсхолдерами `$start`/`$end` — так канонический текст
   * не зависит от конкретных дат и fingerprint стабилен (SPEC §3, §4).
   */
  readonly interval?: { readonly start: string; readonly end: string }
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
    }
  }
  return out
}

export const collectRefs = (fragment: SqlFragment): ReadonlySet<string> => {
  const refs = new Set<string>()
  for (const node of fragment.nodes) {
    if (node._tag === "Ref") refs.add(node.modelName)
  }
  return refs
}

/** Использует ли фрагмент границы интервала (валидация вида модели). */
export const usesBounds = (fragment: SqlFragment): boolean =>
  fragment.nodes.some((node) => node._tag === "Bound")
