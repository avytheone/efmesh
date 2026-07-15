/**
 * Интервальная арифметика (SPEC §2, §5.3): полуинтервалы `[start, end)`
 * времени UTC, выровненные по зерну модели. Учёт заполненных интервалов —
 * основа инкрементальности и бэкфилла; здесь только чистая математика,
 * состояние живёт в state store.
 *
 * Внутреннее представление — epoch millis: зёрна day/hour в UTC не зависят
 * от календаря, деление с округлением вниз даёт выравнивание.
 */

export type IntervalUnit = "day" | "hour"

export interface Interval {
  readonly start: number
  readonly end: number
}

export const unitMillis: Record<IntervalUnit, number> = {
  day: 86_400_000,
  hour: 3_600_000,
}

export const floorTo = (unit: IntervalUnit, ms: number): number => {
  const step = unitMillis[unit]
  return Math.floor(ms / step) * step
}

/**
 * Все завершённые интервалы зерна от `startMs` до `nowMs`:
 * начало выравнивается вниз, последний интервал — тот, что уже закончился
 * (`end <= floor(now)` — недописанное «сегодня» не считается).
 */
export const enumerateIntervals = (
  unit: IntervalUnit,
  startMs: number,
  nowMs: number,
): ReadonlyArray<Interval> => {
  const step = unitMillis[unit]
  const from = floorTo(unit, startMs)
  const to = floorTo(unit, nowMs)
  const intervals: Array<Interval> = []
  for (let start = from; start + step <= to; start += step) {
    intervals.push({ start, end: start + step })
  }
  return intervals
}

/** `wanted` минус `covered` (сравнение по `start`; интервалы одного зерна). */
export const missingIntervals = (
  wanted: ReadonlyArray<Interval>,
  covered: ReadonlyArray<Interval>,
): ReadonlyArray<Interval> => {
  const done = new Set(covered.map((i) => i.start))
  return wanted.filter((i) => !done.has(i.start))
}

/** Смежные интервалы сливаются в непрерывные диапазоны (вход — отсортированный). */
export const mergeIntervals = (
  intervals: ReadonlyArray<Interval>,
): ReadonlyArray<Interval> => {
  const merged: Array<Interval> = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.end === interval.start) {
      merged[merged.length - 1] = { start: last.start, end: interval.end }
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

/**
 * Режет диапазон на батчи не длиннее `batchSize` интервалов зерна.
 * Батч — единица исполнения (один DELETE+INSERT), интервал — единица учёта.
 */
export const splitIntoBatches = (
  range: Interval,
  unit: IntervalUnit,
  batchSize: number,
): ReadonlyArray<Interval> => {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize должен быть целым ≥ 1, получен ${batchSize}`)
  }
  const step = unitMillis[unit] * batchSize
  const batches: Array<Interval> = []
  for (let start = range.start; start < range.end; start += step) {
    batches.push({ start, end: Math.min(start + step, range.end) })
  }
  return batches
}

/** Интервалы зерна внутри диапазона (для поинтервальной отметки done после батча). */
export const intervalsWithin = (
  range: Interval,
  unit: IntervalUnit,
): ReadonlyArray<Interval> => {
  const step = unitMillis[unit]
  const intervals: Array<Interval> = []
  for (let start = range.start; start < range.end; start += step) {
    intervals.push({ start, end: Math.min(start + step, range.end) })
  }
  return intervals
}

/** ISO-8601 UTC — формат хранения границ в state store (сортируется лексикографически). */
export const toIso = (ms: number): string => new Date(ms).toISOString()

export const fromIso = (iso: string): number => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new RangeError(`не ISO-время: ${iso}`)
  return ms
}

/** Литерал для подстановки границы интервала в SQL DuckDB. */
export const sqlTimestamp = (ms: number): string => {
  const iso = new Date(ms).toISOString()
  return `TIMESTAMP '${iso.slice(0, 10)} ${iso.slice(11, 19)}'`
}
