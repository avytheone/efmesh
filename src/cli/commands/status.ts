import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { environmentStatus, isEnvHealthy } from "../../plan/status.ts"
import { configLayers, loadConfig } from "../config.ts"
import { checkFlag, configFlag, jsonFlag } from "../flags.ts"
import { printJson, statusToJson } from "../json.ts"

/** Render a tick's structured JSON `detail` (#19) back to a short human line. */
const tickDetailText = (detail: string): string => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(detail) as Record<string, unknown>
  } catch {
    return detail
  }
  if (Array.isArray(parsed["built"])) {
    return parsed["built"].length > 0 ? `built ${parsed["built"].join(", ")}` : ""
  }
  if (Array.isArray(parsed["blockedBy"])) return `blocked by ${parsed["blockedBy"].join("; ")}`
  if (typeof parsed["lock"] === "string") return `lock ${parsed["lock"]}`
  if (typeof parsed["error"] === "string") {
    const where = typeof parsed["model"] === "string" ? ` ${parsed["model"]}` : ""
    const when = typeof parsed["interval"] === "string" ? ` ${parsed["interval"]}` : ""
    const why = typeof parsed["message"] === "string" ? `: ${parsed["message"]}` : ""
    return `${parsed["error"]}${where}${when}${why}`
  }
  return detail
}

export const statusCommand = Command.make(
  "status",
  { env: Argument.string("env"), config: configFlag, json: jsonFlag, check: checkFlag },
  ({ check, config, env, json }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* environmentStatus(env, loaded.models).pipe(
        Effect.provide(configLayers(loaded)),
      )
      // --check turns the report into a health probe: exit 1 when a backfill is
      // stuck or the last tick errored, composing with systemd OnFailure and
      // healthchecks.io. It still prints (json or human) so an operator sees why.
      if (check && !isEnvHealthy(report)) {
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      if (json) {
        yield* printJson(statusToJson(report))
        return
      }
      if (report.models === 0) {
        yield* Console.log(`environment "${env}" does not exist — the first apply creates it`)
        return
      }
      yield* Console.log(
        `environment "${env}": models ${report.models}, promoted ${report.promotedAt}, store schema v${report.storeVersion}`,
      )
      if (report.lastPlan !== null) {
        yield* Console.log(
          `last plan: ${report.lastPlan.appliedAt} (${report.lastPlan.appliedBy || "unknown"})`,
        )
      }
      for (const lag of report.lag) {
        const state =
          lag.missing === 0
            ? `caught up to ${lag.doneUpTo}`
            : `behind by ${lag.missing} interval(s), caught up to ${lag.doneUpTo ?? "—"}`
        const failed = lag.failed > 0 ? `  ⚠ failed intervals: ${lag.failed}` : ""
        yield* Console.log(`  ${lag.missing === 0 ? "✓" : "…"} ${lag.model}  ${state}${failed}`)
      }
      if (report.ticks.length === 0) {
        yield* Console.log("no run ticks yet")
      } else {
        yield* Console.log("recent run ticks:")
        for (const tick of report.ticks) {
          const mark = tick.outcome === "ok" ? "✓" : tick.outcome === "error" ? "✗" : "…"
          const ms = Date.parse(tick.finishedAt) - Date.parse(tick.startedAt)
          const detail = tickDetailText(tick.detail)
          yield* Console.log(
            `  ${mark} ${tick.startedAt}  ${tick.outcome} (${ms} ms)${detail !== "" ? `  ${detail}` : ""}`,
          )
        }
      }
    }),
).pipe(
  Command.withDescription(
    "what is happening in an environment: promotion, lag, run ticks (--json for CI; --check exits non-zero when unhealthy)",
  ),
)
