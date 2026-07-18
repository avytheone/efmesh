import { renameSync, writeFileSync } from "node:fs"
import { Clock, Effect, Metric } from "effect"
import { commandSeconds, lastRunTimestamp, plannedModels } from "../plan/metrics.ts"
import type { Plan } from "../plan/planner.ts"
import { openMetricsReport } from "./openmetrics.ts"

/**
 * Writing the scrape file (#39). A scraper reads this file on its own schedule,
 * with no lock between us: a partially written file is a parse error on their
 * side and a gap in the series. So the write goes to a sibling temp file and is
 * renamed — rename is atomic on POSIX, the same trick parquet partitions use.
 *
 * Failure to write is deliberately NOT fatal: an unwritable metrics path must
 * not fail an apply that already built and promoted. It is logged as a warning,
 * which is the honest severity — the warehouse is fine, the observability is not.
 */
export const writeMetricsFile = (path: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const body = yield* openMetricsReport
    yield* Effect.try({
      try: () => {
        const temporary = `${path}.tmp`
        writeFileSync(temporary, body, "utf8")
        renameSync(temporary, path)
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`could not write the metrics file ${path}: ${cause}`),
      ),
    )
  })

/** Categories a plan can carry, recorded even when the count is zero. */
const CHANGES = [
  "added",
  "breaking",
  "non-breaking",
  "indirect",
  "forward-only",
  "removed",
  "unchanged",
] as const

/**
 * Facts a command knows only at its end. Recorded even for a no-op tick: an
 * alert on "a silent process" fires on a stale timestamp, so the timestamp must
 * advance whenever the command *ran*, not only when it did work.
 */
export const recordCommandOutcome = (options: {
  readonly outcome: "ok" | "awaiting-human" | "error"
  readonly startedAtMillis: number
  readonly plan?: Plan | undefined
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* Metric.update(commandSeconds, (now - options.startedAtMillis) / 1000)
    yield* Metric.update(
      lastRunTimestamp.pipe(Metric.withAttributes({ outcome: options.outcome })),
      Math.floor(now / 1000),
    )
    if (options.plan === undefined) return
    const counted = new Map<string, number>(CHANGES.map((change) => [change, 0]))
    for (const action of options.plan.actions) {
      counted.set(action.change, (counted.get(action.change) ?? 0) + 1)
    }
    for (const [change, count] of counted) {
      yield* Metric.update(plannedModels.pipe(Metric.withAttributes({ change })), count)
    }
  })
