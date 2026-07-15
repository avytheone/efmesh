import type { Schema } from "effect"
import type { IntervalUnit } from "./interval.ts"
import { ModelDefinitionError } from "./errors.ts"
import type { BoundValue, IdentsValue, RefValue, SqlFragment } from "./sql.ts"
import { collectRefs, sql, usesBounds } from "./sql.ts"

/** Вид материализации (SPEC §3.1). */
export type ModelKind =
  | { readonly _tag: "full" }
  | { readonly _tag: "view" }
  | {
      readonly _tag: "incrementalByTimeRange"
      /** Колонка времени, по которой режутся и перечитываются интервалы. */
      readonly timeColumn: string
      /** С какого момента бэкфиллить (ISO UTC). */
      readonly start: string
      /** Зерно интервала. */
      readonly interval: IntervalUnit
      /** Сколько интервалов зерна исполняется одним DELETE+INSERT. */
      readonly batchSize: number
      /** Сколько последних done-интервалов пересчитывать заново (поздние данные). */
      readonly lookback: number
    }
  | { readonly _tag: "external"; readonly source: ExternalSource }

/**
 * Определение внешнего источника (SPEC §9.3): таблица движка/ATTACH-базы
 * или файлы по пути/URL (`read_parquet`/`read_csv`/`read_json`, включая
 * HTTPS — REST-JSON ложится сюда же).
 */
export type ExternalSource =
  | { readonly _tag: "table"; readonly table: string }
  | {
      readonly _tag: "files"
      readonly path: string
      readonly format: "parquet" | "csv" | "json"
    }

export interface IncrementalByTimeRangeOptions {
  readonly timeColumn: string
  readonly start: string
  readonly interval?: IntervalUnit
  readonly batchSize?: number
  readonly lookback?: number
}

export const kind = {
  full: (): ModelKind => ({ _tag: "full" }),
  view: (): ModelKind => ({ _tag: "view" }),
  incrementalByTimeRange: (options: IncrementalByTimeRangeOptions): ModelKind => ({
    _tag: "incrementalByTimeRange",
    timeColumn: options.timeColumn,
    start: options.start,
    interval: options.interval ?? "day",
    batchSize: options.batchSize ?? 30,
    lookback: options.lookback ?? 0,
  }),
} as const

export const external = {
  table: (table: string): ExternalSource => ({ _tag: "table", table }),
  files: (path: string, format: "parquet" | "csv" | "json"): ExternalSource => ({
    _tag: "files",
    path,
    format,
  }),
} as const

/** Имя модели: `<схема>.<таблица>`. */
const MODEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/

export interface ModelName {
  readonly full: string
  readonly schema: string
  readonly table: string
}

export const parseModelName = (raw: string): ModelName => {
  if (!MODEL_NAME.test(raw)) {
    throw new ModelDefinitionError({
      model: raw,
      reason: "имя модели должно быть вида <схема>.<таблица> (латиница, цифры, _)",
    })
  }
  const [schema, table] = raw.split(".") as [string, string]
  return { full: raw, schema, table }
}

export interface ModelConfig<Fields extends Schema.Struct.Fields> {
  readonly name: string
  readonly kind: ModelKind
  readonly schema: Schema.Struct<Fields>
  readonly description?: string
  /** Логический первичный ключ; пока метаданные (аудит unique — F2). */
  readonly grain?: ReadonlyArray<Extract<keyof Fields, string>>
}

/** Контекст рендера тела модели. Тело обязано быть чистым: всё изменчивое приходит отсюда. */
export interface ModelCtx {
  readonly sql: typeof sql
  readonly ref: (model: AnyModel) => RefValue
  readonly cols: <Fields extends Schema.Struct.Fields>(
    model: Model<Fields>,
    ...names: ReadonlyArray<Extract<keyof Fields, string>>
  ) => IdentsValue
  /**
   * Границы обрабатываемого интервала `[start, end)` — только для
   * incrementalByTimeRange. При исполнении подставляются литералами,
   * в canonical-текст попадают плейсхолдерами (SPEC §3).
   */
  readonly start: BoundValue
  readonly end: BoundValue
}

