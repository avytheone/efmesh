import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { restate } from "../../plan/restate.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { printJson, restateToJson } from "../json.ts"

export const restateCommand = Command.make(
  "restate",
  {
    env: Argument.String("env"),
    config: configFlag,
    model: Flag.String("model").pipe(
      Flag.withDefault(""),
      Flag.withDescription("the incrementalByTimeRange model to replay (its descendants cascade)"),
    ),
    from: Flag.String("from").pipe(
      Flag.withDefault(""),
      Flag.withDescription("range start, ISO UTC, aligned to the model's grain (inclusive)"),
    ),
    to: Flag.String("to").pipe(
      Flag.withDefault(""),
      Flag.withDescription("range end, ISO UTC, aligned to the model's grain (exclusive)"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("show what would be recomputed and change nothing (takes no lock)"),
    ),
    json: jsonFlag,
  },
  ({ config, dryRun, env, from, json, model, to }) =>
    Effect.gen(function* () {
      if (model === "" || from === "" || to === "") {
        yield* Console.error("restate needs --model, --from and --to")
        return yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      const loaded = yield* loadConfig(config)
      const plan = yield* restate(env, model, from, to, loaded.models, {
        ...(dryRun ? { dryRun: true } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))

      if (json) {
        yield* printJson(restateToJson(plan))
        return
      }

      const verb = plan.dryRun ? "would recompute" : "cleared for recompute"
      yield* Console.log(
        `restate${plan.dryRun ? " (dry-run)" : ""} «${plan.model}» in ${plan.env} ` +
          `[${new Date(plan.from).toISOString()}, ${new Date(plan.to).toISOString()})`,
      )
      for (const target of plan.targets) {
        yield* Console.log(
          `  ${target.name} @${target.fingerprint.slice(0, 8)} — ${target.intervals.length} interval(s) ${verb}`,
        )
      }
      yield* Console.log(
        plan.dryRun
          ? `run without --dry-run, then \`efmesh apply ${plan.env}\` (or \`efmesh run ${plan.env}\`) to recompute`
          : `run \`efmesh apply ${plan.env}\` (or \`efmesh run ${plan.env}\`) to recompute the cleared intervals`,
      )
    }),
).pipe(
  Command.withDescription(
    "replay a past time range of an incrementalByTimeRange model and its descendants: clear the range's " +
      "done-intervals so the next plan/apply/run recomputes them (--dry-run previews; --json for CI)",
  ),
)
