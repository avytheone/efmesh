import { Data } from "effect"

/** Invalid model configuration: a malformed name, a self-ref, etc. Thrown at module load time. */
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

/** A seed model's file can't be read — fingerprint and assembly are impossible. */
export class SeedReadError extends Data.TaggedError("SeedReadError")<{
  readonly model: string
  readonly file: string
  readonly cause: unknown
}> {}
