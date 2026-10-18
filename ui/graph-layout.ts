/** Pure layout helpers for the read-only workflow graph view (no React/DOM). */
export type LayoutNode = { id: string };
export type LayoutEdge = { from: string; to: string; back?: boolean };

/**
 * Layered layout: x by longest path from a starting step (forward edges only; a cycle that slipped
 * through is cut), y by order within the layer.
 */
export function layerGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  gap = { x: 240, y: 96 },
): Map<string, { x: number; y: number; depth: number }> {
  const forward = edges.filter((e) => !e.back);
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 0);
  // Bellman-Ford style relaxation bounded by the node count keeps cycles from looping forever.
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of forward) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (depth.has(e.to) && d > (depth.get(e.to) ?? 0) && d < nodes.length) {
        depth.set(e.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number; depth: number }>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    out.set(n.id, { x: d * gap.x, y: row * gap.y, depth: d });
  }
  return out;
}

export const NODE_TYPE_LABEL: Record<string, string> = {
  task: "Agent task",
  command: "Command",
  condition: "Condition",
  human: "Human input",
  fanout: "Fan-out",
  join: "Join",
  loop: "Loop",
};

/** One-line description of a node for lists and graph labels. */
export function nodeSummary(n: Record<string, any>): string {
  switch (n.type) {
    case "task":
      return String(n.title ?? "");
    case "command":
      return (
        (n.shell ? "[shell] " : "") +
        (n.argv ?? [])
          .map((a: unknown) =>
            typeof a === "string" ? a : `{${(a as { input: string }).input}}`,
          )
          .join(" ")
      );
    case "human":
      return String(n.prompt ?? "");
    case "join":
      return `${n.mode ?? "all"}${n.minCompleted ? " (min " + n.minCompleted + ")" : ""}`;
    case "loop":
      return `at most ${n.maxIterations ?? "?"} iterations`;
    case "condition":
      return exprSummary(n.expr);
    default:
      return "";
  }
}
export function exprSummary(e: any): string {
  if (!e) return "";
  if (e.all) return e.all.map(exprSummary).join(" and ");
  if (e.any) return e.any.map(exprSummary).join(" or ");
  if (e.not) return "not " + exprSummary(e.not);
  const operand = (o: any) =>
    !o ? "" : "input" in o ? o.input : JSON.stringify(o.value);
  return `${operand(e.left)} ${e.op}${e.right ? " " + operand(e.right) : ""}`;
}
