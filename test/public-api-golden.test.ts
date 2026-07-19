import { describe, expect, test } from "bun:test"
import * as api from "../src/index.ts"
import * as testingApi from "../src/testing/index.ts"

/**
 * Golden public-API tests: the export whitelist of `src/index.ts` (and the
 * `efmesh/testing` subpath) is FROZEN. Every name here is a SemVer commitment
 * (CLAUDE.md: "the public API is a whitelist … adding an export is an API
 * event"). A red test means the surface drifted — an export was added or
 * removed. The correct reaction mirrors the fingerprint golden: do NOT reflex
 * the frozen list to green, but (1) confirm the change is intended, (2) reflect
 * it in the CHANGELOG as an API event (a removal or rename is BREAKING), and
 * (3) only then update the frozen list below.
 *
 * Runtime `Object.keys` catches value drift precisely; the source is parsed for
 * the full name set so a stray `export type` (no runtime footprint) is caught
 * too.
 */

/** Names in the `export { … } from` / `export type { … } from` blocks of a barrel. */
const barrelExports = (
  source: string,
): { values: ReadonlyArray<string>; types: ReadonlyArray<string> } => {
  const values: Array<string> = []
  const types: Array<string> = []
  for (const block of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const wholeBlockIsType = block[1] !== undefined
    for (const raw of block[2]!.split(",")) {
      const name = raw.trim()
      if (name === "") continue
      if (wholeBlockIsType) types.push(name)
      else if (name.startsWith("type ")) types.push(name.slice("type ".length).trim())
      else values.push(name)
    }
  }
  return { values: values.sort(), types: types.sort() }
}

/** Names of `export const|function|class|interface|type …` declarations (the testing subpath). */
const declaredExports = (source: string): ReadonlyArray<string> => {
  const names: Array<string> = []
  const pattern =
    /export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g
  for (const m of source.matchAll(pattern)) names.push(m[1]!)
  return names.sort()
}

const FROZEN_VALUES: ReadonlyArray<string> = [
  "AttachNotConfiguredError",
  "AuditFailure",
  "AuditTargetError",
  "COMPACT_GRACE_MINUTES",
  "DagCycleError",
  "DataDiffError",
  "DiscoveryConflictError",
  "DiscoveryError",
  "DuckDBEngineLive",
  "DucklakeNotConfiguredError",
  "DuplicateModelError",
  "Efmesh",
  "EngineAdapter",
  "EngineError",
  "EngineFeatureError",
  "EnvironmentAuditError",
  "FINGERPRINT_VERSION",
  "FingerprintVersionError",
  "ForwardOnlyError",
  "InvalidEnvironmentError",
  "LakeNotConfiguredError",
  "LineageError",
  "LockHeldError",
  "LockLostError",
  "MANIFEST_VERSION",
  "ModelDefinitionError",
  "PostgresEngineLive",
  "PostgresStateLive",
  "ReclassifyError",
  "RestateEnvError",
  "RestateGrainError",
  "RestateKindError",
  "RestateRangeError",
  "RunBlockedByChangesError",
  "Runner",
  "STATE_VERSION",
  "ScheduleError",
  "SchemaMismatchError",
  "SeedReadError",
  "SqlParseError",
  "SqliteStateLive",
  "StateError",
  "StateSchemaError",
  "StateStore",
  "UnknownDependencyError",
  "UnknownModelError",
  "audit",
  "auditEnvironment",
  "canonicalizePostgresSql",
  "columnNames",
  "compact",
  "daemon",
  "dataDiffEnvironments",
  "defineConfig",
  "defineExternal",
  "defineModel",
  "defineSeed",
  "defineSqlModel",
  "diffEnvironments",
  "discoverModels",
  "environmentPassport",
  "environmentStatus",
  "external",
  "formatLineage",
  "freshnessOf",
  "fromIso",
  "janitor",
  "kind",
  "lineage",
  "listSchedules",
  "migratePostgresState",
  "migrateSqliteState",
  "parseModelName",
  "registerSchedule",
  "removeSchedule",
  "restate",
  "run",
  "scheduleTitle",
  "systemdUnits",
  "toIso",
]

const FROZEN_TYPES: ReadonlyArray<string> = [
  "Answerable",
  "AnyModel",
  "AppliedPlan",
  "ApplyError",
  "ApplyOptions",
  "Audit",
  "AuditCtx",
  "AuditRunReport",
  "AuditRunResult",
  "AuditScope",
  "AuditSkipped",
  "ChangeCategory",
  "ChangeExplanation",
  "ColumnDrift",
  "CompactOptions",
  "CompactPolicy",
  "CompactReport",
  "CompactSkipReason",
  "CompactedPartition",
  "DataDiffOptions",
  "DataDiffReport",
  "Dialect",
  "DuckDBCredential",
  "DuckDBEngineOptions",
  "EffectivePassport",
  "EfmeshConfig",
  "Engine",
  "EngineColumn",
  "EngineExtension",
  "EngineInit",
  "EngineSemanticInit",
  "EngineSettingValue",
  "EnvDiff",
  "EnvironmentRecord",
  "ExternalConfig",
  "ExternalFileOptions",
  "ExternalSource",
  "GraphError",
  "IncrementalByTimeRangeOptions",
  "Interval",
  "IntervalRecord",
  "IntervalUnit",
  "JanitorOptions",
  "JanitorReport",
  "LineageNode",
  "LockOptions",
  "Manifest",
  "ManifestFreshness",
  "MaterializationTarget",
  "MigrationReport",
  "Model",
  "ModelConfig",
  "ModelCtx",
  "ModelDataDiff",
  "ModelKind",
  "ModelLag",
  "ModelMaintenance",
  "ModelName",
  "ModelPassport",
  "PassportCaveat",
  "PassportReport",
  "Plan",
  "PlanAction",
  "PlanOptions",
  "PlanRecord",
  "PostgresEngineOptions",
  "PostgresStateOptions",
  "RestateError",
  "RestateOptions",
  "RestatePlan",
  "RestateTarget",
  "RunError",
  "RunOptions",
  "ScheduleTarget",
  "SkippedPartition",
  "SnapshotRecord",
  "SqliteStateOptions",
  "StateStoreShape",
  "StatusOptions",
  "StatusReport",
]

/** The `efmesh/testing` subpath — value exports and the full name set. */
const FROZEN_TESTING_VALUES: ReadonlyArray<string> = ["runModel", "testModel"]
const FROZEN_TESTING_NAMES: ReadonlyArray<string> = ["TestModelSpec", "runModel", "testModel"]

describe("public API — the export whitelist is a contract (src/index.ts)", () => {
  test("runtime value exports are frozen", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(barrelExports(source).values).toEqual([...FROZEN_VALUES])
    // runtime keys are the values a consumer can actually reach
    expect(Object.keys(api).sort()).toEqual([...FROZEN_VALUES])
  })

  test("type-only exports are frozen", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text()
    expect(barrelExports(source).types).toEqual([...FROZEN_TYPES])
  })

  test("efmesh/testing subpath is frozen", async () => {
    const source = await Bun.file(new URL("../src/testing/index.ts", import.meta.url)).text()
    expect(declaredExports(source)).toEqual([...FROZEN_TESTING_NAMES])
    expect(Object.keys(testingApi).sort()).toEqual([...FROZEN_TESTING_VALUES])
  })
})
