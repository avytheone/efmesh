import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const warning =
  "S3 compaction is not implemented; no S3 partitions were listed, merged, or deleted: med.events"

test("real compact CLI reports unsupported S3 maintenance in human and JSON output", async () => {
  const root = mkdtempSync(join(import.meta.dir, "..", "efmesh-s3-compact-test-"))
  try {
    const config = join(root, "efmesh.config.ts")
    writeFileSync(
      config,
      [
        'import { defineConfig } from "../src/config.ts"',
        'import { defineModel, kind } from "../src/core/model.ts"',
        'import { Schema } from "effect"',
        'const events = defineModel({ name: "med.events", kind: kind.incrementalByTimeRange({ timeColumn: "happened_at", start: "2026-01-01T00:00:00Z" }), target: "parquet", schema: Schema.Struct({ id: Schema.String, happened_at: Schema.DateTimeUtc }) }, ctx => ctx.sql`SELECT \'e1\' AS id, TIMESTAMP \'2026-01-01 10:00:00\' AS happened_at`)',
        'export default defineConfig({ models: [events], engine: { path: ":memory:" }, state: { path: ":memory:" }, lake: { path: "s3://lake/project" } })',
      ].join("\n"),
    )
    for (const json of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../src/bin.ts"),
          "compact",
          "--config",
          config,
          ...(json ? ["--json"] : []),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(0)
      if (json) {
        expect(JSON.parse(stdout)).toMatchObject({ compacted: [], warnings: [warning] })
      } else {
        expect(stdout).toContain("nothing to compact")
        expect(stderr).toContain(`warning: ${warning}`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
