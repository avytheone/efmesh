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
    /** postgres://… — движком становится Postgres (F3); path игнорируется. */
    readonly url?: string
    /** Размер пула соединений Postgres — параллелизм бэкфилла (SPEC §5.3). */
    readonly max?: number
  }
  readonly state?: {
    /** Путь к SQLite-файлу состояния; по умолчанию `efmesh.state.sqlite`. */
    readonly path?: string
    /** postgres://… — состояние в Postgres (схема efmesh_state, SPEC §6). */
    readonly url?: string
  }
  readonly lake?: {
    /** Корень parquet-озера (SPEC §3.3) — локальная директория или s3://…. */
    readonly path: string
  }
  /** DuckLake-каталог для target: "ducklake" (SPEC §14.5). DuckDB-only. */
  readonly ducklake?: {
    /** Путь к SQLite-файлу каталога DuckLake. */
    readonly catalog: string
    /** Куда DuckLake кладёт parquet-данные; по умолчанию — рядом с каталогом. */
    readonly dataPath?: string
  }
  /** ATTACH-базы по алиасам (SPEC §9.3): url + опции (`TYPE postgres` и т.п.). */
  readonly attach?: Readonly<Record<string, { readonly url: string; readonly options?: string }>>
}

export const defineConfig = (config: EfmeshConfig): EfmeshConfig => config
