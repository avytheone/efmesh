#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { renderFailure, rootCommand, wantsTrace } from "./cli.ts"
import { version } from "../package.json"

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
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
