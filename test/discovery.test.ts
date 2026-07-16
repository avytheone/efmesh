import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { discoverModels } from "../src/discovery.ts"

// a temp directory INSIDE the repo: otherwise bun does not resolve "effect" from the files
const root = mkdtempSync(join(import.meta.dir, "..", "efmesh-discovery-test-"))
const srcIndex = join(import.meta.dir, "..", "src", "index.ts")

afterAll(() => rmSync(root, { recursive: true, force: true }))

const write = (relative: string, content: string) => {
  const path = join(root, relative)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

write(
  "models/sources.ts",
  `import { Schema } from "effect"
import { defineExternal, external } from "${srcIndex}"
export const rawMoves = defineExternal({
  name: "raw.moves",
  source: external.table("src.moves"),
  schema: Schema.Struct({ id: Schema.String }),
})
export const notAModel = { just: "constant" }
`,
)

write(
  "models/med/moves.ts",
  `import { Schema } from "effect"
import { defineModel, kind } from "${srcIndex}"
import { rawMoves } from "../sources.ts"
// re-export of the parent — not a duplicate: the same object is counted once
export { rawMoves }
export const moves = defineModel(
  { name: "med.moves", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) },
  (ctx) => ctx.sql\`SELECT id FROM \${ctx.ref(rawMoves)}\`,
)
`,
)

write(
  "scripts/seed.ts",
  `export const notDiscovered = true\n`,
)

describe("model discovery by glob (SPEC §12)", () => {
  test("collects model exports by mask, non-models and re-exports do not interfere", async () => {
    const models = await Effect.runPromise(discoverModels("models/**/*.ts", root))
    expect(models.map((model) => model.name.full).sort()).toEqual(["med.moves", "raw.moves"])
  })

  test("multiple masks are merged, a file outside the masks does not participate", async () => {
    const models = await Effect.runPromise(
      discoverModels(["models/*.ts", "models/med/*.ts"], root),
    )
    expect(models.map((model) => model.name.full).sort()).toEqual(["med.moves", "raw.moves"])
  })

  test("two different definitions with one name — a load error", async () => {
    write(
      "models/dup.ts",
      `import { Schema } from "effect"
import { defineExternal, external } from "${srcIndex}"
export const rawMovesAgain = defineExternal({
  name: "raw.moves",
  source: external.table("src.moves_other"),
  schema: Schema.Struct({ id: Schema.String }),
})
`,
    )
    try {
      const conflict = await Effect.runPromise(
        Effect.flip(discoverModels("models/**/*.ts", root)),
      )
      expect(conflict._tag).toBe("DiscoveryConflictError")
      if (conflict._tag === "DiscoveryConflictError") {
        expect(conflict.name).toBe("raw.moves")
        expect(conflict.files.length).toBe(2)
      }
    } finally {
      rmSync(join(root, "models/dup.ts"))
    }
  })
})
