import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { loadConfig } from "../src/cli/config.ts"

/**
 * #52: importing the config executes the user's model definitions, so a
 * `define*` refusal arrives in the same catch as an unresolvable path. Wrapping
 * it in ConfigLoadError attached advice about `--config` and the default export
 * to a config whose path and export are both fine — the same dead-end-advice
 * class as the `efmesh migrate` hint in #48.
 */
describe("loadConfig: loading failures vs a config that refuses (#52)", () => {
  // inside the repository — so that import "effect" resolves via node_modules
  const withProject = async (
    files: Record<string, string>,
    run: (dir: string) => Promise<void>,
  ) => {
    const dir = mkdtempSync(join(import.meta.dir, "..", "efmesh-config-test-"))
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content)
      }
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const src = join(import.meta.dir, "../src/index.ts")

  test("a model that refuses surfaces as ModelDefinitionError, not ConfigLoadError", async () => {
    await withProject(
      {
        "efmesh.config.ts": `
import { defineConfig, defineExternal, external } from "${src}"
import { Schema } from "effect"

const raw = defineExternal({
  name: "raw.events",
  source: (external.files as any)("lake/*.csv"),
  schema: Schema.Struct({ id: Schema.String }),
})

export default defineConfig({ engine: { kind: "duckdb", path: "x.duckdb" }, models: [raw] })
`,
      },
      async (dir) => {
        const failure = await Effect.runPromise(
          Effect.flip(loadConfig(join(dir, "efmesh.config.ts"))),
        )
        expect(failure._tag).toBe("ModelDefinitionError")
        expect(failure.message).toContain("raw.events")
        expect(failure.message).toContain("needs a format")
      },
    )
  })

  test("a genuinely unloadable config is still ConfigLoadError", async () => {
    await withProject({ "efmesh.config.ts": `export default { nothing: true }\n` }, async (dir) => {
      const failure = await Effect.runPromise(
        Effect.flip(loadConfig(join(dir, "efmesh.config.ts"))),
      )
      expect(failure._tag).toBe("ConfigLoadError")
      expect(failure.message).toContain("models and/or discovery")
    })
  })

  test("a missing path is ConfigLoadError, where the --config advice applies", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(loadConfig(join(import.meta.dir, "..", "no-such-config.ts"))),
    )
    expect(failure._tag).toBe("ConfigLoadError")
  })
})
