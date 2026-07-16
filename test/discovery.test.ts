import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { discoverModels } from "../src/discovery.ts"

// временная директория ВНУТРИ репо: иначе bun не резолвит "effect" из файлов
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
export const notAModel = { just: "константа" }
`,
)

write(
  "models/med/moves.ts",
  `import { Schema } from "effect"
import { defineModel, kind } from "${srcIndex}"
import { rawMoves } from "../sources.ts"
// реэкспорт родителя — не дубликат: тот же объект считается один раз
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

describe("discovery моделей по glob (SPEC §12)", () => {
  test("собирает экспорты-модели по маске, не-модели и реэкспорты не мешают", async () => {
    const models = await Effect.runPromise(discoverModels("models/**/*.ts", root))
    expect(models.map((model) => model.name.full).sort()).toEqual(["med.moves", "raw.moves"])
  })

  test("несколько масок объединяются, файл вне масок не участвует", async () => {
    const models = await Effect.runPromise(
      discoverModels(["models/*.ts", "models/med/*.ts"], root),
    )
    expect(models.map((model) => model.name.full).sort()).toEqual(["med.moves", "raw.moves"])
  })

  test("два разных определения с одним именем — ошибка загрузки", async () => {
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
