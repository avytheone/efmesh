import { Command } from "effect/unstable/cli"
import { auditCommand } from "./commands/audit.ts"
import { diffCommand } from "./commands/diff.ts"
import { graphCommand } from "./commands/graph.ts"
import { initCommand } from "./commands/init.ts"
import { janitorCommand } from "./commands/janitor.ts"
import { lineageCommand } from "./commands/lineage.ts"
import { migrateCommand } from "./commands/migrate.ts"
import { applyCommand, planCommand } from "./commands/plan-apply.ts"
import { renderCommand } from "./commands/render.ts"
import { restateCommand } from "./commands/restate.ts"
import { runCommand } from "./commands/run.ts"
import { scheduleCommand } from "./commands/schedule.ts"
import { statusCommand } from "./commands/status.ts"

export const rootCommand = Command.make("efmesh").pipe(
  // exit codes are a frozen contract — the full table lives once in the README
  // ("Exit codes"); the three values are restated here so headless callers see
  // them without leaving the terminal, but the canonical documentation is there
  Command.withDescription(
    "sqlmesh on bun, typescript and Effect\n\n" +
      "Exit codes: 0 = ok, 1 = error, 2 = awaiting a human (non-TTY apply without --yes, " +
      "or run hitting unapplied changes). Full table: README § Exit codes.\n" +
      "plan/apply/audit/status/diff/janitor/migrate/lineage/render/schedule --list take --json " +
      "(stable shapes for CI and agents).",
  ),
  Command.withSubcommands([
    initCommand,
    planCommand,
    applyCommand,
    runCommand,
    restateCommand,
    statusCommand,
    auditCommand,
    renderCommand,
    graphCommand,
    lineageCommand,
    diffCommand,
    scheduleCommand,
    janitorCommand,
    migrateCommand,
  ]),
)
