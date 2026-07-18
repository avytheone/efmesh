/**
 * Reading a materialized model from a browser (#41).
 *
 * Shipped as the `@avytheone/efmesh/browser` subpath rather than a separate
 * package, deliberately: the helper and the manifest format are one contract,
 * and two packages would let a client pin versions that disagree about the
 * document they exchange. This subpath imports nothing from the rest of efmesh
 * — no Effect, no DuckDB bindings, no node builtins — so a bundler pulls in
 * only these few lines.
 *
 * The client half of "models → static files → DuckDB in the browser": fetch one
 * manifest, register its files with duckdb-wasm, query them. No directory
 * listing, no globbing over HTTP, no request per partition before the first
 * byte.
 */

/** Mirrors `plan/manifest.ts`; kept structural so this file needs no imports. */
export interface ModelManifest {
  readonly manifestVersion: number
  readonly model: string
  readonly fingerprint: string
  readonly generatedAt: string
  readonly intervals: ReadonlyArray<{ readonly start: string; readonly end: string }>
  readonly schema: ReadonlyArray<{ readonly name: string; readonly type: string }>
  readonly files: ReadonlyArray<string>
  readonly answerable: "full" | "sampled" | "unobservable"
  readonly caveats: ReadonlyArray<string>
  readonly freshness: {
    readonly contiguousThrough: string | null
    readonly latestInterval: string | null
    readonly failedIntervals: number
  }
  readonly redacted: ReadonlyArray<string>
}

/** The manifest version this helper understands. */
export const SUPPORTED_MANIFEST_VERSION = 1

export class ManifestError extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`manifest ${url}: ${reason}`)
    this.name = "ManifestError"
  }
}

/**
 * Fetch and validate a manifest. A newer `manifestVersion` is refused rather
 * than best-guessed: a client that silently misreads a document it does not
 * understand is worse than one that stops.
 */
export const fetchManifest = async (url: string): Promise<ModelManifest> => {
  const response = await fetch(url)
  if (!response.ok) throw new ManifestError(url, `HTTP ${response.status}`)
  const manifest = (await response.json()) as ModelManifest
  if (typeof manifest.manifestVersion !== "number" || !Array.isArray(manifest.files)) {
    throw new ManifestError(url, "not a model manifest")
  }
  if (manifest.manifestVersion > SUPPORTED_MANIFEST_VERSION) {
    throw new ManifestError(
      url,
      `manifestVersion ${manifest.manifestVersion} is newer than the ${SUPPORTED_MANIFEST_VERSION} this helper understands — upgrade the client`,
    )
  }
  return manifest
}

/**
 * Absolute URLs of the manifest's files. Paths are stored relative to the
 * manifest, so the same document works behind any prefix, bucket or CDN.
 */
export const fileUrls = (manifestUrl: string, manifest: ModelManifest): ReadonlyArray<string> =>
  manifest.files.map((file) => new URL(file, manifestUrl).href)

/** The duckdb-wasm surface this helper needs — structural, so no dependency on the package. */
export interface DuckDbLike {
  registerFileURL(
    name: string,
    url: string,
    protocol?: number,
    directIO?: boolean,
  ): Promise<void> | void
}

/**
 * Register a model's files with a duckdb-wasm instance and return the SQL to
 * read it. The relation is `read_parquet([...])` over an explicit list —
 * `union_by_name` because partitions of one model may carry additively
 * different schemas, the same reason the server-side view uses it.
 */
export const registerModel = async (
  db: DuckDbLike,
  manifestUrl: string,
  manifest: ModelManifest,
  options?: { readonly protocol?: number },
): Promise<string> => {
  const urls = fileUrls(manifestUrl, manifest)
  const names = urls.map((url, index) => `${manifest.model}/${manifest.fingerprint}/${index}`)
  await Promise.all(
    urls.map((url, index) =>
      options?.protocol === undefined
        ? db.registerFileURL(names[index]!, url)
        : db.registerFileURL(names[index]!, url, options.protocol),
    ),
  )
  const list = names.map((name) => `'${name.replaceAll(`'`, `''`)}'`).join(", ")
  return `read_parquet([${list}], union_by_name = true)`
}

/**
 * The limits of trust that came with the data (#43). A client that renders a
 * number should render this beside it — that is the entire point of carrying
 * the passport in the same document as the file list.
 */
export const passportOf = (
  manifest: ModelManifest,
): {
  readonly answerable: ModelManifest["answerable"]
  readonly caveats: ReadonlyArray<string>
  readonly completeThrough: string | null
  readonly hasGaps: boolean
} => ({
  answerable: manifest.answerable,
  caveats: manifest.caveats,
  completeThrough: manifest.freshness.contiguousThrough,
  // a gap means the tail exists but the middle does not: a total over the whole
  // range would silently omit rows, so a client must not present it as complete
  hasGaps:
    manifest.freshness.contiguousThrough !== manifest.freshness.latestInterval ||
    manifest.freshness.failedIntervals > 0,
})
