/**
 * Категоризация изменения по каноническим AST (SPEC §5.2): non-breaking —
 * это добавление колонок В КОНЕЦ верхнего SELECT при полностью неизменном
 * остальном дереве (потребители выбирают по именам, INSERT потомков — по
 * позициям, поэтому только суффикс безопасен). Всё прочее — breaking.
 * При любой неожиданной структуре — консервативно breaking.
 */

type AstNode = Record<string, unknown>

/** Верхний SELECT канона: список колонок + остальное дерево (для explain.ts). */
export const topSelect = (
  astJson: string,
): { list: ReadonlyArray<string>; rest: string } | null => {
  try {
    const ast = JSON.parse(astJson) as {
      readonly statements?: ReadonlyArray<{ readonly node?: AstNode }>
    }
    const node = ast.statements?.[0]?.node
    if (node === undefined || !Array.isArray(node["select_list"])) return null
    const list = (node["select_list"] as ReadonlyArray<unknown>).map((item) =>
      JSON.stringify(item),
    )
    const { select_list: _list, ...rest } = node
    return { list, rest: JSON.stringify(rest) }
  } catch {
    return null
  }
}

export const categorizeAstChange = (
  oldAst: string,
  newAst: string,
): "breaking" | "non-breaking" => {
  const before = topSelect(oldAst)
  const after = topSelect(newAst)
  if (before === null || after === null) return "breaking"
  if (before.rest !== after.rest) return "breaking"
  if (after.list.length <= before.list.length) return "breaking"
  // старый select_list — точный префикс нового
  return before.list.every((item, index) => item === after.list[index])
    ? "non-breaking"
    : "breaking"
}
