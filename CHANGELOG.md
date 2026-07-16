# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).
Внутренняя история разработки велась фазами F0–F5 (SPEC.md §13);
первая версия собирает их целиком.

## [Unreleased]

## [0.1.0-beta.1] — 2026-07-16

Первая публичная бета. Всё ниже — новое.

### Модели и план (F0–F1)

- `defineModel`/`defineExternal`: модели — TypeScript-модули, ссылки —
  импорты, форма данных — Effect Schema; DAG строится из значений.
- Fingerprint по каноническому AST (`json_serialize_sql` DuckDB):
  переформатирование SQL не триггерит пересборку.
- Снапшоты версий, виртуальные окружения (view поверх физики),
  план как diff, промоушен без пересчёта.
- `kind.incrementalByTimeRange`: интервальный учёт в state store, бэкфилл
  батчами DELETE+INSERT в транзакции, resume с места остановки, `lookback`.
- Контракт схемы перед сборкой (`DESCRIBE` против объявленной Schema).
- `target: "parquet"`: озеро локально или на S3 (httpfs), интервал = партиция.

### Качество и эксплуатация (F2)

- Аудиты `notNull`/`unique`/`accepted`, blocking/warn.
- `testModel` (`efmesh/testing`): юнит-тесты моделей на фикстурах
  в in-memory DuckDB.
- Категоризация изменений breaking / non-breaking / indirect по AST.
- `efmesh run`: идемпотентный тик планировщика с межпроцессным локом;
  `Runner.daemon` для встраивания.
- `efmesh janitor`, `efmesh diff`, `defineSeed`,
  `kind.incrementalByUniqueKey` (upsert), экспорт витрин в ATTACH-базы,
  метрики и спаны.

### Широта (F3)

- Postgres: движок на `Bun.SQL` (пул, параллельные батчи бэкфилла),
  canonicalize через libpg_query, state store в схеме `efmesh_state`.
- `--forward-only`: правка без переигрывания истории — новая версия
  наследует физику и done-интервалы, новые колонки через `ALTER`.
- `kind.scdType2` (история строк), `kind.embedded` (подзапрос без
  материализации), `defineSqlModel` (сырые `.sql` с `@ref`/`@start`/`@end`).
- Колоночный `efmesh lineage`, `efmesh graph --html`.

### Эксплуатационная зрелость (F4)

- Межмодельная DAG-конкурентность apply (`--jobs`): модель стартует
  по готовности родителей; на DuckDB честно 1 (одно соединение).
- `target: "ducklake"`: физика в DuckLake-каталоге, снапшоты и time travel
  каталога — бонус.
- Автономный `efmesh audit <env>` по view-слою окружения.
- `efmesh init` (скаффолд), версия схемы state store + `efmesh migrate`.
- Подтверждение плана в TTY (`--yes` пропускает, не-TTY едет без вопроса).

### Бета-гейт (F5)

- Межпроцессный лок на `apply` — общий env-лок с `run`: параллельные
  мутации окружения из разных процессов взаимно исключаются
  (`LockHeldError`); у janitor свой глобальный лок.
- Discovery моделей по glob: `discovery: "models/**/*.ts"` в конфиге.
- Ретраи батча бэкфилла: `--retries N`, `Schedule.exponential`;
  аудиты не ретраятся.
- `applied_by` в журнале планов (версия схемы стора 2).
- Лицензия MIT.

### Известные ограничения

- Effect v4 — beta-зависимость; API efmesh держится стабильного
  подмножества.
- Одиночный бинарник `bun build --compile` собирается, но standalone-Bun
  не резолвит импорт `"efmesh"` из рантайм-конфига — дистрибуция пакетом.
- Nullability не входит в контракт схемы (DuckDB `DESCRIBE` её не отдаёт) —
  выражается аудитом `notNull`.
