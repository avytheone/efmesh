import { defineConfig } from "../../src/index.ts"

export default defineConfig({
  // модели находятся discovery по glob (SPEC §12) — конфиг их не перечисляет
  discovery: "models.ts",
  lake: { path: "lake" },
  ducklake: { catalog: "ducklake.sqlite", dataPath: "lake/ducklake" },
})
