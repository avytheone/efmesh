import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Test a packed candidate, not a source alias or a globally installed package.
const repo = fileURLToPath(new URL("../", import.meta.url))
const root = mkdtempSync(join(repo, "efmesh-consumer-test-"))
const candidate = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))
const stable = candidate.devDependencies.effect as string
if (
  !/^4\.\d+\.\d+$/.test(stable) ||
  candidate.peerDependencies.effect !== stable ||
  candidate.dependencies["@effect/platform-bun"] !== stable
) {
  throw new Error("consumer smoke requires matching exact stable v4 peer/dev/platform pins")
}
const run = (args: string[], cwd = root, code = 0) => {
  const child = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  if (child.exitCode !== code)
    throw new Error(
      `${args.join(" ")}: expected ${code}, got ${child.exitCode}\n${stdout}\n${stderr}`,
    )
  return { stdout, stderr }
}
const json = (args: string[], code = 0) => {
  const result = run([join(root, "node_modules/.bin/efmesh"), ...args, "--json"], root, code)
  const body = JSON.parse(result.stdout)
  if (body.apiVersion !== 1) throw new Error("consumer JSON apiVersion changed")
  return body
}
const writeModels = (value: string) =>
  writeFileSync(
    join(root, "models.ts"),
    [
      'import { Schema } from "effect"',
      'import { defineModel, kind } from "@avytheone/efmesh"',
      `export const events = defineModel({ name: "med.events", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) }, ctx => ctx.sql\`SELECT '${value}' AS id\`)`,
    ].join("\n"),
  )
try {
  run(["pm", "pack", "--filename", join(root, "candidate.tgz"), "--quiet"], repo)
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "efmesh-stable-consumer",
      private: true,
      type: "module",
      dependencies: { "@avytheone/efmesh": "file:./candidate.tgz", effect: stable },
    }),
  )
  run(["install"])
  run(["install", "--frozen-lockfile"])
  writeFileSync(
    join(root, "probe.ts"),
    `import { Effect, Layer, Schema } from "effect"
import { Efmesh, defineModel, kind, DuckDBEngineLive, SqliteStateLive } from "@avytheone/efmesh"
const resolved = import.meta.resolve("effect")
if (!resolved.startsWith(new URL("./node_modules/", import.meta.url).href)) throw new Error("effect resolved outside fresh consumer")
const m = defineModel({ name: "med.api", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) }, ctx => ctx.sql\`SELECT 'api' AS id\`)
const result = await Effect.runPromise(Efmesh.apply("dev", [m]).pipe(Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive()))))
if (result.built.join() !== "med.api") throw new Error("fresh consumer pipeline did not build")
console.log("consumer API ok")
`,
  )
  if (!run(["probe.ts"]).stdout.includes("consumer API ok"))
    throw new Error("consumer API probe failed")
  writeModels("initial")
  writeFileSync(
    join(root, "efmesh.config.ts"),
    'import { defineConfig } from "@avytheone/efmesh"\nimport { events } from "./models.ts"\nexport default defineConfig({ models: [events], engine: { path: "consumer.duckdb" }, state: { path: "consumer.sqlite" } })\n',
  )
  const cli = join(root, "node_modules/.bin/efmesh")
  run([cli, "init", "scaffold"])
  const scaffoldPlan = JSON.parse(
    run([cli, "plan", "dev", "--json"], join(root, "scaffold")).stdout,
  )
  if (scaffoldPlan.apiVersion !== 1 || scaffoldPlan.actions.length !== 3)
    throw new Error("generated consumer template did not load/plan")
  if (!run([cli, "--help"]).stdout.includes("efmesh")) throw new Error("CLI help missing")
  if (json(["plan", "dev"]).env !== "dev") throw new Error("CLI plan/config failed")
  if (json(["apply", "dev"], 2).applied !== false) throw new Error("non-TTY apply did not refuse")
  if (json(["apply", "dev", "--yes"]).applied !== true) throw new Error("CLI apply failed")
  if (json(["run", "dev"]).outcome !== "ok") throw new Error("CLI run failed")
  writeModels("changed")
  if (json(["run", "dev"], 2).outcome !== "awaiting-human")
    throw new Error("structural run did not await human")
  const bad = run([cli, "plan", "dev", "--config", "missing.ts", "--json"], root, 1)
  if (bad.stdout.trim() !== "" || !bad.stderr.includes("missing.ts"))
    throw new Error("CLI config error routing changed")
  console.log(
    `fresh consumer effect@${stable}: API + help/config/plan/apply/run + JSON/exit 0,1,2 passed`,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
