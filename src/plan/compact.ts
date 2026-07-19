import { readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { Clock, Effect } from "effect"
import type { AnyModel, CompactPolicy } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { EngineFeatureError } from "./executor.ts"
import { parquetModelPrefix } from "./naming.ts"

/**
 * Partition compaction (#40): a micro-batch writer leaves hundreds of tiny
 * files in a partition, and a partition of hundreds of tiny files is what
 * destroys the query planner. Compaction merges each settled partition into one
 * file, de-duplicating by the declared key on the way through.
 *
 * ## Scope
 *
 * Targets are derived from the project and from nowhere else: efmesh's own
 * parquet materializations, plus the `defineExternal` sources that opted in
 * with `maintenance: { compact: {…} }`. There is deliberately no way to point
 * this at an arbitrary directory — that road ends at a lake manager, which is a
 * non-goal.
 *
 * ## Concurrency: COOPERATIVE, not transactional
 *
 * This is the difference an operator must read before trusting it. Janitor
 * takes a TRANSACTIONAL claim through the state store: two janitors cannot
 * remove the same snapshot, because the claim and the delete are one atomic
 * step. Compaction has no such claim. It coordinates with the lake's writer
 * through file conventions and timing alone:
 *
 * - it never touches a partition dated today or later (the live writer owns it);
 * - it waits out a grace period measured from the newest file's mtime, because
 *   a batch may still be landing;
 * - it publishes the merged file through a `.tmp` and an atomic rename, so a
 *   reader sees either the old files or the new one, never a partial write;
 * - it deletes only the files it listed BEFORE the merge, so a file that
 *   arrives mid-run is left in place rather than lost.
 *
 * Those rules make compaction safe against a well-behaved APPENDING writer.
 * They do not make it safe against a writer that rewrites or deletes files in
 * place, and they do not serialize two concurrent compactors. Do not ascribe
 * janitor's guarantees to compaction — the mechanism does not deliver them.
 */

/** Default wait past the newest file's mtime, in minutes. */
export const COMPACT_GRACE_MINUTES = 10

const MINUTE_MS = 60_000

/** What the merged file is called in a foreign lake, unless the policy renames it. */
const COMPACT_FILE = "compacted.parquet"

/**
 * In efmesh's OWN lake the merged file must take the executor's file name.
 * A lookback recompute rewrites `data.parquet` for the whole partition; had
 * compaction published beside it under another name, the recompute's output
 * would land next to the merged file and the partition would read double.
 */
const OWN_LAKE_FILE = "data.parquet"

export interface CompactOptions {
  /** The project's models — the only source of targets. */
  readonly models: ReadonlyArray<AnyModel>
  /** Root of efmesh's own parquet lake; without it only opted-in externals are compacted. */
  readonly lakePath?: string
  /** Restrict the run to one model by full name. */
  readonly model?: string
  /** Report what would happen; nothing is written, renamed or deleted. */
  readonly dryRun?: boolean
  /** Override every target's grace period, in minutes — for an operator draining a lake. */
  readonly graceMinutes?: number
  /** «Now» — injected for tests. */
  readonly now?: number
  /**
   * Runs after a partition's file list is snapshotted and before the merge.
   * The only way to exercise "a file arriving mid-run is never lost" without
   * racing a real writer; production has no reason to pass it.
   */
  readonly afterSnapshot?: (partition: string) => Effect.Effect<void>
}

export type CompactSkipReason =
  /** Dated today or later — the live writer owns it. */
  | "current-day"
  /** Newest file is younger than the grace period — a batch may be in flight. */
  | "grace-period"
  /** Fewer files than the policy's minFiles — nothing to merge. */
  | "already-compact"
  /** No `<partitionKey>=<date>` segment in the path — not a dated partition. */
  | "undated"

export interface CompactedPartition {
  readonly model: string
  readonly partition: string
  /** How many files the merge consumed. */
  readonly files: number
  /** Rows in the published file; null under --dry-run, where nothing is read. */
  readonly rows: number | null
  readonly published: string
}

export interface SkippedPartition {
  readonly model: string
  readonly partition: string
  readonly reason: CompactSkipReason
}

export interface CompactReport {
  readonly dryRun: boolean
  readonly compacted: ReadonlyArray<CompactedPartition>
  readonly skipped: ReadonlyArray<SkippedPartition>
  /** Whole-target limitations which cannot be represented as a partition skip. */
  readonly warnings: ReadonlyArray<string>
}

/** A policy with every default resolved — what the merge actually runs on. */
interface ResolvedPolicy {
  readonly partitionKey: string
  readonly uniqueKey: ReadonlyArray<string>
  readonly orderBy: ReadonlyArray<string>
  readonly graceMs: number
  readonly fileName: string
  readonly minFiles: number
}

interface CompactTarget {
  readonly model: string
  readonly root: string
  readonly policy: ResolvedPolicy
}

const resolvePolicy = (
  policy: CompactPolicy,
  fileName: string,
  graceOverride: number | undefined,
): ResolvedPolicy => ({
  partitionKey: policy.partitionKey,
  uniqueKey: policy.uniqueKey ?? [],
  orderBy: policy.orderBy ?? [],
  graceMs: (graceOverride ?? policy.graceMinutes ?? COMPACT_GRACE_MINUTES) * MINUTE_MS,
  fileName: policy.fileName ?? fileName,
  minFiles: policy.minFiles ?? 2,
})

/**
 * Where a glob stops being a directory path. `…/archive/&#42;&#42;/&#42;.parquet` is a lake
 * rooted at `…/archive`; the walker takes it from there, so the glob's own
 * shape never has to be interpreted.
 */
const globRoot = (path: string): string => {
  const segments: Array<string> = []
  for (const segment of path.split("/")) {
    if (/[*?[]/.test(segment)) break
    segments.push(segment)
  }
  const candidate = segments.join("/")
  const isDir = ((): boolean => {
    try {
      return statSync(candidate).isDirectory()
    } catch {
      return false
    }
  })()
  return isDir ? candidate : candidate.slice(0, candidate.lastIndexOf("/"))
}

/**
 * Targets, derived from the project. Own parquet materializations are
 * partitioned only under incrementalByTimeRange (a `full` parquet model is a
 * single file with nothing to merge), and their unique key is the model's
 * declared grain.
 */
const compactTargets = (options: CompactOptions): ReadonlyArray<CompactTarget> => {
  const targets: Array<CompactTarget> = []
  for (const model of options.models) {
    if (options.model !== undefined && model.name.full !== options.model) continue
    const declared = model.maintenance?.compact
    if (declared !== undefined && model.kind._tag === "external") {
      if (model.kind.source._tag !== "files") continue
      targets.push({
        model: model.name.full,
        root: globRoot(model.kind.source.path),
        policy: resolvePolicy(declared, COMPACT_FILE, options.graceMinutes),
      })
      continue
    }
    if (
      options.lakePath === undefined ||
      model.target !== "parquet" ||
      model.kind._tag !== "incrementalByTimeRange"
    ) {
      continue
    }
    targets.push({
      model: model.name.full,
      root: parquetModelPrefix(options.lakePath, model.name),
      policy: resolvePolicy(
        { partitionKey: "interval", uniqueKey: model.grain },
        OWN_LAKE_FILE,
        options.graceMinutes,
      ),
    })
  }
  return targets
}

/**
 * Directories that directly hold parquet files. Only `.parquet` counts: a
 * `.parquet.tmp` left by a writer (or by a compaction that died mid-COPY) is
 * neither merged nor deleted — it is not published data.
 */
const leafPartitions = (root: string): ReadonlyArray<string> => {
  // a root that does not exist yet (a lake nothing has written to) is not an
  // error for maintenance — it is simply nothing to do
  const entriesOf = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  const found: Array<string> = []
  const walk = (dir: string): void => {
    let holdsParquet = false
    for (const entry of entriesOf(dir)) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
      else if (entry.isFile() && entry.name.endsWith(".parquet")) holdsParquet = true
    }
    if (holdsParquet) found.push(dir)
  }
  walk(root)
  return found.sort()
}

const PARTITION_DATE = /^(\d{4}-\d{2}-\d{2})/

/**
 * The UTC day a partition belongs to, from the `<key>=<value>` segment. Own
 * partitions are `interval=2026-03-01` or `interval=2026-03-01T05`; a foreign
 * lake names its key itself. Both date on the first ten characters.
 */
const partitionDay = (partition: string, root: string, key: string): string | undefined => {
  for (const segment of partition.slice(root.length).split("/")) {
    if (!segment.startsWith(`${key}=`)) continue
    const matched = PARTITION_DATE.exec(segment.slice(key.length + 1))
    if (matched !== null) return matched[1]
  }
  return undefined
}

interface SnapshotFile {
  readonly path: string
  readonly mtimeMs: number
}

const snapshotFiles = (partition: string): ReadonlyArray<SnapshotFile> => {
  const files: Array<SnapshotFile> = []
  for (const entry of readdirSync(partition, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".parquet")) continue
    const path = `${partition}/${entry.name}`
    files.push({ path, mtimeMs: statSync(path).mtimeMs })
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : 1))
}

