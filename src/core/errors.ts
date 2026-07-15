import { Data } from "effect"

/** Некорректная конфигурация модели: битое имя, self-ref и т.п. Бросается на этапе загрузки модуля. */
export class ModelDefinitionError extends Data.TaggedError("ModelDefinitionError")<{
  readonly model: string
  readonly reason: string
}> {}

export class DuplicateModelError extends Data.TaggedError("DuplicateModelError")<{
  readonly name: string
}> {}

export class UnknownDependencyError extends Data.TaggedError("UnknownDependencyError")<{
  readonly model: string
  readonly dependency: string
}> {}

export class DagCycleError extends Data.TaggedError("DagCycleError")<{
  readonly cycle: ReadonlyArray<string>
}> {}

/** Файл seed-модели не читается — fingerprint и сборка невозможны. */
export class SeedReadError extends Data.TaggedError("SeedReadError")<{
  readonly model: string
  readonly file: string
  readonly cause: unknown
}> {}
