import { readFileSync } from "node:fs"
import type { Schema } from "effect"
import type { Audit } from "./audit.ts"
import type { IntervalUnit } from "./interval.ts"
import { ModelDefinitionError } from "./errors.ts"
import type { BoundValue, IdentsValue, RefValue, SqlFragment } from "./sql.ts"
import { collectRefs, parseSqlText, sql, usesBounds } from "./sql.ts"

/** Materialization kind (SPEC §3.1). */
export type ModelKind =
  | { readonly _tag: "full" }
  | { readonly _tag: "view" }
  | {
      /** Inlined into consumers as a subquery, without materialization (SPEC §3.1). */
      readonly _tag: "embedded"
    }
  | {
      readonly _tag: "incrementalByTimeRange"
      /** Time column that intervals are sliced and reread by. */
      readonly timeColumn: string
      /** Point in time to backfill from (ISO UTC). */
      readonly start: string
      /** Interval grain. */
      readonly interval: IntervalUnit
      /** How many grain intervals a single DELETE+INSERT executes. */
      readonly batchSize: number
      /** How many of the most recent done intervals to recompute (late-arriving data). */
      readonly lookback: number
    }
  | { readonly _tag: "external"; readonly source: ExternalSource }
  | {
      readonly _tag: "seed"
      /** CSV/JSON file with the data; its contents feed into the fingerprint. */
      readonly file: string
      readonly format: "csv" | "json"
    }
  | {
      readonly _tag: "incrementalByUniqueKey"
      /** Logical upsert key; every apply reruns the query and replaces rows by key. */
      readonly key: ReadonlyArray<string>
    }
  | {
      /**
       * Slowly changing dimension, type 2 (SPEC §3.1): row version history.
       * Every apply compares the query against the currently open rows: rows
       * that changed or disappeared are closed (validTo = now), new versions
       * are inserted open (validTo IS NULL).
       */
      readonly _tag: "scdType2"
      readonly key: ReadonlyArray<string>
      /** Versioning columns — managed by efmesh: declared in the schema, absent from the query. */
      readonly validFrom: string
      readonly validTo: string
    }

/**
 * External source definition (SPEC §9.3): an engine table/ATTACH database,
 * or files by path/URL (`read_parquet`/`read_csv`/`read_json`, including
 * HTTPS — REST-JSON lands here too).
 */
export type ExternalSource =
  | { readonly _tag: "table"; readonly table: string }
  | {
      readonly _tag: "files"
      readonly path: string
      readonly format: "parquet" | "csv" | "json"
      readonly options?: ExternalFileOptions
    }

/**
 * Reader options for `external.files` — the two a partitioned lake cannot do
 * without. Both are omitted from the rendered call when unset, so a source
 * that does not ask for them keeps the fingerprint it already had.
 */
export interface ExternalFileOptions {
  /**
   * Reconcile partitions whose schemas differ additively: a column that only
   * newer files carry reads as NULL for the history instead of failing the
   * scan. The archiver appends columns; the reader must not care when.
   */
  readonly unionByName?: boolean
  /** Expose the `key=value` path segments of a hive layout as columns (partition pruning). */
  readonly hivePartitioning?: boolean
}

/** How much of a question a model's data can answer (#43); passthrough to the manifest. */
export type Answerable = "full" | "sampled" | "unobservable"

export interface IncrementalByTimeRangeOptions {
  readonly timeColumn: string
  readonly start: string
  readonly interval?: IntervalUnit
  readonly batchSize?: number
  readonly lookback?: number
}

export const kind = {
  full: (): ModelKind => ({ _tag: "full" }),
  view: (): ModelKind => ({ _tag: "view" }),
  embedded: (): ModelKind => ({ _tag: "embedded" }),
  incrementalByTimeRange: (options: IncrementalByTimeRangeOptions): ModelKind => ({
    _tag: "incrementalByTimeRange",
    timeColumn: options.timeColumn,
    start: options.start,
    interval: options.interval ?? "day",
    batchSize: options.batchSize ?? 30,
    lookback: options.lookback ?? 0,
  }),
  incrementalByUniqueKey: (options: { readonly key: ReadonlyArray<string> }): ModelKind => ({
    _tag: "incrementalByUniqueKey",
    key: options.key,
  }),
  scdType2: (options: {
    readonly key: ReadonlyArray<string>
    readonly validFrom?: string
    readonly validTo?: string
  }): ModelKind => ({
    _tag: "scdType2",
    key: options.key,
    validFrom: options.validFrom ?? "valid_from",
    validTo: options.validTo ?? "valid_to",
  }),
} as const

