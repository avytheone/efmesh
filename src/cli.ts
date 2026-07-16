import * as NodePath from "node:path"
import { Console, Data, Effect, Layer } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { EfmeshConfig } from "./config.ts"
import { buildGraph } from "./core/graph.ts"
import { Efmesh } from "./efmesh.ts"
import { DuckDBEngineLive } from "./engine/duckdb.ts"
import { diffEnvironments } from "./plan/diff.ts"
import { janitor } from "./plan/janitor.ts"
import { fp8 } from "./plan/naming.ts"
import { run } from "./plan/run.ts"
import type { Plan } from "./plan/planner.ts"
import { SqliteStateLive } from "./state/sqlite.ts"

export class ConfigLoadError extends Data.TaggedError("ConfigLoadError")<{
  readonly path: string
  readonly reason: string
}> {}

const loadConfig = (configPath: string): Effect.Effect<EfmeshConfig, ConfigLoadError> =>
  Effect.tryPromise({
    try: async () => {
      const absolute = NodePath.resolve(process.cwd(), configPath)
      const module = (await import(absolute)) as { default?: EfmeshConfig }
      if (module.default === undefined || !Array.isArray(module.default.models)) {
        throw new Error("конфиг должен экспортировать default с полем models")
      }
      return module.default
    },
    catch: (cause) => new ConfigLoadError({ path: configPath, reason: String(cause) }),
  })

/** Слои движка и состояния из конфига — общие для plan/apply. */
const configLayers = (config: EfmeshConfig) =>
  Layer.mergeAll(
    DuckDBEngineLive({ path: config.engine?.path ?? "efmesh.duckdb" }),
    SqliteStateLive({ path: config.state?.path ?? "efmesh.state.sqlite" }),
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

const parseForwardOnly = (value: string): ReadonlyArray<string> | undefined => {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  return names.length > 0 ? names : undefined
}

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
  { env: Argument.string("env"), config: configFlag, forwardOnly: forwardOnlyFlag },
  ({ config, env, forwardOnly }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const names = parseForwardOnly(forwardOnly)
      const applied = yield* Efmesh.apply(env, loaded.models, {
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(loaded.attach !== undefined ? { attach: loaded.attach } : {}),
        ...(names !== undefined ? { forwardOnly: names } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
      yield* printPlan(applied.plan)
      yield* Console.log(
        applied.built.length > 0
          ? `собрано: ${applied.built.join(", ")}`
          : "сборка не потребовалась (только view-swap)",
      )
      yield* Console.log(`окружение «${applied.plan.env}» промоутнуто`)
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
  { env: Argument.string("env"), config: configFlag },
  ({ config, env }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const applied = yield* run(env, loaded.models, {
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(loaded.attach !== undefined ? { attach: loaded.attach } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
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

const graphCommand = Command.make("graph", { config: configFlag }, ({ config }) =>
  Effect.gen(function* () {
    const loaded = yield* loadConfig(config)
    const graph = yield* buildGraph(loaded.models)
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      const deps = model.deps.size > 0 ? `  ←  ${[...model.deps].sort().join(", ")}` : ""
      yield* Console.log(`${name} (${model.kind._tag})${deps}`)
    }
  }),
).pipe(Command.withDescription("DAG моделей в топологическом порядке"))

export const rootCommand = Command.make("efmesh").pipe(
  Command.withDescription("sqlmesh на bun, typescript и Effect"),
  Command.withSubcommands([
    planCommand,
    applyCommand,
    runCommand,
    renderCommand,
    graphCommand,
    diffCommand,
    janitorCommand,
  ]),
)
