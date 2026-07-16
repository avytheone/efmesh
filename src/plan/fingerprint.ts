import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { SeedReadError } from "../core/errors.ts"
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

/** Часть kind, влияющая на данные. Для seed — хэш содержимого файла: правка данных = новая версия. */
const kindPayload = (
  model: { readonly name: { readonly full: string } },
  kind: ModelKind,
): Effect.Effect<unknown, SeedReadError> => {
  switch (kind._tag) {
    case "full":
    case "view":
    case "embedded":
      return Effect.succeed({ _tag: kind._tag })
    case "incrementalByTimeRange":
      return Effect.succeed({
        _tag: kind._tag,
        timeColumn: kind.timeColumn,
        interval: kind.interval,
      })
    case "incrementalByUniqueKey":
      return Effect.succeed({ _tag: kind._tag, key: kind.key })
    case "scdType2":
      return Effect.succeed({
        _tag: kind._tag,
        key: kind.key,
        validFrom: kind.validFrom,
        validTo: kind.validTo,
      })
    case "external":
      return Effect.succeed({ _tag: kind._tag, source: kind.source })
    case "seed":
      return Effect.try({
        try: () => ({
          _tag: kind._tag,
          file: kind.file,
          contentHash: sha256(readFileSync(kind.file, "utf8")),
        }),
        catch: (cause) =>
          new SeedReadError({ model: model.name.full, file: kind.file, cause }),
      })
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
): Effect.Effect<
  ReadonlyMap<string, ModelVersion>,
  EngineError | SqlParseError | SeedReadError,
  EngineAdapter
> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const versions = new Map<string, ModelVersion>()
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      // у external и seed нет SQL — версия определяется источником/файлом и схемой
      const ast =
        model.kind._tag === "external" || model.kind._tag === "seed"
          ? null
          : yield* engine.canonicalize(canonicalSql(graph, name))
      const parents = [...model.deps]
        .sort()
        .map((dep) => `${dep}=${versions.get(dep)!.fingerprint}`)
      const payload = JSON.stringify({
        ast,
        kind: yield* kindPayload(model, model.kind),
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
