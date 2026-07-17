import { Context, Data, type Effect } from "effect"
import { causeText } from "../error-text.ts"

export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `state store: ${this.operation} failed — ${causeText(this.cause)}`
  }
}

/**
 * Current schema version of the state store. A fresh store bootstraps
 * directly at it; a store with an older schema (including one created
 * before versioning existed) refuses to open — data catches up via an
 * explicit `efmesh migrate`.
 * 1 — base layout (F4), 2 — applied_by in the plan journal (F5),
 * 3 — fingerprint_version in snapshots (F6), 4 — run tick journal (0.2.0),
 * 5 — canonicalization cache canon_cache (0.2.0, #8).
 */
export const STATE_VERSION = 5

/** Store schema doesn't match the binary's expectation — `efmesh migrate` is needed. */
export class StateSchemaError extends Data.TaggedError("StateSchemaError")<{
  readonly found: number
  readonly wanted: number
}> {
  override get message(): string {
    return `state store schema is v${this.found}, but this efmesh expects v${this.wanted} — run \`efmesh migrate\``
  }
}

/** Migration outcome for the CLI. */
export interface MigrationReport {
  readonly from: number
  readonly to: number
  /** Where the store's copy was stashed before the schema upgrade (SQLite; F6). */
  readonly backup?: string
}

/** A model version known to the state store (SPEC §6). */
export interface SnapshotRecord {
  readonly name: string
  readonly fingerprint: string
  /** Canonical SQL rendering — for diff display and debugging. */
  readonly renderedSql: string
  /** Canonical AST of the body (JSON) — for categorizing changes (SPEC §5.2). */
  readonly canonicalAst: string
  /**
   * Fingerprint whose physical table/prefix this snapshot uses.
   * Usually its own; under forward-only (SPEC §5.2) it is inherited
   * from the previous version: physics is reused, history is not replayed.
   */
  readonly physicalFp: string
  readonly kind: string
  /**
   * Version of the fingerprint algorithm used to compute this snapshot (SPEC §4).
   * Plan only compares same-version fingerprints; a different version is
   * a loud stop, not a silent "everything is breaking".
   */
  readonly fingerprintVersion: number
  readonly createdAt: string
  /**
   * When the snapshot stopped being pointed to by any environment (ISO UTC);
   * null means it is still referenced. Set and cleared on promotion,
   * the janitor's ttl is counted from here (SPEC §5.4).
   */
  readonly orphanedAt: string | null
}

/** Environment row: logical name → snapshot the view points to. */
export interface EnvironmentRecord {
  readonly env: string
  readonly name: string
  readonly fingerprint: string
  readonly promotedAt: string
}

export interface PlanRecord {
  readonly id: number
  readonly env: string
  readonly summary: string
  readonly appliedAt: string
  /** Who applied the plan (OS user or ApplyOptions.appliedBy); '' for records predating v2. */
  readonly appliedBy: string
}

/**
 * Run tick journal entry (SPEC §7, issue #2): a cron tick that fails at
 * three in the morning must be debuggable after the fact. outcome:
 * ok — tick succeeded; awaiting-human — there are unapplied changes (exit 2);
 * lock-held — the environment is held by another process; error — an actual failure.
 */
export interface RunRecord {
  readonly id: number
  readonly env: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly outcome: "ok" | "awaiting-human" | "lock-held" | "error"
  /** ok: JSON array of collected models; awaiting-human: list of changes; error: error tag. */
  readonly detail: string
}

/**
 * Bookkeeping of a snapshot's filled intervals (SPEC §6) — the single source
 * of truth for what has been computed: a physical table with no records here
 * is considered empty. Bounds are ISO UTC (sorted lexicographically).
 */
export interface IntervalRecord {
  readonly snapshotFp: string
  readonly startTs: string
  readonly endTs: string
  readonly status: "done" | "failed"
  readonly updatedAt: string
}

