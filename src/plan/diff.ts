import { Data, Effect } from "effect"
import type { GraphError } from "../core/graph.ts"
import { buildGraph } from "../core/graph.ts"
import type { AnyModel } from "../core/model.ts"
import { quoteIdent } from "../core/sql.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { viewRef } from "./naming.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"

/** Чем окружения отличаются (SPEC §11: `efmesh diff <envA> <envB>`). */
export interface EnvDiff {
  /** Модель есть только в A. */
  readonly onlyInA: ReadonlyArray<string>
  readonly onlyInB: ReadonlyArray<string>
  /** Разные версии: имя + fp8 обеих сторон. */
  readonly different: ReadonlyArray<{ readonly name: string; readonly a: string; readonly b: string }>
  readonly same: ReadonlyArray<string>
}

export const diffEnvironments = (
  envA: string,
  envB: string,
): Effect.Effect<EnvDiff, StateError, StateStore> =>
  Effect.gen(function* () {
    const store = yield* StateStore
    const a = new Map((yield* store.getEnvironment(envA)).map((r) => [r.name, r.fingerprint]))
    const b = new Map((yield* store.getEnvironment(envB)).map((r) => [r.name, r.fingerprint]))

    const onlyInA: Array<string> = []
    const different: Array<{ name: string; a: string; b: string }> = []
    const same: Array<string> = []
    for (const [name, fpA] of a) {
      const fpB = b.get(name)
      if (fpB === undefined) onlyInA.push(name)
      else if (fpA === fpB) same.push(name)
      else different.push({ name, a: fpA.slice(0, 8), b: fpB.slice(0, 8) })
    }
    const onlyInB = [...b.keys()].filter((name) => !a.has(name))

    return { onlyInA, onlyInB, different, same }
  })

/**
 * Сравнение ДАННЫХ двух окружений (#6, класс table_diff sqlmesh): счётчики
 * строк, пересечение по ключу, помодельные доли расхождений по колонкам —
 * между view-слоями A и B одной базы. На DuckDB-классе данных это дёшево;
 * для больших таблиц — детерминированная выборка по md5 ключа: обе стороны
 * фильтруются одинаковыми бакетами, поэтому выборка выровнена и пары
 * ключей не теряются.
 */

export interface ColumnDrift {
  readonly column: string
  /** Сколько сопоставленных ключей разошлись в этой колонке. */
  readonly mismatches: number
  /** Доля от matched, 0..1. */
  readonly rate: number
}

export interface ModelDataDiff {
  readonly model: string
  /** Полные счётчики строк (не задеты выборкой). */
  readonly rowsA: number
  readonly rowsB: number
  /** Ключ сопоставления: grain или ключ вида (uniqueKey/scdType2). */
  readonly key?: ReadonlyArray<string>
  /** Дальше — только при ключе; при выборке счётчики по выбранным бакетам. */
  readonly onlyInA?: number
  readonly onlyInB?: number
  readonly matched?: number
  readonly columns?: ReadonlyArray<ColumnDrift>
  /** Колонки только одной стороны — дрейф схемы между окружениями. */
  readonly columnsOnlyInA?: ReadonlyArray<string>
  readonly columnsOnlyInB?: ReadonlyArray<string>
  /** Процент md5-бакетов ключа в сравнении; нет поля — сравнение полное. */
  readonly sampledPercent?: number
}

export interface DataDiffReport {
  readonly envA: string
  readonly envB: string
  readonly models: ReadonlyArray<ModelDataDiff>
}

export interface DataDiffOptions {
  /** Только эти модели; по умолчанию — все материализуемые из обоих окружений. */
  readonly models?: ReadonlyArray<string>
  /** 1–99: сравнивать долю ключей (md5-бакеты, выровнено между сторонами). */
  readonly samplePercent?: number
}

export class DataDiffError extends Data.TaggedError("DataDiffError")<{
  readonly model: string
  readonly reason: string
}> {}

/** Виды с view-слоем в окружении — их данные есть с чем сравнивать. */
const COMPARABLE_KINDS: ReadonlySet<string> = new Set([
  "full",
  "view",
  "incrementalByTimeRange",
  "incrementalByUniqueKey",
  "scdType2",
  "seed",
])

const keyOf = (model: AnyModel): ReadonlyArray<string> | undefined => {
  if (model.grain !== undefined && model.grain.length > 0) return model.grain
  if (model.kind._tag === "incrementalByUniqueKey" || model.kind._tag === "scdType2") {
    return model.kind.key
  }
  return undefined
}

/**
 * Детерминированный фильтр выборки: md5 от склейки ключа, первые два
 * hex-символа = 256 бакетов. Работает и на DuckDB, и на Postgres,
 * одинаково на обеих сторонах diff'а.
 */
const samplePredicate = (key: ReadonlyArray<string>, percent: number): string => {
  const buckets = Math.max(1, Math.min(255, Math.floor((256 * percent) / 100)))
  const threshold = buckets.toString(16).padStart(2, "0")
  return `substr(md5(concat_ws('|', ${key.map(quoteIdent).join(", ")})), 1, 2) < '${threshold}'`
}

const asCount = (value: unknown): number => Number(value ?? 0)

