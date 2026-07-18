import { Effect } from "effect"
import { Flag } from "effect/unstable/cli"
import { ReclassifyError } from "../plan/planner.ts"

export const configFlag = Flag.string("config").pipe(
  Flag.withDefault("efmesh.config.ts"),
  Flag.withDescription("path to efmesh.config.ts"),
)

export const forwardOnlyFlag = Flag.string("forward-only").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "comma-separated models: changes apply forward-only — physics and history are reused",
  ),
)

export const reclassifyFlag = Flag.string("reclassify").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    'override categorization (#5): "model=breaking|non-breaking[,…]" on top of --explain; journaled with applied_by',
  ),
)

export const jobsFlag = Flag.string("jobs").pipe(
  Flag.withDefault(""),
  Flag.withDescription("how many models to build at once (DAG concurrency; always 1 on DuckDB)"),
)

export const parseJobs = (value: string): number | undefined => {
  const jobs = Number(value)
  return value !== "" && Number.isFinite(jobs) && jobs >= 1 ? Math.floor(jobs) : undefined
}

/**
 * Where to drop the scrape file (#39). Empty = no file: the default stays a
 * command that writes nothing it was not asked to write.
 */
export const metricsFlag = Flag.string("metrics").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "write an OpenMetrics/Prometheus text file after the command (for node_exporter's textfile collector)",
  ),
)

export const parseMetricsPath = (value: string): string | undefined =>
  value.trim() === "" ? undefined : value

export const retriesFlag = Flag.string("retries").pipe(
  Flag.withDefault(""),
  Flag.withDescription(
    "how many times to retry a failed backfill batch (exponential backoff; default 0)",
  ),
)

export const parseRetries = (value: string): { readonly attempts: number } | undefined => {
  const attempts = Number(value)
  return value !== "" && Number.isFinite(attempts) && attempts >= 1
    ? { attempts: Math.floor(attempts) }
    : undefined
}

export const parseForwardOnly = (value: string): ReadonlyArray<string> | undefined => {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  return names.length > 0 ? names : undefined
}

/** `model=breaking|non-breaking[,…]` → record for PlanOptions.reclassify (#5). */
export const parseReclassify = (
  value: string,
): Effect.Effect<
  Readonly<Record<string, "breaking" | "non-breaking">> | undefined,
  ReclassifyError
> =>
  Effect.gen(function* () {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
    if (entries.length === 0) return undefined
    const parsed: Record<string, "breaking" | "non-breaking"> = {}
    for (const entry of entries) {
      const [model, category, ...extra] = entry.split("=")
      if (
        model === undefined ||
        model === "" ||
        extra.length > 0 ||
        (category !== "breaking" && category !== "non-breaking")
      ) {
        return yield* new ReclassifyError({
          model: entry,
          reason: 'expected "model=breaking" or "model=non-breaking"',
        })
      }
      parsed[model] = category
    }
    return parsed
  })

export const yesFlag = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription(
    "apply without confirmation; required in a non-TTY when the plan has changes (else exit 2)",
  ),
)

/** Accepts y/yes, case-insensitive; anything else (including empty) is a refusal. */
export const isAffirmative = (answer: string | null): boolean =>
  ["y", "yes"].includes((answer ?? "").trim().toLowerCase())

/**
 * The "work awaits a human" exit code (F6): the plan needs confirmation in a
 * non-TTY, or run hit structural changes. Alerting must distinguish this
 * normal state from real errors (code 1).
 */
export const EXIT_AWAITING_HUMAN = 2

/**
 * The fate of a shown plan (SPEC §5.1, tightened in F6): no changes or
 * --yes — apply; changes in a TTY — ask the human; changes in a
 * non-TTY (CI, cron, pipe) — REFUSE: silently applying a plan nobody
 * saw is forbidden, an explicit --yes is required.
 */
export const decideApply = (
  hasChanges: boolean,
  yes: boolean,
  tty: boolean,
): "apply" | "ask" | "refuse" => (!hasChanges || yes ? "apply" : tty ? "ask" : "refuse")

export const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("machine-readable output (stable shape — a contract for CI)"),
)

export const checkFlag = Flag.boolean("check").pipe(
  Flag.withDescription(
    "exit non-zero when the environment is unhealthy (failed intervals or the last tick errored) — for systemd OnFailure / healthchecks.io",
  ),
)

export const explainFlag = Flag.boolean("explain").pipe(
  Flag.withDescription(
    "for each change — which canonical AST nodes diverged and why the category is what it is",
  ),
)
