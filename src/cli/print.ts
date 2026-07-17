import { Console, Effect } from "effect"
import type { DataDiffReport } from "../plan/diff.ts"
import { fp8 } from "../plan/naming.ts"
import type { Plan } from "../plan/planner.ts"

const CHANGE_MARK: Record<string, string> = {
  added: "+",
  breaking: "!",
  "non-breaking": "~",
  indirect: "↻",
  "forward-only": "→",
  removed: "-",
  unchanged: "·",
}

const formatRange = (range: { readonly start: number; readonly end: number }): string =>
  `[${new Date(range.start).toISOString().slice(0, 10)}, ${new Date(range.end).toISOString().slice(0, 10)})`

export const printPlan = (plan: Plan, explain = false) =>
  Effect.gen(function* () {
    yield* Console.log(`plan for environment "${plan.env}":`)
    for (const action of plan.actions) {
      const mark = CHANGE_MARK[action.change] ?? "?"
      const overridden =
        action.reclassifiedFrom !== undefined ? `  [override: was ${action.reclassifiedFrom}]` : ""
      const reused =
        action.change === "indirect" && action.reusedFrom !== undefined ? "  [physics reused]" : ""
      const build = action.build ? "  [build]" : ""
      const backfill =
        action.backfill.length > 0
          ? `  backfill ${action.backfill.map(formatRange).join(", ")}`
          : ""
      yield* Console.log(
        `  ${mark} ${action.name}  ${action.change} @${fp8(action.fingerprint)}${overridden}${reused}${build}${backfill}`,
      )
      if (explain && action.explain !== undefined) {
        yield* Console.log(`      why: ${action.explain.reason}`)
        if (action.explain.diverged.length > 0) {
          yield* Console.log(`      diverged: ${action.explain.diverged.join(", ")}`)
        }
      }
    }
    if (!plan.hasChanges) yield* Console.log("  no changes")
  })

export const printDataDiff = (report: DataDiffReport) =>
  Effect.gen(function* () {
    yield* Console.log(`data "${report.envA}" ↔ "${report.envB}":`)
    if (report.models.length === 0) {
      yield* Console.log("  no shared materializable models")
      return
    }
    for (const entry of report.models) {
      if (entry.key === undefined) {
        yield* Console.log(
          `  · ${entry.model}  A=${entry.rowsA} B=${entry.rowsB}  no key (set a grain) — counts only`,
        )
      } else {
        const clean =
          entry.onlyInA === 0 &&
          entry.onlyInB === 0 &&
          (entry.columns?.length ?? 0) === 0 &&
          entry.rowsA === entry.rowsB
        const sampled =
          entry.sampledPercent !== undefined ? `  (sample ${entry.sampledPercent}%)` : ""
        yield* Console.log(
          `  ${clean ? "✓" : "≠"} ${entry.model}  A=${entry.rowsA} B=${entry.rowsB}  key (${entry.key.join(", ")}): only in A ${entry.onlyInA}, only in B ${entry.onlyInB}, matched ${entry.matched}${sampled}`,
        )
        for (const drift of entry.columns ?? []) {
          yield* Console.log(
            `      ${drift.column}: ${drift.mismatches} of ${entry.matched} (${(drift.rate * 100).toFixed(2)}%)`,
          )
        }
      }
      if (entry.columnsOnlyInA !== undefined) {
        yield* Console.log(`      columns only in A: ${entry.columnsOnlyInA.join(", ")}`)
      }
      if (entry.columnsOnlyInB !== undefined) {
        yield* Console.log(`      columns only in B: ${entry.columnsOnlyInB.join(", ")}`)
      }
    }
  })
