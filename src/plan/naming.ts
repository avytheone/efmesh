import type { ExternalSource, ModelName } from "../core/model.ts"

/**
 * Object layout in the engine (SPEC §2):
 * - physical: schema `_efmesh`, table `<schema>__<table>__<fp8>`;
 * - virtual: prod lives in the models' native schemas (`med.stays`),
 *   other environments — in prefixed ones (`dev__med.stays`).
 *
 * The schema is `_efmesh`, not `efmesh`, precisely because: DuckDB names the
 * catalog after the database file name, and for `efmesh.duckdb` the reference
 * `efmesh.x` becomes ambiguous (catalog or schema) — a Binder Error.
 */

export const PROD_ENV = "prod"

const ENV_NAME = /^[a-z][a-z0-9_]*$/

export const validateEnvName = (env: string): boolean => ENV_NAME.test(env)

export const fp8 = (fingerprint: string): string => fingerprint.slice(0, 8)

export const physicalSchema = "_efmesh"

export const physicalTable = (name: ModelName, fingerprint: string): string =>
  `${name.schema}__${name.table}__${fp8(fingerprint)}`

export const physicalRef = (name: ModelName, fingerprint: string): string =>
  `"${physicalSchema}"."${physicalTable(name, fingerprint)}"`

export const envSchema = (env: string, modelSchema: string): string =>
  env === PROD_ENV ? modelSchema : `${env}__${modelSchema}`

/**
 * Parquet-lake layout (SPEC §3.3): `<lake>/<schema>/<table>/fp=<fp8>/…`,
 * for incremental inside — partitions `interval=<key>/data.parquet`.
 * Interval = partition: a recompute rewrites the partition's files, the
 * source of truth is the interval bookkeeping, so a non-atomic rewrite is harmless.
 */
export const parquetPrefix = (lakePath: string, name: ModelName, fingerprint: string): string =>
  `${parquetModelPrefix(lakePath, name)}/fp=${fp8(fingerprint)}`

/**
 * Everything a model owns in the lake, across versions — the `fp=` level and
 * below. Maintenance (#40) works from the directory tree rather than from the
 * store: what physically exists is the honest input, and janitor is what
 * removes the prefixes of dead versions.
 */
export const parquetModelPrefix = (lakePath: string, name: ModelName): string =>
  `${lakePath.replace(/\/+$/, "")}/${name.schema}/${name.table}`

/**
 * union_by_name: partitions of one prefix may differ in schema after
 * forward-only evolution (new columns appear only in new files — history is
 * read with NULL).
 */
export const parquetRef = (lakePath: string, name: ModelName, fingerprint: string): string =>
  `read_parquet('${parquetPrefix(lakePath, name, fingerprint).replaceAll(`'`, `''`)}/**/*.parquet', union_by_name=true)`

/**
 * DuckLake target (SPEC §14.5): the catalog is attached under a fixed alias,
 * the physical storage is a fingerprint table in it (the same name as native
 * physical storage, only a different catalog). Versioning stays ours;
 * DuckLake snapshots/time travel are a bonus. Consumers outside efmesh must
 * ATTACH it themselves — the environments' views reference the catalog by alias.
 */
export const ducklakeAlias = "_efmesh_ducklake"

export const ducklakeRef = (name: ModelName, fingerprint: string): string =>
  `"${ducklakeAlias}"."${physicalTable(name, fingerprint)}"`

export const ducklakeAttachSql = (config: {
  readonly catalog: string
  readonly dataPath?: string
}): string =>
  `ATTACH IF NOT EXISTS 'ducklake:sqlite:${config.catalog.replaceAll(`'`, `''`)}' AS "${ducklakeAlias}"${
    config.dataPath !== undefined ? ` (DATA_PATH '${config.dataPath.replaceAll(`'`, `''`)}')` : ""
  }`

/** Interval partition key — filesystem-safe (no colons). */
export const intervalKey = (unit: "day" | "hour", startMs: number): string => {
  const iso = new Date(startMs).toISOString()
  return unit === "day" ? iso.slice(0, 10) : `${iso.slice(0, 10)}T${iso.slice(11, 13)}`
}

const READERS = { parquet: "read_parquet", csv: "read_csv", json: "read_json" } as const

/**
 * What a reference to an external model renders to (SPEC §9.3): the table name
 * (of the engine or an ATTACH database) as is, files/URLs — via read_*.
 * external is not materialized, consumers read the source directly.
 */
export const externalSourceRef = (source: ExternalSource): string => {
  if (source._tag === "table") return source.table
  // an unset flag is not rendered as `= false`: the reader's own default stays
  // in force and sources defined before the options existed render unchanged
  const flags: Array<string> = []
  if (source.options?.unionByName !== undefined) {
    flags.push(`union_by_name = ${source.options.unionByName}`)
  }
  if (source.options?.hivePartitioning !== undefined) {
    flags.push(`hive_partitioning = ${source.options.hivePartitioning}`)
  }
  const args = [`'${source.path.replaceAll(`'`, `''`)}'`, ...flags].join(", ")
  return `${READERS[source.format]}(${args})`
}

export const viewRef = (env: string, name: ModelName): string =>
  `"${envSchema(env, name.schema)}"."${name.table}"`
