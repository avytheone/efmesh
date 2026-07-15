import { Context, Data, Effect } from "effect"

export class StateError extends Data.TaggedError("StateError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/** Версия модели, известная state store (SPEC §6). */
export interface SnapshotRecord {
  readonly name: string
  readonly fingerprint: string
  /** Canonical-рендер SQL — для diff-показа и отладки. */
  readonly renderedSql: string
  /** Канонический AST тела (JSON) — для категоризации изменений (SPEC §5.2). */
  readonly canonicalAst: string
  readonly kind: string
  readonly createdAt: string
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
    snapshot: Omit<SnapshotRecord, "createdAt">,
  ) => Effect.Effect<void, StateError>
  readonly getSnapshot: (
    name: string,
    fingerprint: string,
  ) => Effect.Effect<SnapshotRecord | undefined, StateError>
  /** Все снапшоты, на которые ссылается хоть одно окружение, — для janitor (F2). */
  readonly listReferencedFingerprints: () => Effect.Effect<ReadonlySet<string>, StateError>
  readonly getEnvironment: (
    env: string,
  ) => Effect.Effect<ReadonlyArray<EnvironmentRecord>, StateError>
  /** Транзакционно заменяет весь набор окружения. */
  readonly promote: (
    env: string,
    entries: ReadonlyArray<{ readonly name: string; readonly fingerprint: string }>,
  ) => Effect.Effect<void, StateError>
  /** Журнал применённых планов. */
  readonly recordPlan: (env: string, summary: string) => Effect.Effect<void, StateError>
  readonly listPlans: (env: string) => Effect.Effect<ReadonlyArray<PlanRecord>, StateError>
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
