#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { rootCommand } from "./cli.ts"

rootCommand.pipe(
  Command.run({ version: "0.0.1" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
