import { renameSync, writeFileSync } from "node:fs"
import { Clock, Effect } from "effect"
import { fromIso, mergeIntervals, toIso } from "../core/interval.ts"
import type { AnyModel } from "../core/model.ts"
import { columnNames } from "../core/model.ts"
import type { StateStoreShape } from "../state/store.ts"
import { familyOfAst } from "./contract.ts"

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

/** How much of the question this model's data can answer (#43). */
export type Answerable = "full" | "sampled" | "unobservable"

export interface ManifestFreshness {
  /**
   * End of contiguous coverage from the model's start: the point up to which
   * the data is known to be complete. A gap in the middle stops the clock here
   * even when later intervals exist — which is the honest reading, and stricter
   * than "the newest interval we happen to have".
   */
  readonly contiguousThrough: string | null
  /** The newest interval end that exists at all; equals contiguousThrough when there are no gaps. */
  readonly latestInterval: string | null
  /** Intervals that ran and failed — data that is missing on purpose, not merely absent. */
  readonly failedIntervals: number
}

export interface Manifest {
  readonly manifestVersion: number
  readonly model: string
  readonly fingerprint: string
  readonly generatedAt: string
  readonly intervals: ReadonlyArray<{ readonly start: string; readonly end: string }>
  readonly schema: ReadonlyArray<{ readonly name: string; readonly type: string }>
  readonly files: ReadonlyArray<string>
  readonly answerable: Answerable
  readonly caveats: ReadonlyArray<string>
  readonly freshness: ManifestFreshness
  /** Columns this materialization deliberately omits (§ redacted materialization). */
  readonly redacted: ReadonlyArray<string>
}

/**
 * Bumped when a field changes meaning or leaves. Additive fields do not bump
 * it — a client pins on this the way CI pins on `apiVersion`.
 */
export const MANIFEST_VERSION = 1

/**
 * Freshness from the ledger. `contiguousThrough` walks merged done-intervals
 * from the earliest one and stops at the first gap: coverage a consumer can
 * trust is the prefix, not the maximum.
 */
export const freshnessOf = (
  done: ReadonlyArray<{ readonly startTs: string; readonly endTs: string }>,
  failed: number,
): ManifestFreshness => {
  if (done.length === 0) {
    return { contiguousThrough: null, latestInterval: null, failedIntervals: failed }
  }
  const sorted = [...done]
    .map((row) => ({ start: fromIso(row.startTs), end: fromIso(row.endTs) }))
    .sort((a, b) => a.start - b.start)
  const merged = mergeIntervals(sorted)
  return {
    contiguousThrough: toIso(merged[0]!.end),
    latestInterval: toIso(Math.max(...sorted.map((interval) => interval.end))),
    failedIntervals: failed,
  }
}

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
  redacted: [...options.redacted].sort(),
})

/**
 * Published like everything else a reader might catch mid-write: temp file then
 * rename. A client sees the previous manifest whole or the new one whole, never
 * a truncated document — the same rule the partition writes and the environment
 * promotion follow.
 */
export const writeManifest = (path: string, manifest: Manifest): Effect.Effect<void> =>
  Effect.sync(() => {
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    renameSync(temporary, path)
  })

export const manifestFor = (options: {
  readonly store: StateStoreShape
  readonly model: AnyModel
  readonly fingerprint: string
  readonly files: ReadonlyArray<string>
  readonly redacted: ReadonlyArray<string>
}): Effect.Effect<Manifest, never, never> =>
  Effect.gen(function* () {
    const ledger = yield* options.store
      .listIntervals(options.fingerprint)
      .pipe(Effect.orElseSucceed(() => []))
    const done = ledger.filter((row) => row.status === "done")
    const failed = ledger.filter((row) => row.status === "failed")
    const generatedAt = toIso(yield* Clock.currentTimeMillis)
    return buildManifest({
      model: options.model,
      fingerprint: options.fingerprint,
      files: options.files,
      done,
      failed: failed.length,
      generatedAt,
      redacted: options.redacted,
    })
  })