export interface Model<Fields extends Schema.Struct.Fields = Schema.Struct.Fields> {
  readonly _tag: "Model"
  readonly name: ModelName
  readonly kind: ModelKind
  readonly schema: Schema.Struct<Fields>
  readonly description: string | undefined
  readonly grain: ReadonlyArray<string>
  /** Тело, отрендеренное в фрагмент один раз при определении. */
  readonly fragment: SqlFragment
  /** Имена моделей, на которые тело ссылается через `ctx.ref`. */
  readonly deps: ReadonlySet<string>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<any>

export const columnNames = (model: AnyModel): ReadonlyArray<string> =>
  Object.keys(model.schema.fields)

/**
 * Определяет модель. Вызывается на верхнем уровне модуля; тело выполняется
 * ровно один раз — сразу, поэтому ссылки (`ctx.ref`) известны статически
 * и DAG строится без парсинга SQL.
 */
export const defineModel = <const Fields extends Schema.Struct.Fields>(
  config: ModelConfig<Fields>,
  body: (ctx: ModelCtx) => SqlFragment,
): Model<Fields> => {
  const name = parseModelName(config.name)
  if (config.kind._tag === "external") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: "external-модель не имеет тела — используй defineExternal",
    })
  }
  if (config.kind._tag === "incrementalByTimeRange") {
    if (!(config.kind.timeColumn in config.schema.fields)) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `timeColumn «${config.kind.timeColumn}» нет в схеме модели`,
      })
    }
    if (Number.isNaN(Date.parse(config.kind.start))) {
      throw new ModelDefinitionError({
        model: name.full,
        reason: `start «${config.kind.start}» — не ISO-время`,
      })
    }
  }
  const ctx: ModelCtx = {
    sql,
    ref: (model) => ({ _tag: "RefValue", modelName: model.name.full }),
    cols: (model, ...names) => {
      const known = new Set(Object.keys(model.schema.fields))
      for (const column of names) {
        if (!known.has(column)) {
          // недостижимо при честной типизации; защита от `as any`
          throw new ModelDefinitionError({
            model: config.name,
            reason: `колонки «${column}» нет в схеме модели ${model.name.full}`,
          })
        }
      }
      return { _tag: "IdentsValue", names }
    },
    start: { _tag: "BoundValue", which: "start" },
    end: { _tag: "BoundValue", which: "end" },
  }
  const fragment = body(ctx)
  if (usesBounds(fragment) && config.kind._tag !== "incrementalByTimeRange") {
    throw new ModelDefinitionError({
      model: name.full,
      reason: `ctx.start/ctx.end доступны только incrementalByTimeRange, вид модели — ${config.kind._tag}`,
    })
  }
  const deps = collectRefs(fragment)
  if (deps.has(name.full)) {
    throw new ModelDefinitionError({ model: name.full, reason: "модель ссылается сама на себя" })
  }
  return {
    _tag: "Model",
    name,
    kind: config.kind,
    schema: config.schema,
    description: config.description,
    grain: config.grain ?? [],
    fragment,
    deps,
  }
}

export interface ExternalConfig<Fields extends Schema.Struct.Fields> {
  readonly name: string
  readonly source: ExternalSource
  readonly schema: Schema.Struct<Fields>
  readonly description?: string
}

/**
 * Внешний источник (SPEC §3.1, §9.3): не материализуется, но участвует
 * в DAG и lineage, схема объявляется. В fingerprint входит только
 * *определение* источника — содержимое меняется между запусками, и это
 * нормально для сырья.
 */
export const defineExternal = <const Fields extends Schema.Struct.Fields>(
  config: ExternalConfig<Fields>,
): Model<Fields> => ({
  _tag: "Model",
  name: parseModelName(config.name),
  kind: { _tag: "external", source: config.source },
  schema: config.schema,
  description: config.description,
  grain: [],
  fragment: { _tag: "SqlFragment", nodes: [] },
  deps: new Set(),
})
