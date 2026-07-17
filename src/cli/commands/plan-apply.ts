import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { buildGraph } from "../../core/graph.ts"
import { Efmesh } from "../../efmesh.ts"
import { applyPlan } from "../../plan/executor.ts"
import { envLockName, withStateLock } from "../../plan/lock.ts"
import { planChanges } from "../../plan/planner.ts"
import { configLayers, loadConfig } from "../config.ts"
import {
  configFlag,
  decideApply,
  EXIT_AWAITING_HUMAN,
  explainFlag,
  forwardOnlyFlag,
  isAffirmative,
  jobsFlag,
  jsonFlag,
  parseForwardOnly,
  parseJobs,
  parseReclassify,
  parseRetries,
  reclassifyFlag,
  retriesFlag,
  yesFlag,
} from "../flags.ts"
import { planToJson, printJson } from "../json.ts"
import { printPlan } from "../print.ts"

export const planCommand = Command.make(
  "plan",
  {
    env: Argument.string("env"),
    config: configFlag,
    forwardOnly: forwardOnlyFlag,
    reclassify: reclassifyFlag,
    json: jsonFlag,
    explain: explainFlag,
  },
  ({ config, env, explain, forwardOnly, json, reclassify }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const names = parseForwardOnly(forwardOnly)
      const overrides = yield* parseReclassify(reclassify)
      const plan = yield* Efmesh.plan(env, loaded.models, {
        ...(names !== undefined ? { forwardOnly: names } : {}),
        ...(overrides !== undefined ? { reclassify: overrides } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
      yield* json ? printJson(planToJson(plan)) : printPlan(plan, explain)
    }),
).pipe(Command.withDescription("show the project diff against an environment, changing nothing"))

export const applyCommand = Command.make(
  "apply",
  {
    env: Argument.string("env"),
    config: configFlag,
    forwardOnly: forwardOnlyFlag,
    reclassify: reclassifyFlag,
    jobs: jobsFlag,
    retries: retriesFlag,
    yes: yesFlag,
  },
  ({ config, env, forwardOnly, jobs, reclassify, retries, yes }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const names = parseForwardOnly(forwardOnly)
      const overrides = yield* parseReclassify(reclassify)
      const modelConcurrency = parseJobs(jobs)
      const retry = parseRetries(retries)
      // plan and apply — under one layer and one cross-process lock:
      // exactly the plan that was shown and confirmed gets applied, and no one
      // (a second apply, cron with run) wedges in between them (SPEC §14.6);
      // the cost — the lock is held even while the human ponders confirmation
      yield* Effect.gen(function* () {
        const graph = yield* buildGraph(loaded.models)
        const plan = yield* planChanges(env, graph, {
          ...(names !== undefined ? { forwardOnly: names } : {}),
          ...(overrides !== undefined ? { reclassify: overrides } : {}),
        })
        yield* printPlan(plan)
        const decision = decideApply(plan.hasChanges, yes, process.stdin.isTTY === true)
        if (decision === "refuse") {
          yield* Console.error(
            "the plan changes models but there is no one to confirm (non-TTY): add --yes",
          )
          yield* Effect.sync(() => {
            process.exitCode = EXIT_AWAITING_HUMAN
          })
          return
        }
        if (decision === "ask" && !isAffirmative(globalThis.prompt("apply the plan? [y/N]"))) {
          yield* Console.log("apply cancelled")
          return
        }
        const applied = yield* applyPlan(plan, graph, {
          ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
          ...(loaded.ducklake !== undefined ? { ducklake: loaded.ducklake } : {}),
          ...(loaded.attach !== undefined ? { attach: loaded.attach } : {}),
          ...(modelConcurrency !== undefined ? { modelConcurrency } : {}),
          ...(retry !== undefined ? { retry } : {}),
        })
        yield* Console.log(
          applied.built.length > 0
            ? `built: ${applied.built.join(", ")}`
            : "no build needed (view-swap only)",
        )
        yield* Console.log(`environment "${applied.plan.env}" promoted`)
      }).pipe(withStateLock(envLockName(env)), Effect.provide(configLayers(loaded)))
    }),
).pipe(
  Command.withDescription(
    "apply the plan: build physics and swap views (a non-TTY with changes needs --yes; exit 2 = awaiting confirmation)",
  ),
)
