import { rmSync } from "node:fs"
import { Clock, Effect } from "effect"
import { parseModelName } from "../core/model.ts"
import { EngineAdapter } from "../engine/adapter.ts"
import type { EngineError } from "../engine/adapter.ts"
import { StateStore } from "../state/store.ts"
import type { StateError } from "../state/store.ts"
import { parquetPrefix, physicalRef } from "./naming.ts"

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

export interface JanitorOptions {
  readonly ttlDays?: number
  readonly lakePath?: string
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
): Effect.Effect<JanitorReport, EngineError | StateError, EngineAdapter | StateStore> =>
  Effect.gen(function* () {
    const engine = yield* EngineAdapter
    const store = yield* StateStore
    const now = options?.now ?? (yield* Clock.currentTimeMillis)
    const ttlMs = (options?.ttlDays ?? 7) * DAY_MS

    const referenced = yield* store.listReferencedFingerprints()
    const removed: Array<string> = []
    const kept: Array<string> = []

    for (const snapshot of yield* store.listSnapshots()) {
      if (referenced.has(snapshot.fingerprint)) continue
      const label = `${snapshot.name}@${snapshot.fingerprint.slice(0, 8)}`
      const orphanedSince = snapshot.orphanedAt ?? snapshot.createdAt
      if (now - Date.parse(orphanedSince) < ttlMs) {
        kept.push(label)
        continue
      }
      const name = parseModelName(snapshot.name)
      const target = physicalRef(name, snapshot.fingerprint)
      yield* engine.execute(
        snapshot.kind === "view" ? `DROP VIEW IF EXISTS ${target}` : `DROP TABLE IF EXISTS ${target}`,
      )
      if (options?.lakePath !== undefined && !options.lakePath.startsWith("s3://")) {
        const prefix = parquetPrefix(options.lakePath, name, snapshot.fingerprint)
        yield* Effect.sync(() => rmSync(prefix, { recursive: true, force: true }))
      }
      yield* store.deleteSnapshot(snapshot.name, snapshot.fingerprint)
      removed.push(label)
    }

    return { removed, kept }
  })
