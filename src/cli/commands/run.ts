import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { run } from "../../plan/run.ts"
import { configLayers, loadConfig } from "../config.ts"
import {
  configFlag,
  EXIT_AWAITING_HUMAN,
  jobsFlag,
  jsonFlag,
  parseJobs,
  parseRetries,
  retriesFlag,
} from "../flags.ts"
import { printJson, runToJson } from "../json.ts"

export const runCommand = Command.make(
  "run",
  {
    env: Argument.string("env"),
    config: configFlag,
    jobs: jobsFlag,
    retries: retriesFlag,
    json: jsonFlag,
  },
  ({ config, env, jobs, json, retries }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const modelConcurrency = parseJobs(jobs)
      const retry = parseRetries(retries)
      const result = yield* run(env, loaded.models, {
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(loaded.ducklake !== undefined ? { ducklake: loaded.ducklake } : {}),
        ...(loaded.attach !== undefined ? { attach: loaded.attach } : {}),
        ...(modelConcurrency !== undefined ? { modelConcurrency } : {}),
        ...(retry !== undefined ? { retry } : {}),
      }).pipe(
        Effect.map((applied) => ({ blocked: false as const, applied })),
        Effect.provide(configLayers(loaded)),
        // structural changes are the normal "awaits a human with apply", not a failure:
        // alerting tells it apart by exit code 2 (F6). --json still emits the
        // payload on exit 2 so a bot reads why the tick did not advance.
        Effect.catchTag("RunBlockedByChangesError", (blocked) =>
          Effect.gen(function* () {
            if (!json) {
              yield* Console.error(
                `run "${blocked.env}": unapplied changes present — apply needed:\n  ${blocked.changes.join("\n  ")}`,
              )
            }
            yield* Effect.sync(() => {
              process.exitCode = EXIT_AWAITING_HUMAN
            })
            return { blocked: true as const, changes: blocked.changes }
          }),
        ),
      )
      if (result.blocked) {
        if (json) {
          yield* printJson(
            runToJson({ env, outcome: "awaiting-human", processed: [], blockedBy: result.changes }),
          )
        }
        return
      }
      if (json) {
        yield* printJson(runToJson({ env, outcome: "ok", processed: result.applied.built }))
        return
      }
      yield* Console.log(
        result.applied.built.length > 0
          ? `processed: ${result.applied.built.join(", ")}`
          : "no new intervals",
      )
    }),
).pipe(
  Command.withDescription(
    "scheduler tick: catch up intervals of existing versions (--json for CI; structural changes go through apply; exit 2 = changes await a human)",
  ),
)
