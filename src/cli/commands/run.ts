import { Clock, Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { recordCommandOutcome, writeMetricsFile } from "../../observe/report.ts"
import { run } from "../../plan/run.ts"
import { configLayers, loadConfig } from "../config.ts"
import {
  configFlag,
  EXIT_AWAITING_HUMAN,
  jobsFlag,
  jsonFlag,
  metricsFlag,
  parseJobs,
  parseMetricsPath,
  parseRetries,
  retriesFlag,
} from "../flags.ts"
import { printJson, runToJson } from "../json.ts"

/**
 * A tick that ran and did nothing is a different fact from a tick that did not
 * run — so the outcome is recorded on every path, including exit 2, and the
 * file is written even when nothing was built (#39).
 */
const report = (options: {
  readonly outcome: "ok" | "awaiting-human"
  readonly startedAtMillis: number
  readonly path: string | undefined
}) =>
  Effect.gen(function* () {
    yield* recordCommandOutcome({
      outcome: options.outcome,
      startedAtMillis: options.startedAtMillis,
    })
    if (options.path !== undefined) yield* writeMetricsFile(options.path)
  })

export const runCommand = Command.make(
  "run",
  {
    env: Argument.string("env"),
    config: configFlag,
    jobs: jobsFlag,
    retries: retriesFlag,
    json: jsonFlag,
    metrics: metricsFlag,
  },
  ({ config, env, jobs, json, metrics, retries }) =>
    Effect.gen(function* () {
      const startedAtMillis = yield* Clock.currentTimeMillis
      const metricsPath = parseMetricsPath(metrics)
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
      yield* report({
        outcome: result.blocked ? "awaiting-human" : "ok",
        startedAtMillis,
        path: metricsPath,
      })
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
