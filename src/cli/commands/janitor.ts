import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { janitor } from "../../plan/janitor.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { janitorToJson, printJson } from "../json.ts"

export const janitorCommand = Command.make(
  "janitor",
  {
    config: configFlag,
    ttl: Flag.string("ttl").pipe(
      Flag.withDefault("7"),
      Flag.withDescription("how many days orphaned physics lives before removal"),
    ),
    json: jsonFlag,
  },
  ({ config, json, ttl }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* janitor({
        ttlDays: Number(ttl),
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(loaded.ducklake !== undefined ? { ducklake: loaded.ducklake } : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
      if (json) {
        yield* printJson(janitorToJson(report))
        return
      }
      yield* Console.log(
        report.removed.length > 0
          ? `removed: ${report.removed.join(", ")}`
          : "no orphaned physics older than ttl",
      )
      if (report.kept.length > 0) {
        yield* Console.log(`orphaned but younger than ttl: ${report.kept.join(", ")}`)
      }
    }),
).pipe(Command.withDescription("remove physics no environment references (--json for CI)"))
