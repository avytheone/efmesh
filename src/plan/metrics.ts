import { Metric } from "effect"

/** Наблюдаемость из коробки (SPEC §10): счётчики конвейера. */
export const intervalsDone = Metric.counter("efmesh_intervals_done_total", {
  description: "Сколько интервалов досчитано и помечено done",
})

export const auditFailuresTotal = Metric.counter("efmesh_audit_failures_total", {
  description: "Сколько blocking-аудитов провалилось",
})

export const snapshotsBuilt = Metric.counter("efmesh_snapshots_built_total", {
  description: "Сколько снапшотов собрано (физика или бэкфилл)",
})
