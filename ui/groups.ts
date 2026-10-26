/** Pure canvas-grouping and hierarchy-navigation logic (no React, no DOM). */
export type Group = {
  id: string;
  name: string;
  agentIds: string[];
  collapsed: boolean;
};
type AgentLike = { id: string; parentId: string | null };
type EdgeLike = {
  id: string;
  from: string;
  to: string;
  kind: string;
  enabled: boolean;
};
export const groupNodeId = (g: Group | string) =>
  "group:" + (typeof g === "string" ? g : g.id);

/** Drop deleted agents, make membership exclusive (first group wins) and remove empty groups. */
export function sanitizeGroups(
  value: unknown,
  agentIds: readonly string[],
): Group[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set(agentIds);
  const taken = new Set<string>();
  const out: Group[] = [];
  for (const g of value) {
    if (!g || typeof g.id !== "string" || typeof g.name !== "string") continue;
    const members: string[] = (
      Array.isArray(g.agentIds) ? g.agentIds : []
    ).filter(
      (id: unknown): id is string =>
        typeof id === "string" && valid.has(id) && !taken.has(id),
    );
    if (!members.length) continue;
    members.forEach((id: string) => taken.add(id));
    out.push({
      id: g.id,
      name: g.name.trim().slice(0, 40) || "Group",
      agentIds: [...new Set(members)],
      collapsed: !!g.collapsed,
    });
  }
  return out;
}
/** Create a group from agents, removing them from any previous group. */
export function createGroup(
  groups: Group[],
  name: string,
  agentIds: string[],
  id: string,
): Group[] {
  const ids = [...new Set(agentIds)];
  if (!ids.length) return groups;
  const moved = groups
    .map((g) => ({
      ...g,
      agentIds: g.agentIds.filter((a) => !ids.includes(a)),
    }))
    .filter((g) => g.agentIds.length);
  return [
    ...moved,
    {
      id,
      name: name.trim().slice(0, 40) || "Group",
      agentIds: ids,
      collapsed: false,
    },
  ];
}
export const ungroup = (groups: Group[], id: string) =>
  groups.filter((g) => g.id !== id);
export const toggleGroup = (groups: Group[], id: string, collapsed?: boolean) =>
  groups.map((g) =>
    g.id === id ? { ...g, collapsed: collapsed ?? !g.collapsed } : g,
  );
export const setAllCollapsed = (groups: Group[], collapsed: boolean) =>
  groups.map((g) => ({ ...g, collapsed }));

/** Agents hidden by collapsed groups and the group each stands in for. */
export function hiddenAgents(groups: Group[]): Map<string, Group> {
  const map = new Map<string, Group>();
  for (const g of groups)
    if (g.collapsed) for (const a of g.agentIds) map.set(a, g);
  return map;
}
/**
 * Edges as drawn: endpoints inside a collapsed group are remapped to the group node,
 * edges internal to a collapsed group disappear and parallel duplicates are merged.
 */
export function visibleEdges(edges: EdgeLike[], groups: Group[]) {
  const hidden = hiddenAgents(groups);
  const map = (id: string) => {
    const g = hidden.get(id);
    return g ? groupNodeId(g) : id;
  };
  const seen = new Set<string>();
  const out: (EdgeLike & {
    source: string;
    target: string;
    grouped: boolean;
  })[] = [];
  for (const e of edges) {
    const source = map(e.from),
      target = map(e.to);
    if (source === target) continue;
    const grouped = source !== e.from || target !== e.to;
    const key = grouped ? `${source}>${target}>${e.kind}` : e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...e,
      id: grouped ? "g:" + key : e.id,
      source,
      target,
      grouped,
    });
  }
  return out;
}
export type GroupSummary = {
  members: number;
  processing: number;
  failed: number;
  attention: number;
};
export function summarizeGroup(
  g: Group,
  activity: {
    agentId: string;
    state: string;
    failedTaskIds: string[];
    interruptedTaskIds?: string[];
    blockedTaskIds?: string[];
    waitingTaskIds?: string[];
  }[],
): GroupSummary {
  let processing = 0,
    failed = 0,
    attention = 0;
  for (const id of g.agentIds) {
    const a = activity.find((x) => x.agentId === id);
    if (!a) continue;
    if (a.state === "processing") processing++;
    if (a.failedTaskIds.length) failed++;
    if (a.interruptedTaskIds?.length || a.blockedTaskIds?.length) attention++;
  }
  return { members: g.agentIds.length, processing, failed, attention };
}
/** Centre of the member positions, for placing a collapsed group node. */
export function groupCentre(
  g: Group,
  positions: Record<string, { x: number; y: number }>,
) {
  const pts = g.agentIds.map((id) => positions[id]).filter(Boolean);
  if (!pts.length) return { x: 0, y: 0 };
  return {
    x: Math.round(pts.reduce((s, p) => s + p.x, 0) / pts.length),
    y: Math.round(pts.reduce((s, p) => s + p.y, 0) / pts.length),
  };
}
/** Hierarchy navigation over `parentId`. Cycles are tolerated (never loop forever). */
export function relatives(agents: AgentLike[], id: string) {
  const me = agents.find((a) => a.id === id);
  const parent =
    me?.parentId &&
    me.parentId !== id &&
    agents.some((a) => a.id === me.parentId)
      ? me.parentId
      : null;
  const children = agents
    .filter((a) => a.parentId === id && a.id !== id)
    .map((a) => a.id);
  const siblings = agents
    .filter((a) => a.parentId === (me?.parentId ?? null) && a.id !== id)
    .map((a) => a.id);
  return { parent, children, siblings };
}
export function descendants(agents: AgentLike[], id: string): string[] {
  const out: string[] = [],
    seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const c of relatives(agents, queue.shift()!).children)
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
        queue.push(c);
      }
  }
  return out;
}
/** Next sibling in list order, wrapping; used for Alt+Left/Right navigation. */
export function stepSibling(agents: AgentLike[], id: string, dir: 1 | -1) {
  const me = agents.find((a) => a.id === id);
  if (!me) return null;
  const peers = agents.filter((a) => a.parentId === me.parentId);
  if (peers.length < 2) return null;
  const i = peers.findIndex((a) => a.id === id);
  return peers[(i + dir + peers.length) % peers.length].id;
}
