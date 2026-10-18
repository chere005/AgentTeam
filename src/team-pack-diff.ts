// Pure three-way configuration diff for explicit team-pack updates.
//   old   = the pack version that was installed (its stored base)
//   next  = the new pack version
//   local = the live configuration as the user may have edited it
// A field takes the new pack value only when the user never changed it (local == old). If both the
// pack and the user changed it differently the change is a conflict that needs an explicit
// resolution. Nothing here writes anything.
import { stableStringify } from "./team-pack-manifest.ts";

export type Fields = Record<string, unknown>;
export type View = {
  agents: Record<string, Fields | undefined>;
  edges: Record<string, Fields | undefined>;
  rules: Record<string, Fields | undefined>;
};
export type Resolution = "keep-local" | "take-pack";
export type ChangeStatus = "apply" | "conflict" | "keep-local";
export type Change = {
  /** Stable path used for resolutions, e.g. agent:impl:instructions. */
  id: string;
  entity: "agent" | "edge" | "rule";
  key: string;
  label: string;
  field?: string;
  action: "add" | "update" | "remove";
  status: ChangeStatus;
  reason?: string;
  /** Display strings (bounded); the raw values are re-read from the views when applying. */
  old?: string;
  new?: string;
  local?: string;
};

const same = (a: unknown, b: unknown) =>
  (a === undefined && b === undefined) ||
  (a !== undefined &&
    b !== undefined &&
    stableStringify(a) === stableStringify(b));
export type Outcome = "none" | "apply" | "keep-local" | "conflict";
export function threeWay(o: unknown, n: unknown, l: unknown): Outcome {
  if (same(n, l)) return "none";
  if (same(o, n)) return "keep-local";
  if (same(o, l)) return "apply";
  return "conflict";
}
const show = (v: unknown) => {
  if (v === undefined) return "(absent)";
  const s = typeof v === "string" ? v : stableStringify(v);
  return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
};

export function computeDiff(
  old: View,
  next: View,
  local: View,
  labels: { agent: (key: string) => string },
): Change[] {
  const changes: Change[] = [];
  // Agents that exist (or will exist after adds) so dependent edges/rules can be resolved.
  const present = new Set<string>();
  for (const k of new Set([
    ...Object.keys(old.agents),
    ...Object.keys(next.agents),
  ])) {
    if (local.agents[k]) present.add(k);
    else if (old.agents[k] === undefined && next.agents[k]) present.add(k);
  }

  for (const key of union(old.agents, next.agents)) {
    const o = old.agents[key],
      n = next.agents[key],
      l = local.agents[key];
    const label = labels.agent(key);
    if (!o && n) {
      changes.push({
        id: `agent:${key}`,
        entity: "agent",
        key,
        label,
        action: "add",
        status: "apply",
        new: show(n),
      });
      continue;
    }
    if (o && !n) {
      if (l)
        changes.push({
          id: `agent:${key}`,
          entity: "agent",
          key,
          label,
          action: "remove",
          status: "keep-local",
          reason: "removed-by-pack-kept",
          old: show(o),
          local: show(l),
        });
      continue;
    }
    if (!o || !n) continue;
    if (!l) {
      if (!same(o, n))
        changes.push({
          id: `agent:${key}`,
          entity: "agent",
          key,
          label,
          action: "update",
          status: "keep-local",
          reason: "deleted-locally",
        });
      continue;
    }
    for (const f of new Set([
      ...Object.keys(o),
      ...Object.keys(n),
      ...Object.keys(l),
    ])) {
      const out = threeWay(o[f], n[f], l[f]);
      if (out === "none") continue;
      changes.push({
        id: `agent:${key}:${f}`,
        entity: "agent",
        key,
        label,
        field: f,
        action: "update",
        status: out,
        old: show(o[f]),
        new: show(n[f]),
        local: show(l[f]),
      });
    }
  }

  const whole = (
    entity: "edge" | "rule",
    o: View["edges"],
    n: View["edges"],
    l: View["edges"],
  ) => {
    for (const key of union(o, n, l)) {
      const [ov, nv, lv] = [o[key], n[key], l[key]];
      const out = threeWay(ov, nv, lv);
      if (out === "none") continue;
      const ends = endpoints(key, entity);
      const missing = ends.filter((e) => !present.has(e));
      const action: Change["action"] =
        nv === undefined
          ? "remove"
          : lv === undefined || ov === undefined
            ? "add"
            : "update";
      changes.push({
        id: `${entity}:${key}`,
        entity,
        key,
        label: `${entity === "edge" ? "Connection" : "Rule"} ${ends.map(labels.agent).join(" → ")}`,
        action,
        status: missing.length && out !== "keep-local" ? "keep-local" : out,
        ...(missing.length && out !== "keep-local"
          ? { reason: "agent-missing" }
          : {}),
        old: show(ov),
        new: show(nv),
        local: show(lv),
      });
    }
  };
  whole("edge", old.edges, next.edges, local.edges);
  whole("rule", old.rules, next.rules, local.rules);
  return changes;
}

function union(...maps: Record<string, unknown>[]) {
  return [...new Set(maps.flatMap((m) => Object.keys(m)))];
}
/** Agent keys an edge/rule key refers to. */
export function endpoints(key: string, entity: "edge" | "rule"): string[] {
  if (entity === "edge") {
    const [pair] = key.split(":");
    const [from, to] = pair.split(">");
    return [from, to];
  }
  const [agent, target] = key.split("|");
  return target ? [agent, target] : [agent];
}
