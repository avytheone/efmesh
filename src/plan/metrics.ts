import { Metric } from "effect"

/** Observability out of the box (SPEC §10): pipeline counters. */
export const intervalsDone = Metric.counter("efmesh_intervals_done_total", {
  description: "how many intervals were computed and marked done",
})

export const auditFailuresTotal = Metric.counter("efmesh_audit_failures_total", {
  description: "how many blocking audits failed",
})

export const snapshotsBuilt = Metric.counter("efmesh_snapshots_built_total", {
  description: "how many snapshots were built (physics or backfill)",
})
