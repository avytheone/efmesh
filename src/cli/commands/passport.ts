import { Console, Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import type { ModelPassport } from "../../plan/passport.ts"
import { environmentPassport } from "../../plan/passport.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { passportToJson, printJson } from "../json.ts"

/**
 * The limits of trust an environment's data carries (#43). Read-only, and
 * deliberately available for every model rather than only the parquet ones: a
 * manifest reaches a browser client, but a table-target model had no way at all
 * to state what may be believed about it.
 */

const line = (passport: ModelPassport): string => {
  const { answerable, completeThrough, limitedBy } = passport.effective
  const mark = answerable === "full" ? "✓" : answerable === "sampled" ? "~" : "✗"
  const coverage =
    limitedBy === null
      ? "no time-range coverage"
      : completeThrough === null
        ? `nothing computed yet (${limitedBy})`
        : `complete through ${completeThrough}${limitedBy === passport.model ? "" : ` (limited by ${limitedBy})`}`
  const narrowed =
    answerable === passport.declared.answerable ? "" : ` — declared ${passport.declared.answerable}`
  return `  ${mark} ${passport.model}  ${answerable}${narrowed}, ${coverage}`
}

export const passportCommand = Command.make(
  "passport",
  { env: Argument.string("env"), config: configFlag, json: jsonFlag },
  ({ config, env, json }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const report = yield* environmentPassport(env, loaded.models).pipe(
        Effect.provide(configLayers(loaded)),
      )
      if (json) {
        yield* printJson(passportToJson(report))
        return
      }
      if (report.models.length === 0) {
        yield* Console.log(`environment "${env}" does not exist — the first apply creates it`)
        return
      }
      yield* Console.log(`environment "${env}": what its data can be trusted to answer`)
      for (const passport of report.models) {
        yield* Console.log(line(passport))
        for (const caveat of passport.effective.caveats) {
          const from = caveat.model === passport.model ? "" : ` [from ${caveat.model}]`
          yield* Console.log(`      · ${caveat.text}${from}`)
        }
      }
    }),
).pipe(
  Command.withDescription(
    "the limits of trust an environment's data carries: declared answerability and caveats, freshness derived from the ledger, both narrowed by the DAG (--json for clients and agents)",
  ),
)
