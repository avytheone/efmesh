#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { rootCommand } from "./cli.ts"
import { version } from "../package.json"

rootCommand.pipe(
  Command.run({ version }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
