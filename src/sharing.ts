import { relative } from "node:path";
import { accessSummary, decide, type AccessLevel } from "./access.ts";
import type { Agent } from "./model.ts";
import { contains, overlaps, type Resource } from "./resources.ts";
import type { TeamService } from "./service.ts";

/** Shown wherever locks are described: AgentTeam can only coordinate work it launches itself. */
export const EXTERNAL_NOTICE =
  "AgentTeam locks are cooperative and cover only work AgentTeam launches (tasks, chat runs, Git actions). External editors, interactive CLI sessions and native apps are outside this enforcement: they can write to leased paths at any time.";

export type SharedResource = {
  /** The overlapping path (the deeper of two attached folders). */
  path: string;
  /** Named resource covering this path, if any. */
  resource: string | null;
  kind: "write-write" | "read-write" | "read-only";
  /** Whether AgentTeam serializes the agents on this path (always, unless a workflow shares it). */
  serialized: boolean;
  agents: {
    agentId: string;
    name: string;
    workspace: string;
    access: AccessLevel;
    summary: string;
    priority: number;
  }[];
  /** Exact attached-folder pairs that overlap and cause lease conflicts. */
  pairs: { a: string; b: string; agentA: string; agentB: string }[];
  note: string;
};

/**
 * Resources attached to more than one agent, grouped by the exact overlapping path. Exclusion
 * rules are applied: an agent that cannot see the overlap does not count as sharing it.
 */
export function sharedResources(service: TeamService): SharedResource[] {
  const store = service.store;
  const agents = store.list<Agent>("agent");
  const named = store.list<Resource>("resource");
  const groups = new Map<string, SharedResource>();
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++)
      for (const wa of agents[i].workspaces)
        for (const wb of agents[j].workspaces) {
          if (!overlaps(wa.path, wb.path)) continue;
          const path = contains(wa.path, wb.path) ? wb.path : wa.path;
          const level = (ws: Agent["workspaces"][number]) =>
            decide(ws, relative(ws.path, path).replace(/\\/g, "/")).access;
          const la = level(wa),
            lb = level(wb);
          if (la === "none" || lb === "none") continue; // an exclusion removes the overlap for that agent
          const g = groups.get(path) ?? {
            path,
            resource: named.find((r) => overlaps(r.path, path))?.name ?? null,
            kind: "read-only" as const,
            serialized: true,
            agents: [],
            pairs: [],
            note: "",
          };
          for (const [agent, ws, lv] of [
            [agents[i], wa, la],
            [agents[j], wb, lb],
          ] as const)
            if (!g.agents.some((x) => x.agentId === agent.id))
              g.agents.push({
                agentId: agent.id,
                name: agent.name,
                workspace: ws.path,
                access: lv,
                summary: accessSummary(ws),
                priority: service.resources.priority(agent.id),
              });
          g.pairs.push({
            a: wa.path,
            b: wb.path,
            agentA: agents[i].name,
            agentB: agents[j].name,
          });
          groups.set(path, g);
        }
  for (const g of groups.values()) {
    const writers = g.agents.filter((a) => a.access === "write").length;
    g.kind =
      writers > 1 ? "write-write" : writers === 1 ? "read-write" : "read-only";
    g.note =
      g.kind === "write-write"
        ? "Several agents can write here; AgentTeam runs only one at a time unless a workflow shares this resource for guided parallel work."
        : g.kind === "read-write"
          ? "One agent writes while others only read; leases still keep their runs separate."
          : "Every agent here is read-only; leases still serialize their runs (safe default).";
  }
  return [...groups.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Agents currently driven outside the cooperative lock system (interactive CLI or native app). */
export function externalDrivers(service: TeamService) {
  return service.ownership
    .list()
    .filter((o) => o.holder === "cli" || o.holder === "native")
    .map((o) => {
      const agent = service.store.get<Agent>("agent", o.id);
      return {
        agentId: agent.id,
        name: agent.name,
        holder: o.holder,
        label:
          o.holder === "cli" ? "Interactive CLI session" : "Native app session",
        paths: agent.workspaces.map((w) => w.path),
        warning:
          "Outside AgentTeam's cooperative lock enforcement: it can edit these folders while AgentTeam work is also running.",
      };
    });
}
