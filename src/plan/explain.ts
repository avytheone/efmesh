/**
 * Categorization explanation (#4, SPEC §5.2): `plan --explain` shows WHICH
 * nodes of the canonical AST diverged and why the category is what it is.
 * Paths follow the engine's canon tree (json_serialize_sql on DuckDB,
 * libpg_query on Postgres) — this is a debugging hint, not a contract:
 * the shape of the paths moves with the canon and is not a semver event.
 * The category itself is computed by categorize.ts; here — only its rationale.
 */

import { topSelect } from "./categorize.ts"

export interface ChangeExplanation {
  /** Paths of diverged canonical-AST nodes (no more than MAX_DIVERGED). */
  readonly diverged: ReadonlyArray<string>
  /** Why the category is what it is. */
  readonly reason: string
  /** Changed direct parents — the source of the indirect/forward-only cascade. */
  readonly cascadeFrom?: ReadonlyArray<string>
}

/** Beyond this, pointwise paths stop helping — better to open render/diff. */
const MAX_DIVERGED = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const at = (path: string, segment: string): string =>
  path === "" ? segment : `${path}.${segment}`

const walk = (before: unknown, after: unknown, path: string, out: Array<string>): void => {
  if (out.length >= MAX_DIVERGED) return
  if (JSON.stringify(before) === JSON.stringify(after)) return
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length)
    for (let i = 0; i < shared; i++) walk(before[i], after[i], `${path}[${i}]`, out)
    for (let i = shared; i < after.length && out.length < MAX_DIVERGED; i++) {
      out.push(`${path}[${i}] (добавлен)`)
    }
    for (let i = shared; i < before.length && out.length < MAX_DIVERGED; i++) {
      out.push(`${path}[${i}] (удалён)`)
    }
    return
  }
  if (isRecord(before) && isRecord(after)) {
    // node replaced by an expression of another type — pointwise paths inside are meaningless
    if (before["type"] !== after["type"]) {
      out.push(path === "" ? "(корень)" : path)
      return
    }
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    for (const key of keys) walk(before[key], after[key], at(path, key), out)
    return
  }
  out.push(path === "" ? "(корень)" : path)
}

/** The statement's boilerplate wrapper in the path is uninteresting — trim to the query body. */
const trimStatement = (path: string): string =>
  path.replace(/^statements\[0\]\.node\.?/, "").replace(/^stmts\[0\]\.stmt\.?/, "") ||
  "(корень)"

/** Divergence paths of two canonical ASTs (JSON strings); garbage input — empty. */
export const divergedPaths = (oldAst: string, newAst: string): ReadonlyArray<string> => {
  try {
    const out: Array<string> = []
    walk(JSON.parse(oldAst), JSON.parse(newAst), "", out)
    return out.map(trimStatement)
  } catch {
    return []
  }
}

/**
 * Override guardrail (#5): the new top SELECT has fewer columns — they were
 * removed, descendants read them by name, so «non-breaking» plainly contradicts
 * the AST. An unparseable canon does not count as a contradiction: the decision
 * is the operator's, the override is explicit and journaled.
 */
export const dropsColumns = (oldAst: string, newAst: string): boolean => {
  const before = topSelect(oldAst)
  const after = topSelect(newAst)
  if (before === null || after === null) return false
  return after.list.length < before.list.length
}

/**
 * Justifies the categorizeAstChange verdict by the same rules that produced
 * it (SPEC §5.2): non-breaking — only a suffix of the top SELECT.
 */
export const explainCategorized = (
  oldAst: string,
  newAst: string,
  change: "breaking" | "non-breaking",
): ChangeExplanation => {
  const diverged = divergedPaths(oldAst, newAst)
  if (change === "non-breaking") {
    return {
      diverged,
      reason:
        "колонки добавлены в конец верхнего SELECT, остальное дерево нетронуто — потребители читают по именам, пересборка не нужна",
    }
  }
  const before = topSelect(oldAst)
  const after = topSelect(newAst)
  const reason =
    before === null || after === null
      ? "канонический AST неожиданной формы — консервативно breaking"
      : before.rest !== after.rest
        ? "дерево разошлось вне списка SELECT (FROM/WHERE/JOIN/GROUP BY/модификаторы)"
        : after.list.length < before.list.length
          ? "колонки удалены из SELECT — потомки вставляют по позициям, физику надо пересобирать"
          : "список SELECT изменён не только хвостом — правка или перестановка колонок ломает позиции потомков"
  return { diverged, reason }
}
