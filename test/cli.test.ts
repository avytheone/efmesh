import { describe, expect, test } from "bun:test"
import { isAffirmative } from "../src/cli.ts"

describe("подтверждение плана (F4)", () => {
  test("y/yes/д/да — согласие, регистр и пробелы не мешают", () => {
    for (const answer of ["y", "Y", "yes", " YES ", "д", "Да", "да"]) {
      expect(isAffirmative(answer)).toBe(true)
    }
  })

  test("пусто, null (EOF) и всё прочее — отказ", () => {
    for (const answer of [null, "", " ", "n", "no", "нет", "ok", "apply"]) {
      expect(isAffirmative(answer)).toBe(false)
    }
  })
})
