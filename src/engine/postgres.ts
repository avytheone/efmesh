import { SQL } from "bun"
import { Effect, Layer } from "effect"
import { parse } from "libpg-query"
import type { Engine, EngineColumn } from "./adapter.ts"
import { EngineAdapter, EngineError, SqlParseError } from "./adapter.ts"

/**
 * Postgres adapter (SPEC §9.1, F3) over Bun's built-in client (`Bun.SQL`):
 * a connection pool out of the box — a transaction is pinned to a single
 * connection via sql.begin, the rest of the queries are distributed freely
 * across the pool, which is what gives honest backfill parallelism (SPEC §5.3).
 *
 * Canonicalization — libpg_query (a WASM build of Postgres's own parser, SPEC
 * §9.2): the parse tree with token positions stripped is format-invariant,
 * just like DuckDB's json_serialize_sql.
 */

/** Token positions (location) — the only format-dependency of the libpg_query tree. */
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

/**
 * Postgres-SQL canonicalization is pure (libpg_query, no server needed);
 * lifted out of the Layer so golden tests can freeze the canon independently
 * of the pool (SPEC §4: canonicalization = the fingerprint contract).
 */
export const canonicalizePostgresSql = (sqlText: string): Effect.Effect<string, SqlParseError> => {
  // $start/$end of the canonical render are not Postgres syntax;
  // a deterministic replacement with $1/$2 keeps the fingerprint stable
  const parameterized = sqlText.replace(/\$start\b/g, "$1").replace(/\$end\b/g, "$2")
  return Effect.tryPromise({
    try: () => parse(parameterized),
    catch: (cause) =>
      new SqlParseError({
        sql: sqlText,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(Effect.map((tree) => JSON.stringify(stripLocations(tree))))
}

export interface PostgresEngineOptions {
  /** postgres://… or a unix socket via ?host=/path. */
  readonly url: string
  /** Connection pool size; by default 8. */
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
        // Postgres has no DESCRIBE: a temporary view on a single connection
        // (sql.begin) gives names and types from the catalog without running the query
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
            Effect.map(
              (rows): ReadonlyArray<EngineColumn> =>
                rows.map((row) => ({ name: row.name, type: row.type })),
            ),
          ),
        canonicalize: canonicalizePostgresSql,
      }
      return service
    }),
  )
