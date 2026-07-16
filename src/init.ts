import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as NodePath from "node:path"
import { Data, Effect } from "effect"

/**
 * `efmesh init` (SPEC §12): скаффолд минимального проекта — конфиг,
 * пара моделей (seed + витрина с аудитом) и данные к ним. Ничего не
 * перезаписывает: существующий efmesh.config.ts — честная ошибка.
 */

export class InitError extends Data.TaggedError("InitError")<{
  readonly path: string
  readonly reason: string
}> {}

const MODELS_TS = `import { Schema } from "effect"
import { audit, defineModel, defineSeed, kind } from "efmesh"

// seed: справочник из файла; содержимое входит в fingerprint —
// правка CSV = новая версия и пересборка
export const departments = defineSeed({
  name: "ref.departments",
  file: "seeds/departments.csv",
  schema: Schema.Struct({ dept: Schema.String, floor: Schema.Number }),
})

// витрина: full-модель с контрактом схемы и blocking-аудитом
export const floors = defineModel(
  {
    name: "mart.floors",
    kind: kind.full(),
    schema: Schema.Struct({ floor: Schema.Number, depts: Schema.Number }),
    audits: [audit.notNull("floor")],
  },
  (ctx) => ctx.sql\`
    SELECT floor, count(*)::INT AS depts
    FROM \${ctx.ref(departments)}
    GROUP BY floor
  \`,
)
`

const CONFIG_TS = `import { defineConfig } from "efmesh"
import { departments, floors } from "./models.ts"

export default defineConfig({
  models: [departments, floors],
  // engine: { url: "postgres://…" },  // вместо DuckDB-файла
  // lake: { path: "lake" },           // для target: "parquet"
})
`

const SEED_CSV = `dept,floor
ОРИТ,3
терапия,2
хирургия,3
`

export const scaffold = (dir: string): Effect.Effect<ReadonlyArray<string>, InitError> =>
  Effect.gen(function* () {
    const root = NodePath.resolve(dir)
    const files: ReadonlyArray<readonly [string, string]> = [
      ["efmesh.config.ts", CONFIG_TS],
      ["models.ts", MODELS_TS],
      ["seeds/departments.csv", SEED_CSV],
    ]
    for (const [relative] of files) {
      if (existsSync(NodePath.join(root, relative))) {
        return yield* new InitError({
          path: NodePath.join(root, relative),
          reason: "файл уже существует — init ничего не перезаписывает",
        })
      }
    }
    return yield* Effect.try({
      try: () => {
        const created: Array<string> = []
        for (const [relative, content] of files) {
          const path = NodePath.join(root, relative)
          mkdirSync(NodePath.dirname(path), { recursive: true })
          writeFileSync(path, content)
          created.push(relative)
        }
        return created
      },
      catch: (cause) => new InitError({ path: root, reason: String(cause) }),
    })
  })
