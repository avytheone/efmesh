import type { ModelName } from "../core/model.ts"

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

export const viewRef = (env: string, name: ModelName): string =>
  `"${envSchema(env, name.schema)}"."${name.table}"`
