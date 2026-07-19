import { renameSync, writeFileSync } from "node:fs"
import { Clock, Effect } from "effect"
import type { ModelGraph } from "../core/graph.ts"
import { toIso } from "../core/interval.ts"
import type { AnyModel, Answerable } from "../core/model.ts"
import { columnNames } from "../core/model.ts"
import type { ObjectStore } from "../engine/object-store.ts"
import type { EngineError } from "../engine/adapter.ts"
import type { StateStoreShape } from "../state/store.ts"
import { familyOfAst } from "./contract.ts"
import type { EffectivePassport, ManifestFreshness } from "./passport.ts"
import { freshnessOf, passportsOver } from "./passport.ts"

/**
 * The model manifest (#41): what a client needs to read a materialized model
 * without discovering it.
 *
 * A browser cannot glob over HTTP. Without this file a client enumerates
 * parquet URLs by walking a web server's directory listings — fragile (it
 * depends on the listing format), slow (many round trips before the first
 * byte), and non-atomic (a listing can catch a partition mid-rewrite). The
 * manifest states the file set for one version of one model, so a reader
 * fetches one document and then the data.
 *
 * The format carries the answer-passport fields (`answerable`, `caveats`,
 * `freshness`) from the outset, deliberately ahead of the issue that consumes
 * them (#43): a format that clients and agents parse should change once, not
 * twice. `answerable`/`caveats` are declared on the model; `freshness` is
 * DERIVED from the interval ledger and never declared — a hand-maintained
 * badge drifts, the ledger cannot.
 */

export interface Manifest {
  readonly manifestVersion: number
  readonly model: string
  readonly fingerprint: string
  readonly generatedAt: string
  readonly intervals: ReadonlyArray<{ readonly start: string; readonly end: string }>
  readonly schema: ReadonlyArray<{ readonly name: string; readonly type: string }>
  readonly files: ReadonlyArray<string>
  /** As DECLARED on this model — what its author claims about it alone. */
  readonly answerable: Answerable
  readonly caveats: ReadonlyArray<string>
  /** From this model's OWN ledger — what it computed, not what it may claim. */
  readonly freshness: ManifestFreshness
  /**
   * What the DAG permits (#43): the declared values narrowed by every ancestor,
   * plus the ancestor that narrowed them. Additive, so a manifest written before
   * this field existed still parses — a client falls back to the declared half,
   * which is what it read anyway.
   *
   * The declared fields are kept beside it rather than overwritten: "this model
   * claims full, its source makes it sampled" is a diagnosis, and collapsing the
   * two into one number throws it away.
   */
  readonly effective: EffectivePassport
  /** Columns this materialization deliberately omits (§ redacted materialization). */
  readonly redacted: ReadonlyArray<string>
}

/**
 * Bumped when a field changes meaning or leaves. Additive fields do not bump
 * it — a client pins on this the way CI pins on `apiVersion`.
 */
export const MANIFEST_VERSION = 1

/**
 * Column types as TYPE FAMILIES — the same vocabulary the schema contract
 * checks against (`text`/`numeric`/`temporal`/`boolean`), not Effect's internal
 * AST tags. A client reading this file cares what the value IS; `Declaration`
 * would tell it nothing about a timestamp.
 */
const schemaOf = (model: AnyModel): ReadonlyArray<{ name: string; type: string }> =>
  columnNames(model).map((name) => {
    const field = (model.schema.fields as Record<string, { ast?: unknown }>)[name]
    return { name, type: familyOfAst(field?.ast) }
  })

export const buildManifest = (options: {
  readonly model: AnyModel
  readonly fingerprint: string
  readonly files: ReadonlyArray<string>
  readonly done: ReadonlyArray<{ readonly startTs: string; readonly endTs: string }>
  readonly failed: number
  readonly generatedAt: string
  /**
   * Required, not defaulted: a manifest that quietly carried a DAG-blind
   * passport because a caller forgot to compute one would be exactly the
   * dishonest document this field exists to prevent.
   */
  readonly effective: EffectivePassport
  readonly redacted: ReadonlyArray<string>
}): Manifest => ({
  manifestVersion: MANIFEST_VERSION,
  model: options.model.name.full,
  fingerprint: options.fingerprint,
  generatedAt: options.generatedAt,
  intervals: [...options.done]
    .map((row) => ({ start: row.startTs, end: row.endTs }))
    .sort((a, b) => a.start.localeCompare(b.start)),
  schema: schemaOf(options.model),
  // relative to the manifest itself: a client resolves them against the URL it
  // fetched, so the same file works behind any prefix, bucket or CDN
  files: [...options.files].sort(),
  answerable: options.model.answerable ?? "full",
  caveats: options.model.caveats ?? [],
  freshness: freshnessOf(options.done, options.failed),
  effective: options.effective,
  redacted: [...options.redacted].sort(),
})

/**
 * Published like everything else a reader might catch mid-write: temp file then
 * rename. A client sees the previous manifest whole or the new one whole, never
 * a truncated document — the same rule the partition writes and the environment
 * promotion follow.
 */
export const writeManifest = (
  path: string,
  manifest: Manifest,
  objectStore?: ObjectStore,
): Effect.Effect<void, EngineError> => {
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  if (path.startsWith("s3://")) {
    return objectStore === undefined
      ? Effect.die("S3 manifest requires an object-store client")
      : objectStore.writeText(path, content)
  }
  return Effect.sync(() => {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, content, "utf8")
    renameSync(temporary, path)
  })
}

/**
 * `fingerprints` covers the whole plan, not just this model: the effective
 * passport is a property of the model's ancestry, so writing it needs every
 * ancestor's ledger. Reading them again per manifest is a handful of indexed
 * lookups against a store the apply already holds open — cheap next to the
 * parquet write it follows, and it keeps the manifest a function of state at the
 * moment of publication rather than of whatever was cached earlier in the apply.
 */
export const manifestFor = (options: {
  readonly store: StateStoreShape
  readonly graph: ModelGraph
  readonly model: AnyModel
  readonly fingerprint: string
  readonly fingerprints: ReadonlyArray<{ readonly name: string; readonly fingerprint: string }>
  readonly files: ReadonlyArray<string>
  readonly redacted: ReadonlyArray<string>
}): Effect.Effect<Manifest, never, never> =>
  Effect.gen(function* () {
    const ledgerOf = (fingerprint: string) =>
      options.store.listIntervals(fingerprint).pipe(Effect.orElseSucceed(() => []))
    const own = new Map<string, ManifestFreshness>()
    for (const entry of options.fingerprints) {
      const rows = yield* ledgerOf(entry.fingerprint)
      own.set(
        entry.name,
        freshnessOf(
          rows.filter((row) => row.status === "done"),
          rows.filter((row) => row.status === "failed").length,
        ),
      )
    }
    const ledger = yield* ledgerOf(options.fingerprint)
    const done = ledger.filter((row) => row.status === "done")
    const failed = ledger.filter((row) => row.status === "failed")
    const generatedAt = toIso(yield* Clock.currentTimeMillis)
    // invariant: the model being materialized comes from this same graph
    const passport = passportsOver(options.graph, own).get(options.model.name.full)!
    return buildManifest({
      model: options.model,
      fingerprint: options.fingerprint,
      files: options.files,
      done,
      failed: failed.length,
      generatedAt,
      effective: passport.effective,
      redacted: options.redacted,
    })
  })
