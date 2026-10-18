import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_HEIGHT,
  fitOrgLayout,
  orgLayout,
  overlap,
  resolveParents,
  type OrgEdge,
  type OrgNode,
  type OrgLayoutOptions,
} from "../ui/org-layout.ts";

const W = 260;
/** Asserts the org-chart invariants and returns the layout. */
function check(
  nodes: OrgNode[],
  edges: OrgEdge[] = [],
  opts: OrgLayoutOptions = {},
) {
  const l = orgLayout(nodes, edges, opts);
  const size = (id: string) =>
    opts.sizes?.[id] ??
    opts.defaultSize ?? { width: W, height: CARD_HEIGHT.compact };
  const box = (id: string) => ({ ...l.positions[id], ...size(id) });
  const ids = Object.keys(l.positions);
  assert.equal(ids.length, new Set(nodes.map((n) => n.id)).size);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      assert.ok(
        !overlap(box(ids[i]), box(ids[j])),
        `${ids[i]} overlaps ${ids[j]}`,
      );
  for (const [id, p] of Object.entries(l.parent)) {
    if (!p) continue;
    // Parents sit above their children.
    assert.ok(box(p).y + box(p).height <= box(id).y, `${p} is not above ${id}`);
  }
  for (const p of Object.keys(l.depth)) {
    const kids = Object.keys(l.parent).filter((c) => l.parent[c] === p);
    if (!kids.length) continue;
    // Siblings share one row.
    assert.equal(new Set(kids.map((k) => l.positions[k].y)).size, 1);
    // The parent is centered over its first and last child (rounding tolerance).
    const cx = (id: string) => box(id).x + box(id).width / 2;
    const mid = (cx(kids[0]) + cx(kids[kids.length - 1])) / 2;
    assert.ok(Math.abs(cx(p) - mid) <= 1, `${p} not centered over children`);
  }
  // Same depth = same y.
  const byDepth = new Map<number, Set<number>>();
  for (const [id, d] of Object.entries(l.depth))
    byDepth.set(d, (byDepth.get(d) ?? new Set()).add(l.positions[id].y));
  for (const ys of byDepth.values()) assert.equal(ys.size, 1);
  return l;
}

test("single root with two children: root on top, centered", () => {
  const l = check([
    { id: "lead" },
    { id: "a", parentId: "lead" },
    { id: "b", parentId: "lead" },
  ]);
  assert.deepEqual(l.roots, ["lead"]);
  assert.equal(l.positions.lead.y, 0);
  assert.ok(l.positions.a.x < l.positions.b.x);
});

test("multiple roots sit side by side at the top in input order", () => {
  const l = check([
    { id: "r1" },
    { id: "r2" },
    { id: "c1", parentId: "r1" },
    { id: "c2", parentId: "r2" },
  ]);
  assert.deepEqual(l.roots, ["r1", "r2"]);
  assert.equal(l.positions.r1.y, l.positions.r2.y);
  assert.ok(l.positions.r1.x + W < l.positions.r2.x);
});

test("wide fan-out: 30 children in one row, evenly spaced", () => {
  const nodes: OrgNode[] = [{ id: "root" }];
  for (let i = 0; i < 30; i++) nodes.push({ id: `c${i}`, parentId: "root" });
  const l = check(nodes, [], { gapX: 40 });
  const xs = Array.from({ length: 30 }, (_, i) => l.positions[`c${i}`].x);
  const steps = new Set(xs.slice(1).map((x, i) => x - xs[i]));
  assert.deepEqual([...steps], [W + 40]);
});

test("deep chain of 40: one card per row, all aligned", () => {
  const nodes: OrgNode[] = [{ id: "n0" }];
  for (let i = 1; i < 40; i++)
    nodes.push({ id: `n${i}`, parentId: `n${i - 1}` });
  const l = check(nodes);
  assert.equal(new Set(Object.values(l.positions).map((p) => p.x)).size, 1);
  assert.equal(l.depth.n39, 39);
});

test("orphans and cross-team parents become roots; the aside node stays out of the tree", () => {
  const l = check(
    [
      { id: "assistant" },
      { id: "lead" },
      { id: "dev", parentId: "lead" },
      { id: "orphan", parentId: "deleted-agent" },
      { id: "guest", parentId: "agent-in-other-team" },
    ],
    [],
    { aside: ["assistant"] },
  );
  assert.deepEqual(l.roots, ["lead", "orphan", "guest"]);
  assert.equal(l.depth.assistant, undefined);
  // Top-left, left of every tree card.
  assert.equal(l.positions.assistant.y, 0);
  for (const id of ["lead", "dev", "orphan", "guest"])
    assert.ok(l.positions.assistant.x + W <= l.positions[id].x);
});

test("cycles are cut deterministically and never loop", () => {
  const nodes = [
    { id: "a", parentId: "c" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "tail", parentId: "b" },
    { id: "self", parentId: "self" },
  ];
  const l = check(nodes);
  assert.equal(l.parent.a, null); // first cycle member in input order
  assert.equal(l.parent.self, null);
  assert.deepEqual(orgLayout(nodes).positions, l.positions);
  // A cycle above a node that is not on it is cut at its first member.
  const p = resolveParents([
    { id: "x", parentId: "y" },
    { id: "y", parentId: "z" },
    { id: "z", parentId: "y" },
  ]);
  assert.equal(p.y, null);
  assert.equal(p.z, "y");
  assert.equal(p.x, "y");
});

