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
  test("floorTo выравнивает вниз по зерну UTC", () => {
    expect(floorTo("day", fromIso("2026-01-05T13:45:00Z"))).toBe(jan(5))
    expect(floorTo("hour", fromIso("2026-01-05T13:45:00Z"))).toBe(
      fromIso("2026-01-05T13:00:00Z"),
    )
  })

  test("enumerateIntervals: недописанный сегодняшний интервал не считается", () => {
    // now = 3 января 10:00 → завершены только 1-е и 2-е
    const intervals = enumerateIntervals("day", jan(1), fromIso("2026-01-03T10:00:00Z"))
    expect(intervals).toEqual([
      { start: jan(1), end: jan(2) },
      { start: jan(2), end: jan(3) },
    ])
  })

  test("enumerateIntervals: старт внутри дня выравнивается вниз", () => {
    const intervals = enumerateIntervals("day", fromIso("2026-01-01T15:00:00Z"), jan(3))
    expect(intervals[0]).toEqual({ start: jan(1), end: jan(2) })
  })

  test("enumerateIntervals: пусто, когда ни один интервал не завершён", () => {
    expect(enumerateIntervals("day", jan(1), fromIso("2026-01-01T23:59:00Z"))).toEqual([])
  })

  test("missing + merge: дыры сливаются в диапазоны", () => {
    const wanted = enumerateIntervals("day", jan(1), jan(6)) // 1..5
    const covered = [{ start: jan(3), end: jan(4) }]
    const missing = mergeIntervals(missingIntervals(wanted, covered))
    expect(missing).toEqual([
      { start: jan(1), end: jan(3) },
      { start: jan(4), end: jan(6) },
    ])
  })

  test("splitIntoBatches: диапазон режется по batchSize, хвост короче", () => {
    const batches = splitIntoBatches({ start: jan(1), end: jan(6) }, "day", 2)
    expect(batches).toEqual([
      { start: jan(1), end: jan(3) },
      { start: jan(3), end: jan(5) },
      { start: jan(5), end: jan(6) },
    ])
  })

  test("intervalsWithin возвращает зёрна батча для поинтервальной отметки", () => {
    expect(intervalsWithin({ start: jan(1), end: jan(3) }, "day")).toEqual([
      { start: jan(1), end: jan(2) },
      { start: jan(2), end: jan(3) },
    ])
  })

  test("toIso/fromIso — round-trip, sqlTimestamp — литерал DuckDB", () => {
    const ms = jan(2) + DAY / 2
    expect(fromIso(toIso(ms))).toBe(ms)
    expect(sqlTimestamp(jan(2))).toBe("TIMESTAMP '2026-01-02 00:00:00'")
  })
})
