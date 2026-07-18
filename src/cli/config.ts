import * as NodePath from "node:path"
import { Data, Effect, Layer } from "effect"
import type { EfmeshConfig } from "../config.ts"
import type { ModelDefinitionError } from "../core/errors.ts"
import type { AnyModel } from "../core/model.ts"
import { discoverModels, type DiscoveryError, DiscoveryConflictError } from "../discovery.ts"
import { DuckDBEngineLive } from "../engine/duckdb.ts"
import { PostgresEngineLive } from "../engine/postgres.ts"
import { PostgresStateLive } from "../state/postgres.ts"
import { SqliteStateLive } from "../state/sqlite.ts"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly reason: string
}> {
  override get message(): string {
    return `config ${this.path}: ${this.reason}`
  }
}

/** Config with an already-assembled model list: explicit ones + discovery finds. */
export type LoadedConfig = EfmeshConfig & { readonly models: ReadonlyArray<AnyModel> }

/**
 * Definition-time refusals (#52) travel up as themselves. Importing the config
 * executes the user's model definitions, so `define*` throwing lands in the same
 * catch as an unresolvable path — and wrapping it in ConfigLoadError attaches
 * advice about `--config` and the default export to a config whose path and
 * export are both fine. Matched by `_tag` rather than `instanceof`: a project
 * may resolve a different copy of the package than the CLI is running from.
 */
const definitionError = (cause: unknown): ModelDefinitionError | undefined => {
  const tag = (cause as { _tag?: unknown } | null)?._tag
  return tag === "ModelDefinitionError" ? (cause as ModelDefinitionError) : undefined
}

export const loadConfig = (
  configPath: string,
): Effect.Effect<
  LoadedConfig,
  ConfigLoadError | ModelDefinitionError | DiscoveryError | DiscoveryConflictError
> =>
  Effect.gen(function* () {
    const absolute = NodePath.resolve(process.cwd(), configPath)
    const config = yield* Effect.tryPromise({
      try: async () => {
        const module = (await import(absolute)) as { default?: EfmeshConfig }
        if (
          module.default === undefined ||
          (!Array.isArray(module.default.models) && module.default.discovery === undefined)
        ) {
          throw new Error("config must export a default with models and/or discovery")
        }
        return module.default
      },
      catch: (cause) =>
        definitionError(cause) ?? new ConfigLoadError({ path: configPath, reason: String(cause) }),
    })
    const explicit = config.models ?? []
    if (config.discovery === undefined) return { ...config, models: explicit }
    // globs are relative to the config: the project is portable regardless of cwd
    const discovered = yield* discoverModels(config.discovery, NodePath.dirname(absolute))
    const seen = new Set(explicit)
    const names = new Map(explicit.map((model) => [model.name.full, "config models"]))
    const merged = [...explicit]
    for (const model of discovered) {
      if (seen.has(model)) continue
      const already = names.get(model.name.full)
      if (already !== undefined) {
        return yield* new DiscoveryConflictError({
          name: model.name.full,
          files: [already, "discovery"],
        })
      }
      names.set(model.name.full, "discovery")
      merged.push(model)
    }
    return { ...config, models: merged }
  })

/** Engine and state layers from the config — shared by plan/apply. */
export const configLayers = (config: EfmeshConfig) =>
  Layer.mergeAll(
    config.engine?.url !== undefined
      ? PostgresEngineLive({
          url: config.engine.url,
          ...(config.engine.max !== undefined ? { max: config.engine.max } : {}),
        })
      : DuckDBEngineLive({ path: config.engine?.path ?? "efmesh.duckdb" }),
    config.state?.url !== undefined
      ? PostgresStateLive({ url: config.state.url })
      : SqliteStateLive({ path: config.state?.path ?? "efmesh.state.sqlite" }),
  )
