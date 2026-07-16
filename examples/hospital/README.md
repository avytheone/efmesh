# Пример: движения пациентов по отделениям

Маленький, но полный проект: все виды моделей и целей материализации
на одном сюжете — выгрузка движений пациентов из КИС превращается
в витрины нагрузки на отделения.

## DAG

```
raw.moves (external, parquet-выгрузка)     ref.departments (seed, CSV)
        │
   med.moves (incrementalByTimeRange, аудиты notNull/unique/accepted)
        │
   med.stays (full: пребывание + момент следующего движения)
        ├── med.dept_load  (view: заходы по отделениям)
        ├── mart.stays     (target: "parquet" — витрина в озеро)
        └── mart.dept_daily (target: "ducklake" — витрина в DuckLake-каталог)
```

Модели находятся discovery по glob (`discovery: "models.ts"` в конфиге) —
в [efmesh.config.ts](./efmesh.config.ts) они не перечислены.

## Запуск

```sh
bun seed.ts                                # сырьё: lake/raw/moves.parquet
bun ../../src/bin.ts plan dev              # что будет сделано
bun ../../src/bin.ts apply dev             # физика + бэкфилл + view-слой
bun ../../src/bin.ts audit dev             # аудиты view-слоя
bun ../../src/bin.ts apply prod --yes      # промоушен: view-swap без пересчёта
bun ../../src/bin.ts run dev               # cron-тик: догнать новые интервалы
```

Дальше стоит поиграть: поменяйте выражение в `med.stays` и посмотрите
`plan` (breaking + каскад), допишите колонку в конец SELECT (non-breaking),
поправьте `departments.csv` (новая версия seed по содержимому),
снесите старую физику `janitor`-ом.

Файлы `efmesh.duckdb`, `efmesh.state.sqlite`, `ducklake.sqlite` и `lake/`
создаются при работе и в git не попадают.
