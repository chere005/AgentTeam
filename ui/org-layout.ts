/**
 * Pure top-down org-chart layout for the team canvas (no React/DOM; node tests import this file).
 *
 * - The tree comes from `parentId`. Only an agent with no parent at all falls back to an incoming
 *   delegation edge from another member (the first one in input order). A parent outside the laid
 *   out set (another team, deleted) makes the agent a root. Cycles are cut deterministically: the
 *   first agent (input order) found on a cycle becomes a root.
 * - Roots sit side by side at the top; children are centered under their parent (midpoint of the
 *   first and last child) and siblings are spaced by their subtree widths, so subtrees never share
 *   x ranges and no two cards overlap. Rows are as tall as their tallest card plus `gapY`, so the
 *   same code serves compact and detailed cards (pass measured sizes).
 * - `aside` ids (the global Team Assistant) are not part of the tree; they are stacked in a column
 *   left of it, at the top, out of the way.
 * - Deterministic: the same input (order included) always gives the same positions.
 * - `wrap` (compact layout for wide teams, `fitOrgLayout`): leaf siblings in lines of `wrap`.
 */
export type OrgNode = { id: string; parentId?: string | null };
export type OrgEdge = { from: string; to: string; kind?: string };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type OrgLayoutOptions = {
  sizes?: Record<string, Size | undefined>;
  defaultSize?: Size;
  gapX?: number;
  gapY?: number;
  /** Extra horizontal space between separate root trees. */
  rootGap?: number;
  origin?: Point;
  /** Laid out beside the tree, never in it (e.g. the Team Assistant). */
  aside?: string[];
  /**
   * Compact layout for wide teams: siblings that are all leaves are placed in lines of at most
   * `wrap` cards under their parent instead of one long row. Every other line is shifted by half
   * a column, so the connectors to a lower line run through the gaps of the line above.
   */
  wrap?: number;
};
export type OrgLayout = {
  positions: Record<string, Point>;
  /** Tree depth per node (aside nodes are absent). */
  depth: Record<string, number>;
  /** The resolved parent per node (null for roots). */
  parent: Record<string, string | null>;
  roots: string[];
  bounds: { x: number; y: number; width: number; height: number };
};

export const CARD_WIDTH = 260;
/** Nominal card heights before React Flow has measured the cards. */
export const CARD_HEIGHT = { compact: 150, detailed: 340 };

/** Resolve each node's parent: parentId first, delegation edge only without any parentId. */
export function resolveParents(
  nodes: OrgNode[],
  edges: OrgEdge[] = [],
): Record<string, string | null> {
  const ids = new Set(nodes.map((n) => n.id));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const parent: Record<string, string | null> = {};
  for (const n of nodes) {
    if (n.parentId !== undefined && n.parentId !== null) {
      parent[n.id] =
        ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null;
      continue;
    }
    const incoming = edges
      .filter(
        (e) =>
          e.to === n.id &&
          e.from !== n.id &&
          ids.has(e.from) &&
          (e.kind === undefined || e.kind === "delegate"),
      )
      .sort((a, b) => order.get(a.from)! - order.get(b.from)!);
    parent[n.id] = incoming[0]?.from ?? null;
  }
  // Cut cycles: walking up from each node in order, a node that reaches itself becomes a root.
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    for (let p = parent[n.id]; p; p = parent[p]) {
      if (p === n.id || seen.has(p)) {
        if (p === n.id) parent[n.id] = null;
        else {
          // A cycle above n that does not include n: cut it at its first member in input order.
          const cycle: string[] = [];
          for (let q: string | null = p; q && !cycle.includes(q); q = parent[q])
            cycle.push(q);
          cycle.sort((a, b) => order.get(a)! - order.get(b)!);
          parent[cycle[0]] = null;
        }
        break;
      }
      seen.add(p);
    }
  }
  return parent;
}

