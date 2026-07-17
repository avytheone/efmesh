# efmesh

> Трансформация данных в духе [sqlmesh](https://sqlmesh.com) — на TypeScript, [Bun](https://bun.sh) и [Effect](https://effect.website).

*Русское зеркало; основной README — [английский](https://github.com/avytheone/efmesh/blob/main/README.md).*

[![ci](https://github.com/avytheone/efmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/avytheone/efmesh/actions/workflows/ci.yml) ![status](https://img.shields.io/badge/status-beta-orange) ![npm](https://img.shields.io/npm/v/%40avytheone%2Fefmesh) ![license](https://img.shields.io/badge/license-MIT-green) ![runtime](https://img.shields.io/badge/runtime-bun-black) ![effect](https://img.shields.io/badge/effect-v4-5C4EE5)

Модели — обычные TypeScript-модули: тело на SQL, ссылки между моделями — импорты, форма данных — Effect Schema. efmesh считает fingerprint каждой модели по каноническому AST, хранит версии снапшотами, строит план как diff «проект против окружения» и применяет ровно его: физика пересчитывается только там, где что-то реально изменилось, а окружения (dev/prod/…) — виртуальные view поверх общей физики, промоушен в prod не стоит ни одного пересчёта.

<p align="center"><img src="https://raw.githubusercontent.com/avytheone/efmesh/main/docs/demo.svg" alt="efmesh demo: a ref typo is a compile error; a plan rebuilds exactly the changed branch; promotion is a view swap" width="840"></p>

```ts
import { Schema } from "effect"
import { defineModel, kind } from "@avytheone/efmesh"
import { rawMoves } from "./sources.ts"

export const moves = defineModel(
  {
    name: "med.moves",
    kind: kind.incrementalByTimeRange({
      timeColumn: "moved_at",
      start: "2026-01-01T00:00:00Z",
      lookback: 1, // хвост перечитывается — поздние данные подъезжают
    }),
    schema: Schema.Struct({ case_id: Schema.String, moved_at: Schema.DateTimeUtc }),
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(rawMoves, "case_id", "moved_at")}
    FROM ${ctx.ref(rawMoves)}
    WHERE moved_at >= ${ctx.start} AND moved_at < ${ctx.end}
  `,
)
```

## Почему не dbt / sqlmesh

|                        | dbt                   | sqlmesh                 | efmesh |
|------------------------|-----------------------|-------------------------|--------|
| Язык моделей           | SQL + Jinja           | SQL + Jinja/Python      | SQL внутри TypeScript |
| Зависимости            | `ref('строка')`       | парсинг SQL             | импорт модуля — проверяет компилятор |
| Типизация колонок      | нет                   | contracts (рантайм)     | Effect Schema: компайл-тайм + контракт перед сборкой |
| Версионирование        | нет (state-less)      | снапшоты + fingerprint  | снапшоты + fingerprint |
| Dev-окружения          | копии таблиц          | виртуальные (view)      | виртуальные (view) |
| Инкрементальность      | самописный `is_incremental()` | интервалы, автоучёт | интервалы, автоучёт, resume |
| Озеро на parquet       | адаптеры              | адаптеры                | родное: `target: "parquet"`, интервал = партиция |
| Мульти-диалект         | да                    | да (sqlglot)            | **нет** — диалект движка (DuckDB или Postgres) |

Опечатка в `ref` у нас — ошибка компиляции, а не пустой прогон; переименованная колонка родителя ломает сборку потомка до того, как SQL уедет в базу.

## Зачем это существует: маленькие озёра данных

Большинство аналитики в мире — не облачный warehouse, а данные DuckDB-класса: от гигабайт до терабайта на одной машине. Продуктовая аналитика стартапа, витрины одного отдела, on-prem и edge, pipeline внутри SaaS-приложения. dbt и sqlmesh родом из мира облачных DWH и тащат этот вес с собой (Python, адаптеры, инфраструктура). efmesh — это sqlmesh-подход, который `bun add` и поехал, а озеро — это папка parquet-файлов.

Честная позиция: **ядро** — тот же класс систем, что sqlmesh (снапшоты, AST-fingerprint, план как diff, виртуальные окружения), но **широты** нет: ни облачных движков, ни мульти-диалекта, ни веб-UI, ни экосистемы пакетов — и нет амбиции всё это догонять. С dbt-core размен обратный: у dbt индустрия вокруг, но нет state-based планов, виртуальных окружений и версионирования по fingerprint — каждая команда сама изобретает «как не пересчитывать всё». Наши четыре честных преимущества: **типы как контракт DAG** (опечатка ломает сборку, а не ночной прогон), **библиотека прежде CLI** (`Efmesh.apply(...)` встраивается в приложение), **один язык на весь стек** (модели, приложение, тесты) и **кодовая база, читаемая за вечер** (~5.5k строк).

## Для кого это (и для кого нет)

**Для вас**, если вы TypeScript-команда на Bun, хотите типизированный
dbt/sqlmesh-подход поверх DuckDB или Postgres и готовы жить на бете
(efmesh — 0.2.x, Effect v4 — beta, версия effect пинована peer-зависимостью).

**Не для вас**, если нужны: Node-рантайм (пока только Bun), мульти-диалект
или облачные DWH (Snowflake/BigQuery — вне scope), стабильность уровня 1.0
или Python-экосистема — тогда честнее взять sqlmesh.

## Возможности

**Модели.** `full`, `view`, `embedded` (подзапрос без материализации), `incrementalByTimeRange` (интервальный учёт, бэкфилл батчами, lookback), `incrementalByUniqueKey` (upsert), `scdType2` (история строк, `valid_from`/`valid_to` ведёт efmesh), `defineExternal` (таблица, файлы parquet/csv/json, URL), `defineSeed` (справочник из CSV/JSON, содержимое в fingerprint), `defineSqlModel` (сырой `.sql`-файл с `@ref`/`@start`/`@end`).

**Цели материализации.** Нативная таблица движка, `parquet` (озеро: локально или s3://, интервал = партиция, view поверх `read_parquet`), `ducklake` (таблица-на-fingerprint в [DuckLake](https://ducklake.select)-каталоге — снапшоты и time travel каталога бонусом).

**План и версии.** Fingerprint по каноническому AST (переформатирование SQL не триггерит пересборку), категоризация изменений breaking / non-breaking / indirect / forward-only с обоснованием `plan --explain` и оператором-override `--reclassify`, indirect-реюз физики (потомки non-breaking-правки не пересобираются — scdType2 не теряет историю), `--forward-only` — правка без переигрывания истории (новая версия наследует физику и done-интервалы, новые колонки — `ALTER`), подтверждение плана в TTY, журнал применений с `applied_by`.

**Качество.** Контракт схемы перед сборкой (`DESCRIBE` запроса против объявленной Schema), аудиты `notNull` / `unique` / `accepted` (blocking роняет apply, `warn` — логирует), автономный `efmesh audit` по view-слою окружения, `testModel` — юнит-тесты моделей на фикстурах в in-memory DuckDB.

**Эксплуатация.** `run` — идемпотентный тик планировщика для cron/systemd; `apply` и `run` окружения — под одним межпроцессным локом (протухший лок упавшего процесса перехватывается по ttl); DAG-конкурентность `--jobs` (модель стартует по готовности родителей); ретраи батчей `--retries`; janitor для осиротевшей физики (снос — транзакционный claim, гонка с параллельным apply закрыта); Metric-счётчики и спаны на операциях; версионируемая схема state store + `efmesh migrate` (с бэкапом файла стора).

**Движки.** DuckDB (по умолчанию, включая федерацию httpfs/ATTACH) и Postgres (`Bun.SQL`-пул, canonicalize через libpg_query, параллельный бэкфилл). State store — SQLite рядом с проектом или схема в Postgres.

## Быстрый старт

```sh
bun add -d @avytheone/efmesh
bunx efmesh init my-warehouse && cd my-warehouse
bunx efmesh plan dev    # что будет сделано
bunx efmesh apply dev   # физика, бэкфилл, view-слой
```

`init` разворачивает рабочий скелет: `efmesh.config.ts`, модели-пример, seed. Дальше — правьте модели и гоняйте `plan`/`apply`; полный жизненный цикл:

```sh
bunx efmesh apply dev            # применить изменения в dev
bunx efmesh audit dev            # аудиты того, что окружение отдаёт сейчас
bunx efmesh apply prod --yes     # промоушен: view-swap, без пересчёта
bunx efmesh run prod             # cron-тик: догнать новые интервалы
```

Живой пример: [examples/hospital](https://github.com/avytheone/efmesh/tree/main/examples/hospital) — движения пациентов по отделениям, все виды моделей и целей.

## Как это устроено

```
модели (TS-модули)  ──►  DAG + fingerprint по каноническому AST
                              │
                    план = diff против state store
                              │
        apply: физика ── бэкфилл интервалов ── аудиты ── view-слой
                              │
              state store: снапшоты, интервалы, окружения, журнал
```

- **Физический слой** — таблицы `_efmesh.<модель>__<fp8>` (или parquet-префиксы/DuckLake): версия = таблица, старая живёт до janitor.
- **Виртуальный слой** — view `<env>__<schema>.<таблица>` (prod — просто `<schema>.<таблица>`), указывающие на физику. Окружение — это набор указателей; промоушен и откат — переключение view.
- **Учёт интервалов** — единственный источник правды о посчитанном: упавший бэкфилл продолжается с места остановки, пересчёт интервала — DELETE+INSERT диапазона в транзакции, без дублей.

Полная архитектура, инварианты и решения — в [SPEC.md](https://github.com/avytheone/efmesh/blob/main/SPEC.md).

## Качество данных

```ts
// аудит: SQL-предикат нарушений; blocking роняет apply, warn — логирует
audits: [
  audit.notNull("case_id"),
  audit.unique("case_id", "moved_at"),
  audit.warn(audit.accepted("dept", ["КПП", "ОРИТ", "терапия", "хирургия"])),
]
```

```ts
// юнит-тест модели: фикстуры → CTE → in-memory DuckDB → сверка (bun test)
import { testModel } from "@avytheone/efmesh/testing"

test("stays", () =>
  testModel(stays, {
    inputs: { [moves.name.full]: [{ case_id: "c1", moved_at: "2026-01-01T10:00:00Z" }] },
    expect: [{ case_id: "c1", duration: null }],
  }))
```

Объявленная `schema` — не документация, а контракт: перед сборкой efmesh делает `DESCRIBE` запроса и падает с `SchemaMismatchError`, если имена или типы колонок разошлись. NULL-гарантии выражаются аудитом `notNull`.

## Конфигурация

`efmesh.config.ts` — типизированный TS-модуль, никакого YAML:

```ts
import { defineConfig } from "@avytheone/efmesh"

export default defineConfig({
  discovery: "models/**/*.ts",      // все экспорты-модели по glob; дубликат имени = ошибка
  // models: [a, b, c],             // …или значениями (можно совместно с discovery)

  // движок: DuckDB-файл по умолчанию, Postgres — одной строкой
  engine: { path: "efmesh.duckdb" },          // или { url: "postgres://…", max: 8 }
  state: { path: "efmesh.state.sqlite" },     // или { url: "postgres://…" }

  lake: { path: "lake" },                     // для target: "parquet"; локально или s3://
  ducklake: { catalog: "ducklake.sqlite", dataPath: "lake/ducklake" },
  attach: { reporting: { url: "reporting.duckdb" } },  // export-цели по алиасам
})
```

## CLI

| Команда | Что делает |
|---|---|
| `efmesh init [dir]` | скаффолд проекта: конфиг, модели-пример, seed |
| `efmesh plan <env>` | diff проекта против окружения + недостающие интервалы, ничего не меняет |
| `efmesh apply <env>` | план → подтверждение (TTY) → физика, бэкфилл, view-слой |
| `efmesh run <env>` | тик планировщика: только новые интервалы, под локом; для cron |
| `efmesh restate <env> --model m --from t --to t` | переиграть прошлый диапазон для модели и её потомков; `--dry-run`, `--json` |
| `efmesh status <env>` | что происходит: последний план, отставание интервалов, тики run |
| `efmesh audit <env>` | аудиты view-слоя окружения — ловит деградацию задним числом |
| `efmesh diff <envA> <envB>` | чем окружения отличаются; `--data` сравнивает сами данные |
| `efmesh render <model> [--env] [--json]` | итоговый SQL модели |
| `efmesh lineage <model[.col]> [--json]` | колоночный lineage до сырья |
| `efmesh graph [--html]` | DAG моделей текстом или страницей |
| `efmesh janitor [--ttl 7] [--json]` | снести осиротевшую физику старше ttl |
| `efmesh migrate [--json]` | догнать схему state store до текущей версии |
| `efmesh schedule <env>` | зарегистрировать `run <env>` в OS-шедулере через `Bun.cron` (`--list [--json]`) |

`apply`/`run` разделяют `--jobs N` — DAG-конкурентность (на DuckDB всегда 1 — одно соединение) — и `--retries N` — ретраи транзиентных сбоев батча (экспоненциальная пауза). У `apply` есть ещё `--yes`/`-y` — без подтверждения (в non-TTY обязателен, если план что-то меняет) — и `--forward-only <model>,…` — реюз физики и истории.

`plan`/`apply` принимают `--reclassify <model>=breaking|non-breaking[,…]` —
вердикт оператора поверх `--explain`, журналируется с `applied_by`.
Non-breaking-родитель разрешает нетронутым потомкам реюзать физику вместо
пересборки (scdType2 не теряет историю строк); override, очевидно
противоречащий AST (удалённые колонки), не принимается.

`restate <env> --model <m> --from <t> --to <t>` переигрывает прошлый диапазон,
когда задним числом пришли плохие исходные данные: очищает done-интервалы
диапазона у `incrementalByTimeRange`-модели **и её incrementalByTimeRange-
потомков** (каскад — обычная логика недостающих интервалов планировщика), так
что следующий `apply` — или тик `run` — пересчитывает ровно этот диапазон.
Меняется только реестр интервалов, под локом окружения; физику команда напрямую
не трогает (её перезапишет DELETE+INSERT последующего бэкфилла). Границы — ISO
UTC и должны быть выровнены по грануле модели (несогласованная граница —
типизированная ошибка); `scdType2` отклоняется по имени (над историей версий нет
семантики диапазона времени). `--dry-run` печатает, что было бы пересчитано, и
ничего не меняет; `--json` для CI.

Все отчётные команды говорят на `--json` — `plan`, `audit`, `status`, `diff`,
`janitor`, `migrate`, `lineage`, `render` и `schedule --list` — стабильная
машиночитаемая форма (контракт в рамках semver) для CI и ботов; exit-коды не
меняются, stdout — чистый JSON (логи идут в stderr). Каждая форма — JSON-объект,
поэтому новые поля верхнего уровня остаются аддитивными.

`plan --explain` добавляет к каждому изменению обоснование: какие узлы
канонического AST разошлись (`where_clause`, `select_list[2] (добавлен)`, …)
и почему категория именно такая — включая источники каскада у `indirect`.
Те же данные попадают в `--json` полем `explain`; пути по AST — отладочная
подсказка, не часть контракта.

`diff <envA> <envB> --data` сравнивает сами данные двух окружений: счётчики
строк, пересечение по ключу (grain или ключ вида), доли расхождений по
колонкам среди сопоставленных ключей, дрейф схемы между сторонами.
`--sample P` (1–99) сравнивает детерминированную долю ключей — md5-бакеты
выровнены между сторонами, выборка не рождает ложных only-in. `--model a,b`
сужает, `--json` для CI.

`schedule <env> [--cron '@hourly']` регистрирует тик `run` в OS-шедулере
(crontab / launchd / Task Scheduler) через `Bun.cron` — идемпотентно по
заголовку, `--remove` снимает, `--list` показывает записи. Честные
оговорки: OS-cron живёт в локальной таймзоне и не догоняет пропущенные
запуски, а Arch-семейство Linux вовсе не ставит cron-демона —
`--print-systemd` печатает user-юниты (`Persistent=true` догоняет).
Наложение тиков безопасно по построению: `run` берёт env-лок и выходит
с кодом `2`, когда изменения ждут человека.

### Exit-коды

Единый контракт для headless-вызовов (CI, cron, агенты); менять его — событие
SemVer. На него ссылаются собственный `--help` CLI и каждая команда:

| Код | Значение | Когда |
|---|---|---|
| `0` | успех | команда сделала своё дело |
| `1` | ошибка | любой сбой — плохой конфиг, ошибка движка/стора, блокирующее нарушение аудита |
| `2` | ждёт человека | не сбой: у `apply` есть изменения, но нет `--yes` в не-TTY, или `run` упёрся в неприменённые структурные изменения |

Ничто никогда не блокируется в ожидании ввода молча: единственный запрос —
подтверждение `apply`, и оно возникает только в интерактивном TTY; в не-TTY
`apply` с изменениями отказывается с кодом `2`, а не зависает. Молча катить
план, который никто не видел, efmesh отказывается.

## Логирование

`apply` и `run` рассказывают, что делают. Логи идут в **stderr** — stdout
остаётся под план, сводки и `--json`, который остаётся байт-чистым JSON.
Уровни задаёт встроенный флаг `--log-level` (минимальный уровень, по
умолчанию `info`):

- **info** — жизненный цикл, за которым следит человек: старт/финиш сборки
  каждой модели с длительностью, прогресс бэкфила (`batch 3 of 7` с границами
  интервала), промоушен.
- **warn** — warn-аудиты (нарушения, которые не блокируют) и ретраи.
- **debug** — рендер SQL перед выполнением, взятие/освобождение лока и прочие
  внутренности. `--log-level debug` также печатает полный fiber-trace при сбое.

В каждой строке структурные поля-аннотации (`model`, `env`, `interval`, …). В
TTY вывод красивый и цветной; в файл или systemd journal — однострочный
[logfmt](https://brandur.org/logfmt) без ANSI, чтобы читатель логов (или
ИИ-агент, разбирающий трёхчасовой ночной тик) группировал по полям.

Встраиваете efmesh как библиотеку? Логирование — это `Effect.log*`: дайте свой
`Logger`-слой (приёмник, формат, минимальный уровень), и выбор CLI не действует.
Число строк не логируется: efmesh не делает лишний запрос ради подсчёта.

## Перфоманс

Оверхед фреймворка пренебрежим для любого реалистичного проекта (in-memory DuckDB, `bun bench/plan-bench.ts N`):

| моделей | plan холодный | apply (вся физика) | plan пустой | промоушен prod |
|---|---|---|---|---|
| 100 | 54 мс | 158 мс | 3 мс | 51 мс |
| 500 | 228 мс | 759 мс | 11 мс | 197 мс |
| 2000 | 0.9 с | 2.9 с | 50 мс | 1.3 с |

## Postgres

```ts
engine: { url: "postgres://…" },  // canonicalize через libpg_query
state:  { url: "postgres://…" },  // схема efmesh_state
```

Бэкфилл гонит батчи параллельно (пул соединений), независимые ветки DAG строятся одновременно. DuckDB-федерация (seed, parquet, external-файлы, export, ducklake) на Postgres честно падает `EngineFeatureError` — без тихой деградации.

## Статус

**0.2.2** (beta). Ядро построено и прогнано на живом примере: фазы F0–F6 (см. [SPEC.md §13](https://github.com/avytheone/efmesh/blob/main/SPEC.md) и [CHANGELOG](https://github.com/avytheone/efmesh/blob/main/CHANGELOG.md)), 187 тестов, включая живой Postgres-кластер и golden-тесты стабильности fingerprint. Effect v4 — beta-зависимость: пинована точно (peerDependencies), дрейф свежих бет ловит еженедельный CI.

Дальше: сделать efmesh читаемым для оценивающего ИИ-агента — более широкое покрытие `--json` и агентская карта репозитория `llms.txt` (milestone 0.3.0). Известное ограничение: одиночный бинарник `bun build --compile` собирается, но standalone-исполняемые Bun не резолвят импорт `"efmesh"` из рантайм-конфига — дистрибуция пакетом (SPEC §10).

## Документация

- [SPEC.md](https://github.com/avytheone/efmesh/blob/main/SPEC.md) — архитектурная спецификация: решения, инварианты, открытые вопросы;
- [CHANGELOG.md](https://github.com/avytheone/efmesh/blob/main/CHANGELOG.md) — история изменений;
- [examples/hospital](https://github.com/avytheone/efmesh/tree/main/examples/hospital) — живой пример со всеми видами моделей;
- [CONTRIBUTING.md](https://github.com/avytheone/efmesh/blob/main/CONTRIBUTING.md) — как собрать, погонять тесты и предложить правку;
- [llms.txt](https://github.com/avytheone/efmesh/blob/main/llms.txt) — машинно-ориентированная карта репозитория для оценивающего ИИ-агента.

### Агентские скилы

Эксплуатировать efmesh предполагается в основном силами ИИ-агентов, поэтому в
пакете едут [скилы Claude Code](https://github.com/avytheone/efmesh/tree/main/skills),
обучающие агента безопасным процедурам. Каждый работает только через вывод
`--json` и [коды выхода](#exit-коды), без разбора человекочитаемого текста
(тексты самих скилов — на английском, как и вся документация исходников):

- `efmesh-triage` — читает `status --json` и журнал тиков; отличает «ждёт
  человека» (код 2) от удержанной блокировки и от настоящей ошибки;
- `efmesh-safe-apply` — превью `plan --explain --json`, затем apply; когда
  уместны `--reclassify` / `--forward-only`, а когда запрещены;
- `efmesh-backfill-recovery` — найти упавшие/недостающие интервалы и перезапустить `run`;
- `efmesh-environment-hygiene` — `diff` / `diff --data` перед промоушеном,
  ритм janitor и что бэкапить;
- `efmesh-upgrade` — поднять версию пакета, `efmesh migrate`, проверить `status --json`.

Подключение: указать агенту на скилы в установленном пакете
(`node_modules/@avytheone/efmesh/skills/`) либо скопировать/симлинкнуть нужные в
`.claude/skills/` своего проекта:

```sh
ln -s ../../node_modules/@avytheone/efmesh/skills/efmesh-safe-apply .claude/skills/
```

## Лицензия

[MIT](https://github.com/avytheone/efmesh/blob/main/LICENSE) © Alexey Yakimanskiy
