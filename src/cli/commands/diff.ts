import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { EngineAdapter } from "../../engine/adapter.ts"
import { dataDiffEnvironments, diffEnvironments } from "../../plan/diff.ts"
import { ducklakeAttachSql } from "../../plan/naming.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag, parseForwardOnly } from "../flags.ts"
import { printJson } from "../json.ts"
import { printDataDiff } from "../print.ts"

export const diffCommand = Command.make(
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
      const diff = yield* diffEnvironments(envA, envB).pipe(Effect.provide(configLayers(loaded)))
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
