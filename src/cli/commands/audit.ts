import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { auditEnvironment, EnvironmentAuditError } from "../../plan/audit-run.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag, parseForwardOnly } from "../flags.ts"
import { printJson } from "../json.ts"

export const auditCommand = Command.make(
  "audit",
  {
    env: Argument.string("env"),
    config: configFlag,
    model: Flag.string("model").pipe(
      Flag.withDefault(""),
      Flag.withDescription("only these models, comma-separated (default — all with audits)"),
    ),
    json: jsonFlag,
  },
  ({ config, env, model, json }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const only = parseForwardOnly(model)
      const report = yield* auditEnvironment(env, loaded.models, only).pipe(
        Effect.provide(configLayers(loaded)),
      )
      if (json) {
        // the whole report; the blocking-based exit code is preserved — stdout is pure JSON
        yield* printJson(report)
        if (report.blockingViolations > 0) {
          return yield* new EnvironmentAuditError({
            env,
            blockingViolations: report.blockingViolations,
          })
        }
        return
      }
      if (report.results.length === 0 && report.skipped.length === 0) {
        yield* Console.log("no audits — nothing to check")
        return
      }
      for (const result of report.results) {
        const mark = result.violations === 0 ? "✓" : result.blocking ? "✗" : "⚠"
        const tail =
          result.violations > 0
            ? `  ${result.violations} violations${result.blocking ? "" : " (warn)"}`
            : ""
        yield* Console.log(`  ${mark} ${result.model}  ${result.audit}${tail}`)
        // the numbers, on their own line — a coverage gate that only reports a
        // count makes the operator write the query themselves (#42)
        if (result.detail !== undefined) yield* Console.log(`      ${result.detail}`)
      }
      // printed before the verdict, so "clean" is never read as "everything was
      // checked" — this command sees the environment view, and a perInterval
      // audit is about a window it cannot reconstruct (#53)
      for (const entry of report.skipped) {
        yield* Console.log(`  · ${entry.model}  ${entry.audit}  skipped: interval-scoped`)
      }
      if (report.blockingViolations > 0) {
        return yield* new EnvironmentAuditError({
          env,
          blockingViolations: report.blockingViolations,
        })
      }
      const caveat =
        report.skipped.length === 0
          ? ""
          : ` (${report.skipped.length} interval-scoped audit(s) not checked here — apply checks those)`
      yield* Console.log(`blocking audits of environment "${env}" are clean${caveat}`)
    }),
).pipe(Command.withDescription("run audits over an environment's view layer, changing nothing"))
