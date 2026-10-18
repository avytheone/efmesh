import { expect, test } from "bun:test"

for (const [file, flag, dependency] of [
  ["minio.ts", "hasDocker", "Docker"],
  ["pg-cluster.ts", "hasPostgres", "PostgreSQL"],
] as const) {
  for (const ci of ["true", ""]) {
    test(`${dependency} unavailable: ${ci ? "CI fails" : "local probe permits an explicit skip"}`, () => {
      const path = new URL(`./helpers/${file}`, import.meta.url).href
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `const m = await import(${JSON.stringify(path)}); console.log(m.${flag})`,
        ],
        { env: { ...process.env, PATH: "", CI: ci }, stdout: "pipe", stderr: "pipe" },
      )
      if (ci) {
        expect(child.exitCode).toBe(1)
        expect(child.stderr.toString()).toContain(`CI requires ${dependency}`)
      } else {
        expect(child.exitCode).toBe(0)
        expect(child.stdout.toString().trim()).toBe("false")
      }
    })
  }
}
