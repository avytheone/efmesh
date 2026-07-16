/**
 * Публичное API efmesh (F6): осознанный whitelist вместо `export *` —
 * всё, что экспортировано здесь, становится semver-обязательством пакета.
 * Внутренности (naming, lock-хелперы, executor, planner, fingerprint-кухня)
 * намеренно не экспортируются; юнит-тесты моделей — `efmesh/testing`.
 */

// — определение проекта: модели, виды, аудиты, конфиг —
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
  type ExternalConfig,
  type ExternalSource,
  type IncrementalByTimeRangeOptions,
  type MaterializationTarget,
  type Model,
  type ModelConfig,
  type ModelCtx,
  type ModelKind,
  type ModelName,
} from "./core/model.ts"
export { audit, type Audit, type AuditCtx } from "./core/audit.ts"
export { defineConfig, type EfmeshConfig } from "./config.ts"
export { discoverModels, DiscoveryConflictError, DiscoveryError } from "./discovery.ts"

// — фасад и операции: обычные Effect'ы для встраивания (SPEC §10) —
export { Efmesh } from "./efmesh.ts"
export { run, daemon, Runner, RunBlockedByChangesError, type RunError, type RunOptions } from "./plan/run.ts"
export { janitor, type JanitorOptions, type JanitorReport } from "./plan/janitor.ts"
export {
  auditEnvironment,
  AuditTargetError,
  EnvironmentAuditError,
  type AuditRunReport,
  type AuditRunResult,
} from "./plan/audit-run.ts"
export { diffEnvironments, type EnvDiff } from "./plan/diff.ts"
export {
  environmentStatus,
  type ModelLag,
  type StatusOptions,
  type StatusReport,
} from "./plan/status.ts"
export { formatLineage, lineage, LineageError, type LineageNode } from "./plan/lineage.ts"

// — план и применение: типы результата и опций —
export type {
  ChangeCategory,
  Plan,
  PlanAction,
  PlanOptions,
} from "./plan/planner.ts"
export type { ChangeExplanation } from "./plan/explain.ts"
export { FingerprintVersionError, ForwardOnlyError, InvalidEnvironmentError } from "./plan/planner.ts"
export type { AppliedPlan, ApplyError, ApplyOptions } from "./plan/executor.ts"
export {
  AttachNotConfiguredError,
  DucklakeNotConfiguredError,
  EngineFeatureError,
  LakeNotConfiguredError,
} from "./plan/executor.ts"
export { AuditFailure } from "./core/audit.ts"
export { SchemaMismatchError } from "./plan/contract.ts"
export { LockHeldError, type LockOptions } from "./plan/lock.ts"
export { FINGERPRINT_VERSION } from "./plan/fingerprint.ts"

// — граф: составные ошибки загрузки проекта —
export {
  DagCycleError,
  DuplicateModelError,
  ModelDefinitionError,
  SeedReadError,
  UnknownDependencyError,
} from "./core/errors.ts"
export type { GraphError } from "./core/graph.ts"

// — движки: слои и сервис (кастомные обёртки — например, для тестов) —
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

// — state store: слои, миграции, записи —
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

// — интервалы: границы для options.now и разбор отчётов —
export { fromIso, toIso, type Interval, type IntervalUnit } from "./core/interval.ts"
