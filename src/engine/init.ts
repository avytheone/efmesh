/**
 * Declarative engine preparation (#66). Deliberately not `string[]`: arbitrary
 * SQL would make macros invisible to fingerprints and would give credentials a
 * path through printable EngineError.sql.
 */
export interface EngineExtension {
  readonly name: string
  /** DuckDB only: install before loading. Defaults to true. */
  readonly install?: boolean
}

export type EngineSettingValue = string | number | boolean

export interface EngineSemanticInit {
  readonly extensions?: ReadonlyArray<string | EngineExtension>
  /** Session settings. Postgres sends these as startup parameters on every connection. */
  readonly settings?: Readonly<Record<string, EngineSettingValue>>
}

/** DuckDB CREATE SECRET, kept separate from semantic preparation at the type level. */
export interface DuckDBCredential {
  readonly name: string
  readonly type: string
  readonly provider?: string
  readonly scope?: string
  /** DuckDB secret fields such as KEY_ID, SECRET, REGION, or ENDPOINT. */
  readonly values: Readonly<Record<string, EngineSettingValue>>
}

export interface EngineInit extends EngineSemanticInit {
  readonly credentials?: ReadonlyArray<DuckDBCredential>
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const SETTING = /^[A-Za-z_][A-Za-z0-9_.]*$/

export const identifier = (value: string, kind: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`${kind} must be an identifier, got ${value}`)
  return value
}

export const settingName = (value: string): string => {
  if (!SETTING.test(value)) throw new Error(`setting must be a dotted identifier, got ${value}`)
  return value
}

export const literal = (value: EngineSettingValue): string =>
  typeof value === "string"
    ? `'${value.replaceAll("'", "''")}'`
    : typeof value === "boolean"
      ? value
        ? "true"
        : "false"
      : String(value)

export const extension = (value: string | EngineExtension): Required<EngineExtension> =>
  typeof value === "string"
    ? { name: identifier(value, "extension"), install: true }
    : { name: identifier(value.name, "extension"), install: value.install ?? true }
