import { Console } from "effect"
import type { ModelGraph } from "../core/graph.ts"
import type { CompactReport } from "../plan/compact.ts"
import type { JanitorReport } from "../plan/janitor.ts"
import type { LineageNode } from "../plan/lineage.ts"
import type { PassportReport } from "../plan/passport.ts"
import type { Plan } from "../plan/planner.ts"
import type { RestatePlan } from "../plan/restate.ts"
import type { StatusReport } from "../plan/status.ts"
import type { MigrationReport } from "../state/store.ts"

/**
 * JSON shape of the plan (#3) — a CONTRACT for CI and bots: shape changes
 * are package semver events. Intervals are ISO UTC, not epoch ms.
 */
export const planToJson = (plan: Plan): unknown => ({
  env: plan.env,
  hasChanges: plan.hasChanges,
  // additive (#54): legal-but-probably-unmeant configurations. Never a reason
  // the plan will not apply — a caller that ignores this reads the plan exactly
  // as before. `code` is a closed vocabulary so CI asserts on a kind, not prose.
  warnings: plan.warnings.map((warning) => ({
    code: warning.code,
    model: warning.model,
    message: warning.message,
  })),
  actions: plan.actions.map((action) => ({
    name: action.name,
    change: action.change,
    // operator override (#5) and physical reuse — additive contract fields
    ...(action.reclassifiedFrom !== undefined ? { reclassifiedFrom: action.reclassifiedFrom } : {}),
    ...(action.reusedFrom !== undefined ? { reusedFrom: action.reusedFrom } : {}),
    fingerprint: action.fingerprint,
    build: action.build,
    backfill: action.backfill.map((range) => ({
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
    })),
    // category reason (#4); diverged paths are a debug hint, not a contract
    ...(action.explain !== undefined ? { explain: action.explain } : {}),
  })),
})

/**
 * `apply --json` (#28): the plan that ran plus its outcome. `applied` — did
 * `applyPlan` execute at all (false when a non-TTY with changes refused, exit
 * 2, or the human cancelled); `built` — models whose physics was built or
 * backfilled; `promoted` — the environment's view layer was swapped. The plan
 * itself rides under `plan` in the frozen planToJson shape, so a caller reads
 * apply and plan the same way. Exit codes are unchanged: exit 2 still emits
 * this payload (with `applied:false`) that explains why nothing ran.
 */
export const applyToJson = (input: {
  readonly env: string
  readonly applied: boolean
  readonly plan: Plan
  readonly built: ReadonlyArray<string>
  readonly promoted: boolean
}): unknown => ({
  env: input.env,
  applied: input.applied,
  plan: planToJson(input.plan),
  built: input.built,
  promoted: input.promoted,
})

/**
 * `run --json` (#28): a scheduler tick's outcome. `outcome` — "ok" when the
 * tick advanced intervals, "awaiting-human" when structural changes block it
 * (exit 2, unchanged); `processed` — models whose intervals were caught up;
 * `blockedBy` — the unapplied changes, present only when awaiting a human.
 */
export const runToJson = (input: {
  readonly env: string
  readonly outcome: "ok" | "awaiting-human"
  readonly processed: ReadonlyArray<string>
  readonly blockedBy?: ReadonlyArray<string>
}): unknown => ({
  env: input.env,
  outcome: input.outcome,
  processed: input.processed,
  ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
})

/**
 * The tick journal and the plan journal store their `detail`/`summary` as a
 * JSON string (SPEC §7, #19) so the wire shape is a structured object, not
 * text a reader must re-parse by outcome. A record that predates the encoded
 * format (or a corrupt one) is handed back verbatim under `raw` rather than
 * throwing — `status` must never fail to report because one old row won't parse.
 */
const parseDetail = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

/**
 * `status --json` (#28): the double-encoding is gone — `lastPlan.summary` and
 * each `ticks[].detail` are structured objects, not JSON-inside-a-string. The
 * env's own `env`, model count and promotion timestamp stay at the top; `lag`
 * is wire-clean already. The store's internal row ids and the redundant per-row
 * `env` are dropped from the nested plan/tick records — `env` is the top-level
 * key and the id is a store detail, never part of the contract (#28 breaking
 * review, SPEC §11).
 */
export const statusToJson = (report: StatusReport): unknown => ({
  env: report.env,
  storeVersion: report.storeVersion,
  models: report.models,
  promotedAt: report.promotedAt,
  lastPlan:
    report.lastPlan === null
      ? null
      : {
          appliedAt: report.lastPlan.appliedAt,
          appliedBy: report.lastPlan.appliedBy,
          summary: parseDetail(report.lastPlan.summary),
        },
  lag: report.lag.map((entry) => ({
    model: entry.model,
    doneUpTo: entry.doneUpTo,
    missing: entry.missing,
    failed: entry.failed,
  })),
  ticks: report.ticks.map((tick) => ({
    startedAt: tick.startedAt,
    finishedAt: tick.finishedAt,
    outcome: tick.outcome,
    detail: parseDetail(tick.detail),
  })),
})

/**
 * `passport --json` (#43): what a consumer may believe about each model an
 * environment serves. `declared` is what the model's author claims about it
 * alone; `effective` is that claim narrowed by every ancestor, with the
 * ancestor that narrowed it named. Both are on the wire on purpose — a client
 * that renders a number needs the effective value, and a human debugging why it
 * degraded needs the difference.
 */
