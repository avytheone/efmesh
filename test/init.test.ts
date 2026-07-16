import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Efmesh } from "../src/efmesh.ts"
import type { AnyModel } from "../src/core/model.ts"
import { DuckDBEngineLive } from "../src/engine/duckdb.ts"
import { scaffold } from "../src/init.ts"
import { SqliteStateLive } from "../src/state/sqlite.ts"

describe("efmesh init (SPEC §12, F4)", () => {
  test("scaffold creates a project, a repeated init — an honest error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efmesh-init-"))
    const created = await Effect.runPromise(scaffold(dir))
    expect(created).toEqual(["efmesh.config.ts", "models.ts", "seeds/departments.csv"])
    for (const file of created) expect(existsSync(join(dir, file))).toBe(true)

    const again = await Effect.runPromise(Effect.flip(scaffold(dir)))
    expect(again._tag).toBe("InitError")
  })

  test("scaffolded project is alive: plan → apply pass", async () => {
    // inside the repository — so that import "effect" resolves via node_modules
    const dir = mkdtempSync(join(import.meta.dir, "..", "efmesh-init-test-"))
    try {
      await Effect.runPromise(scaffold(dir))
      // the scaffold imports from the «efmesh» package and a relative seed path —
      // to run from the test we swap them for the local src and an absolute path
      const models = readFileSync(join(dir, "models.ts"), "utf8")
        .replaceAll(`"@avytheone/efmesh"`, `"${join(import.meta.dir, "../src/index.ts")}"`)
        .replaceAll(`"seeds/departments.csv"`, `"${join(dir, "seeds/departments.csv")}"`)
      writeFileSync(join(dir, "models.ts"), models)
      const loaded = (await import(join(dir, "models.ts"))) as Record<string, AnyModel>

      const applied = await Effect.runPromise(
        Efmesh.apply("dev", [loaded["departments"]!, loaded["floors"]!]).pipe(
          Effect.provide(Layer.mergeAll(DuckDBEngineLive(), SqliteStateLive())),
        ),
      )
      expect(applied.built).toEqual(["ref.departments", "mart.floors"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
