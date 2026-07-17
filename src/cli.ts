import { writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Cause, Console, Data, Effect, Layer } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { EfmeshConfig } from "./config.ts"
import { buildGraph } from "./core/graph.ts"
import type { AnyModel } from "./core/model.ts"
import { discoverModels, DiscoveryError, DiscoveryConflictError } from "./discovery.ts"
import { Efmesh } from "./efmesh.ts"
import { scaffold } from "./init.ts"
import { DuckDBEngineLive } from "./engine/duckdb.ts"
import { PostgresEngineLive } from "./engine/postgres.ts"
import { PostgresStateLive } from "./state/postgres.ts"
import { auditEnvironment, EnvironmentAuditError } from "./plan/audit-run.ts"
import {
  dataDiffEnvironments,
  diffEnvironments,
  type DataDiffReport,
} from "./plan/diff.ts"
import { EngineAdapter } from "./engine/adapter.ts"
import { ducklakeAttachSql } from "./plan/naming.ts"
import {
  listSchedules,
  registerSchedule,
  removeSchedule,
  systemdUnits,
} from "./plan/schedule.ts"
import { renderGraphHtml } from "./plan/graph-html.ts"
import { formatLineage, lineage, LineageError } from "./plan/lineage.ts"
import { environmentStatus } from "./plan/status.ts"
import { janitor } from "./plan/janitor.ts"
import { fp8 } from "./plan/naming.ts"
import { envLockName, withStateLock } from "./plan/lock.ts"
import { applyPlan } from "./plan/executor.ts"
import { run } from "./plan/run.ts"
import { planChanges, ReclassifyError, type Plan } from "./plan/planner.ts"
import { migratePostgresState } from "./state/postgres.ts"
import { migrateSqliteState, SqliteStateLive } from "./state/sqlite.ts"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly reason: string
}> {
  override get message(): string {
    return `config ${this.path}: ${this.reason}`
  }
}

/** Config with an already-assembled model list: explicit ones + discovery finds. */
type LoadedConfig = EfmeshConfig & { readonly models: ReadonlyArray<AnyModel> }

const loadConfig = (
  configPath: string,
): Effect.Effect<LoadedConfig, ConfigLoadError | DiscoveryError | DiscoveryConflictError> =>
  Effect.gen(function* () {
    const absolute = NodePath.resolve(process.cwd(), configPath)
    const config = yield* Effect.tryPromise({
      try: async () => {
        const module = (await import(absolute)) as { default?: EfmeshConfig }
        if (
          module.default === undefined ||
          (!Array.isArray(module.default.models) && module.default.discovery === undefined)
        ) {
          throw new Error("config must export a default with models and/or discovery")
        }
        return module.default
      },
      catch: (cause) => new ConfigLoadError({ path: configPath, reason: String(cause) }),
    })
    const explicit = config.models ?? []
    if (config.discovery === undefined) return { ...config, models: explicit }
    // globs are relative to the config: the project is portable regardless of cwd
    const discovered = yield* discoverModels(config.discovery, NodePath.dirname(absolute))
    const seen = new Set(explicit)
    const names = new Map(explicit.map((model) => [model.name.full, "config models"]))
    const merged = [...explicit]
    for (const model of discovered) {
      if (seen.has(model)) continue
      const already = names.get(model.name.full)
      if (already !== undefined) {
        return yield* new DiscoveryConflictError({ name: model.name.full, files: [already, "discovery"] })
      }
      names.set(model.name.full, "discovery")
      merged.push(model)
    }
    return { ...config, models: merged }
  })

/** Engine and state layers from the config — shared by plan/apply. */
const configLayers = (config: EfmeshConfig) =>
  Layer.mergeAll(
    config.engine?.url !== undefined
      ? PostgresEngineLive({
          url: config.engine.url,
          ...(config.engine.max !== undefined ? { max: config.engine.max } : {}),
        })
      : DuckDBEngineLive({ path: config.engine?.path ?? "efmesh.duckdb" }),
    config.state?.url !== undefined
      ? PostgresStateLive({ url: config.state.url })
      : SqliteStateLive({ path: config.state?.path ?? "efmesh.state.sqlite" }),
  )

