# EFMESH

sqlmesh на bun, typescript и Effect.

Спецификация: [SPEC.md](./SPEC.md). Статус: **F4** — поверх F0–F3
(модели/DAG, DuckDB-движок, план как diff, виртуальные окружения,
инкрементальность с бэкфиллом и resume, AST-fingerprint, external, контракт
схемы, parquet-озеро, аудиты, `testModel`, категоризация изменений, `run`
с блокировкой, janitor, seed, upsert, экспорт в ATTACH, diff, метрики,
Postgres — движок на `Bun.SQL` + libpg_query и state store, `--forward-only`,
`scdType2`, `embedded`, `.sql`-модели, `lineage`, `graph --html`) добавились
**межмодельная DAG-конкурентность** apply (`--jobs`), **`target: "ducklake"`**
(таблица-на-fingerprint в DuckLake-каталоге), автономный **`efmesh audit`**,
**`efmesh init`**, версионирование схемы state store + **`efmesh migrate`**
и интерактивное **подтверждение плана** в apply.

## Быстрый старт

Модель — TypeScript-модуль, ссылки типизированы:

```ts
import { Schema } from "effect"
import { defineExternal, defineModel, external, kind } from "efmesh"

// сырьё: parquet-файл (или таблица, или JSON по HTTPS) — не материализуется
export const rawMoves = defineExternal({
  name: "raw.moves",
  source: external.files("lake/raw/moves.parquet", "parquet"),
  schema: Schema.Struct({ case_id: Schema.String, moved_at: Schema.DateTimeUtc }),
})

// инкрементальная модель: пересчёт по дням, дозагрузка при каждом apply
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

Объявленная `schema` — контракт: перед сборкой efmesh делает `DESCRIBE`
запроса и падает с `SchemaMismatchError`, если колонки или типы разошлись.
`target: "parquet"` кладёт физику модели в озеро (интервал = партиция),
view поверх `read_parquet`.

Качество — аудиты и юнит-тесты моделей:

```ts
// аудит: SQL-предикат нарушений; blocking роняет apply, warn — логирует
audits: [audit.notNull("case_id"), audit.unique("case_id"), audit.warn(audit.accepted("dept", ["ОРИТ"]))]

// тест: фикстуры → CTE → in-memory DuckDB → сверка (bun test)
import { testModel } from "efmesh/testing"
test("stays", () => testModel(stays, {
  inputs: { [moves.name.full]: [{ case_id: "c1", moved_at: "2026-01-01T10:00:00Z" }] },
  expect: [{ case_id: "c1", duration: null }],
}))
```

Ещё из F2: `defineSeed` (CSV/JSON-справочник, содержимое в fingerprint),
`kind.incrementalByUniqueKey({key})` (upsert), `export: {attach, table}`
(витрина уезжает в ATTACH-базу после аудитов и промоушена), план
различает breaking / non-breaking (колонки добавлены в конец) / indirect
(каскад от родителя).

Из F3:

```ts
// SCD2: история версий строк, valid_from/valid_to ведёт efmesh
kind.scdType2({ key: ["id"] })

// embedded: подставляется потребителям подзапросом, без материализации
kind.embedded()

// сырая .sql-модель: @ref(имя), @start/@end; зависимости — значениями
defineSqlModel({ name: "med.stays", kind: kind.full(), schema, file: "models/stays.sql", refs: [moves] })
```

`efmesh apply dev --forward-only med.moves` применяет правку без
переигрывания истории: новая версия наследует физику и done-интервалы,
новые колонки добавляются ALTER-ом (история получает NULL), indirect-потомки
подхватываются каскадом. Postgres вместо DuckDB — одна строка конфига:

```ts
engine: { url: "postgres://…" },  // canonicalize через libpg_query
state:  { url: "postgres://…" },  // схема efmesh_state, переживает команду
```

Бэкфилл на Postgres гонит батчи параллельно (пул соединений, `concurrency`),
а apply строит независимые ветки DAG одновременно (`--jobs`, модель стартует
по готовности родителей). DuckDB-федерация (seed/parquet/external-файлы/
export/ducklake) на PG честно падает `EngineFeatureError`.

Из F4 — DuckLake как третья цель материализации и эксплуатационные команды:

```ts
// физика — таблица-на-fingerprint в DuckLake-каталоге; версии наши,
// снапшоты и time travel каталога — бонус
kind: kind.full(), target: "ducklake"
// в конфиге: ducklake: { catalog: "ducklake.sqlite", dataPath: "lake/ducklake" }
```

`efmesh apply` в TTY показывает план и ждёт «y» (`--yes` в скриптах не
нужен — не-TTY едет без вопроса). `efmesh audit dev` проверяет аудитами
то, что окружение отдаёт потребителям сейчас, — ловит деградацию задним
числом. `efmesh init` разворачивает скелет проекта, `efmesh migrate`
догоняет схему state store: свежий стор бутстрапится сам, старый без
миграции честно не открывается.

`efmesh.config.ts` собирает проект:

```ts
import { defineConfig } from "efmesh"
import { moves, rawMoves } from "./models.ts"

export default defineConfig({
  models: [rawMoves, moves],
  lake: { path: "lake" }, // для target: "parquet"; локально или s3://
})
```

CLI:

```
bun efmesh init [dir]    # скаффолд: конфиг, модели-пример, seed
bun efmesh plan dev      # diff + недостающие интервалы, ничего не меняет
bun efmesh apply dev     # план → подтверждение (TTY) → физика, интервалы, view
bun efmesh apply prod -y # промоушен: view-swap без пересчёта, без вопроса
bun efmesh run dev       # тик планировщика: только интервалы, с блокировкой
bun efmesh audit dev     # аудиты view-слоя окружения, ничего не меняя
bun efmesh diff dev prod # чем окружения отличаются
bun efmesh janitor       # снести осиротевшую физику старше ttl
bun efmesh migrate       # догнать схему state store до текущей версии
bun efmesh render med.moves [--env dev]
bun efmesh lineage mart.stays.dept   # колоночный lineage до сырья
bun efmesh graph [--html dag.html]   # DAG текстом или страницей
```

`apply`/`run` принимают `--jobs N` — сколько моделей строить одновременно
(DAG-конкурентность; на DuckDB всегда 1 — одно соединение).

Бэкфилл поинтервальный и возобновляемый: упавший батч помечается `failed`,
повторный `apply` продолжает с места остановки, пересчёт интервала — без
дублей (DELETE+INSERT диапазона в транзакции).

Живой пример: [examples/hospital](./examples/hospital/) — `bun seed.ts`,
затем `bun ../../src/bin.ts apply dev`.

## Разработка

```
bun install
bun test
bun run check
```
