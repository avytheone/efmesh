/**
 * Example raw data: writes lake/raw/moves.parquet — as if dumped from the HIS.
 * Run: bun seed.ts (from examples/hospital).
 */
import { mkdirSync } from "node:fs"
import { DuckDBInstance } from "@duckdb/node-api"

mkdirSync(new URL("./lake/raw/", import.meta.url).pathname, { recursive: true })

const instance = await DuckDBInstance.create(":memory:")
const connection = await instance.connect()
await connection.run(`
  COPY (
    SELECT * FROM (VALUES
      ('c1', 'КПП',      TIMESTAMP '2026-01-01 10:00:00'),
      ('c1', 'ОРИТ',     TIMESTAMP '2026-01-01 12:00:00'),
      ('c1', 'терапия',  TIMESTAMP '2026-01-03 09:00:00'),
      ('c2', 'КПП',      TIMESTAMP '2026-01-02 08:00:00'),
      ('c2', 'хирургия', TIMESTAMP '2026-01-02 11:00:00'),
      ('c3', 'КПП',      TIMESTAMP '2026-01-04 07:30:00'),
      ('c3', 'ОРИТ',     TIMESTAMP '2026-01-04 09:00:00')
    ) AS t(case_id, dept, moved_at)
  ) TO '${new URL("./lake/raw/moves.parquet", import.meta.url).pathname}' (FORMAT PARQUET)
`)
connection.closeSync()
instance.closeSync()
console.log("lake/raw/moves.parquet записан")
