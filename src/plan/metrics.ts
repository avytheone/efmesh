import { Metric } from "effect"

/**
 * Observability out of the box (SPEC §10): the pipeline's instrumentation
 * points. Effect's `Metric` registry IS the instrumentation layer (#39) — every
 * output reads from it rather than growing its own accounting. `--metrics`
 * renders it as a scrape file (`observe/openmetrics.ts`); lifecycle events (#29)
 * would attach at these same points; `--json` command payloads are a third
 * consumer. A new output must never mean a new place where facts are produced.
 *
 * Attributes come from the scope, not from each call site: the executor puts
 * `model`/`env` into `Metric.CurrentMetricAttributes` around a model's build,
 * exactly as it does with log annotations, so everything updated in there is
 * labelled and everything outside stays a bare total. Each event lands in
 * exactly one series either way, so `sum()` over a metric name is correct.
 */

export const intervalsDone = Metric.counter("efmesh_intervals_done_total", {
  description: "how many intervals were computed and marked done",
})

/** Intervals whose batch failed and were marked failed rather than done. */
export const intervalsFailed = Metric.counter("efmesh_intervals_failed_total", {
  description: "how many intervals failed and were left for a later retry",
})

export const auditFailuresTotal = Metric.counter("efmesh_audit_failures_total", {
  description: "how many blocking audits failed",
})

export const auditsPassed = Metric.counter("efmesh_audits_passed_total", {
  description: "how many audits ran and found nothing",
})

export const snapshotsBuilt = Metric.counter("efmesh_snapshots_built_total", {
  description: "how many snapshots were built (physics or backfill)",
})

/**
 * Duration of the last build, per model. A gauge rather than a histogram: a
 * warehouse builds a given model once per apply, so a distribution would
 * describe a handful of samples, while what an operator sets a threshold on is
 * "how long did this model take last time".
 */
export const modelBuildSeconds = Metric.gauge("efmesh_model_build_duration_seconds", {
  description: "duration of the last build of this model, in seconds",
})

/** Wall clock of the whole command — what a job-duration alert watches. */
export const commandSeconds = Metric.gauge("efmesh_command_duration_seconds", {
  description: "duration of the last apply/run, in seconds",
})

/**
 * Unix seconds of the last outcome, labelled by outcome. "A silent process is a
 * defect" is alerted on staleness — `time() - efmesh_last_run_timestamp_seconds`
 * crossing the tick interval — which needs a timestamp even when nothing was
 * built, so this is written on every finished command including a no-op tick.
 */
export const lastRunTimestamp = Metric.gauge("efmesh_last_run_timestamp_seconds", {
  description: "unix time of the last finished apply/run, by outcome",
})

/**
 * Models in the last plan, by change category. Distinguishes a tick that is
 * quietly doing nothing because everything is `unchanged` from a tick that is
 * not running at all.
 */
export const plannedModels = Metric.counter("efmesh_planned_models_total", {
  description: "models in the last plan, by change category",
})