export const dataDiffEnvironments = (
  envA: string,
  envB: string,
  models: Iterable<AnyModel>,
  options?: DataDiffOptions,
): Effect.Effect<
  DataDiffReport,
  GraphError | StateError | EngineError | DataDiffError,
  StateStore | EngineAdapter
> =>
  Effect.gen(function* () {
    const store = yield* StateStore
    const engine = yield* EngineAdapter
    const graph = yield* buildGraph(models)
    const inA = new Set((yield* store.getEnvironment(envA)).map((row) => row.name))
    const inB = new Set((yield* store.getEnvironment(envB)).map((row) => row.name))
    for (const name of options?.models ?? []) {
      if (!graph.models.has(name)) {
        return yield* new DataDiffError({ model: name, reason: "модели нет в проекте" })
      }
      if (!inA.has(name) || !inB.has(name)) {
        return yield* new DataDiffError({
          model: name,
          reason: `модели нет в окружении ${inA.has(name) ? envB : envA}`,
        })
      }
    }
    const wanted = options?.models === undefined ? undefined : new Set(options.models)
    const percent = options?.samplePercent

    const reports: Array<ModelDataDiff> = []
    for (const name of graph.order) {
      if (wanted !== undefined && !wanted.has(name)) continue
      if (!inA.has(name) || !inB.has(name)) continue
      const model = graph.models.get(name)!
      if (!COMPARABLE_KINDS.has(model.kind._tag)) continue
      const refA = viewRef(envA, model.name)
      const refB = viewRef(envB, model.name)

      const rowsA = asCount(
        (yield* engine.query(`SELECT count(*) AS n FROM ${refA}`))[0]?.["n"],
      )
      const rowsB = asCount(
        (yield* engine.query(`SELECT count(*) AS n FROM ${refB}`))[0]?.["n"],
      )

      // реальные колонки обеих сторон: окружения могут указывать на разные
      // версии модели — сравниваются только общие, дрейф схемы фиксируется
      const colsA = (yield* engine.describe(`SELECT * FROM ${refA}`)).map((c) => c.name)
      const colsB = (yield* engine.describe(`SELECT * FROM ${refB}`)).map((c) => c.name)
      const setB = new Set(colsB)
      const setA = new Set(colsA)
      const common = colsA.filter((column) => setB.has(column))
      const columnsOnlyInA = colsA.filter((column) => !setB.has(column))
      const columnsOnlyInB = colsB.filter((column) => !setA.has(column))

      const key = keyOf(model)
      const commonSet = new Set(common)
      if (key === undefined || !key.every((column) => commonSet.has(column))) {
        // сопоставлять нечем (нет grain/ключа или ключ не на обеих сторонах) —
        // честные счётчики строк без пары
        reports.push({
          model: name,
          rowsA,
          rowsB,
          ...(columnsOnlyInA.length > 0 ? { columnsOnlyInA } : {}),
          ...(columnsOnlyInB.length > 0 ? { columnsOnlyInB } : {}),
        })
        continue
      }

      const keySet = new Set(key)
      const compared = common.filter((column) => !keySet.has(column))
      const sample = percent === undefined ? "" : ` WHERE ${samplePredicate(key, percent)}`
      const pairs = compared
        .map(
          (column, index) =>
            `, a.${quoteIdent(column)} AS a_${index}, b.${quoteIdent(column)} AS b_${index}`,
        )
        .join("")
      const mismatches = compared
        .map(
          (_, index) =>
            `, count(*) FILTER (WHERE in_a AND in_b AND (a_${index} IS DISTINCT FROM b_${index})) AS mm_${index}`,
        )
        .join("")
      const keyList = key.map(quoteIdent).join(", ")
      const [row] = yield* engine.query(`
        SELECT
          count(*) FILTER (WHERE NOT in_b) AS only_a,
          count(*) FILTER (WHERE NOT in_a) AS only_b,
          count(*) FILTER (WHERE in_a AND in_b) AS matched
          ${mismatches}
        FROM (
          SELECT coalesce(a.in_a, FALSE) AS in_a, coalesce(b.in_b, FALSE) AS in_b${pairs}
          FROM (SELECT TRUE AS in_a, * FROM ${refA}${sample}) a
          FULL OUTER JOIN (SELECT TRUE AS in_b, * FROM ${refB}${sample}) b
          USING (${keyList})
        ) j
      `)
      const matched = asCount(row?.["matched"])
      const columns = compared
        .map((column, index) => {
          const drifted = asCount(row?.[`mm_${index}`])
          return {
            column,
            mismatches: drifted,
            rate: matched === 0 ? 0 : drifted / matched,
          }
        })
        .filter((drift) => drift.mismatches > 0)
      reports.push({
        model: name,
        rowsA,
        rowsB,
        key,
        onlyInA: asCount(row?.["only_a"]),
        onlyInB: asCount(row?.["only_b"]),
        matched,
        columns,
        ...(columnsOnlyInA.length > 0 ? { columnsOnlyInA } : {}),
        ...(columnsOnlyInB.length > 0 ? { columnsOnlyInB } : {}),
        ...(percent !== undefined ? { sampledPercent: percent } : {}),
      })
    }
    return { envA, envB, models: reports }
  }).pipe(Effect.withSpan("efmesh.diff.data", { attributes: { envA, envB } }))