const configFlag = Flag.string("config").pipe(
  Flag.withDefault("efmesh.config.ts"),
  Flag.withDescription("path to efmesh.config.ts"),
)

const CHANGE_MARK: Record<string, string> = {
  added: "+",
  breaking: "!",
  "non-breaking": "~",
  indirect: "↻",
  "forward-only": "→",
  removed: "-",
  unchanged: "·",
}

const forwardOnlyFlag = Flag.string("forward-only").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "comma-separated models: changes apply forward-only — physics and history are reused",
  ),
)

const reclassifyFlag = Flag.string("reclassify").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    'override categorization (#5): "model=breaking|non-breaking[,…]" on top of --explain; journaled with applied_by',
  ),
)

const jobsFlag = Flag.string("jobs").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "how many models to build at once (DAG concurrency; always 1 on DuckDB)",
  ),
)

const parseJobs = (value: string): number | undefined => {
  const jobs = Number(value)
  return value !== "" && Number.isFinite(jobs) && jobs >= 1 ? Math.floor(jobs) : undefined
}

const retriesFlag = Flag.string("retries").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "how many times to retry a failed backfill batch (exponential backoff; default 0)",
  ),
)

const parseRetries = (value: string): { readonly attempts: number } | undefined => {
  const attempts = Number(value)
  return value !== "" && Number.isFinite(attempts) && attempts >= 1
    ? { attempts: Math.floor(attempts) }
    : undefined
}

const parseForwardOnly = (value: string): ReadonlyArray<string> | undefined => {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  return names.length > 0 ? names : undefined
}

/** `model=breaking|non-breaking[,…]` → record for PlanOptions.reclassify (#5). */
export const parseReclassify = (
  value: string,
): Effect.Effect<Readonly<Record<string, "breaking" | "non-breaking">> | undefined, ReclassifyError> =>
  Effect.gen(function* () {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
    if (entries.length === 0) return undefined
    const parsed: Record<string, "breaking" | "non-breaking"> = {}
    for (const entry of entries) {
      const [model, category, ...extra] = entry.split("=")
      if (
        model === undefined ||
        model === "" ||
        extra.length > 0 ||
        (category !== "breaking" && category !== "non-breaking")
      ) {
        return yield* new ReclassifyError({
          model: entry,
          reason: 'expected "model=breaking" or "model=non-breaking"',
        })
      }
      parsed[model] = category
    }
    return parsed
  })

const yesFlag = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("apply without confirmation; required in a non-TTY when the plan has changes (else exit 2)"),
)

/** Accepts y/yes, case-insensitive; anything else (including empty) is a refusal. */
export const isAffirmative = (answer: string | null): boolean =>
  ["y", "yes"].includes((answer ?? "").trim().toLowerCase())

/**
 * The "work awaits a human" exit code (F6): the plan needs confirmation in a
 * non-TTY, or run hit structural changes. Alerting must distinguish this
 * normal state from real errors (code 1).
 */
export const EXIT_AWAITING_HUMAN = 2

/**
 * The fate of a shown plan (SPEC §5.1, tightened in F6): no changes or
 * --yes — apply; changes in a TTY — ask the human; changes in a
 * non-TTY (CI, cron, pipe) — REFUSE: silently applying a plan nobody
 * saw is forbidden, an explicit --yes is required.
 */
export const decideApply = (
  hasChanges: boolean,
  yes: boolean,
  tty: boolean,
): "apply" | "ask" | "refuse" => (!hasChanges || yes ? "apply" : tty ? "ask" : "refuse")

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("machine-readable output (stable shape — a contract for CI)"),
)

