import { defineConfig } from "../../src/index.ts"
import { deptLoad, moves, rawMoves, stays, staysMart } from "./models.ts"

export default defineConfig({
  models: [rawMoves, moves, stays, deptLoad, staysMart],
  lake: { path: "lake" },
})
