/**
 * Interval arithmetic (SPEC §2, §5.3): half-open `[start, end)` UTC time
 * intervals, aligned to the model's grain. Tracking which intervals are
 * filled is the basis of incrementality and backfill; this module is pure
 * math only, state lives in the state store.
 *
 * Internal representation is epoch millis: day/hour grains in UTC don't
 * depend on the calendar, and floor division gives alignment.
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
 * All completed grain intervals from `startMs` to `nowMs`:
 * the start is floor-aligned, and the last interval is one that has
 * already ended (`end <= floor(now)` — an unfinished "today" doesn't count).
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

/** `wanted` minus `covered` (compared by `start`; intervals of the same grain). */
export const missingIntervals = (
  wanted: ReadonlyArray<Interval>,
  covered: ReadonlyArray<Interval>,
): ReadonlyArray<Interval> => {
  const done = new Set(covered.map((i) => i.start))
  return wanted.filter((i) => !done.has(i.start))
}

/** Adjacent intervals merge into contiguous ranges (input must be sorted). */
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
 * Slices a range into batches no longer than `batchSize` grain intervals.
 * A batch is the unit of execution (one DELETE+INSERT); an interval is the unit of tracking.
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

/** Grain intervals within a range (for marking each one done after a batch). */
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

/** ISO-8601 UTC — the storage format for bounds in the state store (sorts lexicographically). */
export const toIso = (ms: number): string => new Date(ms).toISOString()

export const fromIso = (iso: string): number => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new RangeError(`не ISO-время: ${iso}`)
  return ms
}

/** Literal for substituting an interval bound into DuckDB SQL. */
export const sqlTimestamp = (ms: number): string => {
  const iso = new Date(ms).toISOString()
  return `TIMESTAMP '${iso.slice(0, 10)} ${iso.slice(11, 19)}'`
}
