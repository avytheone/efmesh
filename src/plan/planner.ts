import { Clock, Data, Effect } from "effect"
import type { SeedReadError } from "../core/errors.ts"
import type { ModelGraph } from "../core/graph.ts"
import type { Interval } from "../core/interval.ts"
import { enumerateIntervals, fromIso, mergeIntervals, missingIntervals } from "../core/interval.ts"
import type { EngineError, SqlParseError } from "../engine/adapter.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import { categorizeAstChange } from "./categorize.ts"
import { fingerprintGraph } from "./fingerprint.ts"
import { validateEnvName } from "./naming.ts"

export class InvalidEnvironmentError extends Data.TaggedError("InvalidEnvironmentError")<{
  readonly env: string
}> {}

export type ChangeCategory =
  /** Модели не было в окружении. */
  | "added"
  /** Смысловая правка запроса или метаданных: модель и потомки пересобираются. */
  | "breaking"
  /** Добавлены колонки в конец SELECT, остальное дерево нетронуто (SPEC §5.2). */
  | "non-breaking"
  /** Собственный AST не менялся — версия сдвинулась каскадом от родителя. */
  | "indirect"
  /** Была в окружении, из проекта исчезла — view будет снесён при промоушене. */
  | "removed"
  | "unchanged"

export interface PlanAction {
  readonly name: string
  readonly fingerprint: string
  /** Канонический AST тела (null у external) — сохраняется в снапшот. */
  readonly canonicalAst: string | null
  readonly change: ChangeCategory
  /**
   * Нужна ли сборка физики. false для unchanged/removed, external и для
   * снапшотов, уже собранных другим окружением, — тогда промоушен это
   * только view-swap.
   */
  readonly build: boolean
  /**
   * Диапазоны к пересчёту у incrementalByTimeRange (слитые из недостающих
   * интервалов + lookback); у остальных видов пуст. Дыры бывают и у
   * unchanged-модели — время идёт, появляются новые интервалы.
   */
  readonly backfill: ReadonlyArray<Interval>
  /** true у incrementalByUniqueKey: каждый apply перегоняет запрос (upsert по ключу). */
  readonly refresh: boolean
}

export interface Plan {
  readonly env: string
  /** В топологическом порядке; removed — в конце. */
  readonly actions: ReadonlyArray<PlanAction>
  readonly hasChanges: boolean
}

export interface PlanOptions {
  /** «Сейчас» для расчёта интервалов; по умолчанию — Clock. Инъекция для тестов. */
  readonly now?: number
}

export const planChanges = (
  env: string,
  graph: ModelGraph,
  options?: PlanOptions,
): Effect.Effect<
  Plan,
  InvalidEnvironmentError | StateError | EngineError | SqlParseError | SeedReadError,
  StateStore | EngineAdapter
> =>
  Effect.gen(function* () {
    if (!validateEnvName(env)) return yield* new InvalidEnvironmentError({ env })
    const store = yield* StateStore
    const now = options?.now ?? (yield* Clock.currentTimeMillis)
    const versions = yield* fingerprintGraph(graph)
    const current = new Map(
      (yield* store.getEnvironment(env)).map((row) => [row.name, row.fingerprint]),
    )

    const actions: Array<PlanAction> = []
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      const { fingerprint, ast } = versions.get(name)!
      const known = current.get(name)
      let change: ChangeCategory
      if (known === undefined) change = "added"
      else if (known === fingerprint) change = "unchanged"
      else {
        // категоризация по AST против последнего известного снапшота (SPEC §5.2);
        // старых записей без AST и external — консервативно breaking
        const previous = yield* store.getSnapshot(name, known)
        const oldAst = previous?.canonicalAst ?? ""
        if (oldAst === "" || ast === null) change = "breaking"
        else if (oldAst === ast) change = "indirect" // версия сдвинута родителем/метаданными
        else change = categorizeAstChange(oldAst, ast)
      }
      // external не материализуется — версия участвует в diff, физики нет
      const alreadyBuilt =
        model.kind._tag === "external" ||
        change === "unchanged" ||
        (yield* store.getSnapshot(name, fingerprint)) !== undefined

      let backfill: ReadonlyArray<Interval> = []
      if (model.kind._tag === "incrementalByTimeRange") {
        const kind = model.kind
        const wanted = enumerateIntervals(kind.interval, fromIso(kind.start), now)
        // покрытие привязано к fingerprint: новая версия = пустой учёт = полный бэкфилл
        const done = (yield* store.listIntervals(fingerprint))
          .filter((record) => record.status === "done")
          .map((record) => ({ start: fromIso(record.startTs), end: fromIso(record.endTs) }))
        const missing = [...missingIntervals(wanted, done)]
        if (kind.lookback > 0) {
          // поздно приезжающие данные: последние done-интервалы перечитываются
          const tail = done.sort((a, b) => a.start - b.start).slice(-kind.lookback)
          missing.push(...tail)
        }
        backfill = mergeIntervals(missing.sort((a, b) => a.start - b.start))
      }

      actions.push({
        name,
        fingerprint,
        canonicalAst: ast,
        change,
        build: !alreadyBuilt,
        backfill,
        refresh: model.kind._tag === "incrementalByUniqueKey",
      })
    }
    for (const [name, fingerprint] of current) {
      if (!graph.models.has(name)) {
        actions.push({
          name,
          fingerprint,
          canonicalAst: null,
          change: "removed",
          build: false,
          backfill: [],
          refresh: false,
        })
      }
    }

    return {
      env,
      actions,
      hasChanges: actions.some(
        (a) => a.change !== "unchanged" || a.backfill.length > 0 || a.refresh,
      ),
    }
  }).pipe(Effect.withSpan("efmesh.plan", { attributes: { env } }))
