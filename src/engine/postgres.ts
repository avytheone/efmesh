import { SQL } from "bun"
import { Effect, Layer } from "effect"
import { parse } from "libpg-query"
import type { Engine, EngineColumn } from "./adapter.ts"
import { EngineAdapter, EngineError, SqlParseError } from "./adapter.ts"

/**
 * Postgres-адаптер (SPEC §9.1, F3) поверх встроенного клиента Bun (`Bun.SQL`):
 * пул соединений из коробки — транзакция закрепляется за одним соединением
 * через sql.begin, остальные запросы свободно распределяются по пулу,
 * что и даёт честный параллелизм бэкфилла (SPEC §5.3).
 *
 * Канонизация — libpg_query (WASM-сборка парсера самого Postgres, SPEC §9.2):
 * дерево разбора с вычищенными позициями токенов формат-инвариантно,
 * как и json_serialize_sql у DuckDB.
 */

/** Позиции токенов (location) — единственная формат-зависимость дерева libpg_query. */
const stripLocations = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripLocations)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (key === "location") continue
      out[key] = stripLocations(inner)
    }
    return out
  }
  return value
}

export interface PostgresEngineOptions {
  /** postgres://… или unix-сокет через ?host=/путь. */
  readonly url: string
  /** Размер пула соединений; по умолчанию 8. */
  readonly max?: number
}

export const PostgresEngineLive = (
  options: PostgresEngineOptions,
): Layer.Layer<EngineAdapter, EngineError> =>
  Layer.effect(
    EngineAdapter,
    Effect.gen(function* () {
      const sql = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new SQL({ url: options.url, max: options.max ?? 8 }),
          catch: (cause) => new EngineError({ sql: `<connect ${options.url}>`, cause }),
        }),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.ignore),
      )

      const query: Engine["query"] = (sqlText) =>
        Effect.tryPromise({
          try: async () => (await sql.unsafe(sqlText)) as ReadonlyArray<Record<string, unknown>>,
          catch: (cause) => new EngineError({ sql: sqlText, cause }),
        })

      const service: Engine = {
        dialect: "postgres",
        query,
        execute: (sqlText) => Effect.asVoid(query(sqlText)),
        transaction: (statements) =>
          Effect.tryPromise({
            try: () =>
              sql.begin(async (tx) => {
                for (const statement of statements) await tx.unsafe(statement)
              }),
            catch: (cause) => new EngineError({ sql: statements.join(";\n"), cause }),
          }).pipe(Effect.asVoid),
        // DESCRIBE у Postgres нет: временный view на одном соединении
        // (sql.begin) даёт имена и типы из каталога без выполнения запроса
        describe: (sqlText) =>
          Effect.tryPromise({
            try: () =>
              sql.begin(async (tx) => {
                await tx.unsafe(`CREATE TEMP VIEW __efmesh_describe AS ${sqlText}`)
                const rows = (await tx.unsafe(`
                  SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
                  FROM pg_attribute a
                  WHERE a.attrelid = '__efmesh_describe'::regclass
                    AND a.attnum > 0 AND NOT a.attisdropped
                  ORDER BY a.attnum
                `)) as ReadonlyArray<{ name: string; type: string }>
                await tx.unsafe(`DROP VIEW __efmesh_describe`)
                return rows
              }),
            catch: (cause) => new EngineError({ sql: sqlText, cause }),
          }).pipe(
            Effect.map((rows): ReadonlyArray<EngineColumn> =>
              rows.map((row) => ({ name: row.name, type: row.type })),
            ),
          ),
        canonicalize: (sqlText) => {
          // $start/$end канонического рендера — не синтаксис Postgres;
          // детерминированная замена на $1/$2 сохраняет стабильность fingerprint
          const parameterized = sqlText.replace(/\$start\b/g, "$1").replace(/\$end\b/g, "$2")
          return Effect.tryPromise({
            try: () => parse(parameterized),
            catch: (cause) =>
              new SqlParseError({
                sql: sqlText,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }).pipe(Effect.map((tree) => JSON.stringify(stripLocations(tree))))
        },
      }
      return service
    }),
  )
