import { Effect, Metric } from "effect"

/**
 * Metrics as a text file for a scraper (#39).
 *
 * The instrumentation layer is Effect's own `Metric` registry — the counters in
 * `plan/metrics.ts` that the executor already updates. This module is a
 * *renderer* over `Metric.snapshot`, not a second bus: lifecycle events (#29)
 * would be another consumer of the same instrumentation points, and the `--json`
 * command payloads are a third. Adding an output must never mean adding a
 * parallel place where facts are produced.
 *
 * The dialect is the Prometheus text exposition format, which is what
 * node_exporter's textfile collector parses. Deliberately without OpenMetrics'
 * trailing `# EOF`: strict OpenMetrics parsers accept the file either way, while
 * the textfile collector — the target here — rejects the marker outright.
 */

/** Metric names and label names: `[a-zA-Z_:][a-zA-Z0-9_:]*` per the exposition format. */
const NAME_ILLEGAL = /[^a-zA-Z0-9_:]/g

const sanitizeName = (raw: string): string => raw.replace(NAME_ILLEGAL, "_")

/** Label *values* are free text — only `\`, `"` and newlines need escaping. */
const escapeValue = (raw: string): string =>
  raw.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")

/** HELP text is escaped like a label value except that quotes stay literal. */
const escapeHelp = (raw: string): string => raw.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")

const labelsOf = (
  attributes: Record<string, string> | undefined,
  extra?: ReadonlyArray<readonly [string, string]>,
): string => {
  const pairs = [
    ...Object.entries(attributes ?? {}).map(
      ([key, value]) => `${sanitizeName(key)}="${escapeValue(String(value))}"`,
    ),
    ...(extra ?? []).map(([key, value]) => `${sanitizeName(key)}="${escapeValue(value)}"`),
  ]
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`
}

/**
 * A number as the exposition format wants it: `+Inf`/`-Inf`/`NaN` spelled out,
 * integers without a decimal tail so a golden test stays readable.
 */
const formatNumber = (value: number): string => {
  if (Number.isNaN(value)) return "NaN"
  if (value === Number.POSITIVE_INFINITY) return "+Inf"
  if (value === Number.NEGATIVE_INFINITY) return "-Inf"
  return Number.isInteger(value) ? value.toString() : String(value)
}

type Snapshot = Awaited<ReturnType<typeof Metric.snapshotUnsafe>>
type Entry = Snapshot[number]

const TYPE_LINE: Record<string, string> = {
  Counter: "counter",
  Gauge: "gauge",
  Histogram: "histogram",
  Summary: "summary",
  Frequency: "counter",
}

const samplesOf = (entry: Entry): ReadonlyArray<string> => {
  const name = sanitizeName(entry.id)
  const attributes = entry.attributes as Record<string, string> | undefined
  const labels = labelsOf(attributes)
  const state = entry.state as Record<string, any>
  switch (entry.type) {
    case "Counter":
    case "Gauge":
      return [`${name}${labels} ${formatNumber(state["count"] ?? state["value"] ?? 0)}`]
    case "Histogram": {
      // Buckets arrive as [upperBound | null, count]; the null bucket is +Inf.
      // The exposition format wants them cumulative and le-labelled.
      const buckets = (state["buckets"] ?? []) as ReadonlyArray<readonly [number | null, number]>
      let running = 0
      const lines = buckets.map(([boundary, count]) => {
        running += count
        const le = boundary === null ? "+Inf" : formatNumber(boundary)
        return `${name}_bucket${labelsOf(attributes, [["le", le]])} ${formatNumber(running)}`
      })
      return [
        ...lines,
        `${name}_sum${labels} ${formatNumber(state["sum"] ?? 0)}`,
        `${name}_count${labels} ${formatNumber(state["count"] ?? 0)}`,
      ]
    }
    case "Frequency":
      return Object.entries((state["occurrences"] ?? {}) as Record<string, number>).map(
        ([bucket, count]) =>
          `${name}${labelsOf(attributes, [["bucket", bucket]])} ${formatNumber(count)}`,
      )
    default:
      // Summary and anything a future Effect adds: expose sum and count, which
      // every metric shape has, rather than guessing at quantiles.
      return [
        `${name}_sum${labels} ${formatNumber(state["sum"] ?? 0)}`,
        `${name}_count${labels} ${formatNumber(state["count"] ?? 0)}`,
      ]
  }
}

/**
 * Render a registry snapshot. Entries sharing a name are one metric family with
 * different label sets, so HELP/TYPE are emitted once per family — a scraper
 * rejects a file that repeats them.
 */
export const renderOpenMetrics = (snapshot: Snapshot): string => {
  const families = new Map<string, { description: string | undefined; entries: Array<Entry> }>()
  for (const entry of snapshot) {
    const name = sanitizeName(entry.id)
    const family = families.get(name)
    if (family === undefined) {
      families.set(name, { description: entry.description, entries: [entry] })
    } else {
      family.entries.push(entry)
    }
  }

  const blocks: Array<string> = []
  // Sorted so the file is byte-stable across runs: a scraper does not care,
  // but a golden test and a human diffing two dumps do.
  for (const [name, family] of [...families.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines: Array<string> = []
    if (family.description !== undefined && family.description !== "") {
      lines.push(`# HELP ${name} ${escapeHelp(family.description)}`)
    }
    const type = TYPE_LINE[family.entries[0]!.type] ?? "untyped"
    lines.push(`# TYPE ${name} ${type}`)
    lines.push(...family.entries.flatMap(samplesOf).sort())
    blocks.push(lines.join("\n"))
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n")}\n`
}

/** The current registry, rendered. */
export const openMetricsReport: Effect.Effect<string> = Effect.map(
  Metric.snapshot,
  renderOpenMetrics,
)
