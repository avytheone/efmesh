/**
 * Regenerates the committed archive under `archive/` — the output of an
 * at-least-once archiver: hive-partitioned by the archiver's own arrival day,
 * duplicates included on purpose, and two schema generations (the later
 * partitions carry `source_node`, the earlier ones never heard of it).
 *
 * The files are committed so the example runs without this script; it exists
 * so the fixture is reviewable as data rather than as bytes. Run from
 * examples/eventlake: bun seed.ts
 */
import { rmSync } from "node:fs"
import { DuckDBInstance } from "@duckdb/node-api"

const archive = new URL("./archive/", import.meta.url).pathname.replace(/\/$/, "")
rmSync(archive, { recursive: true, force: true })

const instance = await DuckDBInstance.create(":memory:")
const connection = await instance.connect()

/**
 * Schema generation 1 — no `source_node`. Six rows on 03-01 (one of them a
 * same-day redelivery of ev-001) and four on 03-02 (two of them redeliveries
 * of the previous day's ev-002 and ev-003).
 */
await connection.run(`
  COPY (
    SELECT *, arrived_at::DATE AS arrival_date FROM (VALUES
      ('ev-001', 'created', TIMESTAMP '2026-03-01 10:00:00', TIMESTAMP '2026-03-01 10:00:05',  1, '10.50'),
      ('ev-002', 'created', TIMESTAMP '2026-03-01 10:05:00', TIMESTAMP '2026-03-01 10:05:03',  2, '4.00'),
      ('ev-003', 'updated', TIMESTAMP '2026-03-01 10:30:00', TIMESTAMP '2026-03-01 10:30:02',  3, '99.99'),
      ('ev-004', 'created', TIMESTAMP '2026-03-01 11:00:00', TIMESTAMP '2026-03-01 11:00:07',  4, '0.75'),
      ('ev-005', 'closed',  TIMESTAMP '2026-03-01 11:45:00', TIMESTAMP '2026-03-01 11:45:01',  5, '12.00'),
      ('ev-001', 'created', TIMESTAMP '2026-03-01 10:00:00', TIMESTAMP '2026-03-01 23:10:00',  6, '10.50'),
      ('ev-006', 'created', TIMESTAMP '2026-03-02 09:00:00', TIMESTAMP '2026-03-02 09:00:02',  7, '3.25'),
      ('ev-007', 'updated', TIMESTAMP '2026-03-02 09:30:00', TIMESTAMP '2026-03-02 09:30:04',  8, '48.10'),
      ('ev-002', 'created', TIMESTAMP '2026-03-01 10:05:00', TIMESTAMP '2026-03-02 09:31:00',  9, '4.00'),
      ('ev-003', 'updated', TIMESTAMP '2026-03-01 10:30:00', TIMESTAMP '2026-03-02 09:32:00', 10, '99.99')
    ) AS t(event_id, event_type, occurred_at, arrived_at, archiver_offset, metric_value)
  ) TO '${archive}' (
    FORMAT PARQUET, PARTITION_BY (arrival_date), OVERWRITE_OR_IGNORE,
    FILENAME_PATTERN 'gen1_{i}'
  )
`)

/**
 * Schema generation 2 — `source_node` appears. ev-004's redelivery on 03-05
 * is the deliberate cross-window case: four days after the original, past any
 * lookback horizon a daily model can afford (see models.ts).
 */
await connection.run(`
  COPY (
    SELECT *, arrived_at::DATE AS arrival_date FROM (VALUES
      ('ev-008', 'created', TIMESTAMP '2026-03-03 08:00:00', TIMESTAMP '2026-03-03 08:00:01', 11, '7.20', 'node-b'),
      ('ev-006', 'created', TIMESTAMP '2026-03-02 09:00:00', TIMESTAMP '2026-03-03 08:05:00', 12, '3.25', 'node-b'),
      ('ev-001', 'created', TIMESTAMP '2026-03-01 10:00:00', TIMESTAMP '2026-03-03 08:06:00', 13, '10.50', 'node-a'),
      ('ev-009', 'created', TIMESTAMP '2026-03-05 07:00:00', TIMESTAMP '2026-03-05 07:00:02', 14, '5.00', 'node-c'),
      ('ev-004', 'created', TIMESTAMP '2026-03-01 11:00:00', TIMESTAMP '2026-03-05 07:10:00', 15, '0.75', 'node-c'),
      ('ev-008', 'created', TIMESTAMP '2026-03-03 08:00:00', TIMESTAMP '2026-03-05 07:11:00', 16, '7.20', 'node-c')
    ) AS t(event_id, event_type, occurred_at, arrived_at, archiver_offset, metric_value, source_node)
  ) TO '${archive}' (
    FORMAT PARQUET, PARTITION_BY (arrival_date), OVERWRITE_OR_IGNORE,
    FILENAME_PATTERN 'gen2_{i}'
  )
`)

connection.closeSync()
instance.closeSync()
console.log(`archive/ written: 16 rows, 9 distinct event ids`)
