import { writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Console, Data, Effect, Layer } from "effect"
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
import { diffEnvironments } from "./plan/diff.ts"
import { renderGraphHtml } from "./plan/graph-html.ts"
import { formatLineage, lineage, LineageError } from "./plan/lineage.ts"
import { environmentStatus } from "./plan/status.ts"
import { janitor } from "./plan/janitor.ts"
import { fp8 } from "./plan/naming.ts"
import { envLockName, withStateLock } from "./plan/lock.ts"
import { applyPlan } from "./plan/executor.ts"
import { run } from "./plan/run.ts"
import { planChanges, type Plan } from "./plan/planner.ts"
import { migratePostgresState } from "./state/postgres.ts"
import { migrateSqliteState, SqliteStateLive } from "./state/sqlite.ts"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly reason: string
}> {}

/** Конфиг с уже собранным списком моделей: явные + найденные discovery. */
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
          throw new Error("конфиг должен экспортировать default с models и/или discovery")
        }
        return module.default
      },
      catch: (cause) => new ConfigLoadError({ path: configPath, reason: String(cause) }),
    })
    const explicit = config.models ?? []
    if (config.discovery === undefined) return { ...config, models: explicit }
    // маски — относительно конфига: проект переносим независимо от cwd
    const discovered = yield* discoverModels(config.discovery, NodePath.dirname(absolute))
    const seen = new Set(explicit)
    const names = new Map(explicit.map((model) => [model.name.full, "models в конфиге"]))
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

/** Слои движка и состояния из конфига — общие для plan/apply. */
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
  Flag.withDescription("Путь к efmesh.config.ts"),
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
    "Модели через запятую: изменения применяются forward-only — физика и история переиспользуются",
  ),
)

const jobsFlag = Flag.string("jobs").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "Сколько моделей строить одновременно (DAG-конкурентность; на DuckDB всегда 1)",
  ),
)

const parseJobs = (value: string): number | undefined => {
  const jobs = Number(value)
  return value !== "" && Number.isFinite(jobs) && jobs >= 1 ? Math.floor(jobs) : undefined
}

const retriesFlag = Flag.string("retries").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "Сколько раз ретраить упавший батч бэкфилла (экспоненциальная пауза; по умолчанию 0)",
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

const yesFlag = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Применить без подтверждения (не-TTY подтверждения не спрашивает)"),
)

/** y/yes/д/да — регистронезависимо; всё остальное (включая пусто) — отказ. */
export const isAffirmative = (answer: string | null): boolean =>
  ["y", "yes", "д", "да"].includes((answer ?? "").trim().toLowerCase())

/**
 * Exit-код «работа ждёт человека» (F6): план требует подтверждения в не-TTY
 * или run упёрся в структурные изменения. Алертинг обязан отличать это
 * штатное состояние от настоящих ошибок (код 1).
 */
export const EXIT_AWAITING_HUMAN = 2

/**
 * Судьба показанного плана (SPEC §5.1, ужесточено в F6): без изменений или
 * с --yes — применять; изменения в TTY — спросить человека; изменения в
 * не-TTY (CI, cron, пайп) — ОТКАЗ: молча применять план, который никто не
 * видел, нельзя, нужен явный --yes.
 */
export const decideApply = (
  hasChanges: boolean,
  yes: boolean,
  tty: boolean,
): "apply" | "ask" | "refuse" => (!hasChanges || yes ? "apply" : tty ? "ask" : "refuse")

const formatRange = (range: { readonly start: number; readonly end: number }): string =>
  `[${new Date(range.start).toISOString().slice(0, 10)} … ${new Date(range.end).toISOString().slice(0, 10)})`

const printPlan = (plan: Plan) =>
  Effect.gen(function* () {
    yield* Console.log(`план для окружения «${plan.env}»:`)
    for (const action of plan.actions) {
      const mark = CHANGE_MARK[action.change] ?? "?"
      const build = action.build ? "  [сборка]" : ""
      const backfill =
        action.backfill.length > 0
          ? `  бэкфилл ${action.backfill.map(formatRange).join(", ")}`
          : ""
      yield* Console.log(
        `  ${mark} ${action.name}  ${action.change} @${fp8(action.fingerprint)}${build}${backfill}`,
      )
    }
    if (!plan.hasChanges) yield* Console.log("  изменений нет")
  })

const initCommand = Command.make(
  "init",
  { dir: Argument.string("dir").pipe(Argument.withDefault(".")) },
  ({ dir }) =>
    Effect.gen(function* () {
      const created = yield* scaffold(dir)
      for (const file of created) yield* Console.log(`создан ${file}`)
      yield* Console.log("дальше: bunx efmesh plan dev && bunx efmesh apply dev")
    }),
).pipe(Command.withDescription("Скаффолд проекта: конфиг, модели-пример, seed"))

