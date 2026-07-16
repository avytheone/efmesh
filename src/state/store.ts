import { Context, Data, Effect } from "effect"

export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/**
 * Текущая версия схемы state store. Свежий стор бутстрапится сразу
 * на неё; стор со схемой старше (в т.ч. созданный до появления версии)
 * открытие не проходит — данные догоняет явный `efmesh migrate`.
 * 1 — базовая раскладка (F4), 2 — applied_by в журнале планов (F5).
 */
export const STATE_VERSION = 2

/** Схема стора не совпадает с ожидаемой бинарём — нужен `efmesh migrate`. */
export class StateSchemaError extends Data.TaggedError("StateSchemaError")<{
  readonly found: number
  readonly wanted: number
}> {}

/** Итог миграции для CLI. */
export interface MigrationReport {
  readonly from: number
  readonly to: number
}

/** Версия модели, известная state store (SPEC §6). */
export interface SnapshotRecord {
  readonly name: string
  readonly fingerprint: string
  /** Canonical-рендер SQL — для diff-показа и отладки. */
  readonly renderedSql: string
  /** Канонический AST тела (JSON) — для категоризации изменений (SPEC §5.2). */
  readonly canonicalAst: string
  /**
   * Fingerprint, чьей физической таблицей/префиксом пользуется снапшот.
   * Обычно равен собственному; при forward-only (SPEC §5.2) — наследуется
   * от предыдущей версии: физика переиспользуется, история не переигрывается.
   */
  readonly physicalFp: string
  readonly kind: string
  readonly createdAt: string
  /**
   * Когда снапшот перестал быть указан хоть одним окружением (ISO UTC);
   * null — на него ссылаются. Ставится и снимается при промоушене,
   * ttl janitor'а отсчитывается отсюда (SPEC §5.4).
   */
  readonly orphanedAt: string | null
}

/** Строка окружения: логическое имя → снапшот, на который указывает view. */
export interface EnvironmentRecord {
  readonly env: string
  readonly name: string
  readonly fingerprint: string
  readonly promotedAt: string
}

export interface PlanRecord {
  readonly id: number
  readonly env: string
  readonly summary: string
  readonly appliedAt: string
  /** Кто применил план (ОС-пользователь или ApplyOptions.appliedBy); '' у записей до v2. */
  readonly appliedBy: string
}

/**
 * Учёт заполненных интервалов снапшота (SPEC §6) — единственный источник
 * правды о том, что посчитано: физическая таблица без записей здесь
 * считается пустой. Границы — ISO UTC (сортируются лексикографически).
 */
export interface IntervalRecord {
  readonly snapshotFp: string
  readonly startTs: string
  readonly endTs: string
  readonly status: "done" | "failed"
  readonly updatedAt: string
}

export interface StateStoreShape {
  /** Идемпотентно: (name, fingerprint) уникальны, повторная запись — no-op. */
  readonly upsertSnapshot: (
    snapshot: Omit<SnapshotRecord, "createdAt" | "orphanedAt">,
  ) => Effect.Effect<void, StateError>
  readonly getSnapshot: (
    name: string,
    fingerprint: string,
  ) => Effect.Effect<SnapshotRecord | undefined, StateError>
  /** Все снапшоты, на которые ссылается хоть одно окружение, — для janitor. */
  readonly listReferencedFingerprints: () => Effect.Effect<ReadonlySet<string>, StateError>
  readonly listSnapshots: () => Effect.Effect<ReadonlyArray<SnapshotRecord>, StateError>
  /** Удаляет запись снапшота и его учёт интервалов (физику убирает janitor). */
  readonly deleteSnapshot: (name: string, fingerprint: string) => Effect.Effect<void, StateError>
  readonly getEnvironment: (
    env: string,
  ) => Effect.Effect<ReadonlyArray<EnvironmentRecord>, StateError>
  /** Транзакционно заменяет весь набор окружения. */
  readonly promote: (
    env: string,
    entries: ReadonlyArray<{ readonly name: string; readonly fingerprint: string }>,
  ) => Effect.Effect<void, StateError>
  /** Журнал применённых планов. */
  readonly recordPlan: (
    env: string,
    summary: string,
    appliedBy: string,
  ) => Effect.Effect<void, StateError>
  readonly listPlans: (env: string) => Effect.Effect<ReadonlyArray<PlanRecord>, StateError>
  /**
   * Межпроцессная блокировка (SPEC §7): true — получена, false — держит
   * другой процесс. Протухшие (expires) локи перехватываются — упавший
   * процесс не оставляет вечный замок.
   */
  readonly acquireLock: (name: string, ttlMs: number) => Effect.Effect<boolean, StateError>
  readonly releaseLock: (name: string) => Effect.Effect<void, StateError>
  /** Транзакционный upsert интервалов снапшота (повторная отметка — обновление статуса). */
  readonly markIntervals: (
    snapshotFp: string,
    intervals: ReadonlyArray<{ readonly startTs: string; readonly endTs: string }>,
    status: IntervalRecord["status"],
  ) => Effect.Effect<void, StateError>
  readonly listIntervals: (
    snapshotFp: string,
  ) => Effect.Effect<ReadonlyArray<IntervalRecord>, StateError>
}

export class StateStore extends Context.Service<StateStore, StateStoreShape>()(
  "efmesh/StateStore",
) {}