const explainFlag = Flag.boolean("explain").pipe(
  Flag.withDescription(
    "for each change — which canonical AST nodes diverged and why the category is what it is",
  ),
)

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
    ...(action.reclassifiedFrom !== undefined
      ? { reclassifiedFrom: action.reclassifiedFrom }
      : {}),
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

const printJson = (payload: unknown) => Console.log(JSON.stringify(payload, null, 2))

const formatRange = (range: { readonly start: number; readonly end: number }): string =>
  `[${new Date(range.start).toISOString().slice(0, 10)}, ${new Date(range.end).toISOString().slice(0, 10)})`

const printPlan = (plan: Plan, explain = false) =>
  Effect.gen(function* () {
    yield* Console.log(`plan for environment "${plan.env}":`)
    for (const action of plan.actions) {
      const mark = CHANGE_MARK[action.change] ?? "?"
      const overridden =
        action.reclassifiedFrom !== undefined
          ? `  [override: was ${action.reclassifiedFrom}]`
          : ""
      const reused =
        action.change === "indirect" && action.reusedFrom !== undefined
          ? "  [physics reused]"
          : ""
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

const initCommand = Command.make(
  "init",
  { dir: Argument.string("dir").pipe(Argument.withDefault(".")) },
  ({ dir }) =>
    Effect.gen(function* () {
      const created = yield* scaffold(dir)
      for (const file of created) yield* Console.log(`created ${file}`)
      yield* Console.log("next: bunx efmesh plan dev && bunx efmesh apply dev")
    }),
).pipe(Command.withDescription("scaffold a project: config, example models, seed"))

const planCommand = Command.make(
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

const applyCommand = Command.make(
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
        if (
          decision === "ask" &&
          !isAffirmative(globalThis.prompt("apply the plan? [y/N]"))
        ) {
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

const renderCommand = Command.make(
  "render",
  {
    model: Argument.string("model"),
    config: configFlag,
    env: Flag.string("env").pipe(
      Flag.withDefault(""),
      Flag.withDescription("render against an environment's view layer instead of logical names"),
    ),
  },
  ({ config, env, model }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const sql = env === ""
        ? yield* Efmesh.render(loaded.models, model)
        : yield* Efmesh.renderFor(loaded.models, model, env)
      yield* Console.log(sql.trim())
    }),
).pipe(Command.withDescription("show a model's final SQL"))

const runCommand = Command.make(
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
        applied.built.length > 0
          ? `processed: ${applied.built.join(", ")}`
          : "no new intervals",
      )
    }),
).pipe(
  Command.withDescription(
    "scheduler tick: catch up intervals of existing versions (structural changes go through apply; exit 2 = changes await a human)",
  ),
)

const printDataDiff = (report: DataDiffReport) =>
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

const diffCommand = Command.make(
  "diff",
  {
    envA: Argument.string("envA"),
    envB: Argument.string("envB"),
    config: configFlag,
    data: Flag.boolean("data").pipe(
      Flag.withDescription(
        "compare view-layer DATA: row counts, key intersection, per-column divergences",
      ),
    ),
    model: Flag.string("model").pipe(
      Flag.withDefault(""),
      Flag.withDescription("only these models, comma-separated (for --data)"),
    ),
    sample: Flag.string("sample").pipe(
      Flag.withDefault(""),
      Flag.withDescription(
        "percent 1–99: compare a deterministic fraction of keys (md5 buckets; for --data)",
      ),
    ),
    json: jsonFlag,
  },
  ({ config, data, envA, envB, json, model, sample }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      if (data) {
        const only = parseForwardOnly(model)
        const percent = sample === "" ? undefined : Number(sample)
        if (percent !== undefined && !(Number.isFinite(percent) && percent >= 1 && percent <= 99)) {
          yield* Console.error("--sample expects a percent from 1 to 99")
          return yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }
        const report = yield* Effect.gen(function* () {
          // ducklake marts are visible via ATTACH — the same way apply does it
          if (loaded.ducklake !== undefined) {
            const engine = yield* EngineAdapter
            yield* engine.execute(ducklakeAttachSql(loaded.ducklake))
          }
          return yield* dataDiffEnvironments(envA, envB, loaded.models, {
            ...(only !== undefined ? { models: only } : {}),
            ...(percent !== undefined ? { samplePercent: percent } : {}),
          })
        }).pipe(Effect.provide(configLayers(loaded)))
        yield* json ? printJson(report) : printDataDiff(report)
        return
      }
      const diff = yield* diffEnvironments(envA, envB).pipe(
        Effect.provide(configLayers(loaded)),
      )
      if (json) {
        yield* printJson(diff)
        return
      }
      for (const name of diff.onlyInA) yield* Console.log(`< ${name}  only in ${envA}`)
      for (const name of diff.onlyInB) yield* Console.log(`> ${name}  only in ${envB}`)
      for (const entry of diff.different) {
        yield* Console.log(`≠ ${entry.name}  ${envA}@${entry.a} vs ${envB}@${entry.b}`)
      }
      if (diff.onlyInA.length + diff.onlyInB.length + diff.different.length === 0) {
        yield* Console.log("environments are identical")
      }
    }),
).pipe(
  Command.withDescription("how environments differ: versions (state store) or --data (row data)"),
)

const scheduleCommand = Command.make(
  "schedule",
  {
    env: Argument.string("env").pipe(Argument.withDefault("")),
    config: configFlag,
    cron: Flag.string("cron").pipe(
      Flag.withDefault("@hourly"),
      Flag.withDescription("cron expression or nickname (@hourly, @daily, …)"),
    ),
    remove: Flag.boolean("remove").pipe(
      Flag.withDescription("unregister the environment from the OS scheduler"),
    ),
    list: Flag.boolean("list").pipe(
      Flag.withDescription("list efmesh entries in the OS scheduler"),
    ),
    printSystemd: Flag.boolean("print-systemd").pipe(
      Flag.withDescription(
        "print systemd user units instead of cron (Persistent=true catches up misses; a lifeline without a cron daemon)",
      ),
    ),
  },
  ({ config, cron, env, list, printSystemd, remove }) =>
    Effect.gen(function* () {
      if (list) {
        const entries = yield* listSchedules()
        if (entries.length === 0) yield* Console.log("no efmesh entries in the OS scheduler")
        for (const entry of entries) yield* Console.log(`  ${entry}`)
        return
      }
      if (env === "") {
        yield* Console.error("environment required: efmesh schedule <env> [--cron …]")
        return yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      const configAbs = NodePath.resolve(process.cwd(), config)
      const target = { project: NodePath.dirname(configAbs), config: configAbs, env }
      if (printSystemd) {
        const units = systemdUnits(target, cron)
        yield* Console.log(`# ~/.config/systemd/user/${units.name}.service`)
        yield* Console.log(units.service)
        yield* Console.log(`# ~/.config/systemd/user/${units.name}.timer`)
        yield* Console.log(units.timer)
        yield* Console.log(
          `# enable: systemctl --user daemon-reload && systemctl --user enable --now ${units.name}.timer`,
        )
        return
      }
      if (remove) {
        const removed = yield* removeSchedule(target)
        yield* Console.log(`unregistered: ${removed.title}`)
        return
      }
      const registered = yield* registerSchedule(target, cron)
      yield* Console.log(`registered: ${registered.title} — "${cron}" (OS scheduler)`)
      yield* Console.log(`worker: ${registered.worker}`)
      yield* Console.log(
        "tick journal: efmesh status " + env + "; NB: cron does not catch up missed runs — a systemd timer is stricter (--print-systemd)",
      )
    }).pipe(
      // reason is the most valuable part (a recipe for the operator): surface it in words, not a stacktrace
      Effect.catchTag("ScheduleError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`schedule: ${error.reason}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "register run <env> in the OS scheduler (Bun.cron: crontab/launchd/Task Scheduler)",
  ),
)

const janitorCommand = Command.make(
  "janitor",
  {
    config: configFlag,
    ttl: Flag.string("ttl").pipe(
      Flag.withDefault("7"),
      Flag.withDescription("how many days orphaned physics lives before removal"),
    ),
  },
  ({ config, ttl }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* janitor({
        ttlDays: Number(ttl),
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(loaded.ducklake !== undefined ? { ducklake: loaded.ducklake } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
      yield* Console.log(
        report.removed.length > 0
          ? `removed: ${report.removed.join(", ")}`
          : "no orphaned physics older than ttl",
      )
      if (report.kept.length > 0) {
        yield* Console.log(`orphaned but younger than ttl: ${report.kept.join(", ")}`)
      }
    }),
).pipe(Command.withDescription("remove physics no environment references"))

const statusCommand = Command.make(
  "status",
  { env: Argument.string("env"), config: configFlag, json: jsonFlag },
  ({ config, env, json }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* environmentStatus(env, loaded.models).pipe(
        Effect.provide(configLayers(loaded)),
      )
      if (json) {
        yield* printJson(report)
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
).pipe(
  Command.withDescription("what is happening in an environment: promotion, lag, run ticks"),
)

const auditCommand = Command.make(
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
      if (report.results.length === 0) {
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
      }
      if (report.blockingViolations > 0) {
        return yield* new EnvironmentAuditError({
          env,
          blockingViolations: report.blockingViolations,
        })
      }
      yield* Console.log(`blocking audits of environment "${env}" are clean`)
    }),
).pipe(
  Command.withDescription("run audits over an environment's view layer, changing nothing"),
)

const migrateCommand = Command.make(
  "migrate",
  { config: configFlag },
  ({ config }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* (loaded.state?.url !== undefined
        ? migratePostgresState({ url: loaded.state.url })
        : migrateSqliteState({ path: loaded.state?.path ?? "efmesh.state.sqlite" }))
      yield* Console.log(
        report.from === report.to
          ? `state store already at version ${report.to}`
          : `state store: version ${report.from} → ${report.to}`,
      )
      if (report.backup !== undefined) {
        yield* Console.log(`backup of the old store: ${report.backup}`)
      }
    }),
).pipe(Command.withDescription("bring the state store schema up to the current version"))

const graphCommand = Command.make(
  "graph",
  {
    config: configFlag,
    html: Flag.string("html").pipe(
      Flag.withDefault(""),
      Flag.withDescription("write the DAG as a self-contained HTML page at the given path"),
    ),
  },
  ({ config, html }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const graph = yield* buildGraph(loaded.models)
      if (html !== "") {
        yield* Effect.sync(() => writeFileSync(html, renderGraphHtml(graph)))
        yield* Console.log(`DAG written: ${html}`)
        return
      }
      for (const name of graph.order) {
        const model = graph.models.get(name)!
        const deps = model.deps.size > 0 ? `  ←  ${[...model.deps].sort().join(", ")}` : ""
        yield* Console.log(`${name} (${model.kind._tag})${deps}`)
      }
    }),
).pipe(Command.withDescription("the model DAG in topological order (or an --html file)"))

const lineageCommand = Command.make(
  "lineage",
  { target: Argument.string("model[.column]"), config: configFlag },
  ({ config, target }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const segments = target.split(".")
      if (segments.length < 2) {
        return yield* new LineageError({
          model: target,
          reason: "expected <schema>.<table>[.<column>]",
        })
      }
      const modelName = `${segments[0]}.${segments[1]}`
      const graph = yield* buildGraph(loaded.models)
      const model = graph.models.get(modelName)
      if (model === undefined) {
        return yield* new LineageError({ model: modelName, reason: "model is not in the project" })
      }
      const columns =
        segments.length >= 3 ? [segments.slice(2).join(".")] : Object.keys(model.schema.fields)
      for (const column of columns) {
        const tree = yield* lineage(graph, modelName, column).pipe(
          Effect.provide(configLayers(loaded)),
        )
        for (const line of formatLineage(tree)) yield* Console.log(line)
      }
    }),
).pipe(Command.withDescription("column lineage down to raw columns (best-effort)"))

/**
 * Actionable next step for a failure, when one exists — the recipe the
 * `schedule` command already prints for a missing cron daemon, generalized to
 * every error that has one obvious cure (#13). No entry ⇒ the message already
 * says everything; we do not invent filler advice.
 */
const FAILURE_HINTS: Readonly<Record<string, (error: Record<string, unknown>) => string>> = {
  StateSchemaError: () => "run `efmesh migrate` to bring the state store up to date",
  FingerprintVersionError: () => "run `efmesh migrate` or upgrade efmesh, then re-apply",
  LockHeldError: (error) =>
    `wait for the other apply/run to finish, or clear the stale lock «${String(error["name"])}»`,
  LakeNotConfiguredError: () => "add `lake: { path: … }` to efmesh.config.ts",
  DucklakeNotConfiguredError: () => "add `ducklake: { catalog: … }` to efmesh.config.ts",
  AttachNotConfiguredError: (error) =>
    `add «${String(error["attach"])}» to \`attach\` in efmesh.config.ts`,
  ConfigLoadError: () =>
    "check the --config path and that it default-exports defineConfig({ … })",
  RunBlockedByChangesError: (error) => `run \`efmesh apply ${String(error["env"])}\``,
}

/** First line of a rendered failure: the tag names the class, the message the culprit + cause. */
const errorHeadline = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>
    const message = record["message"]
    const detail = typeof message === "string" && message !== "" ? message : "(no detail)"
    return `${String(record["_tag"])}: ${detail}`
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message !== "" ? error.message : "(no detail)"}`
  }
  return String(error)
}

/**
 * The single failure renderer (#13): cause first (the tagged error's derived
 * message names the culprit), an actionable hint where one exists, and the
 * Effect fiber trace ONLY under `--log-level debug` — an operator or agent
 * sees one screen with the real cause, not a stack over an empty message. The
 * exit code stays a frozen contract (0/1/2): the caller sets it, not this.
 */
export const renderFailure = (
  cause: Cause.Cause<unknown>,
  options?: { readonly debug?: boolean },
): string => {
  const error = Cause.squash(cause)
  const lines = [errorHeadline(error)]
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as Record<string, unknown>)["_tag"])
      : ""
  const hint = FAILURE_HINTS[tag]?.(error as Record<string, unknown>)
  if (hint !== undefined) lines.push(`  → ${hint}`)
  if (options?.debug === true) {
    lines.push("", "── trace (--log-level debug) ──", Cause.pretty(cause))
  } else {
    lines.push("  (re-run with --log-level debug for the full trace)")
  }
  return lines.join("\n")
}

/**
 * Whether the run asked for the full trace. Reused from the already-parsed
 * global `--log-level` flag (values trace/debug/all mean "show me everything")
 * so there is one knob, not a second bespoke verbosity flag.
 */
export const wantsTrace = (argv: ReadonlyArray<string>): boolean => {
  const verbose = new Set(["trace", "debug", "all"])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg.startsWith("--log-level=")) return verbose.has(arg.slice("--log-level=".length))
    if (arg === "--log-level") return verbose.has((argv[index + 1] ?? "").toLowerCase())
  }
  return false
}

export const rootCommand = Command.make("efmesh").pipe(
  Command.withDescription("sqlmesh on bun, typescript and Effect"),
  Command.withSubcommands([
    initCommand,
    planCommand,
    applyCommand,
    runCommand,
    statusCommand,
    auditCommand,
    renderCommand,
    graphCommand,
    lineageCommand,
    diffCommand,
    scheduleCommand,
    janitorCommand,
    migrateCommand,
  ]),
)
