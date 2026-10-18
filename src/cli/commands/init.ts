import { Console, Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { scaffold } from "../../init.ts"

export const initCommand = Command.make(
  "init",
  { dir: Argument.String("dir").pipe(Argument.withDefault(".")) },
  ({ dir }) =>
    Effect.gen(function* () {
      const created = yield* scaffold(dir)
      for (const file of created) yield* Console.log(`created ${file}`)
      yield* Console.log("next: bunx efmesh plan dev && bunx efmesh apply dev")
    }),
).pipe(Command.withDescription("scaffold a project: config, example models, seed"))
