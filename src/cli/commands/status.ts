import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { environmentStatus } from "../../plan/status.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { printJson, statusToJson } from "../json.ts"

export const statusCommand = Command.make(
  "status",
  { env: Argument.string("env"), config: configFlag, json: jsonFlag },
  ({ config, env, json }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* environmentStatus(env, loaded.models).pipe(
        Effect.provide(configLayers(loaded)),
      )
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
          yield* Console.log(
            `  ${mark} ${tick.startedAt}  ${tick.outcome} (${ms} ms)${tick.detail !== "" ? `  ${tick.detail}` : ""}`,
          )
        }
      }
    }),
).pipe(Command.withDescription("what is happening in an environment: promotion, lag, run ticks"))