export const external = {
  table: (table: string): ExternalSource => ({ _tag: "table", table }),
  files: (
    path: string,
    format: "parquet" | "csv" | "json",
    options?: ExternalFileOptions,
  ): ExternalSource => ({
    _tag: "files",
    path,
    format,
    // absent, not `{}`: the fingerprint payload carries the source verbatim
    ...(options === undefined ? {} : { options }),
  }),
} as const

/** Model name: `<schema>.<table>`. */
const MODEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/

export interface ModelName {
  readonly full: string
  readonly schema: string
  readonly table: string
}

export const parseModelName = (raw: string): ModelName => {
  if (!MODEL_NAME.test(raw)) {
    throw new ModelDefinitionError({
      model: raw,
      reason: "model name must be of the form <schema>.<table> (latin letters, digits, _)",
    })
  }
  const [schema, table] = raw.split(".") as [string, string]
  return { full: raw, schema, table }
}

/**
 * Where to put the physical layer (SPEC §3.3): a native engine table,
 * lake parquet files (interval = partition, a view over read_parquet), or
 * a DuckLake catalog (SPEC §14.5: a table-per-fingerprint in an ATTACH
 * catalog — DuckLake's own snapshots and time travel come along for free,
 * but versioning stays ours).
 */
export type MaterializationTarget = "table" | "parquet" | "ducklake"

export interface ModelConfig<Fields extends Schema.Struct.Fields> {
  readonly name: string
  readonly kind: ModelKind
  readonly schema: Schema.Struct<Fields>
  readonly description?: string
  /**
   * How much of a question this model's data can answer (#41, #43) — passed
   * through into the manifest so a client reads the limits of trust along with
   * the data. Documentation, not physics: changing it does not re-fingerprint
   * the model or rebuild anything.
   */
  readonly answerable?: Answerable
  /** Human-readable limits that a schema cannot express ("observation starts on X"). */
  readonly caveats?: ReadonlyArray<string>
  /**
   * Columns a redacted environment must not materialize (#41). The physics of
   * such an environment is separate and these columns never exist in it — a
   * view-level mask protects nothing once a client reads the files directly.
   * Unlike `answerable`, this DOES change the fingerprint: it is different data.
   */
  readonly redact?: ReadonlyArray<Extract<keyof Fields, string>>
  /** Logical primary key; metadata only for now (unique audit — F2). */
  readonly grain?: ReadonlyArray<Extract<keyof Fields, string>>
  /** Materialization target; defaults to a native engine table. */
  readonly target?: MaterializationTarget
  /** Quality audits (SPEC §8); excluded from the fingerprint. */
  readonly audits?: ReadonlyArray<Audit>
  /**
   * Export outward (SPEC §9.3): after audits and promotion, the finished
   * result is shipped to an ATTACH database (`attach` — an alias from config).
   */
  readonly export?: { readonly attach: string; readonly table: string }
}

/** Rendering context for a model body. The body must be pure: all mutable state flows in from here. */
export interface ModelCtx {
  readonly sql: typeof sql
  readonly ref: (model: AnyModel) => RefValue
  readonly cols: <Fields extends Schema.Struct.Fields>(
    model: Model<Fields>,
    ...names: ReadonlyArray<Extract<keyof Fields, string>>
  ) => IdentsValue
  /**
   * Bounds of the interval being processed `[start, end)` — only for
   * incrementalByTimeRange. Substituted with literals at execution time;
   * rendered as placeholders in the canonical text (SPEC §3).
   */
  readonly start: BoundValue
  readonly end: BoundValue
}

