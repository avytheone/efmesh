import { defineConfig } from "../../src/index.ts"

export default defineConfig({
  // models are found by discovery via glob (SPEC §12) — the config does not list them
  discovery: "models.ts",
  // efmesh's own physics; the raw archive under `archive/` is not ours to write
  lake: { path: "lake" },
})
