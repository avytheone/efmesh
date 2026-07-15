import { Effect } from "effect"
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
