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
import type { ChangeExplanation } from "./explain.ts"
import { dropsColumns, explainCategorized } from "./explain.ts"
import { FINGERPRINT_VERSION, fingerprintGraph, modelFingerprint } from "./fingerprint.ts"
import { validateEnvName } from "./naming.ts"

export class InvalidEnvironmentError extends Data.TaggedError("InvalidEnvironmentError")<{
  readonly env: string
}> {}

/** Модель нельзя применить forward-only (SPEC §5.2). */
export class ForwardOnlyError extends Data.TaggedError("ForwardOnlyError")<{
  readonly model: string
  readonly reason: string
}> {}

/**
 * Override категоризации не принимается (#5): модели нет в проекте или
 * AST-дифф очевидно противоречит заявленному вердикту (удалённые колонки
 * не бывают non-breaking — потомки читают их по именам).
 */
export class ReclassifyError extends Data.TaggedError("ReclassifyError")<{
  readonly model: string
  readonly reason: string
}> {}

/**
 * Снапшот посчитан другой версией алгоритма fingerprint (SPEC §4):
 * отпечатки разных версий несравнимы — план честно останавливается,
 * а не показывает «всё breaking». Лечится миграцией той версии efmesh,
 * которая сменила алгоритм.
 */
export class FingerprintVersionError extends Data.TaggedError("FingerprintVersionError")<{
  readonly model: string
  readonly found: number
  readonly wanted: number
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
  /** Вердикт планировщика до override оператора (#5); журналируется. */
  readonly reclassifiedFrom?: ChangeCategory
  /**
   * Почему категория такая (#4): разошедшиеся узлы канонического AST и
   * причина словами. Есть у всех изменённых моделей, кроме added/removed —
   * там сравнивать не с чем. Пути diverged — отладочная подсказка, не контракт.
   */
  readonly explain?: ChangeExplanation
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
  /**
   * Override категоризации (#5, SPEC §5.2): оператор, глядя на `--explain`,
   * заявляет вердикт вместо планировщика. Управляет судьбой ПОТОМКОВ
   * (non-breaking-родитель разрешает им реюз физики); саму модель от
   * пересборки освобождает не он, а forwardOnly. Гвардрейл: очевидное
   * противоречие AST (удалённые колонки → non-breaking) — ошибка.
   * Применяется только к вердиктам breaking/non-breaking; на unchanged/
   * added/removed/indirect молча не влияет.
   */
  readonly reclassify?: Readonly<Record<string, "breaking" | "non-breaking">>
}

/**
 * Виды, чью физику стоит наследовать при indirect-реюзе (#5): материализуемые
 * таблицы. view/embedded материализации не имеют, seed пересобирается из
 * файла дёшево и родителей не имеет.
 */
const REUSABLE_KINDS: ReadonlySet<string> = new Set([
  "full",
  "incrementalByTimeRange",
  "incrementalByUniqueKey",
  "scdType2",
])

