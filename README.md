# EFMESH

sqlmesh на bun, typescript и Effect.

Спецификация: [SPEC.md](./SPEC.md). Статус: **F0** — модели/DAG, DuckDB-движок,
state store, план как diff, физический+виртуальный слой, промоушен без пересчёта.

## Быстрый старт

Модель — TypeScript-модуль, ссылки типизированы:

```ts
import { Schema } from "effect"
import { defineModel, kind } from "efmesh"
import { moves } from "./moves.ts"

export const stays = defineModel(
  {
    name: "med.stays",
    kind: kind.full(),
    schema: Schema.Struct({ case_id: Schema.String, dept: Schema.String }),
  },
  (ctx) => ctx.sql`
    SELECT ${ctx.cols(moves, "case_id", "dept")}
    FROM ${ctx.ref(moves)}
  `,
)
```

`efmesh.config.ts` собирает проект:

```ts
import { defineConfig } from "efmesh"
import { moves, stays } from "./models.ts"

export default defineConfig({ models: [moves, stays] })
```

CLI:

```
bun efmesh plan dev      # diff против окружения, ничего не меняет
bun efmesh apply dev     # собрать физику + переключить view
bun efmesh apply prod    # промоушен: view-swap без пересчёта
bun efmesh render med.stays [--env dev]
bun efmesh graph
```

Живой пример: [examples/hospital](./examples/hospital/).

## Разработка

```
bun install
bun test
bun run check
```
