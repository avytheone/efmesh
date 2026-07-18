import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { compact } from "../../plan/compact.ts"
import { configLayers, loadConfig } from "../config.ts"
import { configFlag, jsonFlag } from "../flags.ts"
import { compactToJson, printJson } from "../json.ts"

export const compactCommand = Command.make(
  "compact",
  {
    config: configFlag,
    model: Flag.string("model").pipe(
      Flag.withDefault(""),
      Flag.withDescription("compact only this model's partitions"),
    ),
    grace: Flag.string("grace").pipe(
      Flag.withDefault(""),
      Flag.withDescription(
        "minutes to wait past a partition's newest file before merging it (overrides the declared policy; default 10)",
      ),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("report what would be merged; write and delete nothing"),
    ),
    json: jsonFlag,
  },
  ({ config, dryRun, grace, json, model }) =>
    Effect.gen(function* () {
      const loaded = yield* loadConfig(config)
      const graceMinutes = Number(grace)
      const report = yield* compact({
        models: loaded.models,
        dryRun,
        ...(loaded.lake !== undefined ? { lakePath: loaded.lake.path } : {}),
        ...(model !== "" ? { model } : {}),
        ...(grace !== "" && Number.isFinite(graceMinutes) && graceMinutes >= 0
          ? { graceMinutes }
          : {}),
      }).pipe(Effect.provide(configLayers(loaded)))
      if (json) {
        yield* printJson(compactToJson(report))
        return
      }
      const prefix = report.dryRun ? "would merge" : "merged"
      for (const entry of report.compacted) {
        const rows = entry.rows === null ? "" : `, ${entry.rows} rows`
        yield* Console.log(`${prefix} ${entry.files} files${rows} → ${entry.published}`)
      }
      if (report.compacted.length === 0) {
        yield* Console.log("nothing to compact")
      }
      // the reasons matter more than the partition list: "everything was in the
      // grace period" and "nothing is partitioned the way you declared" look
      // identical from a count alone
      const byReason = new Map<string, number>()
      for (const entry of report.skipped) {
        byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1)
      }
      if (byReason.size > 0) {
        const summary = [...byReason].map(([reason, count]) => `${reason}: ${count}`).join(", ")
        yield* Console.log(`left alone — ${summary}`)
      }
    }),
).pipe(
  Command.withDescription(
    "merge a partition's small files into one (own lake + externals that opted in; cooperative, not transactional — README § compact)",
  ),
)
