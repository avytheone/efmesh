import { rmSync } from "node:fs"
import { Clock, Effect } from "effect"
import { parseModelName } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import { janitorLockName, withStateLock, type LockHeldError, type LockOptions } from "./lock.ts"
import { ducklakeAttachSql, ducklakeRef, parquetPrefix, physicalRef } from "./naming.ts"

/**
 * Уборка осиротевшей физики (SPEC §5.4): снапшоты, на которые не ссылается
 * ни одно окружение и которые осиротели раньше, чем ttl назад, сносятся —
 * таблица/view движка, parquet-префикс озера, запись снапшота и учёт
 * интервалов.
 *
 * ttl отсчитывается от orphaned_at — отметки, которую промоушен ставит
 * при потере последней ссылки и снимает при возврате (откат на старую
 * версию обнуляет счётчик). Для записей без отметки (ни разу не
 * промоутились — например, apply упал до промоушена) — от created_at.
 * ttl по умолчанию 7 дней — достаточно, чтобы мгновенно откатиться
 * переключением view.
 */

export interface JanitorOptions extends LockOptions {
  readonly ttlDays?: number
  readonly lakePath?: string
  /** DuckLake-каталог (SPEC §14.5) — чтобы снести и таблицы-на-fingerprint в нём. */
  readonly ducklake?: { readonly catalog: string; readonly dataPath?: string }
  /** «Сейчас» — инъекция для тестов. */
  readonly now?: number
}

export interface JanitorReport {
  /** Снесённые снапшоты в виде `имя@fp8`. */
  readonly removed: ReadonlyArray<string>
  /** Осиротевшие, но моложе ttl — остаются до следующего раза. */
  readonly kept: ReadonlyArray<string>
}

const DAY_MS = 86_400_000

export const janitor = (
  options?: JanitorOptions,
): Effect.Effect<
  JanitorReport,
  EngineError | StateError | LockHeldError,
  EngineAdapter | StateStore
> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const store = yield* StateStore
    const now = options?.now ?? (yield* Clock.currentTimeMillis)
    const ttlMs = (options?.ttlDays ?? 7) * DAY_MS

    // снапшот не хранит цель материализации — при настроенном каталоге
    // таблица сносится и там, и в _efmesh (DROP IF EXISTS терпим к пустоте)
    const ducklake = options?.ducklake
    if (ducklake !== undefined && engine.dialect === "duckdb") {
      yield* engine.execute(ducklakeAttachSql(ducklake))
    }

    const referenced = yield* store.listReferencedFingerprints()
    const removed: Array<string> = []
    const kept: Array<string> = []

    const snapshots = yield* store.listSnapshots()
    const isDoomed = (snapshot: (typeof snapshots)[number]): boolean =>
      !referenced.has(snapshot.fingerprint) &&
      now - Date.parse(snapshot.orphanedAt ?? snapshot.createdAt) >= ttlMs
    // физика делится между версиями при forward-only — таблица/префикс
    // сносятся, только когда их не использует ни один выживающий снапшот
    const physicalInUse = new Set(
      snapshots.filter((snapshot) => !isDoomed(snapshot)).map((snapshot) => snapshot.physicalFp),
    )

    for (const snapshot of snapshots) {
      if (referenced.has(snapshot.fingerprint)) continue
      const label = `${snapshot.name}@${snapshot.fingerprint.slice(0, 8)}`
      if (!isDoomed(snapshot)) {
        kept.push(label)
        continue
      }
      const name = parseModelName(snapshot.name)
      if (!physicalInUse.has(snapshot.physicalFp)) {
        const target = physicalRef(name, snapshot.physicalFp)
        yield* engine.execute(
          snapshot.kind === "view"
            ? `DROP VIEW IF EXISTS ${target}`
            : `DROP TABLE IF EXISTS ${target}`,
        )
        if (ducklake !== undefined && engine.dialect === "duckdb" && snapshot.kind !== "view") {
          yield* engine.execute(
            `DROP TABLE IF EXISTS ${ducklakeRef(name, snapshot.physicalFp)}`,
          )
        }
        if (options?.lakePath !== undefined && !options.lakePath.startsWith("s3://")) {
          const prefix = parquetPrefix(options.lakePath, name, snapshot.physicalFp)
          yield* Effect.sync(() => rmSync(prefix, { recursive: true, force: true }))
        }
      }
      yield* store.deleteSnapshot(snapshot.name, snapshot.fingerprint)
      removed.push(label)
    }

    return { removed, kept }
  }).pipe(
    // два janitor'а из разных процессов не должны наперегонки сносить одно и
    // то же; от гонки janitor↔apply защищает ttl (окно на мгновенный откат)
    withStateLock(janitorLockName, options?.lockTtlMs),
  )
