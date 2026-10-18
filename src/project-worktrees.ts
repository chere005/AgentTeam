// Worktrees of pipeline projects whose worker agents are shared by several projects of one team.
// The worktree service's own attach makes the new worktree the agent's ACTIVE folder and (by
// default) drops the source checkout from the agent, so a second project's preparation would
// either fail (source gone) or switch the folder an earlier project's queued worker runs in.
// Here the worktree is added as an extra write folder instead; the worker task declares the
// worktree as its resource path, which leases only that folder and selects it as the task's
// working directory (TeamService.launchPlan with the task id).
//
// The shared checkout the worktree branches from stays attached (a later project's preparation
// branches from it, change detection snapshots it) but READ-ONLY for that worker while it has a
// worktree of it: AgentTeam-mediated writes as the worker there (Git panel, staging, commands,
// path assignments) are refused rather than only detected. The integration step runs on the
// integrator, which keeps its write access. Provider processes run in the worktree; per-folder OS
// sandboxing is not implemented, so writes a provider makes elsewhere on its own are still only
// detected by the parallel change check (every attached checkout is snapshotted) and routed to
// the planner. The previous write access is recorded on the worktree record (`sourceAccess`) and
// restored when the worker's last such worktree is removed or archived, or when a path-isolated
// assignment needs the checkout writable again.
import { assert, type Agent } from "./model.ts";
import { contains } from "./resources.ts";
import type { Store } from "./store.ts";
import type { WorktreeRecord } from "./worktrees.ts";

/** A worker's own worktree that turned its source checkout read-only for that worker. */
export type ProjectWorktreeRecord = WorktreeRecord & {
  sourceAccess?: "write";
};

export function addWorktreeFolder(
  store: Store,
  agentId: string,
  worktreeId: string,
) {
  store.transaction(() => {
    const rec = store.get<ProjectWorktreeRecord>("worktree", worktreeId);
    const agent = store.get<Agent>("agent", agentId);
    const source = agent.workspaces.find(
      (w) => w.path === rec.source && w.access === "write",
    );
    let workspaces = agent.workspaces.map((w) =>
      w === source ? { ...w, access: "read" as const } : w,
    );
    if (!workspaces.some((w) => w.path === rec.path))
      workspaces = [
        ...workspaces,
        {
          path: rec.path,
          access: "write" as const,
          active: !workspaces.some((w) => w.active),
        },
      ];
    store.put("agent", { ...agent, workspaces });
    // Remember a downgrade made now, or one an earlier worktree of the same source made.
    const downgraded =
      !!source ||
      store
        .list<ProjectWorktreeRecord>("worktree")
        .some(
          (r) =>
            r.id !== rec.id &&
            r.ownerId === agentId &&
            r.source === rec.source &&
            r.sourceAccess === "write",
        );
    store.put("worktree", {
      ...rec,
      status: "attached",
      ownerId: agentId,
      keepSource: true,
      attachError: undefined,
      ...(downgraded ? { sourceAccess: "write" as const } : {}),
    });
    store.emit("agent.updated", agentId, {
      worktreeAdded: rec.path,
      ...(source ? { sourceReadOnly: rec.source } : {}),
    });
    store.emit("workspace.worktree_attached", agentId, { path: rec.path });
  });
}

/**
 * Give `agentId` write access to `source` back where addWorktreeFolder took it away, once no
 * attached worktree of that source owned by the agent (other than `except`) still needs the
 * protection, or at once with `force` (a path-isolated assignment writes the checkout itself).
 * Returns whether the access changed. Joins the caller's transaction.
 */
export function restoreSourceWrite(
  store: Store,
  agentId: string,
  source: string,
  opts: { force?: boolean; except?: string } = {},
) {
  return store.transaction(() => {
    const records = store
      .list<ProjectWorktreeRecord>("worktree")
      .filter(
        (r) =>
          r.ownerId === agentId &&
          r.source === source &&
          r.sourceAccess === "write",
      );
    if (!records.length) return false;
    if (
      !opts.force &&
      records.some((r) => r.id !== opts.except && r.status === "attached")
    )
      return false;
    for (const r of records) {
      const { sourceAccess: _s, ...rest } = r;
      store.put("worktree", rest);
    }
    const agent = store.get<Agent>("agent", agentId);
    const ws = agent.workspaces.find((w) => w.path === source);
    if (!ws || ws.access === "write") return false;
    store.put("agent", {
      ...agent,
      workspaces: agent.workspaces.map((w) =>
        w === ws ? { ...w, access: "write" as const } : w,
      ),
    });
    store.emit("agent.updated", agentId, { sourceWritable: source });
    return true;
  });
}

/**
 * Working folder of a task: the attached folder that contains every path the task declares (the
 * active folder when it does, else the most specific one), or null to keep the agent's active
 * folder when the task declares nothing. A worker shared by two projects thus runs each project's
 * task in that project's worktree or checkout, whichever folder was attached last. Paths spread
 * over several folders run in the active folder when it holds one of them, else in the folder of
 * the first path. A declared path outside every attached folder (its folder was detached or the
 * worktree removed after the task was created) refuses the launch: falling back to the active
 * folder would run the task in a folder its lease does not cover, possibly another project's.
 */
export function taskWorkingFolder(
  store: Store,
  agent: Agent,
  taskId: string | undefined,
): string | null {
  if (!taskId) return null;
  const task = store
    .list<{ id: string; resourcePaths?: string[] }>("task")
    .find((t) => t.id === taskId);
  const declared = task?.resourcePaths ?? [];
  if (!declared.length) return null;
  const missing = declared.filter(
    (p) => !agent.workspaces.some((w) => contains(w.path, p)),
  );
  assert(
    !missing.length,
    "resource_path_detached",
    `${agent.name} no longer has a folder containing ${missing[0]}, which this task declares; attach it again or change the task`,
    409,
  );
  const holds = (root: string) => declared.every((p) => contains(root, p));
  const active = agent.workspaces.find((w) => w.active);
  if (active && holds(active.path)) return active.path;
  const all = agent.workspaces
    .filter((w) => holds(w.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (all) return all.path;
  if (active && declared.some((p) => contains(active.path, p)))
    return active.path;
  return agent.workspaces
    .filter((w) => contains(w.path, declared[0]))
    .sort((a, b) => b.path.length - a.path.length)[0].path;
}
