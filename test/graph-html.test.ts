import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { buildGraph } from "../src/core/graph.ts"
import { defineExternal, defineModel, external, kind } from "../src/core/model.ts"
import { renderGraphHtml } from "../src/plan/graph-html.ts"

const raw = defineExternal({
  name: "src.rows",
  source: external.table("src.rows"),
  schema: Schema.Struct({ id: Schema.String }),
})

const mid = defineModel(
  { name: "med.mid", kind: kind.full(), schema: Schema.Struct({ id: Schema.String }) },
  (ctx) => ctx.sql`SELECT id FROM ${ctx.ref(raw)}`,
)

const top = defineModel(
  { name: "med.top", kind: kind.view(), schema: Schema.Struct({ n: Schema.Number }) },
  (ctx) => ctx.sql`SELECT count(*)::INT AS n FROM ${ctx.ref(mid)}`,
)

describe("graph --html", () => {
  test("самодостаточная страница: все узлы, рёбра по deps, слои слева направо", async () => {
    const graph = await Effect.runPromise(buildGraph([raw, mid, top]))
    const html = renderGraphHtml(graph)

    expect(html).toContain("<svg")
    for (const name of ["src.rows", "med.mid", "med.top"]) {
      expect(html).toContain(`data-name="${name}"`)
    }
    expect(html).toContain(`data-from="src.rows" data-to="med.mid"`)
    expect(html).toContain(`data-from="med.mid" data-to="med.top"`)
    // никаких внешних ресурсов (xmlns-URI неймспейса — не загрузка)
    expect(html).not.toContain("<link")
    expect(html).not.toContain("src=")
    expect(html).not.toContain("@import")
    // родитель левее потомка
    const xOf = (name: string): number =>
      Number(html.match(new RegExp(`data-name="${name}" transform="translate\\((\\d+)`))![1])
    expect(xOf("src.rows")).toBeLessThan(xOf("med.mid"))
    expect(xOf("med.mid")).toBeLessThan(xOf("med.top"))
  })
})