export const planChanges = (
  env: string,
  graph: ModelGraph,
  options?: PlanOptions,
): Effect.Effect<
  Plan,
  | InvalidEnvironmentError
  | ForwardOnlyError
  | ReclassifyError
  | FingerprintVersionError
  | StateError
  | EngineError
  | SqlParseError
  | SeedReadError,
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
    const reclassify = options?.reclassify ?? {}
    for (const flagged of Object.keys(reclassify)) {
      if (!graph.models.has(flagged)) {
        return yield* new ReclassifyError({ model: flagged, reason: "модели нет в проекте" })
      }
    }
    // кэш канонизации (#8) — стор под рукой; его сбои глотаются:
    // промах кэша — это просто честный пересчёт, а не ошибка плана
    const versions = yield* fingerprintGraph(graph, {
      get: (key) => store.getCanon(key).pipe(Effect.orElseSucceed(() => undefined)),
      put: (key, canonical) => store.putCanon(key, canonical).pipe(Effect.ignore),
    })
    const current = new Map(
      (yield* store.getEnvironment(env)).map((row) => [row.name, row.fingerprint]),
    )

    const actions: Array<PlanAction> = []
    const changeOf = new Map<string, ChangeCategory>()
    // кто в этом плане наследует физику старой версии (indirect-реюз, #5)
    const reusedPhysics = new Set<string>()
    for (const name of graph.order) {
      const model = graph.models.get(name)!
      const { fingerprint, ast } = versions.get(name)!
      const known = current.get(name)
      let change: ChangeCategory
      let explain: ChangeExplanation | undefined
      let reclassifiedFrom: ChangeCategory | undefined
      let reusedFrom: string | undefined
      let physicalFingerprint = fingerprint
      if (known === undefined) change = "added"
      else if (known === fingerprint) change = "unchanged"
      else {
        // категоризация по AST против последнего известного снапшота (SPEC §5.2);
        // старых записей без AST и external — консервативно breaking
        const previous = yield* store.getSnapshot(name, known)
        if (previous !== undefined && previous.fingerprintVersion !== FINGERPRINT_VERSION) {
          return yield* new FingerprintVersionError({
            model: name,
            found: previous.fingerprintVersion,
            wanted: FINGERPRINT_VERSION,
          })
        }
        const oldAst = previous?.canonicalAst ?? ""
        const changedParents = [...model.deps].filter((dep) => {
          const parent = changeOf.get(dep)
          return parent !== undefined && parent !== "unchanged"
        })
        if (oldAst === "" || ast === null) {
          change = "breaking"
          explain = {
            diverged: [],
            reason:
              ast === null
                ? "у модели нет SQL-тела (external/seed) — версию сдвинули источник/файл, схема или родители; сравнивать AST не с чем"
                : "у прошлого снапшота не сохранён канонический AST — сравнивать не с чем, консервативно breaking",
          }
        } else if (oldAst === ast) {
          change = "indirect" // версия сдвинута родителем/метаданными
          explain =
            changedParents.length > 0
              ? {
                  diverged: [],
                  reason: `собственный AST не менялся — версию сдвинул каскад от родителей: ${changedParents.join(", ")}`,
                  cascadeFrom: changedParents,
                }
              : {
                  diverged: [],
                  reason:
                    "собственный AST не менялся — разошлись метаданные (kind/grain/columns/target)",
                }
        } else {
          change = categorizeAstChange(oldAst, ast)
          explain = explainCategorized(oldAst, ast, change)
        }
        // override оператора (#5): вердикт заявлен флагом поверх --explain;
        // планировщик проверяет только очевидное противоречие AST
        const override = reclassify[name]
        if (
          override !== undefined &&
          (change === "breaking" || change === "non-breaking") &&
          change !== override
        ) {
          if (override === "non-breaking" && (oldAst === "" || ast === null)) {
            return yield* new ReclassifyError({
              model: name,
              reason:
                "канонического AST нет — проверить вердикт нечем, override не принимается",
            })
          }
          if (override === "non-breaking" && ast !== null && dropsColumns(oldAst, ast)) {
            return yield* new ReclassifyError({
              model: name,
              reason:
                "в новом SELECT колонок меньше — потомки читают удалённые колонки по именам, non-breaking противоречит AST",
            })
          }
          reclassifiedFrom = change
          explain = {
            diverged: explain?.diverged ?? [],
            reason: `override оператора: ${change} → ${override}; вердикт планировщика: ${explain?.reason ?? "—"}`,
          }
          change = override
        }
        // «версию сдвинули ТОЛЬКО родители»: отпечаток со старыми подписями
        // родителей обязан дать known — иначе вместе с родителями разошлись
        // и метаданные (kind/grain/columns/target), наследовать физику нельзя
        const parentsOnly =
          change === "indirect" &&
          previous !== undefined &&
          [...model.deps].every((dep) => current.has(dep)) &&
          (yield* modelFingerprint(
            model,
            ast,
            [...model.deps].sort().map((dep) => `${dep}=${current.get(dep)!}`),
          )) === known
        // forward-only: явный флаг пользователя — либо каскад: собственный AST
        // не менялся, а все изменившиеся родители сами forward-only (реюз
        // физики родителя означает, что и потомку нечего переигрывать)
        const cascaded =
          parentsOnly &&
          model.kind._tag === "incrementalByTimeRange" &&
          [...model.deps].every((dep) => {
            const parent = changeOf.get(dep)
            return parent === undefined || parent === "unchanged" || parent === "forward-only"
          })
        if (previous !== undefined && (forwardOnly.has(name) || cascaded)) {
          change = "forward-only"
          reusedFrom = known
          physicalFingerprint = previous.physicalFp
          explain = forwardOnly.has(name)
            ? {
                diverged: explain?.diverged ?? [],
                reason: `forward-only по флагу: физика и done-интервалы наследуются от @${known.slice(0, 8)}, история не переигрывается`,
              }
            : {
                diverged: [],
                reason:
                  "собственный AST не менялся, все изменившиеся родители forward-only — физика реюзается каскадом",
                cascadeFrom: changedParents,
              }
        }
        // indirect-реюз (#5, класс sqlmesh «indirect non-breaking»): своё тело
        // не менялось, версию сдвинули только родители, и каждый изменившийся
        // родитель гарантирует те же данные в старых колонках (non-breaking —
        // строго суффикс; forward-only и реюз — буквально та же физика) —
        // потомку нечего переигрывать: физика и учёт наследуются, scdType2
        // не теряет накопленную историю строк
        if (
          change === "indirect" &&
          parentsOnly &&
          REUSABLE_KINDS.has(model.kind._tag) &&
          changedParents.length > 0 &&
          changedParents.every((dep) => {
            const parent = changeOf.get(dep)!
            return (
              parent === "non-breaking" ||
              parent === "forward-only" ||
              (parent === "indirect" && reusedPhysics.has(dep))
            )
          })
        ) {
          reusedFrom = known
          physicalFingerprint = previous!.physicalFp
          reusedPhysics.add(name)
          explain = {
            diverged: [],
            reason: `изменившиеся родители не трогают существующие данные (non-breaking/forward-only) — физика и учёт наследуются от @${known.slice(0, 8)}, пересборки нет`,
            cascadeFrom: changedParents,
          }
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
        ...(reclassifiedFrom !== undefined ? { reclassifiedFrom } : {}),
        ...(explain !== undefined ? { explain } : {}),
        build: !alreadyBuilt,
        backfill,
        // каждый apply сверяет запрос с физикой: upsert / SCD-версионирование
        refresh:
          model.kind._tag === "incrementalByUniqueKey" || model.kind._tag === "scdType2",
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
