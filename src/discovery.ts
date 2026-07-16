import * as NodePath from "node:path"
import { Data, Effect } from "effect"
import type { AnyModel } from "./core/model.ts"

/**
 * Model discovery by glob (SPEC §12): files matching the config's masks are
 * imported, and every model export (defineModel/defineExternal/defineSeed/
 * defineSqlModel — all tagged _tag: "Model") joins the project. Order is
 * deterministic (paths are sorted); two distinct definitions sharing a name
 * are a load error; the same object re-exported from several files counts
 * once.
 */

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly path: string
  readonly reason: string
}> {
  override get message(): string {
    return `model discovery at ${this.path}: ${this.reason}`
  }
}

export class DiscoveryConflictError extends Data.TaggedError("DiscoveryConflictError")<{
  readonly name: string
  readonly files: ReadonlyArray<string>
}> {
  override get message(): string {
    return `model «${this.name}» is defined in more than one place: ${this.files.join(", ")}`
  }
}

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
