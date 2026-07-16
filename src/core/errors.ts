import { Data } from "effect"
import { causeText } from "../error-text.ts"

/** Invalid model configuration: a malformed name, a self-ref, etc. Thrown at module load time. */
export class ModelDefinitionError extends Data.TaggedError("ModelDefinitionError")<{
  readonly model: string
  readonly reason: string
}> {
  override get message(): string {
    return `model «${this.model}»: ${this.reason}`
  }
}

export class DuplicateModelError extends Data.TaggedError("DuplicateModelError")<{
  readonly name: string
}> {
  override get message(): string {
    return `model «${this.name}» is defined twice — names must be unique across the project`
  }
}

export class UnknownDependencyError extends Data.TaggedError("UnknownDependencyError")<{
  readonly model: string
  readonly dependency: string
}> {
  override get message(): string {
    return `model «${this.model}» depends on «${this.dependency}», which is not in the project`
  }
}

export class DagCycleError extends Data.TaggedError("DagCycleError")<{
  readonly cycle: ReadonlyArray<string>
}> {
  override get message(): string {
    return `dependency cycle: ${this.cycle.join(" → ")}`
  }
}

/** A seed model's file can't be read — fingerprint and assembly are impossible. */
export class SeedReadError extends Data.TaggedError("SeedReadError")<{
  readonly model: string
  readonly file: string
  readonly cause: unknown
}> {
  override get message(): string {
    return `seed «${this.model}»: cannot read ${this.file} — ${causeText(this.cause)}`
  }
}

/** A model name handed to the facade/CLI (render, lineage) is not in the project. */
export class UnknownModelError extends Data.TaggedError("UnknownModelError")<{
  readonly model: string
}> {
  override get message(): string {
    return `model «${this.model}» is not in the project`
  }
}
