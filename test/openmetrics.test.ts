import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Effect, Metric } from "effect"
import { renderOpenMetrics } from "../src/observe/openmetrics.ts"
import { writeMetricsFile } from "../src/observe/report.ts"

/**
 * Golden tests on the scrape format (#39): machines read this file, so its
 * shape is frozen here. A red test means the exposition format moved — check it
 * against a scraper before touching the expectations.
 */

const SNAPSHOT = [
  {
    id: "efmesh_intervals_done_total",
    type: "Counter",
    description: "how many intervals were computed and marked done",
    state: { count: 4, incremental: true },
  },
  {
    id: "efmesh_intervals_done_total",
    type: "Counter",
    description: "how many intervals were computed and marked done",
    attributes: { model: "med.moves", env: "dev" },
    state: { count: 7, incremental: true },
  },
  {
    id: "efmesh_model_build_duration_seconds",
    type: "Gauge",
    description: "duration of the last build of this model, in seconds",
    attributes: { model: "mart.stays", env: "dev" },
    state: { value: 0.015 },
  },
] as any

describe("OpenMetrics rendering (#39)", () => {
  test("the exposition format is frozen", () => {
    expect(renderOpenMetrics(SNAPSHOT)).toBe(
      [
        "# HELP efmesh_intervals_done_total how many intervals were computed and marked done",
        "# TYPE efmesh_intervals_done_total counter",
        "efmesh_intervals_done_total 4",
        'efmesh_intervals_done_total{model="med.moves",env="dev"} 7',
        "# HELP efmesh_model_build_duration_seconds duration of the last build of this model, in seconds",
        "# TYPE efmesh_model_build_duration_seconds gauge",
        'efmesh_model_build_duration_seconds{model="mart.stays",env="dev"} 0.015',
        "",
      ].join("\n"),
    )
  })

  test("HELP and TYPE appear once per family, not once per label set", () => {
    const rendered = renderOpenMetrics(SNAPSHOT)
    expect(rendered.match(/# TYPE efmesh_intervals_done_total/g)).toHaveLength(1)
    expect(rendered.match(/# HELP efmesh_intervals_done_total/g)).toHaveLength(1)
  })

  test("no OpenMetrics EOF marker — the textfile collector rejects it", () => {
    expect(renderOpenMetrics(SNAPSHOT)).not.toContain("# EOF")
  })

  test("label values are escaped, metric names sanitised", () => {
    const rendered = renderOpenMetrics([
      {
        id: "efmesh.odd-name",
        type: "Counter",
        description: 'a "quoted" help\nwith a newline',
        attributes: { model: 'a"b\\c', note: "line\nbreak" },
        state: { count: 1 },
      },
    ] as any)
    expect(rendered).toContain("efmesh_odd_name")
    expect(rendered).toContain('model="a\\"b\\\\c"')
    expect(rendered).toContain('note="line\\nbreak"')
    // HELP is one line: the newline must not split it into a bogus second line
    expect(rendered.split("\n").filter((line) => line.startsWith("# HELP"))).toHaveLength(1)
  })

  test("histogram buckets are cumulative and le-labelled, with _sum and _count", () => {
    const rendered = renderOpenMetrics([
      {
        id: "efmesh_hist",
        type: "Histogram",
        description: "d",
        state: {
          buckets: [
            [10, 1],
            [20, 2],
            [null, 1],
          ],
          count: 4,
          sum: 55,
          min: 5,
          max: 30,
        },
      },
    ] as any)
    expect(rendered).toContain('efmesh_hist_bucket{le="10"} 1')
    expect(rendered).toContain('efmesh_hist_bucket{le="20"} 3')
    expect(rendered).toContain('efmesh_hist_bucket{le="+Inf"} 4')
    expect(rendered).toContain("efmesh_hist_sum 55")
    expect(rendered).toContain("efmesh_hist_count 4")
  })

  test("an empty registry renders an empty file, not a stray newline", () => {
    expect(renderOpenMetrics([] as any)).toBe("")
  })
})

describe("writing the scrape file (#39)", () => {
  test("written via a temp file and rename — a scraper never sees a partial read", async () => {
    // inside the repository — temp dirs elsewhere break module resolution
    const dir = mkdtempSync(join(import.meta.dir, "..", "efmesh-metrics-test-"))
    try {
      const path = join(dir, "efmesh.prom")
      const counter = Metric.counter("efmesh_test_written_total", { description: "d" })
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Metric.update(counter, 3)
          yield* writeMetricsFile(path)
        }),
      )
      expect(readFileSync(path, "utf8")).toContain("efmesh_test_written_total 3")
      expect(existsSync(`${path}.tmp`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an unwritable path warns instead of failing the command", async () => {
    const result = await Effect.runPromiseExit(
      writeMetricsFile("/nonexistent-directory-efmesh/metrics.prom"),
    )
    expect(result._tag).toBe("Success")
  })
})
