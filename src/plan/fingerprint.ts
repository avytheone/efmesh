import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { SeedReadError } from "../core/errors.ts"
import type { ModelGraph } from "../core/graph.ts"
import type { ModelKind } from "../core/model.ts"
import { columnNames } from "../core/model.ts"
import { render } from "../core/sql.ts"
import type { EngineError, SqlParseError } from "../engine/adapter.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { familyOfAst } from "./contract.ts"

/**
 * Snapshot fingerprint (SPEC §4): hash of the canonicalized AST (engine's
 * native parser — reformatting a query does not change the fingerprint),
 * of the metadata that affects data, and of the fingerprints of direct
 * dependencies (transitivity).
 *
 * `batchSize`, `lookback`, `start` and `description` do not enter the
 * fingerprint: they change execution or the amount of history, not the shape
 * of the data — the interval ledger will notice missing intervals on its own.
 */

/**
 * Fingerprint algorithm version — a CONTRACT (SPEC §4). The fingerprint
 * depends on the engine canonicalization (DuckDB json_serialize_sql /
 * libpg_query) and on the composition of the payload below: any change to
 * them silently re-fingerprints all of a user's models and forces a full
 * rebuild of the warehouse. Therefore: (1) canonicalization is frozen by
 * golden tests (test/fingerprint-golden.test.ts) — a red test on a
 * DuckDB/libpg_query upgrade means canon drift; (2) a deliberate change of
 * algorithm = increment of this constant + a migration history; the plan does
 * not compare snapshots of a different version, it honestly stops instead.
 *
 * v2 (#17): column TYPE families join the payload — a schema type change
 * (e.g. Number→String) now shifts the fingerprint, making "types as the DAG
 * contract" honest. Families come from `familyOfAst` (SPEC §4).
 */
export const FINGERPRINT_VERSION = 2

const sha256 = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input)
  return hasher.digest("hex")
}

/** Canonical render: refs are logical names, bounds are $start/$end placeholders. */
export const canonicalSql = (graph: ModelGraph, name: string): string => {
  const model = graph.models.get(name)
  // invariant: callers pass a name already known to the graph (the facade
  // guards user input with UnknownModelError before reaching here)
  if (model === undefined)
    throw new Error(`invariant violated: model «${name}» is not in the graph`)
  return render(model.fragment, { resolveRef: (ref) => ref })
}

/** Part of kind that affects data. For seed — hash of the file contents: editing the data = a new version. */
const kindPayload = (
  model: { readonly name: { readonly full: string } },
  kind: ModelKind,
): Effect.Effect<unknown, SeedReadError> => {
  switch (kind._tag) {
    case "full":
    case "view":
    case "embedded":
      return Effect.succeed({ _tag: kind._tag })
    case "incrementalByTimeRange":
      return Effect.succeed({
        _tag: kind._tag,
        timeColumn: kind.timeColumn,
        interval: kind.interval,
      })
    case "incrementalByUniqueKey":
      return Effect.succeed({ _tag: kind._tag, key: kind.key })
    case "scdType2":
      return Effect.succeed({
        _tag: kind._tag,
        key: kind.key,
        validFrom: kind.validFrom,
        validTo: kind.validTo,
      })
    case "external":
      return Effect.succeed({ _tag: kind._tag, source: kind.source })
    case "seed":
      return Effect.try({
        try: () => ({
          _tag: kind._tag,
          file: kind.file,
          contentHash: sha256(readFileSync(kind.file, "utf8")),
        }),
        catch: (cause) => new SeedReadError({ model: model.name.full, file: kind.file, cause }),
      })
  }
}

export interface ModelVersion {
  readonly fingerprint: string
  /** Canonical AST of the body; null for external. Stored in the snapshot for categorization (§5.2). */
  readonly ast: string | null
}

/**
 * Canonicalization cache (#8): a repeated plan consists almost entirely of
 * json_serialize_sql round-trips over unchanged models. The cache is not
 * data: get/put must be infallible (a miss/failure = recompute).
 */
export interface CanonCache {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly put: (key: string, canonical: string) => Effect.Effect<void>
}

/** Cache key: algorithm version + dialect + source — a canon upgrade is not masked. */
export const canonCacheKey = (dialect: string, source: string): string =>
  sha256(`${FINGERPRINT_VERSION}:${dialect}:${source}`)

/** The model in the scope the fingerprint needs: kind, data-shape metadata, target. */
type FingerprintableModel = Parameters<typeof columnNames>[0] & {
  readonly name: { readonly full: string }
  readonly kind: ModelKind
  readonly grain: ReadonlyArray<string> | undefined
  readonly target: string | undefined
}

/**
 * Column type families in schema order (#17, SPEC §4). Reuses `familyOfAst`
 * (the same map the DESCRIBE contract check uses): a type change that crosses
 * a family boundary (Number→String) shifts the fingerprint, so the plan stops
 * lying about "unchanged" when the physical shape actually moved. Family
 * granularity is deliberate — an annotation swap within one family (both
 * numeric) does not churn physics; catching sub-family narrowing (Int vs
 * Double) is DESCRIBE territory, left to the contract check (§3.2).
 */
const columnFamilies = (model: FingerprintableModel): ReadonlyArray<string> =>
  (Object.values(model.schema.fields) as ReadonlyArray<{ readonly ast: unknown }>).map((field) =>
    familyOfAst(field.ast),
  )

/**
 * Fingerprint of a single model from a ready AST and parent signatures
 * (`name=fingerprint`, sorted). The planner needs it to check the
 * "version shifted by parents ONLY" case (#5): a recompute with the old
 * signatures must yield the old fingerprint — otherwise the metadata diverged
 * too, and the physics cannot be reused.
 */
export const modelFingerprint = (
  model: FingerprintableModel,
  ast: string | null,
  parents: ReadonlyArray<string>,
): Effect.Effect<string, SeedReadError> =>
  Effect.gen(function* () {
    const payload = JSON.stringify({
      ast,
      kind: yield* kindPayload(model, model.kind),
      grain: model.grain,
      columns: columnNames(model),
      // types are the DAG contract (#17): families aligned to `columns`
      columnFamilies: columnFamilies(model),
      // a change of materialization target = new physics, consumers re-read it
      target: model.target,
      parents,
    })
    return sha256(payload)
  })

/** Fingerprint of all models in the graph; transitivity via parent hashes. */
export const fingerprintGraph = (
  graph: ModelGraph,
  cache?: CanonCache,
): Effect.Effect<
  ReadonlyMap<string, ModelVersion>,
  EngineError | SqlParseError | SeedReadError,
  EngineAdapter
> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const canonicalize = (source: string): Effect.Effect<string, EngineError | SqlParseError> =>
      Effect.gen(function* () {
        if (cache === undefined) return yield* engine.canonicalize(source)
        const key = canonCacheKey(engine.dialect, source)
        const hit = yield* cache.get(key)
        if (hit !== undefined) return hit
        const canon = yield* engine.canonicalize(source)
        yield* cache.put(key, canon)
        return canon
      })
    const versions = new Map<string, ModelVersion>()
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      // external and seed have no SQL — the version is determined by source/file and schema
      const ast =
        model.kind._tag === "external" || model.kind._tag === "seed"
          ? null
          : yield* canonicalize(canonicalSql(graph, name))
      const parents = [...model.deps]
        .sort()
        .map((dep) => `${dep}=${versions.get(dep)!.fingerprint}`)
      versions.set(name, { fingerprint: yield* modelFingerprint(model, ast, parents), ast })
    }
    return versions
  })
