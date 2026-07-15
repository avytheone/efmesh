import { DuckDBInstance } from "@duckdb/node-api"
import { Effect, Layer } from "effect"
import type { Engine, EngineColumn } from "./adapter.ts"
import { EngineAdapter, EngineError } from "./adapter.ts"

export interface DuckDBEngineOptions {
  /** Путь к файлу базы; по умолчанию in-memory. */
  readonly path?: string
}

export const DuckDBEngineLive = (
  options?: DuckDBEngineOptions,
): Layer.Layer<EngineAdapter, EngineError> =>
  Layer.effect(
    EngineAdapter,
    Effect.gen(function* () {
      const path = options?.path ?? ":memory:"
      const { connection } = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const instance = await DuckDBInstance.create(path)
            const connection = await instance.connect()
            return { instance, connection }
          },
          catch: (cause) => new EngineError({ sql: `<connect ${path}>`, cause }),
        }),
        ({ connection, instance }) =>
          Effect.sync(() => {
            connection.closeSync()
            instance.closeSync()
          }),
      )

      const run = (sqlText: string) =>
        Effect.tryPromise({
          try: () => connection.run(sqlText),
          catch: (cause) => new EngineError({ sql: sqlText, cause }),
        })

      const query: Engine["query"] = (sqlText) =>
        run(sqlText).pipe(
          Effect.flatMap((result) =>
            Effect.tryPromise({
              try: () => result.getRowObjects(),
              catch: (cause) => new EngineError({ sql: sqlText, cause }),
            }),
          ),
        )

      const service: Engine = {
        dialect: "duckdb",
        query,
        execute: (sqlText) => Effect.asVoid(run(sqlText)),
        describe: (sqlText) =>
          query(`DESCRIBE (${sqlText})`).pipe(
            Effect.map((rows): ReadonlyArray<EngineColumn> =>
              rows.map((row) => ({
                name: String(row["column_name"]),
                type: String(row["column_type"]),
              })),
            ),
          ),
      }
      return service
    }),
  )
