# EFMESH

sqlmesh на bun, typescript и Effect.

Спецификация: [SPEC.md](./SPEC.md). Статус: **F1** — к скелету F0 (модели/DAG,
DuckDB-движок, state store, план как diff, физический+виртуальный слой,
промоушен без пересчёта) добавились инкрементальность по интервалам с
бэкфиллом и resume, fingerprint по канонизированному AST, external-источники,
контракт схемы и parquet-озеро.

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
