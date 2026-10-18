import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

for (const [file, flag, dependency] of [
  ["minio.ts", "hasDocker", "Docker"],
  ["pg-cluster.ts", "hasPostgres", "PostgreSQL"],
] as const) {
  for (const ci of ["true", ""]) {
    test(`${dependency} unavailable: ${ci ? "CI fails" : "local probe permits an explicit skip"}`, () => {
      // An empty PATH string may fall back to system lookup; a directory cannot.
      const emptyPath = mkdtempSync(join(import.meta.dir, "..", "efmesh-prerequisite-test-"))
      try {
        const path = new URL(`./helpers/${file}`, import.meta.url).href
        const child = Bun.spawnSync(
          [
            process.execPath,
            "--eval",
            `const m = await import(${JSON.stringify(path)}); console.log(m.${flag})`,
          ],
          { env: { ...process.env, PATH: emptyPath, CI: ci }, stdout: "pipe", stderr: "pipe" },
        )
        if (ci) {
          expect(child.exitCode).toBe(1)
          expect(child.stderr.toString()).toContain(`CI requires ${dependency}`)
        } else {
          expect(child.exitCode).toBe(0)
          expect(child.stdout.toString().trim()).toBe("false")
        }
      } finally {
        rmSync(emptyPath, { recursive: true, force: true })
      }
    })
  }
}
