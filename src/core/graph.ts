import { Effect } from "effect"
import { DagCycleError, DuplicateModelError, UnknownDependencyError } from "./errors.ts"
import type { AnyModel } from "./model.ts"

export interface ModelGraph {
  readonly models: ReadonlyMap<string, AnyModel>
  /** Топологический порядок: родители раньше детей. */
  readonly order: ReadonlyArray<string>
  /** Прямые потомки: кто ссылается на данную модель. */
  readonly dependents: ReadonlyMap<string, ReadonlySet<string>>
}

export type GraphError = DuplicateModelError | UnknownDependencyError | DagCycleError

/** Собирает DAG из набора моделей: дубликаты, неизвестные зависимости, циклы — типизированные ошибки. */
export const buildGraph = (
  input: Iterable<AnyModel>,
): Effect.Effect<ModelGraph, GraphError> =>
  Effect.gen(function* () {
    const models = new Map<string, AnyModel>()
    for (const model of input) {
      if (models.has(model.name.full)) {
        return yield* new DuplicateModelError({ name: model.name.full })
      }
      models.set(model.name.full, model)
    }

    const dependents = new Map<string, Set<string>>()
    for (const name of models.keys()) dependents.set(name, new Set())
    for (const model of models.values()) {
      for (const dep of model.deps) {
        if (!models.has(dep)) {
          return yield* new UnknownDependencyError({ model: model.name.full, dependency: dep })
        }
        dependents.get(dep)!.add(model.name.full)
      }
    }

    // Кан: считаем входящие степени (число зависимостей), снимаем нулевые.
    const inDegree = new Map<string, number>()
    for (const [name, model] of models) inDegree.set(name, model.deps.size)
    // сортировка очереди — чтобы порядок был детерминированным между запусками
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n).sort()
    const order: Array<string> = []
    while (queue.length > 0) {
      const name = queue.shift()!
      order.push(name)
      for (const child of [...dependents.get(name)!].sort()) {
        const left = inDegree.get(child)! - 1
        inDegree.set(child, left)
        if (left === 0) queue.push(child)
      }
    }

    if (order.length !== models.size) {
      const cycle = [...models.keys()].filter((n) => !order.includes(n))
      return yield* new DagCycleError({ cycle })
    }

    return { models, order, dependents }
  })

/** Все транзитивные потомки модели (для breaking-каскада в плане). */
export const transitiveDependents = (graph: ModelGraph, name: string): ReadonlySet<string> => {
  const out = new Set<string>()
  const stack = [name]
  while (stack.length > 0) {
    for (const child of graph.dependents.get(stack.pop()!) ?? []) {
      if (!out.has(child)) {
        out.add(child)
        stack.push(child)
      }
    }
  }
  return out
}
