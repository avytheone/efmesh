import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Efmesh } from "../../efmesh.ts"
import { loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { printJson, renderToJson } from "../json.ts"

export const renderCommand = Command.make(
  "render",
  {
    model: Argument.string("model"),
    config: configFlag,
    env: Flag.string("env").pipe(
      Flag.withDefault(""),
      Flag.withDescription("render against an environment's view layer instead of logical names"),
    ),
    json: jsonFlag,
  },
  ({ config, env, json, model }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const sql =
        env === ""
          ? yield* Efmesh.render(loaded.models, model)
          : yield* Efmesh.renderFor(loaded.models, model, env)
      yield* json ? printJson(renderToJson(model, env, sql.trim())) : Console.log(sql.trim())
    }),
).pipe(Command.withDescription("show a model's final SQL (--json wraps it as { model, env, sql })"))
