import { Clock, Data, Effect } from "effect"
import type { SeedReadError } from "../core/errors.ts"
import type { ModelGraph } from "../core/graph.ts"
import type { Interval } from "../core/interval.ts"
import { enumerateIntervals, fromIso, mergeIntervals, missingIntervals } from "../core/interval.ts"
import type { EngineError, SqlParseError } from "../engine/adapter.ts"
import type { EngineAdapter } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import { categorizeAstChange } from "./categorize.ts"
import type { ChangeExplanation } from "./explain.ts"
import { dropsColumns, explainCategorized } from "./explain.ts"
import { windowRiskMessage, windowRiskOf } from "./window-risk.ts"
import { FINGERPRINT_VERSION, fingerprintGraph, modelFingerprint } from "./fingerprint.ts"
import { validateEnvName } from "./naming.ts"

export class InvalidEnvironmentError extends Data.TaggedError("InvalidEnvironmentError")<{
  readonly env: string
}> {
  override get message(): string {
    return `invalid environment name «${this.env}» — use latin letters, digits and _`
  }
}

/** The model cannot be applied forward-only (SPEC §5.2). */
export class ForwardOnlyError extends Data.TaggedError("ForwardOnlyError")<{
  readonly model: string
  readonly reason: string
}> {
  override get message(): string {
    return `model «${this.model}» cannot be applied forward-only: ${this.reason}`
  }
}

/**
 * A categorization override is rejected (#5): the model is not in the project
 * or the AST diff obviously contradicts the claimed verdict (removed columns
 * are never non-breaking — descendants read them by name).
 */
export class ReclassifyError extends Data.TaggedError("ReclassifyError")<{
  readonly model: string
  readonly reason: string
}> {
  override get message(): string {
    return `reclassify «${this.model}»: ${this.reason}`
  }
}

/**
 * The snapshot was computed by a LATER version of the fingerprint algorithm
 * (SPEC §4) — the store was written by a newer efmesh than the one reading it.
 * Nothing can be inferred from a canonical form this binary does not know, so
 * the plan halts; the cure is upgrading efmesh, never a store migration.
 *
 * The opposite direction (an older snapshot) is not an error: it categorizes as
 * breaking and the apply re-fingerprints the model (#48).
 */
export class FingerprintVersionError extends Data.TaggedError("FingerprintVersionError")<{
  readonly model: string
  readonly found: number
  readonly wanted: number
}> {
  override get message(): string {
    return `model «${this.model}» was fingerprinted by algorithm v${this.found}, newer than the v${this.wanted} this efmesh understands`
  }
}

export type ChangeCategory =
  /** The model was not in the environment. */
  | "added"
  /** A meaningful edit of the query or metadata: the model and its descendants rebuild. */
  | "breaking"
  /** Columns appended to the end of the SELECT, the rest of the tree untouched (SPEC §5.2). */
  | "non-breaking"
  /** The own AST did not change — the version shifted by cascade from a parent. */
  | "indirect"
  /**
   * The physics and done-intervals of the old version are reused, history is
   * not replayed — the new logic takes effect from the moment of application
   * (SPEC §5.2). An explicit user flag or a cascade from forward-only parents.
   */
  | "forward-only"
  /** Was in the environment, vanished from the project — the view is dropped at promotion. */
  | "removed"
  | "unchanged"

export interface PlanAction {
  readonly name: string
  readonly fingerprint: string
  /**
   * The fingerprint whose physics the snapshot uses: usually its own, and
   * under forward-only — inherited from the previous version.
   */
  readonly physicalFingerprint: string
  /** Where the physics and done-intervals are inherited from (fingerprint of the old version) under forward-only. */
  readonly reusedFrom?: string
  /** Canonical AST of the body (null for external) — saved into the snapshot. */
  readonly canonicalAst: string | null
  readonly change: ChangeCategory
  /** The planner's verdict before the operator override (#5); journaled. */
  readonly reclassifiedFrom?: ChangeCategory
  /**
   * Why the category is what it is (#4): the diverged nodes of the canonical
   * AST and the reason in words. Present on all changed models except
   * added/removed — there is nothing to compare there. The diverged paths are
   * a debugging hint, not a contract.
   */
  readonly explain?: ChangeExplanation
  /**
   * Whether physics needs building. false for unchanged/removed, external and
   * for snapshots already built by another environment — then promotion is
   * only a view-swap.
   */
  readonly build: boolean
  /**
   * Ranges to recompute for incrementalByTimeRange (merged from missing
   * intervals + lookback); empty for other kinds. Gaps happen even for an
   * unchanged model — time passes, new intervals appear.
   */
  readonly backfill: ReadonlyArray<Interval>
  /** true for incrementalByUniqueKey: every apply re-runs the query (upsert by key). */
  readonly refresh: boolean
}

