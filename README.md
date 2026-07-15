# EFMESH

sqlmesh на bun, typescript и Effect.

Спецификация: [SPEC.md](./SPEC.md). Статус: **F2** — поверх F0/F1 (модели/DAG,
DuckDB-движок, план как diff, виртуальные окружения, инкрементальность по
интервалам с бэкфиллом и resume, AST-fingerprint, external, контракт схемы,
parquet-озеро) добавились аудиты качества, `testModel` на in-memory DuckDB,
категоризация breaking/non-breaking по AST, `run` по расписанию с
межпроцессной блокировкой, janitor, seed-справочники, upsert по ключу,
экспорт в ATTACH-базы, `diff` окружений и метрики.

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
bun efmesh plan dev      # diff + недостающие интервалы, ничего не меняет
bun efmesh apply dev     # собрать физику, догнать интервалы, переключить view
bun efmesh apply prod    # промоушен: view-swap без пересчёта
bun efmesh run dev       # тик планировщика: только интервалы, с блокировкой
bun efmesh diff dev prod # чем окружения отличаются
bun efmesh janitor       # снести осиротевшую физику старше ttl
bun efmesh render med.moves [--env dev]
bun efmesh graph
```

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
