import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { buildGraph } from "../../core/graph.ts"
import { formatLineage, lineage, LineageError, type LineageNode } from "../../plan/lineage.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { lineageToJson, printJson } from "../json.ts"

export const lineageCommand = Command.make(
  "lineage",
  { target: Argument.string("model[.column]"), config: configFlag, json: jsonFlag },
  ({ config, json, target }) =>
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
      const trees: Array<LineageNode> = []
      for (const column of columns) {
        const tree = yield* lineage(graph, modelName, column).pipe(
          Effect.provide(configLayers(loaded)),
        )
        if (json) {
          trees.push(tree)
        } else {
          for (const line of formatLineage(tree)) yield* Console.log(line)
        }
      }
      if (json) yield* printJson(lineageToJson(modelName, trees))
    }),
).pipe(
  Command.withDescription(
    "column lineage down to raw columns, best-effort (--json emits the tree)",
  ),
)
