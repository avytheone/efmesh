import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { buildGraph } from "../src/core/graph.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { Efmesh } from "../src/efmesh.ts"
import { EngineAdapter } from "../src/engine/adapter.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { planChanges } from "../src/plan/planner.ts"
import { canonicalizePostgresSql } from "../src/engine/postgres.ts"
import { FINGERPRINT_VERSION, fingerprintGraph } from "../src/plan/fingerprint.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"
import { StateStore } from "../src/state/store.ts"

/**
 * Golden-тесты fingerprint (SPEC §4): отпечатки ЗАМОРОЖЕНЫ. Красный тест
 * здесь означает, что канонизация (json_serialize_sql DuckDB или
 * libpg_query) или состав payload сдвинулись — у каждого пользователя
 * это молча пере-фингерпринтит все модели и вынудит полный ребилд склада.
 * Правильная реакция: НЕ обновлять хэши, а (1) понять, что дало дрейф
 * (апгрейд @duckdb/node-api? libpg-query? правка payload?), (2) осознанно
 * инкрементировать FINGERPRINT_VERSION и обеспечить историю миграции,
 * (3) только потом заморозить новые значения.
 */

const raw = defineExternal({
  name: "golden.raw",
  source: external.table("src.events"),
  schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
})

const incremental = defineModel(
  {
    name: "golden.events",
    kind: kind.incrementalByTimeRange({ timeColumn: "happened_at", start: "2026-01-01T00:00:00Z" }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
    grain: ["id"],
  },
  (ctx) => ctx.sql`
    SELECT id, happened_at FROM ${ctx.ref(raw)}
    WHERE happened_at >= ${ctx.start} AND happened_at < ${ctx.end}
  `,
)

const mart = defineModel(
  {
    name: "golden.daily",
    kind: kind.full(),
    schema: Schema.Struct({ day: Schema.DateTimeUtc, n: Schema.Number }),
  },
  (ctx) => ctx.sql`
    SELECT date_trunc('day', happened_at) AS day, count(*)::INT AS n
    FROM ${ctx.ref(incremental)} GROUP BY day
  `,
)

// то же тело, что у incremental, но переформатированное: лишние пробелы,
// переносы, регистр ключевых слов — канонизация обязана дать тот же отпечаток
const reformatted = defineModel(
  {
    name: "golden.events",
    kind: kind.incrementalByTimeRange({ timeColumn: "happened_at", start: "2026-01-01T00:00:00Z" }),
    schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }),
    grain: ["id"],
  },
  (ctx) => ctx.sql`select id,
         happened_at
    from ${ctx.ref(raw)}
   where happened_at >= ${ctx.start}
     and happened_at <  ${ctx.end}`,
)

const sha256 = (input: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(input)
  return hasher.digest("hex")
}

const GOLDEN = {
  fingerprintVersion: 1,
  raw: "31b6f1f055faff70d9d743fefe05b3656aa927b09793195f200192d8c4b911c9",
  events: "680e885965b7157049ca8004e466a54052fa537bf2fb25650b15d0b54ff34509",
  daily: "bcc3275ba4f4b35d6ae0e6ce4f925ce3060929c709ccc31dc3ce1a6fa5a9e1a2",
  postgresCanonSha256: "cf4706f8cec93781f29aa5d2541fc0917d7aae38a9185a9298ddca43e0b28f97",
} as const

const fingerprints = (models: Parameters<typeof buildGraph>[0]) =>
  Effect.runPromise(
    buildGraph(models)
      .pipe(Effect.flatMap(fingerprintGraph), Effect.provide(DuckDBEngineLive())),
  )

describe("golden fingerprints — канонизация как контракт (SPEC §4)", () => {
  test("константа версии не трогается случайно", () => {
    expect(FINGERPRINT_VERSION).toBe(GOLDEN.fingerprintVersion)
  })

  test("DuckDB: отпечатки заморожены", async () => {
    const versions = await fingerprints([raw, incremental, mart])
    expect(versions.get("golden.raw")?.fingerprint).toBe(GOLDEN.raw)
    expect(versions.get("golden.events")?.fingerprint).toBe(GOLDEN.events)
    expect(versions.get("golden.daily")?.fingerprint).toBe(GOLDEN.daily)
  })

  test("DuckDB: переформатирование тела не меняет отпечаток", async () => {
    const versions = await fingerprints([raw, reformatted])
    expect(versions.get("golden.events")?.fingerprint).toBe(GOLDEN.events)
  })

  test("libpg_query: канон Postgres заморожен (sha256 дерева)", async () => {
    const canon = await Effect.runPromise(
      canonicalizePostgresSql(
        `SELECT id, happened_at FROM golden.raw WHERE happened_at >= $start AND happened_at < $end`,
      ),
    )
    expect(sha256(canon)).toBe(GOLDEN.postgresCanonSha256)
  })

  test("снапшот чужой версии алгоритма — план честно останавливается", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore
        // окружение указывает на снапшот, посчитанный «будущей» версией алгоритма
        yield* store.upsertSnapshot({
          name: "golden.daily",
          fingerprint: "oldfp",
          renderedSql: "SELECT 1",
          canonicalAst: "{}",
          physicalFp: "oldfp",
          kind: "full",
          fingerprintVersion: FINGERPRINT_VERSION + 1,
        })
        yield* store.promote("dev", [{ name: "golden.daily", fingerprint: "oldfp" }])
        return yield* Effect.flip(Efmesh.plan("dev", [raw, incremental, mart]))
      }).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))),
    )
    expect(failure._tag).toBe("FingerprintVersionError")
    expect(failure).toMatchObject({ model: "golden.daily", wanted: FINGERPRINT_VERSION })
  })
})

describe("кэш канонизации (#8)", () => {
  test("второй plan не зовёт canonicalize; отпечатки идентичны; чужой ключ не липнет", async () => {
    let calls = 0
    const models = [raw, incremental, mart]
    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* EngineAdapter
        const counting = {
          ...engine,
          canonicalize: (sql: string) =>
            Effect.suspend(() => {
              calls += 1
              return engine.canonicalize(sql)
            }),
        }
        const graph = yield* buildGraph(models)
        const first = yield* planChanges("dev", graph).pipe(
          Effect.provideService(EngineAdapter, counting),
        )
        const callsAfterFirst = calls
        const second = yield* planChanges("dev", graph).pipe(
          Effect.provideService(EngineAdapter, counting),
        )
        expect(callsAfterFirst).toBeGreaterThan(0)
        expect(calls).toBe(callsAfterFirst) // всё из кэша
        return { first, second }
      }).pipe(
        Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())),
      ),
    )
    expect(second.actions.map((a) => a.fingerprint)).toEqual(
      first.actions.map((a) => a.fingerprint),
    )
  })
})
