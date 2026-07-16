import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  cronToOnCalendar,
  scheduleTitle,
  systemdUnits,
  validateCron,
  workerPath,
  workerSource,
} from "../src/plan/schedule.ts"

/**
 * #10: efmesh schedule. Регистрация в OS-шедулере в тестах не гоняется
 * (она мутирует crontab машины) — проверяются чистые части: заголовок,
 * воркер, systemd-фоллбэк, валидация выражений парсером Bun.cron.
 */

const target = {
  project: "/data/my warehouse",
  config: "/data/my warehouse/efmesh.config.ts",
  env: "prod",
}

describe("efmesh schedule (#10)", () => {
  test("заголовок Bun.cron: только [A-Za-z0-9_-], проект и окружение внутри", () => {
    expect(scheduleTitle(target)).toBe("efmesh-my-warehouse-prod")
    expect(scheduleTitle({ project: "/x/жёсткий.проект", env: "dev/eu" })).toBe(
      "efmesh----------------dev-eu",
    )
  })

  test("воркер: абсолютные пути, bin этого пакета, exit-код тика доносится", () => {
    const source = workerSource(target)
    expect(source).toContain(`"run", "prod"`)
    expect(source).toContain(JSON.stringify(target.config))
    expect(source).toContain(`cwd: ${JSON.stringify(target.project)}`)
    expect(source).toContain("src/bin.ts")
    expect(source).toContain("process.exitCode = await proc.exited")
    expect(workerPath(target)).toBe("/data/my warehouse/.efmesh/schedule-prod.ts")
  })

  test("systemd-фоллбэк: oneshot, Persistent=true, никнеймы переведены", () => {
    expect(cronToOnCalendar("@hourly")).toBe("hourly")
    expect(cronToOnCalendar("@midnight")).toBe("daily")
    expect(cronToOnCalendar("*/5 * * * *")).toBeUndefined()
    const units = systemdUnits(target, "@daily")
    expect(units.name).toBe("efmesh-my-warehouse-prod")
    expect(units.service).toContain("WorkingDirectory=/data/my warehouse")
    expect(units.service).toContain("run prod --config /data/my warehouse/efmesh.config.ts")
    expect(units.timer).toContain("OnCalendar=daily")
    expect(units.timer).toContain("Persistent=true")
    // произвольный cron не переводится молча — TODO прямо в юните
    expect(systemdUnits(target, "*/5 * * * *").timer).toContain("TODO")
  })

  test("валидация выражений — парсером Bun.cron", async () => {
    await Effect.runPromise(validateCron("@hourly"))
    await Effect.runPromise(validateCron("*/15 9-17 * * MON-FRI"))
    const failure = await Effect.runPromise(Effect.flip(validateCron("каждый час")))
    expect(failure._tag).toBe("ScheduleError")
  })
})
