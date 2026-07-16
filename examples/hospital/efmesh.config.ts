import { defineConfig } from "../../src/index.ts"
import { departments, deptDaily, deptLoad, moves, rawMoves, stays, staysMart } from "./models.ts"

export default defineConfig({
  models: [departments, rawMoves, moves, stays, deptLoad, staysMart, deptDaily],
  lake: { path: "lake" },
  ducklake: { catalog: "ducklake.sqlite", dataPath: "lake/ducklake" },
})