const literal = (value: string): string => `'${value.replaceAll(`'`, `''`)}'`
const ident = (name: string): string => `"${name.replaceAll(`"`, `""`)}"`

/**
 * The merge query over an explicit file list.
 *
 * `union_by_name` because a transition-day partition holds both schema
 * generations at once — the file the archiver wrote before it grew a column and
 * the ones it wrote after. `hive_partitioning = false` because the partition key
 * lives in the DIRECTORY name: materializing it into the file would make the
 * next hive-partitioned read see that column twice.
 *
 * The projection is `* EXCLUDE (_rn)` and never an explicit column list, so a
 * column the writer started emitting after this policy was declared survives
 * the merge instead of being silently dropped by a list written in the past.
 */
export const compactMergeSql = (
  files: ReadonlyArray<string>,
  policy: Pick<ResolvedPolicy, "uniqueKey" | "orderBy">,
): string => {
  const scan = `read_parquet([${files.map(literal).join(", ")}], union_by_name = true, hive_partitioning = false)`
  if (policy.uniqueKey.length === 0) return `SELECT * FROM ${scan}`
  const partitionBy = policy.uniqueKey.map(ident).join(", ")
  const order =
    policy.orderBy.length === 0 ? "" : ` ORDER BY ${policy.orderBy.map(ident).join(", ")}`
  return (
    `SELECT * EXCLUDE (_rn) FROM (SELECT *, row_number() OVER (PARTITION BY ${partitionBy}${order})` +
    ` AS _rn FROM ${scan}) WHERE _rn = 1`
  )
}

