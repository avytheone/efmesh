import { Schema } from "effect"
import type { ModelGraph } from "../core/graph.ts"
import { columnNames, type AnyModel } from "../core/model.ts"
import type { SqlFragment } from "../core/sql.ts"
import { quoteIdent } from "../core/sql.ts"

/**
 * Redacted materialization (#41).
 *
 * A view-level mask protects nothing the moment a client reads the physical
 * files — and the manifest exists precisely so clients can. So a redacted
 * environment does not hide columns: it points at DIFFERENT PHYSICS in which
 * the redacted columns were never written.
 *
 * The mechanism falls out of what efmesh already does. Redaction rewrites the
 * model's body as a projection of the surviving declared columns and drops the
 * redacted ones from its schema. That changes the canonical AST, which changes
 * the fingerprint, which by construction means a separate physical table and a
 * separate lake prefix. No new concept is introduced, and none of the existing
 * guarantees have to be re-proved for it.
 *
 * The projection lists columns explicitly rather than using DuckDB's
 * `SELECT * EXCLUDE`: the declared schema already knows every column, and an
 * explicit list is the one form both engines accept.
 *
 * THREAT MODEL, stated plainly and repeated in the docs: a redacted environment
 * is *safe defaults* — agents and dev environments see clean data unless
 * someone deliberately points them elsewhere. It is NOT access control on the
 * physical storage. Anyone who can read the unredacted environment's files can
 * read the unredacted data; that boundary is the storage's job (bucket policy,
 * filesystem permissions), not this feature's.
 */

/** Wraps a body in a projection of the columns that survive redaction. */
const projectionOf = (model: AnyModel, keep: ReadonlyArray<string>): SqlFragment => ({
  _tag: "SqlFragment",
  nodes: [
    { _tag: "Text", text: `SELECT ${keep.map(quoteIdent).join(", ")} FROM (` },
    ...model.fragment.nodes,
    { _tag: "Text", text: ") efmesh_redacted" },
  ],
})

/**
 * The model as a redacted environment materializes it. Returns the model
 * unchanged when it declares no policy — most models do not, and an untouched
 * model must keep its fingerprint so redacted and plain environments still
 * share the physics of everything that is not sensitive.
 */
export const redactModel = (model: AnyModel): AnyModel => {
  if (model.redact.length === 0) return model
  const redacted = new Set(model.redact)
  const keep = columnNames(model).filter((column) => !redacted.has(column))
  const fields = Object.fromEntries(
    Object.entries(model.schema.fields).filter(([name]) => !redacted.has(name)),
  ) as Schema.Struct.Fields
  return {
    ...model,
    schema: Schema.Struct(fields) as AnyModel["schema"],
    grain: model.grain.filter((column) => !redacted.has(column)),
    // an audit may reference a column that no longer exists here
    audits: model.audits.filter(
      (entry) => !model.redact.some((column) => entry.name.includes(column)),
    ),
    fragment: projectionOf(model, keep),
  }
}

/** Every model of the graph as a redacted environment materializes it. */
export const redactGraph = (graph: ModelGraph): ModelGraph => ({
  ...graph,
  models: new Map([...graph.models].map(([name, model]) => [name, redactModel(model)])),
})

/** What a model's redacted materialization omits — for the manifest. */
export const redactedColumns = (model: AnyModel, redacting: boolean): ReadonlyArray<string> =>
  redacting ? model.redact : []
