import { DuckDBInstance } from "@duckdb/node-api"
import { Effect, Layer } from "effect"
import type { Engine, EngineColumn } from "./adapter.ts"
import { EngineAdapter, EngineError, SqlParseError } from "./adapter.ts"

/**
 * AST от json_serialize_sql содержит позиции токенов (query_location) —
 * единственное, чем отличаются одинаковые по смыслу, но по-разному
 * отформатированные запросы. Вычищаем — остаётся формат-инвариантное ядро.
 */
const stripLocations = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripLocations)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (key === "query_location") continue
      out[key] = stripLocations(inner)
    }
    return out
  }
  return value
}

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
        canonicalize: (sqlText) =>
          query(
            `SELECT json_serialize_sql('${sqlText.replaceAll(`'`, `''`)}') AS ast`,
          ).pipe(
            Effect.flatMap((rows) => {
              const ast = JSON.parse(String(rows[0]?.["ast"])) as {
                readonly error: boolean
                readonly error_message?: string
              }
              // ошибка парсинга приходит содержимым JSON, не исключением
              if (ast.error) {
                return new SqlParseError({
                  sql: sqlText,
                  message: ast.error_message ?? "parse error",
                })
              }
              return Effect.succeed(JSON.stringify(stripLocations(ast)))
            }),
          ),
      }
      return service
    }),
  )
