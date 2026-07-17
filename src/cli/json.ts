import { Console } from "effect"
import type { JanitorReport } from "../plan/janitor.ts"
import type { LineageNode } from "../plan/lineage.ts"
import type { Plan } from "../plan/planner.ts"
import type { MigrationReport } from "../state/store.ts"

/**
 * JSON shape of the plan (#3) — a CONTRACT for CI and bots: shape changes
 * are package semver events. Intervals are ISO UTC, not epoch ms.
 */
export const planToJson = (plan: Plan): unknown => ({
  env: plan.env,
  hasChanges: plan.hasChanges,
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

export const printJson = (payload: unknown) => Console.log(JSON.stringify(payload, null, 2))