const planCommand = Command.make(
  "plan",
  { env: Argument.string("env"), config: configFlag, forwardOnly: forwardOnlyFlag },
  ({ config, env, forwardOnly }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const names = parseForwardOnly(forwardOnly)
      const plan = yield* Efmesh.plan(env, loaded.models, {
        ...(names !== undefined ? { forwardOnly: names } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
      yield* printPlan(plan)
    }),
).pipe(Command.withDescription("Показать diff проекта против окружения, ничего не меняя"))

const applyCommand = Command.make(
  "apply",
  {
    env: Argument.string("env"),
    config: configFlag,
    forwardOnly: forwardOnlyFlag,
    jobs: jobsFlag,
    retries: retriesFlag,
    yes: yesFlag,
  },
  ({ config, env, forwardOnly, jobs, retries, yes }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const names = parseForwardOnly(forwardOnly)
      const modelConcurrency = parseJobs(jobs)
      const retry = parseRetries(retries)
      // план и применение — под одним слоем и одним межпроцессным локом:
      // применяется ровно тот план, который показан и подтверждён, и никто
      // (второй apply, cron с run) не вклинится между ними (SPEC §14.6);
      // цена — лок держится и пока человек думает над подтверждением
      yield* Effect.gen(function* () {
        const graph = yield* buildGraph(loaded.models)
        const plan = yield* planChanges(env, graph, {
          ...(names !== undefined ? { forwardOnly: names } : {}),
        })
        yield* printPlan(plan)
        const decision = decideApply(plan.hasChanges, yes, process.stdin.isTTY === true)
        if (decision === "refuse") {
          yield* Console.error(
            "план меняет модели, а подтвердить некому (не-TTY): добавьте --yes",
          )
          yield* Effect.sync(() => {
            process.exitCode = EXIT_AWAITING_HUMAN
          })
          return
        }
        if (
          decision === "ask" &&
          !isAffirmative(globalThis.prompt("применить план? [y/N]"))
        ) {
          yield* Console.log("применение отменено")
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
            ? `собрано: ${applied.built.join(", ")}`
            : "сборка не потребовалась (только view-swap)",
        )
        yield* Console.log(`окружение «${applied.plan.env}» промоутнуто`)
      }).pipe(withStateLock(envLockName(env)), Effect.provide(configLayers(loaded)))
    }),
).pipe(Command.withDescription("Применить план: собрать физику и переключить view"))

const renderCommand = Command.make(
  "render",
  {
    model: Argument.string("model"),
    config: configFlag,
    env: Flag.string("env").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Рендер против view-слоя окружения вместо логических имён"),
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
).pipe(Command.withDescription("Показать итоговый SQL модели"))

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
        // структурные изменения — штатное «ждёт человека с apply», не сбой:
        // алертинг различает по exit-коду 2 (F6)
        Effect.catchTag("RunBlockedByChangesError", (blocked) =>
          Effect.gen(function* () {
            yield* Console.error(
              `run ${blocked.env}: есть неприменённые изменения — нужен apply:\n  ${blocked.changes.join("\n  ")}`,
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
          ? `обработано: ${applied.built.join(", ")}`
          : "новых интервалов нет",
      )
    }),
).pipe(
  Command.withDescription(
    "Тик планировщика: догнать интервалы существующих версий (изменения — через apply)",
  ),
)

const diffCommand = Command.make(
  "diff",
  { envA: Argument.string("envA"), envB: Argument.string("envB"), config: configFlag },
  ({ config, envA, envB }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const diff = yield* diffEnvironments(envA, envB).pipe(
        Effect.provide(configLayers(loaded)),
      )
      for (const name of diff.onlyInA) yield* Console.log(`< ${name}  только в ${envA}`)
      for (const name of diff.onlyInB) yield* Console.log(`> ${name}  только в ${envB}`)
      for (const entry of diff.different) {
        yield* Console.log(`≠ ${entry.name}  ${envA}@${entry.a} vs ${envB}@${entry.b}`)
      }
      if (diff.onlyInA.length + diff.onlyInB.length + diff.different.length === 0) {
        yield* Console.log("окружения идентичны")
      }
    }),
).pipe(Command.withDescription("Чем окружения отличаются (по state store)"))

const janitorCommand = Command.make(
  "janitor",
  {
    config: configFlag,
    ttl: Flag.string("ttl").pipe(
      Flag.withDefault("7"),
      Flag.withDescription("Сколько дней осиротевшая физика живёт до сноса"),
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
          ? `снесено: ${report.removed.join(", ")}`
          : "осиротевшей физики старше ttl нет",
      )
      if (report.kept.length > 0) {
        yield* Console.log(`осиротело, но моложе ttl: ${report.kept.join(", ")}`)
      }
    }),
).pipe(Command.withDescription("Убрать физику, на которую не ссылается ни одно окружение"))