test("uneven subtrees: siblings spaced by subtree width, no overlaps, parents centered", () => {
  const nodes: OrgNode[] = [
    { id: "root" },
    { id: "big", parentId: "root" },
    { id: "small", parentId: "root" },
    { id: "lonely", parentId: "root" },
  ];
  for (let i = 0; i < 6; i++) nodes.push({ id: `b${i}`, parentId: "big" });
  for (let i = 0; i < 3; i++)
    nodes.push(
      { id: `bb${i}`, parentId: "b0" },
      { id: `bc${i}`, parentId: "b5" },
    );
  nodes.push({ id: "s0", parentId: "small" });
  const l = check(nodes);
  assert.ok(l.positions.small.x > l.positions.b5.x);
});

test("detailed cards get taller rows than compact ones; measured sizes are respected", () => {
  const nodes = [{ id: "r" }, { id: "c", parentId: "r" }];
  const compact = orgLayout(nodes, [], {
    defaultSize: { width: W, height: CARD_HEIGHT.compact },
    gapY: 80,
  });
  const detailed = check(nodes, [], {
    defaultSize: { width: W, height: CARD_HEIGHT.detailed },
    gapY: 80,
  });
  assert.equal(compact.positions.c.y, CARD_HEIGHT.compact + 80);
  assert.equal(detailed.positions.c.y, CARD_HEIGHT.detailed + 80);
  const mixed = check(
    [
      { id: "r" },
      { id: "a", parentId: "r" },
      { id: "b", parentId: "r" },
      { id: "g", parentId: "a" },
    ],
    [],
    {
      sizes: { a: { width: 300, height: 500 }, b: { width: 200, height: 100 } },
      gapY: 50,
    },
  );
  assert.equal(mixed.positions.g.y, mixed.positions.a.y + 500 + 50);
});

test("delegation edges are used only for agents without any parent", () => {
  const p = resolveParents(
    [
      { id: "lead" },
      { id: "dev" },
      { id: "rev", parentId: "lead" },
      { id: "solo", parentId: null },
    ],
    [
      { from: "lead", to: "dev", kind: "delegate" },
      { from: "dev", to: "rev", kind: "delegate" },
      { from: "dev", to: "solo", kind: "review" },
    ],
  );
  assert.equal(p.dev, "lead");
  assert.equal(p.rev, "lead"); // explicit parent wins over the edge
  assert.equal(p.solo, null); // only delegation edges count
});

test("stable ordering: identical input gives identical output; sibling order follows input", () => {
  const nodes = [
    { id: "m" },
    { id: "z", parentId: "m" },
    { id: "a", parentId: "m" },
  ];
  const one = orgLayout(nodes);
  const two = orgLayout(structuredClone(nodes));
  assert.deepEqual(one, two);
  assert.ok(one.positions.z.x < one.positions.a.x);
  assert.deepEqual(orgLayout([]).positions, {});
});

test("compact layout (wrap): wide leaf rows become staggered lines; invariants deliberately relaxed only for those rows", () => {
  // lead -> integrator -> 10 leaf workers, lead -> reviewer (leaf): like the pipeline team.
  const nodes: OrgNode[] = [
    { id: "lead" },
    { id: "int", parentId: "lead" },
    { id: "rev", parentId: "lead" },
    ...Array.from({ length: 10 }, (_, i) => ({ id: "w" + i, parentId: "int" })),
  ];
  const plain = orgLayout(nodes);
  const l = orgLayout(nodes, [], { wrap: 3 });
  const box = (id: string) => ({
    ...l.positions[id],
    width: W,
    height: CARD_HEIGHT.compact,
  });
  const ids = Object.keys(l.positions);
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      assert.ok(!overlap(box(ids[i]), box(ids[j])), `${ids[i]} / ${ids[j]}`);
  for (const [id, p] of Object.entries(l.parent))
    if (p) assert.ok(box(p).y + box(p).height <= box(id).y, `${p} above ${id}`);
  // Lines of at most 3, four lines, each lower line below the previous.
  const ys = [
    ...new Set(ids.filter((x) => x[0] === "w").map((x) => l.positions[x].y)),
  ].sort((a, b) => a - b);
  assert.equal(ys.length, 4);
  for (const y of ys)
    assert.ok(
      ids.filter((x) => x[0] === "w" && l.positions[x].y === y).length <= 3,
    );
  // Non-wrapped siblings (int, rev) still share one row; the integrator is centered over its first line.
  assert.equal(l.positions.int.y, l.positions.rev.y);
  const cx = (id: string) => box(id).x + W / 2;
  assert.ok(Math.abs(cx("int") - (cx("w0") + cx("w2")) / 2) <= 1);
  // Second-line connectors run through the gaps of the first line (no first-line card under them).
  for (const k of ["w3", "w4", "w5"])
    for (const f of ["w0", "w1", "w2"])
      assert.ok(
        cx(k) <= box(f).x || cx(k) >= box(f).x + W,
        `${k} line crosses ${f}`,
      );
  assert.ok(l.bounds.width < plain.bounds.width / 2);
  // fitOrgLayout: plain when it fits, else the widest wrap that fits.
  assert.equal(fitOrgLayout(nodes, [], {}, plain.bounds.width).wrap, null);
  const fitted = fitOrgLayout(nodes, [], {}, 1500);
  assert.ok(fitted.wrap! >= 2 && fitted.bounds.width <= 1500);
  assert.ok(
    orgLayout(nodes, [], { wrap: fitted.wrap! + 1 }).bounds.width > 1500,
  );
  // Deterministic.
  assert.deepEqual(orgLayout(nodes, [], { wrap: 3 }).positions, l.positions);
});
