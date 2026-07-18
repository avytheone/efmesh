import type { AnyModel } from "./core/model.ts"

/**
 * Project config — `efmesh.config.ts` (SPEC §11): a typed TS module, no
 * YAML. The CLI imports it and assembles the engine and state layers.
 */
export interface EfmeshConfig {
  /** Models by value; can be combined with discovery — a duplicate name is an error. */
  readonly models?: ReadonlyArray<AnyModel>
  /**
   * Glob masks for model files, relative to the config (SPEC §12):
   * every model export found in matched files joins the project.
   */
  readonly discovery?: string | ReadonlyArray<string>
  readonly engine?: {
    /** Path to the DuckDB file; defaults to `efmesh.duckdb` next to the config. */
    readonly path?: string
    /** postgres://… — switches the engine to Postgres (F3); path is ignored. */
    readonly url?: string
    /** Postgres connection pool size — backfill parallelism (SPEC §5.3). */
    readonly max?: number
  }
  readonly state?: {
    /** Path to the SQLite state file; defaults to `efmesh.state.sqlite`. */
    readonly path?: string
    /** postgres://… — state lives in Postgres (schema efmesh_state, SPEC §6). */
    readonly url?: string
  }
  readonly lake?: {
    /** Root of the parquet lake (SPEC §3.3) — a local directory or s3://…. */
    readonly path: string
  }
  /** DuckLake catalog for target: "ducklake" (SPEC §14.5). DuckDB-only. */
  readonly ducklake?: {
    /** Path to the DuckLake catalog's SQLite file. */
    readonly catalog: string
    /** Where DuckLake writes parquet data; defaults to next to the catalog. */
    readonly dataPath?: string
  }
  /** ATTACH databases by alias (SPEC §9.3): url + options (`TYPE postgres` etc.). */
  readonly attach?: Readonly<Record<string, { readonly url: string; readonly options?: string }>>
  /**
   * Per-environment settings (#41). `redacted` environments materialize their
   * own physics with every model's `redact` columns absent — a view mask is no
   * boundary once clients read the files. Safe defaults, not access control:
   * see SPEC §3.4 for the threat model.
   */
  readonly environments?: Readonly<Record<string, { readonly redacted?: boolean }>>
}

export const defineConfig = (config: EfmeshConfig): EfmeshConfig => config
