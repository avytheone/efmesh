import * as NodePath from "node:path"
import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  listSchedules,
  registerSchedule,
  removeSchedule,
  systemdUnits,
} from "../../plan/schedule.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { printJson, scheduleListToJson } from "../json.ts"

export const scheduleCommand = Command.make(
  "schedule",
  {
    env: Argument.string("env").pipe(Argument.withDefault("")),
    config: configFlag,
    cron: Flag.string("cron").pipe(
      Flag.withDefault("@hourly"),
      Flag.withDescription("cron expression or nickname (@hourly, @daily, …)"),
    ),
    remove: Flag.boolean("remove").pipe(
      Flag.withDescription("unregister the environment from the OS scheduler"),
    ),
    list: Flag.boolean("list").pipe(
      Flag.withDescription("list efmesh entries in the OS scheduler"),
    ),
    printSystemd: Flag.boolean("print-systemd").pipe(
      Flag.withDescription(
        "print systemd user units instead of cron (Persistent=true catches up misses; a lifeline without a cron daemon)",
      ),
    ),
    json: jsonFlag,
  },
  ({ config, cron, env, json, list, printSystemd, remove }) =>
    Effect.gen(function* () {
      if (list) {
        const entries = yield* listSchedules()
        if (json) {
          yield* printJson(scheduleListToJson(entries))
          return
        }
        if (entries.length === 0) yield* Console.log("no efmesh entries in the OS scheduler")
        for (const entry of entries) yield* Console.log(`  ${entry}`)
        return
      }
      if (env === "") {
        yield* Console.error("environment required: efmesh schedule <env> [--cron …]")
        return yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      const configAbs = NodePath.resolve(process.cwd(), config)
      const target = { project: NodePath.dirname(configAbs), config: configAbs, env }
      if (printSystemd) {
        const units = systemdUnits(target, cron)
        yield* Console.log(`# ~/.config/systemd/user/${units.name}.service`)
        yield* Console.log(units.service)
        yield* Console.log(`# ~/.config/systemd/user/${units.name}.timer`)
        yield* Console.log(units.timer)
        yield* Console.log(
          `# enable: systemctl --user daemon-reload && systemctl --user enable --now ${units.name}.timer`,
        )
        return
      }
      if (remove) {
        const removed = yield* removeSchedule(target)
        yield* Console.log(`unregistered: ${removed.title}`)
        return
      }
      const registered = yield* registerSchedule(target, cron)
      yield* Console.log(`registered: ${registered.title} — "${cron}" (OS scheduler)`)
      yield* Console.log(`worker: ${registered.worker}`)
      yield* Console.log(
        `tick journal: efmesh status ${env}; NB: cron does not catch up missed runs — a systemd timer is stricter (--print-systemd)`,
      )
    }).pipe(
      // reason is the most valuable part (a recipe for the operator): surface it in words, not a stacktrace
      Effect.catchTag("ScheduleError", (error) =>
        Effect.gen(function* () {
          yield* Console.error(`schedule: ${error.reason}`)
          yield* Effect.sync(() => {
            process.exitCode = 1
          })
        }),
      ),
    ),
).pipe(
  Command.withDescription(
    "register run <env> in the OS scheduler (Bun.cron: crontab/launchd/Task Scheduler); --list [--json]",
  ),
)
