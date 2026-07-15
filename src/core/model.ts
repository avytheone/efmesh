import type { Schema } from "effect"
import { ModelDefinitionError } from "./errors.ts"
import type { IdentsValue, RefValue, SqlFragment } from "./sql.ts"
import { collectRefs, sql } from "./sql.ts"

/** Вид материализации (F0: только full и view, см. SPEC §3.1). */
export type ModelKind = { readonly _tag: "full" } | { readonly _tag: "view" }

export const kind = {
  full: (): ModelKind => ({ _tag: "full" }),
  view: (): ModelKind => ({ _tag: "view" }),
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
  }
  const fragment = body(ctx)
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