export interface Model<Fields extends Schema.Struct.Fields = Schema.Struct.Fields> {
  readonly _tag: "Model"
  readonly name: ModelName
  readonly kind: ModelKind
  readonly schema: Schema.Struct<Fields>
  readonly description: string | undefined
  readonly answerable: Answerable | undefined
  readonly caveats: ReadonlyArray<string> | undefined
  readonly redact: ReadonlyArray<string>
  readonly grain: ReadonlyArray<string>
  readonly target: MaterializationTarget
  readonly audits: ReadonlyArray<Audit>
  /** Body, rendered into a fragment once at definition time. */
  readonly fragment: SqlFragment
  /** Names of the models the body references via `ctx.ref`. */
  readonly deps: ReadonlySet<string>
  /** The source models themselves, by name — schemas for fixture validation in testModel. */
  readonly refs: ReadonlyMap<string, AnyModel>
  readonly export?: { readonly attach: string; readonly table: string }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<any>

export const columnNames = (model: AnyModel): ReadonlyArray<string> =>
  Object.keys(model.schema.fields)

/**
 * Runtime shape checks for what the types already say (#51). Bun executes
 * TypeScript without checking it and the CLI loads the user's config by
 * `import()`, so a project with no `tsc` in the loop — an agent-authored config,
 * a plain `bunx efmesh` — reaches us with fields simply missing. Unchecked, an
 * absent one degrades into malformed SQL (`FROM undefined('…')`) and surfaces as
 * an engine catalog error naming neither the config nor the field. These refuse
 * at definition time instead, where the model is still in hand.
 */
const requireSchema = (name: ModelName, schema: unknown): void => {
  if (
    typeof schema !== "object" ||
    schema === null ||
    typeof (schema as { fields?: unknown }).fields !== "object"
  ) {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "schema is required and must be a Schema.Struct — it is the data-shape contract",
    })
  }
}

// The literal formats `external.files` accepts; the readers that render them
// live in plan/naming.ts (importing it here would close a cycle), so the type
// union on ExternalSource is what keeps the two aligned.
const FILE_FORMATS = new Set(["parquet", "csv", "json"])

const validateExternalSource = (name: ModelName, source: ExternalSource | undefined): void => {
  if (typeof source !== "object" || source === null) {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "source is required — external.table(…) or external.files(path, format)",
    })
  }
  if (source._tag === "table") {
    if (typeof source.table !== "string" || source.table.trim() === "") {
      throw new ModelDefinitionError({
        model: name.full,
        reason: "external.table(…) needs a non-empty table name",
      })
    }
    return
  }
  if (source._tag === "files") {
    if (typeof source.path !== "string" || source.path.trim() === "") {
      throw new ModelDefinitionError({
        model: name.full,
        reason: "external.files(…) needs a non-empty path or URL",
      })
    }
    if (!FILE_FORMATS.has(source.format as string)) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `external.files(«${source.path}», …) needs a format — one of ${[...FILE_FORMATS].join(", ")}; got ${String(source.format)}`,
      })
    }
    if (source.options !== undefined) {
      for (const flag of ["unionByName", "hivePartitioning"] as const) {
        const value = source.options[flag]
        if (value !== undefined && typeof value !== "boolean") {
          throw new ModelDefinitionError({
            model: name.full,
            reason: `external.files(«${source.path}», …) option «${flag}» must be a boolean; got ${String(value)}`,
          })
        }
      }
    }
    return
  }
  throw new ModelDefinitionError({
    model: name.full,
    reason: `unknown external source «${String((source as { _tag?: unknown })._tag)}» — use external.table(…) or external.files(…)`,
  })
}

