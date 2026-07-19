import { rmSync } from "node:fs"
import { Clock, Effect } from "effect"
import { parseModelName } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import {
  janitorLockName,
  withStateLock,
  type LockHeldError,
  type LockLostError,
  type LockOptions,
} from "./lock.ts"
import { ducklakeAttachSql, ducklakeRef, parquetPrefix, physicalRef } from "./naming.ts"

/**
 * Cleanup of orphaned physical storage (SPEC §5.4): snapshots referenced by
 * no environment and orphaned longer than ttl ago are removed — the engine
 * table/view, the lake parquet prefix, the snapshot record and the interval
 * bookkeeping.
 *
 * ttl is measured from orphaned_at — the mark a promotion sets when the last
 * reference is lost and clears on return (rolling back to an old version
 * resets the counter). For records without the mark (never promoted — e.g.
 * an apply that crashed before promotion) — from created_at.
 * ttl defaults to 7 days — enough to roll back instantly by switching the
 * view.
 */

export interface JanitorOptions extends LockOptions {
  readonly ttlDays?: number
  readonly lakePath?: string
  /** DuckLake catalog (SPEC §14.5) — to also drop the fingerprint tables inside it. */
  readonly ducklake?: { readonly catalog: string; readonly dataPath?: string }
  /** «Now» — injected for tests. */
  readonly now?: number
}

export interface JanitorReport {
  /** Removed snapshots as `name@fp8`. */
  readonly removed: ReadonlyArray<string>
  /** Orphaned but younger than ttl — kept until next time. */
  readonly kept: ReadonlyArray<string>
  /** Operational limitations encountered while removing physical storage. */
  readonly warnings: ReadonlyArray<string>
}

const DAY_MS = 86_400_000

export const janitor = (
  options?: JanitorOptions,
): Effect.Effect<
  JanitorReport,
  EngineError | StateError | LockHeldError | LockLostError,
  EngineAdapter | StateStore
> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const store = yield* StateStore
    const now = options?.now ?? (yield* Clock.currentTimeMillis)
    const ttlMs = (options?.ttlDays ?? 7) * DAY_MS

    // a snapshot does not store its materialization target — with a catalog
    // configured, the table is dropped both there and in _efmesh (DROP IF EXISTS
    // tolerates absence)
    const ducklake = options?.ducklake
    if (ducklake !== undefined && engine.dialect === "duckdb") {
      yield* engine.execute(ducklakeAttachSql(ducklake))
    }

    const referenced = yield* store.listReferencedFingerprints()
    const removed: Array<string> = []
    const kept: Array<string> = []
    const warnings: Array<string> = []

    const snapshots = yield* store.listSnapshots()
    const deadline = new Date(now - ttlMs).toISOString()
    const s3WithoutMaintenance =
      options?.lakePath?.startsWith("s3://") === true && engine.objectStore === undefined
    if (s3WithoutMaintenance) {
      warnings.push(
        "S3 lake cleanup was not attempted: an explicit S3 credential is required; snapshot records were preserved",
      )
    }
    const isDoomed = (snapshot: (typeof snapshots)[number]): boolean =>
      !referenced.has(snapshot.fingerprint) &&
      (snapshot.orphanedAt ?? snapshot.createdAt) <= deadline

    // phase 1 — transactional claim of records: removal happens only if the
    // snapshot is STILL not referenced and an orphan (the checks are atomic
    // with the delete); against a parallel apply that resurrected the version
    // (upsert clears orphaned_at) the claim loses — and its physical storage
    // is left untouched (F6 race)
    const claimed: Array<(typeof snapshots)[number]> = []
    for (const snapshot of snapshots) {
      if (referenced.has(snapshot.fingerprint)) continue
      const label = `${snapshot.name}@${snapshot.fingerprint.slice(0, 8)}`
      if (!isDoomed(snapshot)) {
        kept.push(label)
        continue
      }
      // Do not throw away the only durable pointer to objects we could not
      // delete. A later run with an explicit credential must still find them.
      if (s3WithoutMaintenance) {
        kept.push(label)
        continue
      }
      const won = yield* store.deleteSnapshotIfDoomed(snapshot.name, snapshot.fingerprint, deadline)
      if (!won) {
        kept.push(label)
        continue
      }
      claimed.push(snapshot)
      removed.push(label)
    }

    // phase 2 — drop physical storage by the FRESH store state: storage is
    // shared between versions (forward-only) and dropped only if, after the
    // claims, no surviving snapshot uses it
    const survivors = yield* store.listSnapshots()
    const physicalInUse = new Set(survivors.map((snapshot) => snapshot.physicalFp))
    const dropped = new Set<string>()
    for (const snapshot of claimed) {
      if (physicalInUse.has(snapshot.physicalFp) || dropped.has(snapshot.physicalFp)) continue
      dropped.add(snapshot.physicalFp)
      const name = parseModelName(snapshot.name)
      const target = physicalRef(name, snapshot.physicalFp)
      yield* Effect.logDebug("dropping orphaned physics").pipe(
        Effect.annotateLogs({ model: snapshot.name, physical: snapshot.physicalFp.slice(0, 8) }),
      )
      yield* engine.execute(
        snapshot.kind === "view"
          ? `DROP VIEW IF EXISTS ${target}`
          : `DROP TABLE IF EXISTS ${target}`,
      )
      if (ducklake !== undefined && engine.dialect === "duckdb" && snapshot.kind !== "view") {
        yield* engine.execute(`DROP TABLE IF EXISTS ${ducklakeRef(name, snapshot.physicalFp)}`)
      }
      if (options?.lakePath?.startsWith("s3://")) {
        const prefix = parquetPrefix(options.lakePath, name, snapshot.physicalFp)
        yield* engine.objectStore!.deletePrefix(`${prefix}/`)
      } else if (options?.lakePath !== undefined) {
        const prefix = parquetPrefix(options.lakePath, name, snapshot.physicalFp)
        yield* Effect.sync(() => rmSync(prefix, { recursive: true, force: true }))
      }
    }

    return { removed, kept, warnings }
  }).pipe(
    // two janitors from different processes must not race to remove the same
    // thing; the janitor↔apply race is guarded by ttl (the window for an instant rollback)
    withStateLock(janitorLockName, options?.lockTtlMs),
  )
