import { writeFileSync } from "node:fs"
import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { buildGraph } from "../../core/graph.ts"
import { renderGraphHtml } from "../../plan/graph-html.ts"
import { loadConfig } from "../config.ts"
import { configFlag } from "../flags.ts"

export const graphCommand = Command.make(
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
