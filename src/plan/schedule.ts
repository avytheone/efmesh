import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Data, Effect } from "effect"

/**
 * `efmesh schedule` (#10): регистрация тика `run` в OS-шедулере через
 * Bun.cron (>=1.3.11): crontab на Linux, launchd на macOS, Task Scheduler
 * на Windows. Один заголовок = одна запись, повторная регистрация
 * перезаписывает на месте (идемпотентно).
 *
 * Честные оговорки (документированы в README/SPEC): cron не догоняет
 * пропущенные запуски (systemd Persistent=true строже — есть
 * --print-systemd), OS-уровень живёт в ЛОКАЛЬНОЙ таймзоне (TZ=UTC поверх),
 * на Linux нужен живой cron-демон — семейство Arch без cronie не имеет
 * его вовсе. Наложение тиков безопасно по построению: run держит env-лок,
 * а «ждёт человека» = exit 2, не сбой.
 */

export class ScheduleError extends Data.TaggedError("ScheduleError")<{
  readonly reason: string
}> {}

/** Всё, что нужно воркеру, — абсолютными путями (crontab не знает cwd). */
export interface ScheduleTarget {
  /** Директория проекта (где лежит конфиг) — cwd тика. */
  readonly project: string
  /** Абсолютный путь конфига. */
  readonly config: string
  readonly env: string
}

/** Заголовок Bun.cron: только [A-Za-z0-9_-]; включает проект и окружение. */
export const scheduleTitle = (target: Pick<ScheduleTarget, "project" | "env">): string =>
  `efmesh-${basename(target.project)}-${target.env}`.replaceAll(/[^A-Za-z0-9_-]/g, "-")

/** Куда генерируется воркер: рядом с конфигом, в служебной .efmesh/. */
export const workerPath = (target: ScheduleTarget): string =>
  join(target.project, ".efmesh", `schedule-${target.env}.ts`)

/** Бинарь CLI этого же пакета — воркер зовёт его, не гадая по npm-именам. */
const binPath = (): string => fileURLToPath(new URL("../bin.ts", import.meta.url))

/**
 * Исходник воркера для Bun.cron: OS-шедулер исполняет scheduled(), тот
 * гоняет обычный `efmesh run` — та же семантика exit-кодов (2 = «ждёт
 * человека») и тот же журнал тиков в сторе (`efmesh status`).
 */
export const workerSource = (target: ScheduleTarget): string => `// сгенерировано \`efmesh schedule\` — не редактируйте: перерегистрация перезапишет
export default {
  async scheduled() {
    const proc = Bun.spawn(
      [${JSON.stringify(process.execPath)}, ${JSON.stringify(binPath())}, "run", ${JSON.stringify(target.env)}, "--config", ${JSON.stringify(target.config)}],
      { cwd: ${JSON.stringify(target.project)}, stdout: "inherit", stderr: "inherit" },
    )
    process.exitCode = await proc.exited
  },
}
`

/** Никнеймы cron → OnCalendar systemd; произвольные выражения не переводятся. */
export const cronToOnCalendar = (cron: string): string | undefined =>
  (
    {
      "@hourly": "hourly",
      "@daily": "daily",
      "@midnight": "daily",
      "@weekly": "weekly",
      "@monthly": "monthly",
      "@yearly": "yearly",
      "@annually": "yearly",
    } as Record<string, string>
  )[cron.trim()]

/**
 * systemd-фоллбэк (--print-systemd): у cron нет догона пропущенных запусков
 * и на Arch-семействе нет демона — user-таймер с Persistent=true честнее.
 */