const statusCommand = Command.make(
  "status",
  { env: Argument.string("env"), config: configFlag },
  ({ config, env }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* environmentStatus(env, loaded.models).pipe(
        Effect.provide(configLayers(loaded)),
      )
      if (report.models === 0) {
        yield* Console.log(`окружение «${env}» не существует — его создаст первый apply`)
        return
      }
      yield* Console.log(
        `окружение «${env}»: моделей ${report.models}, промоушен ${report.promotedAt}, схема стора v${report.storeVersion}`,
      )
      if (report.lastPlan !== null) {
        yield* Console.log(
          `последний план: ${report.lastPlan.appliedAt} (${report.lastPlan.appliedBy || "неизвестно"})`,
        )
      }
      for (const lag of report.lag) {
        const state =
          lag.missing === 0
            ? `догнано до ${lag.doneUpTo}`
            : `отстаёт на ${lag.missing} интервал(ов), догнано до ${lag.doneUpTo ?? "—"}`
        const failed = lag.failed > 0 ? `  ⚠ failed-интервалов: ${lag.failed}` : ""
        yield* Console.log(`  ${lag.missing === 0 ? "✓" : "…"} ${lag.model}  ${state}${failed}`)
      }
      if (report.ticks.length === 0) {
        yield* Console.log("тиков run ещё не было")
      } else {
        yield* Console.log("последние тики run:")
        for (const tick of report.ticks) {
          const mark = tick.outcome === "ok" ? "✓" : tick.outcome === "error" ? "✗" : "…"
          const ms = Date.parse(tick.finishedAt) - Date.parse(tick.startedAt)
          yield* Console.log(
            `  ${mark} ${tick.startedAt}  ${tick.outcome} (${ms} мс)${tick.detail !== "" ? `  ${tick.detail}` : ""}`,
          )
        }
      }
    }),
).pipe(
  Command.withDescription("Что происходит в окружении: промоушен, отставание, тики run"),
)

const auditCommand = Command.make(
  "audit",
  {
    env: Argument.string("env"),
    config: configFlag,
    model: Flag.string("model").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Только эти модели, через запятую (по умолчанию — все с аудитами)"),
    ),
  },
  ({ config, env, model }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const only = parseForwardOnly(model)
      const report = yield* auditEnvironment(env, loaded.models, only).pipe(
        Effect.provide(configLayers(loaded)),
      )
      if (report.results.length === 0) {
        yield* Console.log("аудитов нет — нечего проверять")
        return
      }
      for (const result of report.results) {
        const mark = result.violations === 0 ? "✓" : result.blocking ? "✗" : "⚠"
        const tail =
          result.violations > 0
            ? `  ${result.violations} нарушений${result.blocking ? "" : " (warn)"}`
            : ""
        yield* Console.log(`  ${mark} ${result.model}  ${result.audit}${tail}`)
      }
      if (report.blockingViolations > 0) {
        return yield* new EnvironmentAuditError({
          env,
          blockingViolations: report.blockingViolations,
        })
      }
      yield* Console.log(`blocking-аудиты окружения «${env}» чисты`)
    }),
).pipe(
  Command.withDescription("Прогнать аудиты по view-слою окружения, ничего не меняя"),
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
          ? `state store уже на версии ${report.to}`
          : `state store: версия ${report.from} → ${report.to}`,
      )
      if (report.backup !== undefined) {
        yield* Console.log(`копия старого стора: ${report.backup}`)
      }
    }),
).pipe(Command.withDescription("Догнать схему state store до текущей версии"))

const graphCommand = Command.make(
  "graph",
  {
    config: configFlag,
    html: Flag.string("html").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Записать DAG самодостаточной HTML-страницей по указанному пути"),
    ),
  },
  ({ config, html }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const graph = yield* buildGraph(loaded.models)
      if (html !== "") {
        yield* Effect.sync(() => writeFileSync(html, renderGraphHtml(graph)))
        yield* Console.log(`DAG записан: ${html}`)
        return
      }
      for (const name of graph.order) {
        const model = graph.models.get(name)!
        const deps = model.deps.size > 0 ? `  ←  ${[...model.deps].sort().join(", ")}` : ""
        yield* Console.log(`${name} (${model.kind._tag})${deps}`)
      }
    }),
).pipe(Command.withDescription("DAG моделей в топологическом порядке (или --html файл)"))

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
          reason: "ожидается <схема>.<таблица>[.<колонка>]",
        })
      }
      const modelName = `${segments[0]}.${segments[1]}`
      const graph = yield* buildGraph(loaded.models)
      const model = graph.models.get(modelName)
      if (model === undefined) {
        return yield* new LineageError({ model: modelName, reason: "модели нет в проекте" })
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
).pipe(Command.withDescription("Колоночный lineage до сырьевых колонок (best-effort)"))

export const rootCommand = Command.make("efmesh").pipe(
  Command.withDescription("sqlmesh на bun, typescript и Effect"),
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
    janitorCommand,
    migrateCommand,
  ]),
)
