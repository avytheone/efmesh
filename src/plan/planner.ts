import { Data, Effect } from "effect"
import type { ModelGraph } from "../core/graph.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import { fingerprintGraph } from "./fingerprint.ts"
import { validateEnvName } from "./naming.ts"

export class InvalidEnvironmentError extends Data.TaggedError("InvalidEnvironmentError")<{
  readonly env: string
}> {}

export type ChangeCategory =
  /** Модели не было в окружении. */
  | "added"
  /** Fingerprint разошёлся. F0: любое изменение = breaking (категоризация по AST — F2). */
  | "breaking"
  /** Была в окружении, из проекта исчезла — view будет снесён при промоушене. */
  | "removed"
  | "unchanged"

export interface PlanAction {
  readonly name: string
  readonly fingerprint: string
  readonly change: ChangeCategory
  /**
   * Нужна ли сборка физики. false для unchanged/removed и для снапшотов,
   * уже собранных другим окружением, — тогда промоушен это только view-swap.
   */
  readonly build: boolean
}

export interface Plan {
  readonly env: string
  /** В топологическом порядке; removed — в конце. */
  readonly actions: ReadonlyArray<PlanAction>
  readonly hasChanges: boolean
}

export const planChanges = (
  env: string,
  graph: ModelGraph,
): Effect.Effect<Plan, InvalidEnvironmentError | StateError, StateStore> =>
  Effect.gen(function* () {
    if (!validateEnvName(env)) return yield* new InvalidEnvironmentError({ env })
    const store = yield* StateStore
    const fingerprints = fingerprintGraph(graph)
    const current = new Map(
      (yield* store.getEnvironment(env)).map((row) => [row.name, row.fingerprint]),
    )

    const actions: Array<PlanAction> = []
    for (const name of graph.order) {
      const fingerprint = fingerprints.get(name)!
      const known = current.get(name)
      const change: ChangeCategory =
        known === undefined ? "added" : known === fingerprint ? "unchanged" : "breaking"
      const alreadyBuilt =
        change === "unchanged" ||
        (yield* store.getSnapshot(name, fingerprint)) !== undefined
      actions.push({ name, fingerprint, change, build: !alreadyBuilt })
    }
    for (const [name, fingerprint] of current) {
      if (!graph.models.has(name)) {
        actions.push({ name, fingerprint, change: "removed", build: false })
      }
    }

    return {
      env,
      actions,
      hasChanges: actions.some((a) => a.change !== "unchanged"),
    }
  })
