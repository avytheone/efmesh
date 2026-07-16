/**
 * Change categorization by canonical ASTs (SPEC §5.2): non-breaking is adding
 * columns TO THE END of the top SELECT with the rest of the tree entirely
 * unchanged (consumers select by name, descendants' INSERT is by position, so
 * only a suffix is safe). Everything else is breaking. On any unexpected
 * structure — conservatively breaking.
 */

type AstNode = Record<string, unknown>

/** The canon's top SELECT: the column list + the rest of the tree (for explain.ts). */
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
  // the old select_list is an exact prefix of the new one
  return before.list.every((item, index) => item === after.list[index])
    ? "non-breaking"
    : "breaking"
}
