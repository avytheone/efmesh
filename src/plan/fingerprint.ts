import { Effect } from "effect"
import type { ModelGraph } from "../core/graph.ts"
import type { ModelKind } from "../core/model.ts"
import { columnNames } from "../core/model.ts"
import { render } from "../core/sql.ts"
import type { EngineError, SqlParseError } from "../engine/adapter.ts"
import { EngineAdapter } from "../engine/adapter.ts"

/**
 * Fingerprint снапшота (SPEC §4): хэш канонизированного AST (родной парсер
 * движка, переформатирование запроса fingerprint не меняет), метаданных,
 * влияющих на данные, и fingerprint'ов прямых зависимостей (транзитивность).
 *
 * `batchSize`, `lookback`, `start` и `description` в fingerprint не входят:
 * они меняют исполнение или объём истории, но не форму данных — недостающие
 * интервалы учёт увидит сам.
 */

const sha256 = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input)
  return hasher.digest("hex")
}

/** Canonical-рендер: ссылки — логические имена, границы — плейсхолдеры $start/$end. */
export const canonicalSql = (graph: ModelGraph, name: string): string => {
  const model = graph.models.get(name)
  if (model === undefined) throw new Error(`модели ${name} нет в графе`)
  return render(model.fragment, { resolveRef: (ref) => ref })
}

/** Часть kind, влияющая на данные. */
const kindPayload = (kind: ModelKind): unknown => {
  switch (kind._tag) {
    case "full":
    case "view":
      return { _tag: kind._tag }
    case "incrementalByTimeRange":
      return { _tag: kind._tag, timeColumn: kind.timeColumn, interval: kind.interval }
    case "external":
      return { _tag: kind._tag, source: kind.source }
  }
}

export interface ModelVersion {
  readonly fingerprint: string
  /** Канонический AST тела; null у external. Хранится в снапшоте для категоризации (§5.2). */
  readonly ast: string | null
}

/** Fingerprint всех моделей графа; транзитивность — через хэши родителей. */
export const fingerprintGraph = (
  graph: ModelGraph,
): Effect.Effect<ReadonlyMap<string, ModelVersion>, EngineError | SqlParseError, EngineAdapter> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const versions = new Map<string, ModelVersion>()
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      // у external нет SQL — его версия определяется источником и схемой
      const ast =
        model.kind._tag === "external"
          ? null
          : yield* engine.canonicalize(canonicalSql(graph, name))
      const parents = [...model.deps]
        .sort()
        .map((dep) => `${dep}=${versions.get(dep)!.fingerprint}`)
      const payload = JSON.stringify({
        ast,
        kind: kindPayload(model.kind),
        grain: model.grain,
        columns: columnNames(model),
        // смена цели материализации = новая физика, потребители перечитают её
        target: model.target,
        parents,
      })
      versions.set(name, { fingerprint: sha256(payload), ast })
    }
    return versions
  })
