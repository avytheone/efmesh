import { describe, expect, test } from "bun:test"
import { decideApply, EXIT_AWAITING_HUMAN, isAffirmative } from "../src/cli.ts"

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

describe("судьба плана в apply (F6: не-TTY без --yes = отказ)", () => {
  test("без изменений применяется всегда — view-swap безопасен", () => {
    expect(decideApply(false, false, false)).toBe("apply")
    expect(decideApply(false, false, true)).toBe("apply")
  })

  test("--yes применяет изменения где угодно", () => {
    expect(decideApply(true, true, false)).toBe("apply")
    expect(decideApply(true, true, true)).toBe("apply")
  })

  test("изменения: TTY спрашивает, не-TTY отказывает", () => {
    expect(decideApply(true, false, true)).toBe("ask")
    expect(decideApply(true, false, false)).toBe("refuse")
  })

  test("код «ждёт человека» отличим от ошибки", () => {
    expect(EXIT_AWAITING_HUMAN).toBe(2)
  })
})
