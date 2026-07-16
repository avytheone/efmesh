import type { ExternalSource, ModelName } from "../core/model.ts"

/**
 * Раскладка объектов в движке (SPEC §2):
 * - физика: схема `_efmesh`, таблица `<схема>__<таблица>__<fp8>`;
 * - виртуалка: prod живёт в родных схемах моделей (`med.stays`),
 *   остальные окружения — в префиксованных (`dev__med.stays`).
 *
 * Схема именно `_efmesh`, не `efmesh`: DuckDB называет каталог по имени
 * файла базы, и для `efmesh.duckdb` ссылка `efmesh.x` становится
 * неоднозначной (каталог или схема) — Binder Error.
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
 * Раскладка parquet-озера (SPEC §3.3): `<lake>/<схема>/<таблица>/fp=<fp8>/…`,
 * у incremental внутри — партиции `interval=<ключ>/data.parquet`.
 * Интервал = партиция: пересчёт — перезапись файлов партиции, источник
 * правды — учёт интервалов, поэтому неатомарность перезаписи не страшна.
 */
export const parquetPrefix = (lakePath: string, name: ModelName, fingerprint: string): string =>
  `${lakePath.replace(/\/+$/, "")}/${name.schema}/${name.table}/fp=${fp8(fingerprint)}`

/**
 * union_by_name: партиции одного префикса могут отличаться схемой после
 * forward-only-эволюции (новые колонки появляются только в новых файлах —
 * история читается с NULL).
 */
export const parquetRef = (lakePath: string, name: ModelName, fingerprint: string): string =>
  `read_parquet('${parquetPrefix(lakePath, name, fingerprint).replaceAll(`'`, `''`)}/**/*.parquet', union_by_name=true)`

/** Ключ партиции интервала — безопасен для файловых систем (без двоеточий). */
export const intervalKey = (unit: "day" | "hour", startMs: number): string => {
  const iso = new Date(startMs).toISOString()
  return unit === "day" ? iso.slice(0, 10) : `${iso.slice(0, 10)}T${iso.slice(11, 13)}`
}

const READERS = { parquet: "read_parquet", csv: "read_csv", json: "read_json" } as const

/**
 * Во что рендерится ссылка на external-модель (SPEC §9.3): имя таблицы
 * (движка или ATTACH-базы) как есть, файлы/URL — через read_*.
 * external не материализуется, потребители читают источник напрямую.
 */
export const externalSourceRef = (source: ExternalSource): string =>
  source._tag === "table"
    ? source.table
    : `${READERS[source.format]}('${source.path.replaceAll(`'`, `''`)}')`

export const viewRef = (env: string, name: ModelName): string =>
  `"${envSchema(env, name.schema)}"."${name.table}"`
