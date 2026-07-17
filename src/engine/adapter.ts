import { Context, Data, type Effect } from "effect"
import { causeText, sqlSnippet } from "../error-text.ts"

/**
 * The engine rejected a statement (SPEC §9.1). `cause` is the engine's own
 * error (DuckDB/Postgres) — never swallowed; `sql` is the statement that
 * failed; `model` names the culprit when the failure happened while building a
 * specific model (attached by the executor). The `message` is derived from all
 * three so an operator or agent sees what the engine said and where, not an
 * empty `EngineError:` (#13).
 */
export class EngineError extends Data.TaggedError("EngineError")<{
  readonly sql: string
  readonly cause: unknown
  /** The model being built when the engine failed, when known. */
  readonly model?: string
}> {
  override get message(): string {
    const where = this.model !== undefined ? `[model ${this.model}] ` : ""
    return `${where}${causeText(this.cause)} — while running SQL: ${sqlSnippet(this.sql)}`
  }
}

/** The engine could not parse the model's SQL (SPEC §9.2). */
export class SqlParseError extends Data.TaggedError("SqlParseError")<{
  readonly sql: string
  /** The engine parser's own message; also this error's rendered `message`. */
  readonly message: string
}> {}

export interface EngineColumn {
  readonly name: string
  readonly type: string
}

/**
 * Engine adapter (SPEC §9.1). A minimal surface: DDL helpers live separately
 * (executor) and go through execute — the adapter has no need to know about
 * the physical/virtual layer.
 */
export type Dialect = "duckdb" | "postgres"

export interface Engine {
  readonly dialect: Dialect
  readonly query: (
    sql: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, EngineError>
  readonly execute: (sql: string) => Effect.Effect<void, EngineError>
  /**
   * A set of statements in one engine transaction, rolled back on any error.
   * An adapter primitive rather than BEGIN/COMMIT via execute: on a connection
   * pool (Postgres) separate calls would scatter across different connections.
   */
  readonly transaction: (statements: ReadonlyArray<string>) => Effect.Effect<void, EngineError>
  /** Names and types of a query's columns without executing it (schema contract, SPEC §3.2). */
  readonly describe: (sql: string) => Effect.Effect<ReadonlyArray<EngineColumn>, EngineError>
  /**
   * The canonical form of a SELECT query for the fingerprint (SPEC §4, §9.2):
   * parsing by the engine's native parser, normalization, deterministic
   * serialization. Reformatting the text does not change the result.
   */
  readonly canonicalize: (sql: string) => Effect.Effect<string, EngineError | SqlParseError>
}

export class EngineAdapter extends Context.Service<EngineAdapter, Engine>()(
  "efmesh/EngineAdapter",
) {}
