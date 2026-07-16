#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Logger } from "effect"
import { Command } from "effect/unstable/cli"
import { renderFailure, rootCommand, wantsTrace } from "./cli.ts"
import { version } from "../package.json"

// Logging (#14) goes to STDERR so `--json` stdout stays byte-clean — a contract
// for CI and agents. A human at a stderr TTY gets colored pretty output; a pipe,
// log file or the systemd journal gets plain one-line logfmt with no ANSI, which
// the fields (model=, env=, interval=) make machine-readable. The minimum level
// is Info by default (lifecycle visible during apply/run); the CLI's built-in
// `--log-level` flag lowers it to debug (SQL, lock internals) or raises it. An
// embedder wanting different sinks/levels provides its own Logger layer instead.
const loggerLayer = Logger.layer([
  process.stderr.isTTY === true
    ? Logger.consolePretty({ stderr: true })
    : Logger.withConsoleError(Logger.formatLogFmt),
])

// One central failure screen (#13): catch every cause here and render it
// ourselves (cause first, one screen, fiber trace only under --log-level
// debug) instead of letting runMain dump a pretty cause over an empty message.
// Interrupts (Ctrl+C) are not failures — leave them to the default teardown.
// The exit code stays a frozen contract: a rendered failure is 1, unless a
// command already claimed 2 ("awaiting a human") before failing.
const debug = wantsTrace(process.argv)

// Interrupt with nothing failed/died — Ctrl+C during a clean wait: not a
// failure to render, hand it back to the default teardown.
const isInterruptOnly = (cause: Cause.Cause<unknown>): boolean =>
  !Cause.hasFails(cause) && Cause.interruptors(cause).size > 0

rootCommand.pipe(
  Command.run({ version }),
  Effect.catchCause((cause) =>
    isInterruptOnly(cause)
      ? Effect.failCause(cause)
      : Effect.sync(() => {
          process.stderr.write(`${renderFailure(cause, { debug })}\n`)
          if (process.exitCode === undefined || process.exitCode === 0) {
            process.exitCode = 1
          }
        }),
  ),
  Effect.provide(loggerLayer),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
