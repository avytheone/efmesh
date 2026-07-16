/**
 * Объяснение категоризации (#4, SPEC §5.2): `plan --explain` показывает,
 * КАКИЕ узлы канонического AST разошлись и почему категория именно такая.
 * Пути идут по дереву канона движка (json_serialize_sql у DuckDB,
 * libpg_query у Postgres) — это отладочная подсказка, а не контракт:
 * форма путей меняется вместе с каноном и semver-события не образует.
 * Категорию считает categorize.ts; здесь — только её обоснование.
 */

import { topSelect } from "./categorize.ts"

export interface ChangeExplanation {
  /** Пути разошедшихся узлов канонического AST (не больше MAX_DIVERGED). */
  readonly diverged: ReadonlyArray<string>
  /** Почему категория именно такая. */
  readonly reason: string
  /** Изменившиеся прямые родители — источник каскада indirect/forward-only. */
  readonly cascadeFrom?: ReadonlyArray<string>
}

/** Дальше точечные пути перестают помогать — лучше открыть render/diff. */
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
    // узел заменён выражением другого типа — точечные пути внутри бессмысленны
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

/** Служебная обёртка стейтмента в пути не интересна — режем до тела запроса. */
const trimStatement = (path: string): string =>
  path.replace(/^statements\[0\]\.node\.?/, "").replace(/^stmts\[0\]\.stmt\.?/, "") ||
  "(корень)"

/** Пути расхождения двух канонических AST (JSON-строки); мусор на входе — пусто. */
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
 * Обоснование вердикта categorizeAstChange теми же правилами, которыми он
 * вынесен (SPEC §5.2): non-breaking — только суффикс верхнего SELECT.
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