export interface Plan {
  readonly env: string
  /** In topological order; removed comes last. */
  readonly actions: ReadonlyArray<PlanAction>
  readonly hasChanges: boolean
  /**
   * Things that are legal but probably not meant (#54). Never a reason to
   * refuse — a plan with warnings applies exactly as it would without them —
   * so an empty array is the common case and a caller may ignore it.
   */
  readonly warnings: ReadonlyArray<PlanWarning>
}

export interface PlanWarning {
  /** Closed vocabulary, so CI can assert on a kind of warning rather than on prose. */
  readonly code: "window-over-batch"
  readonly model: string
  readonly message: string
}

export interface PlanOptions {
  /** "Now" for computing intervals; defaults to Clock. Injection point for tests. */
  readonly now?: number
  /**
   * Models whose changes to apply forward-only (SPEC §5.2): the new version
   * inherits the physical table and done-intervals of the old one, history is
   * not replayed. Only incrementalByTimeRange — other kinds have no
   * "retroactive" notion by construction.
   */
  readonly forwardOnly?: ReadonlyArray<string>
  /**
   * Categorization override (#5, SPEC §5.2): the operator, looking at
   * `--explain`, states the verdict instead of the planner. It governs the
   * fate of DESCENDANTS (a non-breaking parent lets them reuse the physics);
   * the model itself is freed from rebuilding not by this but by forwardOnly.
   * Guardrail: an obvious AST contradiction (removed columns → non-breaking)
   * is an error. Applies only to breaking/non-breaking verdicts; on unchanged/
   * added/removed/indirect it silently has no effect.
   */
  readonly reclassify?: Readonly<Record<string, "breaking" | "non-breaking">>
  /**
   * Materialize this environment redacted (#41): every model's `redact`
   * columns are projected away before fingerprinting, so the environment gets
   * its own physics in which those columns were never written. Models that
   * declare no policy are untouched and keep sharing physics with plain
   * environments.
   */
  readonly redacted?: boolean
}

/**
 * Kinds whose physics is worth inheriting on indirect reuse (#5):
 * materialized tables. view/embedded have no materialization; seed rebuilds
 * cheaply from a file and has no parents.
 */
const REUSABLE_KINDS: ReadonlySet<string> = new Set([
  "full",
  "incrementalByTimeRange",
  "incrementalByUniqueKey",
  "scdType2",
])

export const planChanges = (
  env: string,
  graph: ModelGraph,
  options?: PlanOptions,
): Effect.Effect<
  Plan,
  | InvalidEnvironmentError
  | ForwardOnlyError
  | ReclassifyError
  | FingerprintVersionError
  | StateError
  | EngineError
  | SqlParseError
  | SeedReadError,
  StateStore | EngineAdapter