export const systemdUnits = (
  target: ScheduleTarget,
  cron: string,
): { readonly service: string; readonly timer: string; readonly name: string } => {
  const name = scheduleTitle(target)
  const calendar = cronToOnCalendar(cron)
  return {
    name,
    service: `[Unit]
Description=efmesh run ${target.env} (${basename(target.project)})

[Service]
Type=oneshot
WorkingDirectory=${target.project}
ExecStart=${process.execPath} ${binPath()} run ${target.env} --config ${target.config}
# exit 2 = «ждёт человека» (нужен apply) — намеренно failure юнита: видно в алертах
`,
    timer: `[Unit]
Description=efmesh run ${target.env} — таймер

[Timer]
OnCalendar=${calendar ?? `hourly  # TODO: переведите «${cron}» в OnCalendar вручную`}
Persistent=true

[Install]
WantedBy=timers.target
`,
  }
}

/** Валидация выражения тем же парсером, который будет его исполнять. */
export const validateCron = (cron: string): Effect.Effect<void, ScheduleError> =>
  Effect.gen(function* () {
    const next = yield* Effect.try({
      try: () => Bun.cron.parse(cron),
      catch: () => new ScheduleError({ reason: `не разбирается cron-выражение «${cron}»` }),
    })
    if (next === null) {
      return yield* new ScheduleError({
        reason: `cron-выражение «${cron}» никогда не сработает`,
      })
    }
  })

/** Linux без crontab-бинаря (Arch-семейство) — честная ошибка с рецептом. */
const requireCrontab = (): Effect.Effect<void, ScheduleError> =>
  Effect.gen(function* () {
    if (process.platform !== "linux" || Bun.which("crontab") !== null) return
    return yield* new ScheduleError({
      reason:
        "на этой машине нет crontab (Arch-семейство не ставит cron-демона): " +
        "установите cronie ЛИБО используйте systemd-таймер — efmesh schedule <env> --print-systemd",
    })
  })

export const registerSchedule = (
  target: ScheduleTarget,
  cron: string,
): Effect.Effect<{ readonly title: string; readonly worker: string }, ScheduleError> =>
  Effect.gen(function* () {
    yield* validateCron(cron)
    yield* requireCrontab()
    if (!existsSync(target.config)) {
      return yield* new ScheduleError({ reason: `конфига нет: ${target.config}` })
    }
    const worker = workerPath(target)
    yield* Effect.try({
      try: () => {
        mkdirSync(dirname(worker), { recursive: true })
        writeFileSync(worker, workerSource(target))
      },
      catch: (cause) =>
        new ScheduleError({ reason: `воркер не записался: ${String(cause)}` }),
    })
    const title = scheduleTitle(target)
    yield* Effect.tryPromise({
      try: () => Bun.cron(worker, cron, title),
      catch: (cause) =>
        new ScheduleError({ reason: `Bun.cron не зарегистрировал: ${String(cause)}` }),
    })
    return { title, worker }
  })

export const removeSchedule = (
  target: ScheduleTarget,
): Effect.Effect<{ readonly title: string }, ScheduleError> =>
  Effect.gen(function* () {
    const title = scheduleTitle(target)
    yield* Effect.tryPromise({
      try: () => Bun.cron.remove(title),
      catch: (cause) => new ScheduleError({ reason: `Bun.cron.remove: ${String(cause)}` }),
    })
    // воркер больше никем не исполняется — прибираем молча
    yield* Effect.sync(() => rmSync(workerPath(target), { force: true }))
    return { title }
  })

/**
 * Список efmesh-регистраций — по платформенным следам Bun.cron: маркеры
 * `# bun-cron: <title>` в crontab (Linux) / plist'ы launchd (macOS).
 */
export const listSchedules = (): Effect.Effect<ReadonlyArray<string>, ScheduleError> =>
  Effect.gen(function* () {
    if (process.platform === "linux") {
      if (Bun.which("crontab") === null) return []
      const out = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["crontab", "-l"], { stdout: "pipe", stderr: "ignore" })
          const text = await proc.stdout.text()
          await proc.exited // пустой crontab выходит с 1 — это не ошибка
          return text
        },
        catch: (cause) => new ScheduleError({ reason: `crontab -l: ${String(cause)}` }),
      })
      return out
        .split("\n")
        .filter((line) => line.includes("bun-cron") && line.includes("efmesh-"))
    }
    if (process.platform === "darwin") {
      const out = yield* Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["launchctl", "list"], { stdout: "pipe", stderr: "ignore" })
          const text = await proc.stdout.text()
          await proc.exited
          return text
        },
        catch: (cause) => new ScheduleError({ reason: `launchctl list: ${String(cause)}` }),
      })
      return out.split("\n").filter((line) => line.includes("bun.cron.efmesh-"))
    }
    return yield* new ScheduleError({
      reason: `список на ${process.platform} смотрите средствами ОС (Task Scheduler: schtasks /query)`,
    })
  })