/**
 * Where the merge writes before it publishes. The pid is in the name because
 * nothing serializes two compactors — or a compactor and a concurrent apply
 * rewriting the same partition — and two processes sharing one temp path would
 * publish a half-written file. The rename is what publishes, and it is atomic
 * on POSIX.
 */
export const compactWritePath = (published: string, pid: number): string =>
  `${published}.${pid}.tmp`

export const compact = (
  options: CompactOptions,
): Effect.Effect<CompactReport, EngineError | EngineFeatureError, EngineAdapter> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const now = options.now ?? (yield* Clock.currentTimeMillis)
    const today = new Date(now).toISOString().slice(0, 10)
    const dryRun = options.dryRun ?? false
    const targets = compactTargets(options)
    if (targets.length > 0 && engine.dialect !== "duckdb") {
      return yield* new EngineFeatureError({
        model: targets[0]!.model,
        feature: "partition compaction",
        dialect: engine.dialect,
      })
    }

    const compacted: Array<CompactedPartition> = []
    const skipped: Array<SkippedPartition> = []
    const s3Targets = targets.filter((target) => target.root.startsWith("s3://"))
    const warnings =
      s3Targets.length === 0
        ? []
        : [
            `S3 compaction is not implemented; no S3 partitions were listed, merged, or deleted: ${s3Targets.map((target) => target.model).join(", ")}`,
          ]

    for (const target of targets.filter((candidate) => !candidate.root.startsWith("s3://"))) {
      const { model, policy, root } = target
      for (const partition of leafPartitions(root)) {
        const skip = (reason: CompactSkipReason): void => {
          skipped.push({ model, partition, reason })
        }
        const day = partitionDay(partition, root, policy.partitionKey)
        if (day === undefined) {
          skip("undated")
          continue
        }
        // strictly older than the current UTC day: today's partition belongs to
        // the writer, and a future-dated one is a clock the writer owns too
        if (day >= today) {
          skip("current-day")
          continue
        }
        const snapshot = snapshotFiles(partition)
        if (snapshot.length < policy.minFiles) {
          skip("already-compact")
          continue
        }
        const newest = snapshot.reduce((max, file) => Math.max(max, file.mtimeMs), 0)
        if (now - newest < policy.graceMs) {
          skip("grace-period")
          continue
        }
        const published = `${partition}/${policy.fileName}`
        if (dryRun) {
          compacted.push({ model, partition, files: snapshot.length, rows: null, published })
          continue
        }
        if (options.afterSnapshot !== undefined) yield* options.afterSnapshot(partition)

        // the merge reads the SNAPSHOT, not the directory: whatever the writer
        // adds from here on is neither read nor deleted below
        const paths = snapshot.map((file) => file.path)
        const writePath = compactWritePath(published, process.pid)
        const dropTemp = Effect.sync(() => rmSync(writePath, { force: true }))
        const rows = yield* Effect.gen(function* () {
          const merge = compactMergeSql(paths, policy)
          yield* engine.execute(`COPY (${merge}) TO ${literal(writePath)} (FORMAT PARQUET)`)
          const counted = yield* engine.query(
            `SELECT count(*) AS n FROM read_parquet(${literal(writePath)})`,
          )
          return Number(counted[0]?.["n"] ?? 0)
          // a failed merge must not leave a stray temp file for the next run to trip over
        }).pipe(Effect.tapError(() => dropTemp))
        yield* Effect.logDebug("compacting partition").pipe(
          Effect.annotateLogs({ model, partition, files: paths.length, rows }),
        )
        yield* Effect.sync(() => renameSync(writePath, published))
        yield* Effect.sync(() => {
          for (const path of paths) {
            if (path !== published) rmSync(path, { force: true })
          }
        })
        compacted.push({ model, partition, files: paths.length, rows, published })
      }
    }

    return { dryRun, compacted, skipped, warnings }
  })