> =>
  Effect.gen(function* () {
    if (!validateEnvName(env)) return yield* new InvalidEnvironmentError({ env })
    const store = yield* StateStore
    const now = options?.now ?? (yield* Clock.currentTimeMillis)
    const forwardOnly = new Set(options?.forwardOnly ?? [])
    for (const flagged of forwardOnly) {
      const model = graph.models.get(flagged)
      if (model === undefined) {
        return yield* new ForwardOnlyError({
          model: flagged,
          reason: "model is not in the project",
        })
      }
      if (model.kind._tag !== "incrementalByTimeRange") {
        return yield* new ForwardOnlyError({
          model: flagged,
          reason: `forward-only reuses physics and interval accounting — applicable only to incrementalByTimeRange, model kind is ${model.kind._tag}`,
        })
      }
    }
    const reclassify = options?.reclassify ?? {}
    for (const flagged of Object.keys(reclassify)) {
      if (!graph.models.has(flagged)) {
        return yield* new ReclassifyError({ model: flagged, reason: "model is not in the project" })
      }
    }
    // canonicalization cache (#8) — the store is at hand; its failures are
    // swallowed: a cache miss is just an honest recompute, not a plan error
    const versions = yield* fingerprintGraph(graph, {
      get: (key) => store.getCanon(key).pipe(Effect.orElseSucceed(() => undefined)),
      put: (key, canonical) => store.putCanon(key, canonical).pipe(Effect.ignore),
    })
    const current = new Map(
      (yield* store.getEnvironment(env)).map((row) => [row.name, row.fingerprint]),
    )

    const actions: Array<PlanAction> = []
    const changeOf = new Map<string, ChangeCategory>()
    // who in this plan inherits the physics of the old version (indirect reuse, #5)
    const reusedPhysics = new Set<string>()
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      const { fingerprint, ast } = versions.get(name)!
      const known = current.get(name)
      let change: ChangeCategory
      let explain: ChangeExplanation | undefined
      let reclassifiedFrom: ChangeCategory | undefined
      let reusedFrom: string | undefined
      let physicalFingerprint = fingerprint
      if (known === undefined) change = "added"
      else if (known === fingerprint) change = "unchanged"
      else {
        // categorization by AST against the last known snapshot (SPEC §5.2);
        // old records without an AST and external — conservatively breaking
        const previous = yield* store.getSnapshot(name, known)
        // A snapshot from a LATER algorithm is a downgrade: this efmesh cannot
        // read what a newer one wrote, and guessing would corrupt the environment.
        if (previous !== undefined && previous.fingerprintVersion > FINGERPRINT_VERSION) {
          return yield* new FingerprintVersionError({
            model: name,
            found: previous.fingerprintVersion,
            wanted: FINGERPRINT_VERSION,
          })
        }
        // An EARLIER algorithm (#48): its canonical AST is incomparable with
        // ours — the same "nothing to compare against" situation as a snapshot
        // with no AST, so it categorizes as breaking. Halting here instead
        // would wedge the environment: plan is the only route to the re-apply
        // that rewrites snapshots at the current version, and `efmesh migrate`
        // cannot help (it owns the store schema, not snapshot payloads).
        const stale = previous !== undefined && previous.fingerprintVersion < FINGERPRINT_VERSION
        const oldAst = stale ? "" : (previous?.canonicalAst ?? "")
        const changedParents = [...model.deps].filter((dep) => {
          const parent = changeOf.get(dep)
          return parent !== undefined && parent !== "unchanged"
        })
        if (oldAst === "" || ast === null) {
          change = "breaking"
          explain = {
            diverged: [],
            reason: stale
              ? `the previous snapshot was fingerprinted by algorithm v${previous?.fingerprintVersion} and this efmesh uses v${FINGERPRINT_VERSION} — the canonical forms are incomparable, conservatively breaking; the apply re-fingerprints the model`
              : ast === null
                ? "model has no SQL body (external/seed) — the version was shifted by source/file, schema or parents; there is no AST to compare against"
                : "the previous snapshot did not store a canonical AST — nothing to compare against, conservatively breaking",
          }
        } else if (oldAst === ast) {
          change = "indirect" // version shifted by a parent/metadata
          explain =
            changedParents.length > 0
              ? {
                  diverged: [],
                  reason: `own AST did not change — the version was shifted by a cascade from parents: ${changedParents.join(", ")}`,
                  cascadeFrom: changedParents,
                }
              : {
                  diverged: [],
                  reason: "own AST did not change — metadata diverged (kind/grain/columns/target)",
                }
        } else {
          change = categorizeAstChange(oldAst, ast)
          explain = explainCategorized(oldAst, ast, change)
        }
        // operator override (#5): the verdict is stated by a flag on top of
        // --explain; the planner checks only an obvious AST contradiction
        const override = reclassify[name]
        if (
          override !== undefined &&
          (change === "breaking" || change === "non-breaking") &&
          change !== override
        ) {
          if (override === "non-breaking" && (oldAst === "" || ast === null)) {
            return yield* new ReclassifyError({
              model: name,
              reason:
                "no canonical AST — nothing to check the verdict against, override is not accepted",
            })
          }
          if (override === "non-breaking" && ast !== null && dropsColumns(oldAst, ast)) {
            return yield* new ReclassifyError({
              model: name,
              reason:
                "the new SELECT has fewer columns — descendants read the removed columns by name, non-breaking contradicts the AST",
            })
          }
          reclassifiedFrom = change
          explain = {
            diverged: explain?.diverged ?? [],
            reason: `operator override: ${change} → ${override}; planner verdict: ${explain?.reason ?? "—"}`,
          }
          change = override
        }
        // "version shifted by parents ONLY": a fingerprint with the old parent
        // signatures must yield known — otherwise the metadata diverged along
        // with the parents (kind/grain/columns/target) and physics cannot be inherited
        const parentsOnly =
          change === "indirect" &&
          previous !== undefined &&
          [...model.deps].every((dep) => current.has(dep)) &&
          (yield* modelFingerprint(
            model,
            ast,
            [...model.deps].sort().map((dep) => `${dep}=${current.get(dep)!}`),
          )) === known
        // forward-only: an explicit user flag — or a cascade: the own AST did
        // not change and all changed parents are themselves forward-only (reuse
        // of a parent's physics means the descendant has nothing to replay either)
        const cascaded =
          parentsOnly &&
          model.kind._tag === "incrementalByTimeRange" &&
          [...model.deps].every((dep) => {
            const parent = changeOf.get(dep)
            return parent === undefined || parent === "unchanged" || parent === "forward-only"
          })
        // `!stale`: physics from a snapshot of another algorithm version cannot
        // be inherited — the payload that produced its physicalFp had different
        // composition, so "reuse the old physics" would not mean what it says (#48).
        if (previous !== undefined && !stale && (forwardOnly.has(name) || cascaded)) {
          change = "forward-only"
          reusedFrom = known
          physicalFingerprint = previous.physicalFp
          explain = forwardOnly.has(name)
            ? {
                diverged: explain?.diverged ?? [],
                reason: `forward-only by flag: physics and done intervals are inherited from @${known.slice(0, 8)}, history is not replayed`,
              }
            : {
                diverged: [],
                reason:
                  "own AST did not change, all changed parents are forward-only — physics is reused by cascade",
                cascadeFrom: changedParents,
              }
        }
        // indirect reuse (#5, sqlmesh's "indirect non-breaking" class): the own
        // body did not change, the version was shifted only by parents, and each
        // changed parent guarantees the same data in the old columns (non-breaking
        // — strictly a suffix; forward-only and reuse — literally the same
        // physics) — the descendant has nothing to replay: physics and ledger are
        // inherited, scdType2 does not lose its accumulated row history
        if (
          change === "indirect" &&
          parentsOnly &&
          REUSABLE_KINDS.has(model.kind._tag) &&
          changedParents.length > 0 &&
          changedParents.every((dep) => {
            const parent = changeOf.get(dep)!
            return (
              parent === "non-breaking" ||
              parent === "forward-only" ||
              (parent === "indirect" && reusedPhysics.has(dep))
            )
          })
        ) {
          reusedFrom = known
          physicalFingerprint = previous!.physicalFp
          reusedPhysics.add(name)
          explain = {
            diverged: [],
            reason: `changed parents do not touch existing data (non-breaking/forward-only) — physics and accounting are inherited from @${known.slice(0, 8)}, no rebuild`,
            cascadeFrom: changedParents,
          }
        }
      }
      changeOf.set(name, change)
      // external is not materialized — the version participates in the diff, there is no physics
      const existing = yield* store.getSnapshot(name, fingerprint)
      if (existing !== undefined) physicalFingerprint = existing.physicalFp
      const alreadyBuilt =
        model.kind._tag === "external" || change === "unchanged" || existing !== undefined

      let backfill: ReadonlyArray<Interval> = []
      if (model.kind._tag === "incrementalByTimeRange") {
        const kind = model.kind
        const wanted = enumerateIntervals(kind.interval, fromIso(kind.start), now)
        // coverage is keyed to the fingerprint: a new version = empty ledger =
        // full backfill; forward-only inherits the done-intervals of the old
        // version — only what was missing is recomputed
        const inherited = reusedFrom === undefined ? [] : yield* store.listIntervals(reusedFrom)
        const doneByStart = new Map<number, Interval>()
        for (const record of [...(yield* store.listIntervals(fingerprint)), ...inherited]) {
          if (record.status !== "done") continue
          doneByStart.set(fromIso(record.startTs), {
            start: fromIso(record.startTs),
            end: fromIso(record.endTs),
          })
        }
        const done = [...doneByStart.values()]
        const missing = [...missingIntervals(wanted, done)]
        if (kind.lookback > 0) {
          // late-arriving data: the last done-intervals are re-read
          const tail = done.sort((a, b) => a.start - b.start).slice(-kind.lookback)
          missing.push(...tail)
        }
        backfill = mergeIntervals(missing.sort((a, b) => a.start - b.start))
      }

      actions.push({
        name,
        fingerprint,
        physicalFingerprint,
        ...(reusedFrom !== undefined ? { reusedFrom } : {}),
        canonicalAst: ast,
        change,
        ...(reclassifiedFrom !== undefined ? { reclassifiedFrom } : {}),
        ...(explain !== undefined ? { explain } : {}),
        build: !alreadyBuilt,
        backfill,
        // every apply reconciles the query with the physics: upsert / SCD versioning
        refresh: model.kind._tag === "incrementalByUniqueKey" || model.kind._tag === "scdType2",
      })
    }
    for (const [name, fingerprint] of current) {
      if (!graph.models.has(name)) {
        actions.push({
          name,
          fingerprint,
          physicalFingerprint: fingerprint,
          canonicalAst: null,
          change: "removed",
          build: false,
          backfill: [],
          refresh: false,
        })
      }
    }

    const warnings: Array<PlanWarning> = []
    for (const action of actions) {
      const model = graph.models.get(action.name)
      if (model === undefined) continue
      const risk = windowRiskOf(model, action.canonicalAst)
      if (risk !== null) {
        warnings.push({
          code: "window-over-batch",
          model: risk.model,
          message: windowRiskMessage(risk),
        })
      }
    }

    return {
      env,
      actions,
      hasChanges: actions.some(
        (a) => a.change !== "unchanged" || a.backfill.length > 0 || a.refresh,
      ),
      warnings,
    }
  }).pipe(Effect.withSpan("efmesh.plan", { attributes: { env } }))