/** Shared model-kind config checks — for defineModel and defineSqlModel. */
const validateKindConfig = <Fields extends Schema.Struct.Fields>(
  name: ModelName,
  config: ModelConfig<Fields>,
): void => {
  requireSchema(name, config.schema)
  if (typeof config.kind !== "object" || config.kind === null) {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "kind is required — kind.full(), kind.incrementalByTimeRange({…}), …",
    })
  }
  if (config.kind._tag === "external") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "an external model has no body — use defineExternal",
    })
  }
  if (config.kind._tag === "seed") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "a seed model has no body — use defineSeed",
    })
  }
  if (config.kind._tag === "incrementalByUniqueKey" || config.kind._tag === "scdType2") {
    for (const keyColumn of config.kind.key) {
      if (!(keyColumn in config.schema.fields)) {
        throw new ModelDefinitionError({
          model: name.full,
          reason: `key column «${keyColumn}» is not in the model schema`,
        })
      }
    }
    if (config.kind.key.length === 0) {
      throw new ModelDefinitionError({ model: name.full, reason: "key cannot be empty" })
    }
  }
  if (config.kind._tag === "scdType2") {
    const { validFrom, validTo } = config.kind
    if (validFrom === validTo) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: "validFrom and validTo cannot be the same",
      })
    }
    for (const column of [validFrom, validTo]) {
      if (!(column in config.schema.fields)) {
        throw new ModelDefinitionError({
          model: name.full,
          reason: `versioning column «${column}» is not in the model schema — consumers must see it`,
        })
      }
      if (config.kind.key.includes(column)) {
        throw new ModelDefinitionError({
          model: name.full,
          reason: `versioning column «${column}» cannot be part of key`,
        })
      }
    }
    if (config.target === "parquet") {
      throw new ModelDefinitionError({
        model: name.full,
        reason: "scdType2 closes rows in place — a parquet target is not applicable",
      })
    }
  }
  if (
    (config.kind._tag === "view" || config.kind._tag === "embedded") &&
    config.target !== undefined &&
    config.target !== "table"
  ) {
    throw new ModelDefinitionError({
      model: name.full,
      reason: `${config.kind._tag} is not materialized — target «${config.target}» is not applicable to it`,
    })
  }
  if (config.kind._tag === "incrementalByUniqueKey" && config.target === "parquet") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: 'key upsert into parquet files is impossible — use target: "table"',
    })
  }
  if (config.kind._tag === "incrementalByTimeRange") {
    if (!(config.kind.timeColumn in config.schema.fields)) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `timeColumn «${config.kind.timeColumn}» is not in the model schema`,
      })
    }
    if (Number.isNaN(Date.parse(config.kind.start))) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `start «${config.kind.start}» is not an ISO time`,
      })
    }
  }
}

/** Final assembly of a model from a fragment — shared body invariants. */
const assembleModel = <Fields extends Schema.Struct.Fields>(
  name: ModelName,
  config: ModelConfig<Fields>,
  fragment: SqlFragment,
  refs: ReadonlyMap<string, AnyModel>,
): Model<Fields> => {
  if (usesBounds(fragment) && config.kind._tag !== "incrementalByTimeRange") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: `ctx.start/ctx.end are available only in incrementalByTimeRange, model kind is ${config.kind._tag}`,
    })
  }
  const deps = collectRefs(fragment)
  if (deps.has(name.full)) {
    throw new ModelDefinitionError({ model: name.full, reason: "model references itself" })
  }
  return {
    _tag: "Model",
    name,
    kind: config.kind,
    schema: config.schema,
    description: config.description,
    answerable: config.answerable,
    caveats: config.caveats,
    redact: config.redact ?? [],
    grain: config.grain ?? [],
    target: config.target ?? "table",
    audits: config.audits ?? [],
    fragment,
    deps,
    refs,
    ...(config.export !== undefined ? { export: config.export } : {}),
  }
}

/**
 * Defines a model. Called at module top level; the body runs exactly once,
 * immediately, so references (`ctx.ref`) are known statically and the DAG
 * is built without parsing SQL.
 */
export const defineModel = <const Fields extends Schema.Struct.Fields>(
  config: ModelConfig<Fields>,
  body: (ctx: ModelCtx) => SqlFragment,
): Model<Fields> => {
  const name = parseModelName(config.name)
  validateKindConfig(name, config)
  const refs = new Map<string, AnyModel>()
  const ctx: ModelCtx = {
    sql,
    ref: (model) => {
      refs.set(model.name.full, model)
      return { _tag: "RefValue", modelName: model.name.full }
    },
    cols: (model, ...names) => {
      const known = new Set(Object.keys(model.schema.fields))
      for (const column of names) {
        if (!known.has(column)) {
          // unreachable under honest typing; guards against `as any`
          throw new ModelDefinitionError({
            model: config.name,
            reason: `column «${column}» is not in the schema of model ${model.name.full}`,
          })
        }
      }
      return { _tag: "IdentsValue", names }
    },
    start: { _tag: "BoundValue", which: "start" },
    end: { _tag: "BoundValue", which: "end" },
  }
  return assembleModel(name, config, body(ctx), refs)
}

export interface SqlModelConfig<Fields extends Schema.Struct.Fields> extends ModelConfig<Fields> {
  /** Path to the .sql body file: `@ref(schema.table)`, `@start`, `@end`. */
  readonly file: string
  /**
   * Models the SQL text references via `@ref` — passed by value, so the
   * DAG and testModel work the same way as for ordinary models.
   */
  readonly refs?: ReadonlyArray<AnyModel>
}

