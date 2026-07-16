import { defineConfig } from "../../src/index.ts"

export default defineConfig({
  // models are found by discovery via glob (SPEC §12) — the config does not list them
  discovery: "models.ts",
  lake: { path: "lake" },
  ducklake: { catalog: "ducklake.sqlite", dataPath: "lake/ducklake" },
})
