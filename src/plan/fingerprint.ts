import type { ModelGraph } from "../core/graph.ts"
import { columnNames } from "../core/model.ts"
import { render } from "../core/sql.ts"

/**
 * Fingerprint снапшота (SPEC §4), F0-вариант: хэш от canonical-рендера SQL
 * (ссылки — логические имена), вида, grain, списка колонок и fingerprint'ов
 * прямых зависимостей. Канонизация через AST движка — F1; пока
 * переформатирование текста запроса честно считается изменением.
 */

const sha256 = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input)
  return hasher.digest("hex")
}

/** Canonical-рендер: ссылки резолвятся в логические имена моделей. */
export const canonicalSql = (graph: ModelGraph, name: string): string => {
  const model = graph.models.get(name)
  if (model === undefined) throw new Error(`модели ${name} нет в графе`)
  return render(model.fragment, { resolveRef: (ref) => ref })
}

/** Fingerprint всех моделей графа; транзитивность — через хэши родителей. */
export const fingerprintGraph = (graph: ModelGraph): ReadonlyMap<string, string> => {
  const fingerprints = new Map<string, string>()
  for (const name of graph.order) {
    const model = graph.models.get(name)!
    const parents = [...model.deps].sort().map((dep) => `${dep}=${fingerprints.get(dep)!}`)
    const payload = JSON.stringify({
      sql: canonicalSql(graph, name),
      kind: model.kind._tag,
      grain: model.grain,
      columns: columnNames(model),
      parents,
    })
    fingerprints.set(name, sha256(payload))
  }
  return fingerprints
}
