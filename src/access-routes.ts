import { z } from "zod";
import { accessReport, accessSummary } from "./access.ts";
import { explainWaiting, type InspectorContext } from "./inspector.ts";
import { type Agent } from "./model.ts";
import { buildQueue, queueReasons, resourceBusyReason } from "./queue.ts";
import { canonicalDeclaredPaths } from "./declared-paths.ts";
import {
  EXTERNAL_NOTICE,
  externalDrivers,
  sharedResources,
} from "./sharing.ts";
import { overlaps, type Lease } from "./resources.ts";
import type { TeamService } from "./service.ts";
import type { WorktreeService } from "./worktrees.ts";

/**
 * Effective access, shared resources, queue and parallel-work API (behind the bearer-token check):
 *   GET  /resources/overview                 leases (owner/scope/draining), unified queue with reasons,
 *                                            shared resources with exact overlapping paths, external drivers
 *   GET  /agents/:id/access                  per-folder allowed/denied paths with reasons + lock scope
 *   POST /resources/launch-review            {agentId, resourcePaths?, workflowId?} what a task would reserve/wait for
 *   POST /resources/leases/:id/force-release {confirmStopped: true, reason}
 *   GET  /workflows/:id/parallel             assignments, changed files, conflicts, integration step
 *   POST /workflows/:id/parallel/assign      disjoint paths / worktrees + integration task
 * Returns undefined when the path is not one of these routes.
 */
export function accessAgentView(service: TeamService, agentId: string) {
  const agent = service.store.get<Agent>("agent", agentId);
  const ownership = service.ownership.view(agentId);
  const external = ownership.holder === "cli" || ownership.holder === "native";
  return {
    agentId,
    name: agent.name,
    workspaces: agent.workspaces.map((w) => ({
      ...accessReport(w),
      summary: accessSummary(w),
      active: w.active,
      rules: w.rules ?? [],
    })),
    lock: {
      default:
        "Every attached folder is leased while AgentTeam runs this agent, unless a task declares the paths it needs.",
      holds: service.store
        .list<Lease>("lease")
        .filter((l) => l.agentId === agentId)
        .map((l) => ({
          id: l.id,
          scope: l.scope ?? "attached-folders",
          paths: l.paths,
          draining: l.draining ?? null,
        })),
    },
    external: {
      outsideLocks: external,
      holder: ownership.holder,
      notice: EXTERNAL_NOTICE,
    },
  };
}
export async function accessRoute(
  service: TeamService,
  ctx: InspectorContext,
  deps: { worktrees?: WorktreeService },
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  const dec = (v: string) => decodeURIComponent(v);
  const store = service.store;
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "/resources/overview") {
    const name = (id: string) =>
      store.list<Agent>("agent").find((a) => a.id === id)?.name ?? id;
    const taskIds = new Set(
      store.list<{ id: string }>("task").map((t) => t.id),
    );
    return {
      data: {
        leases: store.list<Lease>("lease").map((l) => ({
          ...l,
          agent: name(l.agentId),
          kind: taskIds.has(l.id)
            ? "task"
            : l.id.startsWith("git:")
              ? "git"
              : "chat",
          scope: l.scope ?? "attached-folders",
          livePids: service.resources.livePids(l),
        })),
        draining: service.locks.view(),
        queue: buildQueue(service).map((e) => ({
          ...e,
          agent: name(e.agentId),
          reasons:
            e.kind === "task"
              ? explainWaiting(service, ctx, { taskId: e.id }).reasons
              : [
                  ...(resourceBusyReason(service, e)
                    ? [resourceBusyReason(service, e)!]
                    : []),
                  ...queueReasons(service, e.id),
                ],
        })),
        shared: sharedResources(service),
        external: {
          notice: EXTERNAL_NOTICE,
          drivers: externalDrivers(service),
        },
        fairness:
          "One queue orders tasks and chat runs: Preempt first, then priority plus one point per five seconds waiting. A request waiting only for a lease reserves its paths against lower-ranked requests, so sustained load cannot starve it. Running work is never interrupted.",
      },
    };
  }
  if (method === "GET" && (m = path.match(/^\/agents\/([^/]+)\/access$/)))
    return { data: accessAgentView(service, dec(m[1])) };
  if (method === "POST" && path === "/resources/launch-review") {
    const data = z
      .object({
        agentId: z.string(),
        workflowId: z.string().nullable().optional(),
        resourcePaths: z.array(z.string().min(1).max(1000)).max(50).optional(),
      })
      .strict()
      .parse(await readBody());
    const agent = store.get<Agent>("agent", data.agentId);
    const declared = canonicalDeclaredPaths(agent, data.resourcePaths);
    const reserved = declared?.length
      ? { scope: "declared" as const, paths: declared }
      : {
          scope: "attached-folders" as const,
          paths: agent.workspaces.map((w) => w.path),
        };
    const probe = "launch-review";
    const conflicts = service.resources.conflicts(
      agent.id,
      data.workflowId ?? null,
      probe,
    );
    const view = accessAgentView(service, agent.id);
    return {
      data: {
        agent: { id: agent.id, name: agent.name },
        workspaces: view.workspaces,
        external: view.external,
        reserves: reserved,
        // Without declared paths the agent leases every attached folder (safe default).
        note:
          reserved.scope === "declared"
            ? "Only the declared paths are leased; other attached folders stay free for other agents."
            : "No paths declared: every attached folder is leased for the run (safe default).",
        priority: service.resources.priority(agent.id),
        wouldWait: conflicts.length > 0,
        holders: conflicts.map((l) => ({
          leaseId: l.id,
          agent: store.get<Agent>("agent", l.agentId).name,
          overlaps: reserved.paths.flatMap((p) =>
            l.paths
              .filter((o) => overlaps(p, o))
              .map((o) => ({ mine: p, theirs: o })),
          ),
        })),
        queueDepth: buildQueue(service).length,
      },
    };
  }
  if (
    method === "POST" &&
    (m = path.match(/^\/resources\/leases\/([^/]+)\/force-release$/))
  )
    return { data: service.locks.forceRelease(dec(m[1]), await readBody()) };
  if (
    method === "GET" &&
    (m = path.match(/^\/workflows\/([^/]+)\/parallel$/))
  ) {
    store.get("workflow", dec(m[1]));
    return { data: service.parallel.view(dec(m[1])) };
  }
  if (
    method === "POST" &&
    (m = path.match(/^\/workflows\/([^/]+)\/parallel\/assign$/))
  ) {
    store.get("workflow", dec(m[1]));
    await service.parallel.assign(dec(m[1]), await readBody(), deps);
    return { data: service.parallel.view(dec(m[1])), status: 201 };
  }
  return undefined;
}
