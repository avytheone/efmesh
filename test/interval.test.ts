import { describe, expect, test } from "bun:test"
import {
  enumerateIntervals,
  floorTo,
  fromIso,
  intervalsWithin,
  mergeIntervals,
  missingIntervals,
  splitIntoBatches,
  sqlTimestamp,
  toIso,
} from "../src/core/interval.ts"

const DAY = 86_400_000
const jan = (d: number) => Date.parse(`2026-01-${String(d).padStart(2, "0")}T00:00:00Z`)

describe("interval", () => {
  test("floorTo aligns down to the UTC grain", () => {
    expect(floorTo("day", fromIso("2026-01-05T13:45:00Z"))).toBe(jan(5))
    expect(floorTo("hour", fromIso("2026-01-05T13:45:00Z"))).toBe(fromIso("2026-01-05T13:00:00Z"))
  })

  test("enumerateIntervals: an unfinished current interval does not count", () => {
    // now = Jan 3 10:00 → only the 1st and 2nd are complete
    const intervals = enumerateIntervals("day", jan(1), fromIso("2026-01-03T10:00:00Z"))
    expect(intervals).toEqual([
      { start: jan(1), end: jan(2) },
      { start: jan(2), end: jan(3) },
    ])
  })

  test("enumerateIntervals: a start inside a day aligns down", () => {
    const intervals = enumerateIntervals("day", fromIso("2026-01-01T15:00:00Z"), jan(3))
    expect(intervals[0]).toEqual({ start: jan(1), end: jan(2) })
  })

  test("enumerateIntervals: empty when no interval is complete", () => {
    expect(enumerateIntervals("day", jan(1), fromIso("2026-01-01T23:59:00Z"))).toEqual([])
  })

  test("missing + merge: gaps are merged into ranges", () => {
    const wanted = enumerateIntervals("day", jan(1), jan(6)) // 1..5
    const covered = [{ start: jan(3), end: jan(4) }]
    const missing = mergeIntervals(missingIntervals(wanted, covered))
    expect(missing).toEqual([
      { start: jan(1), end: jan(3) },
      { start: jan(4), end: jan(6) },
    ])
  })

  test("splitIntoBatches: the range is cut by batchSize, the tail is shorter", () => {
    const batches = splitIntoBatches({ start: jan(1), end: jan(6) }, "day", 2)
    expect(batches).toEqual([
      { start: jan(1), end: jan(3) },
      { start: jan(3), end: jan(5) },
      { start: jan(5), end: jan(6) },
    ])
  })

  test("intervalsWithin returns the batch's grains for per-interval marking", () => {
    expect(intervalsWithin({ start: jan(1), end: jan(3) }, "day")).toEqual([
      { start: jan(1), end: jan(2) },
      { start: jan(2), end: jan(3) },
    ])
  })

  test("toIso/fromIso — round-trip, sqlTimestamp — a DuckDB literal", () => {
    const ms = jan(2) + DAY / 2
    expect(fromIso(toIso(ms))).toBe(ms)
    expect(sqlTimestamp(jan(2))).toBe("TIMESTAMP '2026-01-02 00:00:00'")
  })
})
