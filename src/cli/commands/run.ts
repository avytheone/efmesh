import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { run } from "../../plan/run.ts"
import { configLayers, loadConfig } from "../config.ts"
import {
  configFlag,
  EXIT_AWAITING_HUMAN,
  jobsFlag,
  parseJobs,
  parseRetries,
  retriesFlag,
} from "../flags.ts"

export const runCommand = Command.make(
  "run",
  { env: Argument.string("env"), config: configFlag, jobs: jobsFlag, retries: retriesFlag },
  ({ config, env, jobs, retries }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const modelConcurrency = parseJobs(jobs)
      const retry = parseRetries(retries)
      const applied = yield* run(env, loaded.models, {
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(loaded.ducklake !== undefined ? { ducklake: loaded.ducklake } : {}),
        ...(loaded.attach !== undefined ? { attach: loaded.attach } : {}),
        ...(modelConcurrency !== undefined ? { modelConcurrency } : {}),
        ...(retry !== undefined ? { retry } : {}),
      }).pipe(
        Effect.provide(configLayers(loaded)),
        // structural changes are the normal "awaits a human with apply", not a failure:
        // alerting tells it apart by exit code 2 (F6)
        Effect.catchTag("RunBlockedByChangesError", (blocked) =>
          Effect.gen(function* () {
            yield* Console.error(
              `run "${blocked.env}": unapplied changes present — apply needed:\n  ${blocked.changes.join("\n  ")}`,
            )
            yield* Effect.sync(() => {
              process.exitCode = EXIT_AWAITING_HUMAN
            })
            return undefined
          }),
        ),
      )
      if (applied === undefined) return
      yield* Console.log(
        applied.built.length > 0 ? `processed: ${applied.built.join(", ")}` : "no new intervals",
      )
    }),
).pipe(
  Command.withDescription(
    "scheduler tick: catch up intervals of existing versions (structural changes go through apply; exit 2 = changes await a human)",
  ),
)