/**
 * Model from a raw .sql file (SPEC §14.1) — for migrating existing
 * dbt/sqlmesh projects. Reference typing is lost (an honest price to pay):
 * every `@ref` in the text must be declared in `refs`, and extra
 * declarations are an error.
 */
export const defineSqlModel = <const Fields extends Schema.Struct.Fields>(
  config: SqlModelConfig<Fields>,
): Model<Fields> => {
  const name = parseModelName(config.name)
  validateKindConfig(name, config)
  let text: string
  try {
    text = readFileSync(config.file, "utf8")
  } catch (cause) {
    throw new ModelDefinitionError({
      model: name.full,
      reason: `could not read ${config.file}: ${String(cause)}`,
    })
  }
  const fragment = parseSqlText(text)
  const declared = new Map((config.refs ?? []).map((model) => [model.name.full, model]))
  const used = collectRefs(fragment)
  for (const ref of used) {
    if (!declared.has(ref)) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `@ref(${ref}) in ${config.file} is not declared in refs`,
      })
    }
  }
  for (const declaredName of declared.keys()) {
    if (!used.has(declaredName)) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `model ${declaredName} is declared in refs but @ref in ${config.file} does not use it`,
      })
    }
  }
  return assembleModel(name, config, fragment, declared)
}

export interface ExternalConfig<Fields extends Schema.Struct.Fields> {
  readonly name: string
  readonly source: ExternalSource
  readonly schema: Schema.Struct<Fields>
  readonly description?: string
  /** Passthrough to the manifest of anything downstream (#41, #43). */
  readonly answerable?: Answerable
  readonly caveats?: ReadonlyArray<string>
}

/**
 * External source (SPEC §3.1, §9.3): not materialized, but participates
 * in the DAG and lineage, and declares a schema. Only the source's
 * *definition* feeds into the fingerprint — the contents change between
 * runs, which is normal for raw data.
 */
export const defineExternal = <const Fields extends Schema.Struct.Fields>(
  config: ExternalConfig<Fields>,
): Model<Fields> => {
  const name = parseModelName(config.name)
  requireSchema(name, config.schema)
  validateExternalSource(name, config.source)
  return {
    _tag: "Model",
    name,
    kind: { _tag: "external", source: config.source },
    schema: config.schema,
    description: config.description,
    answerable: config.answerable,
    caveats: config.caveats,
    // external is not ours to materialize and a seed is reference data: neither
    // has physics we could redact
    redact: [],
    grain: [],
    target: "table", // not materialized — field is unused
    audits: [],
    fragment: { _tag: "SqlFragment", nodes: [] },
    deps: new Set(),
    refs: new Map(),
  }
}

export interface SeedConfig<Fields extends Schema.Struct.Fields> {
  readonly name: string
  /** Path to the CSV/JSON file; format inferred from the extension or given explicitly. */
  readonly file: string
  readonly format?: "csv" | "json"
  readonly schema: Schema.Struct<Fields>
  readonly description?: string
  /** Passthrough to the manifest of anything downstream (#41, #43). */
  readonly answerable?: Answerable
  readonly caveats?: ReadonlyArray<string>
  readonly audits?: ReadonlyArray<Audit>
}

/**
 * Seed (SPEC §3.1): a reference table from a file. Unlike external, the
 * file's contents feed into the fingerprint — editing the data means a new
 * version and a rebuild; shape is checked by the schema contract at build time.
 */
export const defineSeed = <const Fields extends Schema.Struct.Fields>(
  config: SeedConfig<Fields>,
): Model<Fields> => {
  const name = parseModelName(config.name)
  requireSchema(name, config.schema)
  if (typeof config.file !== "string" || config.file.trim() === "") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "file is required — the path to the seed's csv/json",
    })
  }
  if (config.format !== undefined && config.format !== "csv" && config.format !== "json") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: `format «${String(config.format)}» is not a seed format — csv or json`,
    })
  }
  const format = config.format ?? (config.file.endsWith(".json") ? "json" : "csv")
  return {
    _tag: "Model",
    name,
    kind: { _tag: "seed", file: config.file, format },
    schema: config.schema,
    description: config.description,
    answerable: config.answerable,
    caveats: config.caveats,
    // external is not ours to materialize and a seed is reference data: neither
    // has physics we could redact
    redact: [],
    grain: [],
    target: "table",
    audits: config.audits ?? [],
    fragment: { _tag: "SqlFragment", nodes: [] },
    deps: new Set(),
    refs: new Map(),
  }
}
