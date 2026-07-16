import type { ModelGraph } from "../core/graph.ts"

/**
 * `efmesh graph --html` (SPEC §11): самодостаточная страница с DAG моделей —
 * SVG без внешних зависимостей, слои по длиннейшему пути от корней,
 * рёбра — кривые Безье, подсветка соседей по наведению.
 */

const KIND_COLOR: Record<string, string> = {
  external: "#8899aa",
  seed: "#b08968",
  view: "#5fa8d3",
  embedded: "#9d8cd6",
  full: "#4f772d",
  incrementalByTimeRange: "#e07a5f",
  incrementalByUniqueKey: "#d4a373",
  scdType2: "#c05299",
}

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(`"`, "&quot;")

const NODE_W = 210
const NODE_H = 46
const COL_GAP = 90
const ROW_GAP = 26
const PAD = 32

export const renderGraphHtml = (graph: ModelGraph): string => {
  // слой = длиннейший путь от корней: родители всегда левее потомков
  const depth = new Map<string, number>()
  for (const name of graph.order) {
    const model = graph.models.get(name)!
    let level = 0
    for (const dep of model.deps) level = Math.max(level, (depth.get(dep) ?? 0) + 1)
    depth.set(name, level)
  }
  const columns = new Map<number, Array<string>>()
  for (const name of graph.order) {
    const level = depth.get(name)!
    const column = columns.get(level) ?? []
    column.push(name)
    columns.set(level, column)
  }

  const position = new Map<string, { x: number; y: number }>()
  for (const [level, names] of columns) {
    names.forEach((name, index) => {
      position.set(name, {
        x: PAD + level * (NODE_W + COL_GAP),
        y: PAD + index * (NODE_H + ROW_GAP),
      })
    })
  }
  const width = PAD * 2 + columns.size * (NODE_W + COL_GAP) - COL_GAP
  const height =
    PAD * 2 +
    Math.max(...[...columns.values()].map((names) => names.length)) * (NODE_H + ROW_GAP) -
    ROW_GAP

  const edges: Array<string> = []
  for (const name of graph.order) {
    const model = graph.models.get(name)!
    const to = position.get(name)!
    for (const dep of model.deps) {
      const from = position.get(dep)!
      const x1 = from.x + NODE_W
      const y1 = from.y + NODE_H / 2
      const x2 = to.x
      const y2 = to.y + NODE_H / 2
      const bend = (x2 - x1) / 2
      edges.push(
        `<path class="edge" data-from="${escapeHtml(dep)}" data-to="${escapeHtml(name)}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}"/>`,
      )
    }
  }

  const nodes = graph.order.map((name) => {
    const model = graph.models.get(name)!
    const { x, y } = position.get(name)!
    const color = KIND_COLOR[model.kind._tag] ?? "#666"
    const title =
      model.description !== undefined ? `${name} — ${model.description}` : name
    return `<g class="node" data-name="${escapeHtml(name)}" transform="translate(${x}, ${y})">
      <title>${escapeHtml(title)}</title>
      <rect width="${NODE_W}" height="${NODE_H}" rx="8"/>
      <rect width="4" height="${NODE_H}" rx="2" fill="${color}"/>
      <text x="14" y="19" class="name">${escapeHtml(name)}</text>
      <text x="14" y="36" class="kind" fill="${color}">${escapeHtml(model.kind._tag)}</text>
    </g>`
  })

  const legend = Object.entries(KIND_COLOR)
    .filter(([tag]) => [...graph.models.values()].some((model) => model.kind._tag === tag))
    .map(
      ([tag, color]) =>
        `<span class="badge"><i style="background:${color}"></i>${escapeHtml(tag)}</span>`,
    )
    .join("")

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>efmesh — DAG моделей</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px;
         background: light-dark(#fafafa, #16181d); color: light-dark(#222, #ddd); }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .legend { margin-bottom: 12px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; margin-right: 14px;
           font-size: 12px; opacity: .85; }
  .badge i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  svg { max-width: 100%; height: auto; }
  .node rect:first-of-type { fill: light-dark(#fff, #23262e);
    stroke: light-dark(#d5d5d5, #3a3f4a); }
  .node .name { font-weight: 600; font-size: 13px; fill: light-dark(#222, #eee); }
  .node .kind { font-size: 11px; }
  .edge { fill: none; stroke: light-dark(#b9c0c9, #4a5160); stroke-width: 1.5; }
  .node, .edge { transition: opacity .12s ease; }
  svg.focused .node:not(.lit), svg.focused .edge:not(.lit) { opacity: .18; }
  .edge.lit { stroke: light-dark(#e07a5f, #e6a08c); stroke-width: 2; }
</style>
</head>
<body>
<h1>efmesh — DAG моделей</h1>
<div class="legend">${legend}</div>
<svg id="dag" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
${edges.join("\n")}
${nodes.join("\n")}
</svg>
<script>
  const svg = document.getElementById("dag")
  const edges = [...svg.querySelectorAll(".edge")]
  for (const node of svg.querySelectorAll(".node")) {
    node.addEventListener("mouseenter", () => {
      const name = node.dataset.name
      svg.classList.add("focused")
      node.classList.add("lit")
      for (const edge of edges) {
        if (edge.dataset.from !== name && edge.dataset.to !== name) continue
        edge.classList.add("lit")
        const other = edge.dataset.from === name ? edge.dataset.to : edge.dataset.from
        svg.querySelector('.node[data-name="' + CSS.escape(other) + '"]')?.classList.add("lit")
      }
    })
    node.addEventListener("mouseleave", () => {
      svg.classList.remove("focused")
      for (const lit of svg.querySelectorAll(".lit")) lit.classList.remove("lit")
    })
  }
</script>
</body>
</html>
`
}
