/**
 * Public API of efmesh (F6): a deliberate whitelist instead of `export *` —
 * everything exported here becomes a semver commitment of the package.
 * Internals (naming, lock helpers, executor, planner, fingerprint plumbing)
 * are deliberately not exported; unit-testing models lives in `efmesh/testing`.
 */

// — project definition: models, kinds, audits, config —
export {
  defineExternal,
  defineModel,
  defineSeed,
  defineSqlModel,
  external,
  kind,
  columnNames,
  parseModelName,
  type AnyModel,
  type CompactPolicy,
  type ExternalConfig,
  type Answerable,
  type ExternalFileOptions,
  type ExternalSource,
  type IncrementalByTimeRangeOptions,
  type MaterializationTarget,
  type Model,
  type ModelConfig,
  type ModelCtx,
  type ModelKind,
  type ModelMaintenance,
  type ModelName,
} from "./core/model.ts"
export { audit, type Audit, type AuditCtx, type AuditScope } from "./core/audit.ts"
export { defineConfig, type EfmeshConfig } from "./config.ts"
export type {
  DuckDBCredential,
  EngineExtension,
  EngineInit,
  EngineSemanticInit,
  EngineSettingValue,
} from "./engine/init.ts"
export { discoverModels, DiscoveryConflictError, DiscoveryError } from "./discovery.ts"

// — facade and operations: plain Effects for embedding (SPEC §10) —
export { Efmesh } from "./efmesh.ts"
export {
  run,
  daemon,
  Runner,
  RunBlockedByChangesError,
  type RunError,
  type RunOptions,
} from "./plan/run.ts"
export {
  restate,
  RestateEnvError,
  RestateGrainError,
  RestateKindError,
  RestateRangeError,
  type RestateError,
  type RestateOptions,
  type RestatePlan,
  type RestateTarget,
} from "./plan/restate.ts"
export { janitor, type JanitorOptions, type JanitorReport } from "./plan/janitor.ts"
export {
  compact,
  COMPACT_GRACE_MINUTES,
  type CompactedPartition,
  type CompactOptions,
  type CompactReport,
  type CompactSkipReason,
  type SkippedPartition,
} from "./plan/compact.ts"
export {
  auditEnvironment,
  AuditTargetError,
  EnvironmentAuditError,
  type AuditRunReport,
  type AuditRunResult,
  type AuditSkipped,
} from "./plan/audit-run.ts"
export {
  dataDiffEnvironments,
  DataDiffError,
  diffEnvironments,
  type ColumnDrift,
  type DataDiffOptions,
  type DataDiffReport,
  type EnvDiff,
  type ModelDataDiff,
} from "./plan/diff.ts"
export {
  environmentStatus,
  type ModelLag,
  type StatusOptions,
  type StatusReport,
} from "./plan/status.ts"
export { formatLineage, lineage, LineageError, type LineageNode } from "./plan/lineage.ts"
export {
  listSchedules,
  registerSchedule,
  removeSchedule,
  ScheduleError,
  scheduleTitle,
  systemdUnits,
  type ScheduleTarget,
} from "./plan/schedule.ts"

// — plan and apply: result and options types —
export type {
  ChangeCategory,
  Plan,
  PlanAction,
  PlanOptions,
} from "./plan/planner.ts"
export type { ChangeExplanation } from "./plan/explain.ts"
export {
  FingerprintVersionError,
  ForwardOnlyError,
  InvalidEnvironmentError,
  ReclassifyError,
} from "./plan/planner.ts"
export type { AppliedPlan, ApplyError, ApplyOptions } from "./plan/executor.ts"
export {
  AttachNotConfiguredError,
  DucklakeNotConfiguredError,
  EngineFeatureError,
  LakeNotConfiguredError,
} from "./plan/executor.ts"
export { AuditFailure } from "./core/audit.ts"
export { SchemaMismatchError } from "./plan/contract.ts"
export { LockHeldError, LockLostError, type LockOptions } from "./plan/lock.ts"
export { FINGERPRINT_VERSION } from "./plan/fingerprint.ts"

// — graph: compound project-loading errors —
export {
  DagCycleError,
  DuplicateModelError,
  ModelDefinitionError,
  SeedReadError,
  UnknownDependencyError,
  UnknownModelError,
} from "./core/errors.ts"
export type { GraphError } from "./core/graph.ts"

// — engines: layers and service (custom wrappers — e.g. for tests) —
export {
  EngineAdapter,
  EngineError,
  SqlParseError,
  type Dialect,
  type Engine,
  type EngineColumn,
} from "./engine/adapter.ts"
export { DuckDBEngineLive, type DuckDBEngineOptions } from "./engine/duckdb.ts"
export {
  canonicalizePostgresSql,
  PostgresEngineLive,
  type PostgresEngineOptions,
} from "./engine/postgres.ts"

// — state store: layers, migrations, records —
export {
  StateStore,
  StateError,
  StateSchemaError,
  STATE_VERSION,
  type EnvironmentRecord,
  type IntervalRecord,
  type MigrationReport,
  type PlanRecord,
  type SnapshotRecord,
  type StateStoreShape,
} from "./state/store.ts"
export { migrateSqliteState, SqliteStateLive, type SqliteStateOptions } from "./state/sqlite.ts"
export {
  migratePostgresState,
  PostgresStateLive,
  type PostgresStateOptions,
} from "./state/postgres.ts"

// — intervals: bounds for options.now and report parsing —
export { fromIso, toIso, type Interval, type IntervalUnit } from "./core/interval.ts"

export { MANIFEST_VERSION, type Manifest } from "./plan/manifest.ts"

// — the answer honesty passport (#43): declared limits, derived freshness, both
// narrowed by the DAG —
export {
  environmentPassport,
  freshnessOf,
  type EffectivePassport,
  type ManifestFreshness,
  type ModelPassport,
  type PassportCaveat,
  type PassportReport,
} from "./plan/passport.ts"
