import type { AnyModel } from "../core/model.ts"

/**
 * `batchSize` is documented as a performance knob, and it is not only that
 * (#54): a backfill batch renders ONE `[start, end)` for the whole batch, not
 * one per interval. For a model whose correctness depends on the width of that
 * range — any window function over it — the semantics therefore change with how
 * the work happened to be chunked. The same model over the same data
 * de-duplicates across seven days while catching up with `batchSize: 7`, and
 * across one on the steady daily tick.
 *
 * Nothing warned about that, and no output hinted that the rendered window was
 * wider than the declared interval. This is that warning, raised where the
 * mistake is introduced rather than where it eventually shows: at plan time,
 * from the model's own declaration, before anything is written.
 *
 * It is a WARNING and never an error. A window function over a wide batch is
 * legitimate when the result does not depend on the frame — a running total
 * partitioned by a key that never spans intervals, say — and efmesh cannot know
 * which. Refusing would make a correct model unbuildable to protect an
 * incorrect one.
 */

/**
 * Does the canonical AST contain a window function?
 *
 * Structural, not textual, and therefore worth the dialect-specific knowledge:
 * grepping the SQL for `OVER` matches a column named `over`, the word inside a
 * string literal, and a comment. Both engines' serialized trees mark the
 * construct itself — DuckDB with `"class": "WINDOW"`, libpg_query with an
 * `over` clause on the function call — and neither marks anything else.
 */
export const hasWindowFunction = (canonicalAst: string): boolean => {
  let tree: unknown
  try {
    tree = JSON.parse(canonicalAst)
  } catch {
    // not a serialized tree (an engine that canonicalizes to text, an empty AST
    // for a kind that has none): no claim either way, so no warning
    return false
  }
  let found = false
  const walk = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const record = node as Record<string, unknown>
    if (record["class"] === "WINDOW") {
      found = true
      return
    }
    if (record["over"] !== undefined && record["over"] !== null) {
      found = true
      return
    }
    for (const value of Object.values(record)) walk(value)
  }
  walk(tree)
  return found
}

export interface WindowRisk {
  readonly model: string
  readonly batchSize: number
  readonly interval: string
}

/**
 * The model renders a window function over a range that may be wider than its
 * declared interval. Reported on the DECLARATION rather than on the occasion:
 * a steady tick with one missing interval renders one interval and looks fine,
 * but the model is already configured so that the next backfill will widen it.
 * Warning at the moment the risk is introduced is the whole point.
 */
export const windowRiskOf = (model: AnyModel, canonicalAst: string | null): WindowRisk | null => {
  if (model.kind._tag !== "incrementalByTimeRange") return null
  if (model.kind.batchSize <= 1) return null
  if (canonicalAst === null || !hasWindowFunction(canonicalAst)) return null
  return {
    model: model.name.full,
    batchSize: model.kind.batchSize,
    interval: model.kind.interval,
  }
}

export const windowRiskMessage = (risk: WindowRisk): string =>
  `model «${risk.model}» renders a window function over the whole batch, and batchSize is ${risk.batchSize}: ` +
  `a backfill renders one [start, end) per BATCH, so the frame spans up to ${risk.batchSize} ${risk.interval}(s) ` +
  `while catching up and one on the steady tick — same model, same data, different result. ` +
  `Set batchSize: 1 if the result depends on the width of that window.`
