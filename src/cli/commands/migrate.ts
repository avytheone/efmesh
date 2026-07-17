import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { migratePostgresState } from "../../state/postgres.ts"
import { migrateSqliteState } from "../../state/sqlite.ts"
import { loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { migrateToJson, printJson } from "../json.ts"

export const migrateCommand = Command.make(
  "migrate",
  { config: configFlag, json: jsonFlag },
  ({ config, json }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* loaded.state?.url !== undefined
        ? migratePostgresState({ url: loaded.state.url })
        : migrateSqliteState({ path: loaded.state?.path ?? "efmesh.state.sqlite" })
      if (json) {
        yield* printJson(migrateToJson(report))
        return
      }
      yield* Console.log(
        report.from === report.to
          ? `state store already at version ${report.to}`
          : `state store: version ${report.from} → ${report.to}`,
      )
      if (report.backup !== undefined) {
        yield* Console.log(`backup of the old store: ${report.backup}`)
      }
    }),
).pipe(
  Command.withDescription(
    "bring the state store schema up to the current version (--json emits { from, to, backup? })",
  ),
)