export const passportToJson = (report: PassportReport): unknown => ({
  env: report.env,
  models: report.models.map((passport) => ({
    model: passport.model,
    declared: {
      answerable: passport.declared.answerable,
      caveats: passport.declared.caveats,
    },
    freshness: {
      contiguousThrough: passport.freshness.contiguousThrough,
      latestInterval: passport.freshness.latestInterval,
      failedIntervals: passport.freshness.failedIntervals,
    },
    effective: {
      answerable: passport.effective.answerable,
      caveats: passport.effective.caveats.map((caveat) => ({
        model: caveat.model,
        text: caveat.text,
      })),
      completeThrough: passport.effective.completeThrough,
      limitedBy: passport.effective.limitedBy,
    },
  })),
})

/**
 * `graph --json` (#28): the DAG as an object — models in topological order,
 * each with its kind tag and its sorted direct deps.
 */
export const graphToJson = (graph: ModelGraph): unknown => ({
  models: graph.order.map((name) => {
    const model = graph.models.get(name)!
    return { name, kind: model.kind._tag, deps: [...model.deps].sort() }
  }),
})

/**
 * JSON shapes for the operate-me-headless commands (#16) — CONTRACTs for CI
 * and agents, on the same footing as planToJson: shape changes are package
 * semver events. Each is an OBJECT (never a bare array or string) so a future
 * top-level `apiVersion` (#20) is a purely additive change. Reports already
 * shaped as a clean contract (janitor, migrate) are passed through their own
 * transformer so an internal field added to the report later cannot silently
 * leak into the wire shape.
 */
export const janitorToJson = (report: JanitorReport): unknown => ({
  removed: report.removed,
  kept: report.kept,
  warnings: report.warnings,
})

/**
 * `compact --json` (#40): the partitions merged and the ones left alone, each
 * with the reason it was left. The reasons are a closed vocabulary
 * (`current-day` / `grace-period` / `already-compact` / `undated`) so a CI job
 * can assert on them; `rows` is null under `--dry-run`, where nothing is read.
 */
export const compactToJson = (report: CompactReport): unknown => ({
  dryRun: report.dryRun,
  compacted: report.compacted.map((entry) => ({
    model: entry.model,
    partition: entry.partition,
    files: entry.files,
    rows: entry.rows,
    published: entry.published,
  })),
  skipped: report.skipped.map((entry) => ({
    model: entry.model,
    partition: entry.partition,
    reason: entry.reason,
  })),
  warnings: report.warnings,
})

export const migrateToJson = (report: MigrationReport): unknown => ({
  from: report.from,
  to: report.to,
  // backup is SQLite-only — omitted (not null) when absent, additive when present
  ...(report.backup !== undefined ? { backup: report.backup } : {}),
})

/** Rendered SQL wrapped in an object; env is null when rendering logical names. */
export const renderToJson = (model: string, env: string, sql: string): unknown => ({
  model,
  env: env === "" ? null : env,
  sql,
})

/** One lineage tree per requested column (LineageNode is already wire-clean). */
export const lineageToJson = (model: string, trees: ReadonlyArray<LineageNode>): unknown => ({
  model,
  lineage: trees,
})

/** OS-scheduler entries as an object so the list can gain sibling fields later. */
export const scheduleListToJson = (entries: ReadonlyArray<string>): unknown => ({ entries })

/**
 * Restate (#21) as an object: the range and, per touched model, the intervals
 * that will be (dryRun) or were cleared for recompute. Intervals are ISO UTC;
 * `dryRun` tells a bot whether the store was mutated.
 */
export const restateToJson = (plan: RestatePlan): unknown => ({
  env: plan.env,
  model: plan.model,
  from: new Date(plan.from).toISOString(),
  to: new Date(plan.to).toISOString(),
  interval: plan.interval,
  dryRun: plan.dryRun,
  targets: plan.targets.map((target) => ({
    name: target.name,
    fingerprint: target.fingerprint,
    intervals: target.intervals.map((range) => ({
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
    })),
  })),
})

/**
 * The wire-contract version stamped on EVERY `--json` payload (#20): a single
 * top-level integer a reader pins on to know the field names it can trust.
 * Bumped only on a breaking shape change — the same SemVer event that changing
 * a field would be. Additive fields do NOT bump it (that is the whole reason
 * every shape is an object). It is applied in exactly ONE place — `withApiVersion`
 * inside `printJson`, through which every `--json` command already prints — so
 * no transformer can ship a payload that forgets it.
 */
export const API_VERSION = 1

/**
 * Stamp `apiVersion` onto a payload, kept first so it reads at the top. Every
 * transformer returns an object; the guard only defends the (unreached) case of
 * a bare value so a future careless caller degrades to `{apiVersion, value}`
 * instead of a silently un-versioned scalar.
 */
export const withApiVersion = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? { apiVersion: API_VERSION, ...(payload as Record<string, unknown>) }
    : { apiVersion: API_VERSION, value: payload }

export const printJson = (payload: unknown) =>
  Console.log(JSON.stringify(withApiVersion(payload), null, 2))
