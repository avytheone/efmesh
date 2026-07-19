import { DuckDBInstance } from "@duckdb/node-api"
import { Effect, Layer, Semaphore } from "effect"
import type { Engine, EngineColumn } from "./adapter.ts"
import { EngineAdapter, EngineError, SqlParseError } from "./adapter.ts"
import { extension, identifier, literal, settingName, type EngineInit } from "./init.ts"

/**
 * The AST from json_serialize_sql contains token positions (query_location) —
 * the only thing that differs between semantically identical but differently
 * formatted queries. We strip it — leaving a format-invariant core.
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
  /** Path to the database file; by default in-memory. */
  readonly path?: string
  readonly init?: EngineInit
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

      // Capability declarations are applied before the service is exposed, so
      // canonicalization sees the same functions/settings as execution.
      for (const item of options?.init?.extensions ?? []) {
        const ext = extension(item)
        if (ext.install) yield* Effect.asVoid(run(`INSTALL ${ext.name}`))
        yield* Effect.asVoid(run(`LOAD ${ext.name}`))
      }
      for (const [name, value] of Object.entries(options?.init?.settings ?? {})) {
        yield* Effect.asVoid(run(`SET ${settingName(name)} = ${literal(value)}`))
      }
      for (const credential of options?.init?.credentials ?? []) {
        const name = identifier(credential.name, "credential name")
        const fields = [
          `TYPE ${identifier(credential.type, "credential type")}`,
          ...(credential.provider !== undefined
            ? [`PROVIDER ${identifier(credential.provider, "credential provider")}`]
            : []),
          ...(credential.scope !== undefined ? [`SCOPE ${literal(credential.scope)}`] : []),
          ...Object.entries(credential.values).map(
            ([key, value]) => `${identifier(key, "credential field")} ${literal(value)}`,
          ),
        ]
        const statement = `CREATE OR REPLACE SECRET ${name} (${fields.join(", ")})`
        yield* Effect.tryPromise({
          try: () => connection.run(statement),
          // Neither the statement nor the driver's cause is allowed into the error channel.
          catch: () =>
            new EngineError({
              sql: `<credential ${name}>`,
              cause: "credential initialization failed (details redacted)",
            }),
        }).pipe(Effect.asVoid)
      }

      const query: Engine["query"] = (sqlText) =>
        run(sqlText).pipe(
          Effect.flatMap((result) =>
            Effect.tryPromise({
              try: () => result.getRowObjects(),
              catch: (cause) => new EngineError({ sql: sqlText, cause }),
            }),
          ),
        )

      // single connection: parallel transactions are serialized by a semaphore
      // so fibers do not interleave each other's BEGIN/COMMIT
      const transactionLock = yield* Semaphore.make(1)

      const service: Engine = {
        dialect: "duckdb",
        query,
        execute: (sqlText) => Effect.asVoid(run(sqlText)),
        transaction: (statements) =>
          transactionLock.withPermits(1)(
            Effect.asVoid(run("BEGIN")).pipe(
              Effect.andThen(
                Effect.forEach(statements, (statement) => run(statement), { discard: true }),
              ),
              Effect.andThen(Effect.asVoid(run("COMMIT"))),
              Effect.onError(() => Effect.asVoid(run("ROLLBACK")).pipe(Effect.ignore)),
            ),
          ),
        describe: (sqlText) =>
          query(`DESCRIBE (${sqlText})`).pipe(
            Effect.map(
              (rows): ReadonlyArray<EngineColumn> =>
                rows.map((row) => ({
                  name: String(row["column_name"]),
                  type: String(row["column_type"]),
                })),
            ),
          ),
        canonicalize: (sqlText) =>
          query(`SELECT json_serialize_sql('${sqlText.replaceAll(`'`, `''`)}') AS ast`).pipe(
            Effect.flatMap((rows) => {
              const ast = JSON.parse(String(rows[0]?.["ast"])) as {
                readonly error: boolean
                readonly error_message?: string
              }
              // a parse error arrives as JSON content, not as an exception
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
