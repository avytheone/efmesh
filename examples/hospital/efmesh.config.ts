import { defineConfig } from "../../src/index.ts"
import { deptLoad, moves, stays } from "./models.ts"

export default defineConfig({
  models: [moves, stays, deptLoad],
})
