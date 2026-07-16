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
 * #10: efmesh schedule. Registration in the OS scheduler is not exercised in
 * tests (it mutates the machine's crontab) — the pure parts are checked: the
 * title, the worker, the systemd fallback, expression validation via Bun.cron.
 */

const target = {
  project: "/data/my warehouse",
  config: "/data/my warehouse/efmesh.config.ts",
  env: "prod",
}

describe("efmesh schedule (#10)", () => {
  test("Bun.cron title: only [A-Za-z0-9_-], project and environment inside", () => {
    expect(scheduleTitle(target)).toBe("efmesh-my-warehouse-prod")
    expect(scheduleTitle({ project: "/x/жёсткий.проект", env: "dev/eu" })).toBe(
      "efmesh----------------dev-eu",
    )
  })

  test("worker: absolute paths, this package's bin, the tick exit code is propagated", () => {
    const source = workerSource(target)
    expect(source).toContain(`"run", "prod"`)
    expect(source).toContain(JSON.stringify(target.config))
    expect(source).toContain(`cwd: ${JSON.stringify(target.project)}`)
    expect(source).toContain("src/bin.ts")
    expect(source).toContain("process.exitCode = await proc.exited")
    expect(workerPath(target)).toBe("/data/my warehouse/.efmesh/schedule-prod.ts")
  })

  test("systemd fallback: oneshot, Persistent=true, nicknames translated", () => {
    expect(cronToOnCalendar("@hourly")).toBe("hourly")
    expect(cronToOnCalendar("@midnight")).toBe("daily")
    expect(cronToOnCalendar("*/5 * * * *")).toBeUndefined()
    const units = systemdUnits(target, "@daily")
    expect(units.name).toBe("efmesh-my-warehouse-prod")
    expect(units.service).toContain("WorkingDirectory=/data/my warehouse")
    expect(units.service).toContain("run prod --config /data/my warehouse/efmesh.config.ts")
    expect(units.timer).toContain("OnCalendar=daily")
    expect(units.timer).toContain("Persistent=true")
    // an arbitrary cron is not translated silently — a TODO right in the unit
    expect(systemdUnits(target, "*/5 * * * *").timer).toContain("TODO")
  })

  test("expression validation — via the Bun.cron parser", async () => {
    await Effect.runPromise(validateCron("@hourly"))
    await Effect.runPromise(validateCron("*/15 9-17 * * MON-FRI"))
    const failure = await Effect.runPromise(Effect.flip(validateCron("every hour")))
    expect(failure._tag).toBe("ScheduleError")
  })
})
