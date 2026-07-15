import { Context, Data, Effect } from "effect"

export class EngineError extends Data.TaggedError("EngineError")<{
  readonly sql: string
  readonly cause: unknown
}> {}

export interface EngineColumn {
  readonly name: string
  readonly type: string
}

/**
 * Адаптер движка (SPEC §9.1). Минимальная поверхность: DDL-помощники
 * живут отдельно (executor) и ходят через execute — адаптеру незачем
 * знать про физический/виртуальный слой.
 */
export interface Engine {
  readonly dialect: "duckdb"
  readonly query: (
    sql: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, EngineError>
  readonly execute: (sql: string) => Effect.Effect<void, EngineError>
  /** Имена и типы колонок запроса без его выполнения (контракт схемы, SPEC §3.2). */
  readonly describe: (sql: string) => Effect.Effect<ReadonlyArray<EngineColumn>, EngineError>
}

export class EngineAdapter extends Context.Service<EngineAdapter, Engine>()(
  "efmesh/EngineAdapter",
) {}
