import * as NodePath from "node:path"
import { Data, Effect } from "effect"
import type { AnyModel } from "./core/model.ts"

/**
 * Discovery моделей по glob (SPEC §12): файлы по маскам из конфига
 * импортируются, все экспорты-модели (defineModel/defineExternal/defineSeed/
 * defineSqlModel — у всех _tag: "Model") собираются в проект. Порядок —
 * детерминированный (сортировка путей), два разных определения с одним
 * именем — ошибка загрузки; один и тот же объект, реэкспортированный из
 * нескольких файлов, считается один раз.
 */

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly path: string
  readonly reason: string
}> {}

export class DiscoveryConflictError extends Data.TaggedError("DiscoveryConflictError")<{
  readonly name: string
  readonly files: ReadonlyArray<string>
}> {}

const isModel = (value: unknown): value is AnyModel =>
  typeof value === "object" &&
  value !== null &&
  (value as { _tag?: unknown })._tag === "Model" &&
  typeof (value as { name?: { full?: unknown } }).name?.full === "string"

const scanPattern = (pattern: string, root: string): Effect.Effect<ReadonlyArray<string>, DiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      const found: Array<string> = []
      for await (const file of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
        found.push(file)
      }
      return found
    },
    catch: (cause) => new DiscoveryError({ path: pattern, reason: String(cause) }),
  })

export const discoverModels = (
  patterns: string | ReadonlyArray<string>,
  root: string,
): Effect.Effect<ReadonlyArray<AnyModel>, DiscoveryError | DiscoveryConflictError> =>
  Effect.gen(function* () {
    const masks = typeof patterns === "string" ? [patterns] : patterns
    const files = new Set<string>()
    for (const mask of masks) {
      for (const file of yield* scanPattern(mask, root)) files.add(file)
    }

    const models: Array<AnyModel> = []
    const seen = new Set<AnyModel>()
    const owner = new Map<string, string>()
    for (const file of [...files].sort()) {
      const module = yield* Effect.tryPromise({
        try: () => import(file) as Promise<Record<string, unknown>>,
        catch: (cause) => new DiscoveryError({ path: file, reason: String(cause) }),
      })
      for (const value of Object.values(module)) {
        if (!isModel(value) || seen.has(value)) continue
        const relative = NodePath.relative(root, file)
        const already = owner.get(value.name.full)
        if (already !== undefined) {
          return yield* new DiscoveryConflictError({
            name: value.name.full,
            files: [already, relative],
          })
        }
        seen.add(value)
        owner.set(value.name.full, relative)
        models.push(value)
      }
    }
    return models
  })
