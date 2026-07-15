import type { AnyModel } from "./core/model.ts"

/**
 * Конфиг проекта — `efmesh.config.ts` (SPEC §11): типизированный TS-модуль,
 * никакого YAML. CLI импортирует его и собирает слои движка и состояния.
 */
export interface EfmeshConfig {
  readonly models: ReadonlyArray<AnyModel>
  readonly engine?: {
    /** Путь к файлу DuckDB; по умолчанию `efmesh.duckdb` рядом с конфигом. */
    readonly path?: string
  }
  readonly state?: {
    /** Путь к SQLite-файлу состояния; по умолчанию `efmesh.state.sqlite`. */
    readonly path?: string
  }
  readonly lake?: {
    /** Корень parquet-озера (SPEC §3.3) — локальная директория или s3://…. */
    readonly path: string
  }
}

export const defineConfig = (config: EfmeshConfig): EfmeshConfig => config