export function orgLayout(
  nodes: OrgNode[],
  edges: OrgEdge[] = [],
  opts: OrgLayoutOptions = {},
): OrgLayout {
  const gapX = opts.gapX ?? 48,
    gapY = opts.gapY ?? 90,
    rootGap = opts.rootGap ?? gapX * 2,
    origin = opts.origin ?? { x: 0, y: 0 },
    fallback = opts.defaultSize ?? {
      width: CARD_WIDTH,
      height: CARD_HEIGHT.compact,
    };
  const asideSet = new Set(opts.aside ?? []);
  // Unique ids only (first occurrence wins), aside nodes removed from the tree.
  const seenIds = new Set<string>();
  const unique = nodes.filter((n) =>
    seenIds.has(n.id) ? false : (seenIds.add(n.id), true),
  );
  const members = unique.filter((n) => !asideSet.has(n.id));
  const aside = unique.filter((n) => asideSet.has(n.id));
  const size = (id: string): Size => {
    const s = opts.sizes?.[id];
    return s && s.width > 0 && s.height > 0 ? s : fallback;
  };
  const parent = resolveParents(members, edges);
  const children = new Map<string, string[]>();
  for (const n of members) children.set(n.id, []);
  const roots: string[] = [];
  for (const n of members) {
    const p = parent[n.id];
    if (p) children.get(p)!.push(n.id);
    else roots.push(n.id);
  }
  // Compact layout: lines of leaf siblings (line index and vertical offset inside their row).
  const wrap =
    opts.wrap && Number.isFinite(opts.wrap) && opts.wrap >= 1
      ? Math.floor(opts.wrap)
      : 0;
  const lineGap = Math.round(gapY * 0.6);
  const line: Record<string, number> = {};
  const lineOffset: Record<string, number> = {};
  const wrapped = (id: string) => {
    const kids = children.get(id)!;
    return (
      wrap > 0 &&
      kids.length > wrap &&
      kids.every((k) => !children.get(k)!.length)
    );
  };
  for (const n of members) {
    if (!wrapped(n.id)) continue;
    const kids = children.get(n.id)!;
    const lineH = Math.max(...kids.map((k) => size(k).height));
    kids.forEach((k, i) => {
      line[k] = Math.floor(i / wrap);
      lineOffset[k] = line[k] * (lineH + lineGap);
    });
  }
  // Depth and row heights.
  const depth: Record<string, number> = {};
  const rowHeight: number[] = [];
  const visit = (id: string, d: number) => {
    depth[id] = d;
    rowHeight[d] = Math.max(
      rowHeight[d] ?? 0,
      (lineOffset[id] ?? 0) + size(id).height,
    );
    for (const c of children.get(id)!) visit(c, d + 1);
  };
  for (const r of roots) visit(r, 0);
  const rowY: number[] = [];
  let y = origin.y;
  for (let d = 0; d < rowHeight.length; d++) {
    rowY[d] = y;
    y += rowHeight[d] + gapY;
  }
  // x: centers by subtree; subtrees occupy disjoint x ranges.
  const center: Record<string, number> = {};
  const shift = (id: string, dx: number) => {
    center[id] += dx;
    for (const c of children.get(id)!) shift(c, dx);
  };
  /** Lays out the subtree starting at `left`; returns its right edge. */
  const place = (id: string, left: number): number => {
    const w = size(id).width;
    const kids = children.get(id)!;
    if (!kids.length) {
      center[id] = left + w / 2;
      return left + w;
    }
    if (wrapped(id)) {
      // Grid of leaf lines; odd lines shifted by half a column.
      const colW = Math.max(...kids.map((k) => size(k).width));
      const pitch = colW + gapX;
      let right = left;
      kids.forEach((k, i) => {
        const shiftX = line[k] % 2 ? pitch / 2 : 0;
        center[k] = left + shiftX + (i % wrap) * pitch + colW / 2;
        right = Math.max(right, center[k] + colW / 2);
      });
      // The parent sits over the first line.
      const first = kids.slice(0, wrap);
      center[id] = (center[first[0]] + center[first[first.length - 1]]) / 2;
      const overhang = left - (center[id] - w / 2);
      if (overhang > 0) {
        shift(id, overhang);
        right += overhang;
      }
      return Math.max(right, center[id] + w / 2);
    }
    let cursor = left;
    let right = left;
    for (const c of kids) {
      right = place(c, cursor);
      cursor = right + gapX;
    }
    center[id] = (center[kids[0]] + center[kids[kids.length - 1]]) / 2;
    const overhang = left - (center[id] - w / 2);
    if (overhang > 0) {
      // The parent is wider than its children's span on the left: move the whole subtree.
      shift(id, overhang);
      right += overhang;
    }
    return Math.max(right, center[id] + w / 2);
  };
  let cursor = origin.x;
  for (const r of roots) cursor = place(r, cursor) + rootGap;
  const positions: Record<string, Point> = {};
  for (const n of members) {
    const s = size(n.id);
    positions[n.id] = {
      x: Math.round(center[n.id] - s.width / 2),
      y: Math.round(rowY[depth[n.id]] + (lineOffset[n.id] ?? 0)),
    };
  }
  // Aside column: left of the tree, top-aligned.
  let ay = origin.y;
  const asideWidth = Math.max(0, ...aside.map((n) => size(n.id).width));
  for (const n of aside) {
    positions[n.id] = {
      x: Math.round(origin.x - asideWidth - rootGap),
      y: Math.round(ay),
    };
    ay += size(n.id).height + gapY;
  }
  const boxes = Object.entries(positions).map(([id, p]) => ({
    ...p,
    ...size(id),
  }));
  const minX = Math.min(...boxes.map((b) => b.x), origin.x),
    minY = Math.min(...boxes.map((b) => b.y), origin.y),
    maxX = Math.max(...boxes.map((b) => b.x + b.width), origin.x),
    maxY = Math.max(...boxes.map((b) => b.y + b.height), origin.y);
  return {
    positions,
    depth,
    parent,
    roots,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

/** True when two boxes overlap (touching edges do not count). */
export function overlap(a: Point & Size, b: Point & Size): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * The org layout for a canvas: the regular one when it fits `maxWidth` (flow units, i.e. the
 * canvas width at the lowest readable zoom), else the widest compact (`wrap`) layout that fits,
 * else the narrowest one tried (wrap 2). Wrapping only reflows leaf sibling rows.
 */
export function fitOrgLayout(
  nodes: OrgNode[],
  edges: OrgEdge[],
  opts: OrgLayoutOptions,
  maxWidth: number,
): OrgLayout & { wrap: number | null } {
  const plain = orgLayout(nodes, edges, { ...opts, wrap: undefined });
  if (!(maxWidth > 0) || plain.bounds.width <= maxWidth)
    return { ...plain, wrap: null };
  const kidCounts = new Map<string, number>();
  for (const p of Object.values(plain.parent))
    if (p) kidCounts.set(p, (kidCounts.get(p) ?? 0) + 1);
  const widest = Math.max(0, ...kidCounts.values());
  let last: OrgLayout | null = null;
  for (let w = widest - 1; w >= 2; w--) {
    last = orgLayout(nodes, edges, { ...opts, wrap: w });
    if (last.bounds.width <= maxWidth) return { ...last, wrap: w };
  }
  return last ? { ...last, wrap: 2 } : { ...plain, wrap: null };
}