export interface StateStoreShape {
  /** Idempotent: (name, fingerprint) is unique, a repeated write is a no-op. */
  readonly upsertSnapshot: (
    snapshot: Omit<SnapshotRecord, "createdAt" | "orphanedAt">,
  ) => Effect.Effect<void, StateError>
  readonly getSnapshot: (
    name: string,
    fingerprint: string,
  ) => Effect.Effect<SnapshotRecord | undefined, StateError>
  /** All snapshots referenced by at least one environment — for the janitor. */
  readonly listReferencedFingerprints: () => Effect.Effect<ReadonlySet<string>, StateError>
  readonly listSnapshots: () => Effect.Effect<ReadonlyArray<SnapshotRecord>, StateError>
  /** Deletes the snapshot record and its interval bookkeeping (the janitor removes the physics). */
  readonly deleteSnapshot: (name: string, fingerprint: string) => Effect.Effect<void, StateError>
  /**
   * Transactional "claim" of an orphan by the janitor (SPEC §5.4, F6): the
   * record and its interval bookkeeping are deleted only if the snapshot is
   * STILL not referenced by any environment and orphaned no later than the
   * deadline (ISO UTC) — both checks run in the same transaction as the
   * delete, so a concurrent apply that revived the version can't lose it to
   * removal. true — removed, false — state changed underneath.
   */
  readonly deleteSnapshotIfDoomed: (
    name: string,
    fingerprint: string,
    deadline: string,
  ) => Effect.Effect<boolean, StateError>
  readonly getEnvironment: (
    env: string,
  ) => Effect.Effect<ReadonlyArray<EnvironmentRecord>, StateError>
  /**
   * Transactionally replaces the environment's whole set. Entries with
   * `requireSnapshot: true` are checked for the snapshot's liveness in the
   * same transaction: if the janitor already removed it, promotion fails
   * loudly — the view never switches to demolished physics.
   */
  readonly promote: (
    env: string,
    entries: ReadonlyArray<{
      readonly name: string
      readonly fingerprint: string
      readonly requireSnapshot?: boolean
    }>,
  ) => Effect.Effect<void, StateError>
  /** Journal of applied plans. */
  readonly recordPlan: (
    env: string,
    summary: string,
    appliedBy: string,
  ) => Effect.Effect<void, StateError>
  /**
   * Canonicalization cache (#8): the key already includes the dialect and
   * FINGERPRINT_VERSION — a change in algorithm or engine can never hand back
   * a stale canon. The cache is not data: a miss or failure is safe, the
   * caller must swallow it.
   */
  readonly getCanon: (key: string) => Effect.Effect<string | undefined, StateError>
  readonly putCanon: (key: string, canonical: string) => Effect.Effect<void, StateError>
  /** Run tick journal (SPEC §7): the outcome of every tick, including unsuccessful ones. */
  readonly recordRun: (record: Omit<RunRecord, "id">) => Effect.Effect<void, StateError>
  /** The environment's most recent ticks, newest first. */
  readonly listRuns: (
    env: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<RunRecord>, StateError>
  readonly listPlans: (env: string) => Effect.Effect<ReadonlyArray<PlanRecord>, StateError>
  /**
   * Cross-process lock (SPEC §7): true — acquired, false — held by another
   * process. Stale (expired) locks are reclaimed — a crashed process
   * doesn't leave a lock held forever.
   */
  readonly acquireLock: (name: string, ttlMs: number) => Effect.Effect<boolean, StateError>
  readonly releaseLock: (name: string) => Effect.Effect<void, StateError>
  /** Transactional upsert of snapshot intervals (re-marking updates the status). */
  readonly markIntervals: (
    snapshotFp: string,
    intervals: ReadonlyArray<{ readonly startTs: string; readonly endTs: string }>,
    status: IntervalRecord["status"],
  ) => Effect.Effect<void, StateError>
  readonly listIntervals: (
    snapshotFp: string,
  ) => Effect.Effect<ReadonlyArray<IntervalRecord>, StateError>
  /**
   * Deletes a snapshot's interval bookkeeping whose start falls in the
   * half-open `[from, to)` (ISO UTC, lexicographic) — restate (#21): a range
   * with no records reads as "empty", so the next plan/apply recomputes it as
   * backfill. The physics is not touched; the ensuing backfill's DELETE+INSERT
   * overwrites it. Transactional (a single DELETE).
   */
  readonly clearIntervals: (
    snapshotFp: string,
    from: string,
    to: string,
  ) => Effect.Effect<void, StateError>
}

export class StateStore extends Context.Service<StateStore, StateStoreShape>()(
  "efmesh/StateStore",
) {}
