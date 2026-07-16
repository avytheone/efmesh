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

/** Модель нельзя применить forward-only (SPEC §5.2). */
export class ForwardOnlyError extends Data.TaggedError("ForwardOnlyError")<{
  readonly model: string
  readonly reason: string
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
  /**
   * Физика и done-интервалы старой версии переиспользуются, история не
   * переигрывается — новая логика действует с момента применения (SPEC §5.2).
   * Явный флаг пользователя или каскад от forward-only-родителей.
   */
  | "forward-only"
  /** Была в окружении, из проекта исчезла — view будет снесён при промоушене. */
  | "removed"
  | "unchanged"

export interface PlanAction {
  readonly name: string
  readonly fingerprint: string
  /**
   * Fingerprint, чьей физикой пользуется снапшот: обычно собственный,
   * при forward-only — унаследованный от предыдущей версии.
   */
  readonly physicalFingerprint: string
  /** Откуда наследуются физика и done-интервалы (fingerprint старой версии) при forward-only. */
  readonly reusedFrom?: string
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
  /**
   * Модели, чьи изменения применить forward-only (SPEC §5.2): новая версия
   * наследует физическую таблицу и done-интервалы старой, история не
   * переигрывается. Только incrementalByTimeRange — у остальных видов
   * «задним числом» не бывает по построению.
   */
  readonly forwardOnly?: ReadonlyArray<string>
}

export const planChanges = (
  env: string,
  graph: ModelGraph,
  options?: PlanOptions,
): Effect.Effect<
  Plan,
  InvalidEnvironmentError | ForwardOnlyError | StateError | EngineError | SqlParseError | SeedReadError,
  StateStore | EngineAdapter
> =>
  Effect.gen(function* () {
    if (!validateEnvName(env)) return yield* new InvalidEnvironmentError({ env })
    const store = yield* StateStore
    const now = options?.now ?? (yield* Clock.currentTimeMillis)
    const forwardOnly = new Set(options?.forwardOnly ?? [])
    for (const flagged of forwardOnly) {
      const model = graph.models.get(flagged)
      if (model === undefined) {
        return yield* new ForwardOnlyError({ model: flagged, reason: "модели нет в проекте" })
      }
      if (model.kind._tag !== "incrementalByTimeRange") {
        return yield* new ForwardOnlyError({
          model: flagged,
          reason: `forward-only переиспользует физику и учёт интервалов — применим только к incrementalByTimeRange, вид модели — ${model.kind._tag}`,
        })
      }
    }
    const versions = yield* fingerprintGraph(graph)
    const current = new Map(
      (yield* store.getEnvironment(env)).map((row) => [row.name, row.fingerprint]),
    )

    const actions: Array<PlanAction> = []
    const changeOf = new Map<string, ChangeCategory>()
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      const { fingerprint, ast } = versions.get(name)!
      const known = current.get(name)
      let change: ChangeCategory
      let reusedFrom: string | undefined
      let physicalFingerprint = fingerprint
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
        // forward-only: явный флаг пользователя — либо каскад: собственный AST
        // не менялся, а все изменившиеся родители сами forward-only (реюз
        // физики родителя означает, что и потомку нечего переигрывать)
        const cascaded =
          change === "indirect" &&
          model.kind._tag === "incrementalByTimeRange" &&
          [...model.deps].every((dep) => {
            const parent = changeOf.get(dep)
            return parent === undefined || parent === "unchanged" || parent === "forward-only"
          })
        if (previous !== undefined && (forwardOnly.has(name) || cascaded)) {
          change = "forward-only"
          reusedFrom = known
          physicalFingerprint = previous.physicalFp
        }
      }
      changeOf.set(name, change)
      // external не материализуется — версия участвует в diff, физики нет
      const existing = yield* store.getSnapshot(name, fingerprint)
      if (existing !== undefined) physicalFingerprint = existing.physicalFp
      const alreadyBuilt =
        model.kind._tag === "external" || change === "unchanged" || existing !== undefined

      let backfill: ReadonlyArray<Interval> = []
      if (model.kind._tag === "incrementalByTimeRange") {
        const kind = model.kind
        const wanted = enumerateIntervals(kind.interval, fromIso(kind.start), now)
        // покрытие привязано к fingerprint: новая версия = пустой учёт = полный
        // бэкфилл; forward-only наследует done-интервалы старой версии —
        // пересчитывается только то, чего не было
        const inherited =
          reusedFrom === undefined ? [] : yield* store.listIntervals(reusedFrom)
        const doneByStart = new Map<number, Interval>()
        for (const record of [...(yield* store.listIntervals(fingerprint)), ...inherited]) {
          if (record.status !== "done") continue
          doneByStart.set(fromIso(record.startTs), {
            start: fromIso(record.startTs),
            end: fromIso(record.endTs),
          })
        }
        const done = [...doneByStart.values()]
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
        physicalFingerprint,
        ...(reusedFrom !== undefined ? { reusedFrom } : {}),
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
          physicalFingerprint: fingerprint,
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
