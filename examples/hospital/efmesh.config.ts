import { defineConfig } from "../../src/index.ts"
import { departments, deptLoad, moves, rawMoves, stays, staysMart } from "./models.ts"

export default defineConfig({
  models: [departments, rawMoves, moves, stays, deptLoad, staysMart],
  lake: { path: "lake" },
})
