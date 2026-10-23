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
// integrator, which keeps its write access. Provider commands receive the task's declared roots;
// direct Claude and Codex launches apply their supported directory-level restrictions. They cannot
// enforce per-file AgentTeam rules, so scoped tasks using those rules are refused. The previous
// write access is recorded on the worktree record (`sourceAccess`) and restored when the worker's
// last such worktree is removed or archived, or when a path-isolated assignment needs the checkout
// writable again.
import { assert, type Agent } from "./model.ts";
import { decideBoth } from "./access.ts";
import { contains } from "./resources.ts";
import type { Store } from "./store.ts";
import type { WorktreeRecord } from "./worktrees.ts";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function pathKey(path: string) {
  if (process.platform === "win32") {
    const unprefixed = path
      .replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/, "")
      .replaceAll("/", "\\");
    const normalized = resolve(unprefixed),
      withoutTrailingSeparator = normalized.replace(/\\+$/, "");
    return (
      /^[a-z]:$/i.test(withoutTrailingSeparator)
        ? `${withoutTrailingSeparator}\\`
        : withoutTrailingSeparator
    ).toLowerCase();
  }
  return resolve(path);
}

function samePath(a: string, b: string) {
  return pathKey(a) === pathKey(b);
}

function containsPath(root: string, path: string) {
  const rel = relative(pathKey(root), pathKey(path));
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !/^\.\.[\\/]/.test(rel))
  );
}

export type ProviderWorkspaceRoot = {
  path: string;
  access: "read" | "write";
  active: boolean;
  /** Native provider tools cannot represent AgentTeam's per-file rules. */
  restricted: boolean;
};

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
 * Exact provider roots for a task, or null when it declares none. Keep these at the declared
 * directories themselves: using their enclosing attachments would expose sibling resources the
 * task does not hold a lease for. A detached or newly restricted path refuses the launch.
 */
export function taskProviderRoots(
  store: Store,
  agent: Agent,
  taskId: string | undefined,
): ProviderWorkspaceRoot[] | null {
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
  const files = declared.filter(
    (p) => existsSync(p) && !statSync(p).isDirectory(),
  );
  assert(
    !files.length,
    "resource_path_not_directory",
    `Task resource paths must be directories to isolate provider access; "${files[0]}" is a file`,
    400,
  );
  return declared.map((path) => {
    const workspace = agent.workspaces
      .filter((w) => contains(w.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    assert(
      existsSync(workspace.path) &&
        samePath(realpathSync(workspace.path), workspace.path),
      "workspace_changed",
      `Attached folder ${workspace.path} moved or now resolves through a symlink; reattach it`,
      409,
    );
    if (existsSync(path))
      assert(
        samePath(realpathSync(path), path),
        "resource_path_changed",
        `Task resource folder ${path} now resolves through a symlink or has moved`,
        409,
      );
    const rel = relative(workspace.path, path).replace(/\\/g, "/");
    const decision = decideBoth(workspace, rel, rel);
    assert(
      decision.access !== "none",
      "resource_path_access_changed",
      `${agent.name} no longer has access to ${path}: ${decision.reason}`,
      403,
    );
    return {
      path,
      access:
        workspace.access === "write" && decision.access === "write"
          ? ("write" as const)
          : ("read" as const),
      active: false,
      restricted: !!workspace.explicitOnly || !!workspace.rules?.length,
    };
  });
}

/** Create requested output directories just before dispatch; their paths are already leased. */
export async function prepareTaskResourceFolders(
  store: Store,
  agent: Agent,
  taskId: string,
) {
  const task = store
    .list<{ id: string; resourcePaths?: string[] }>("task")
    .find((t) => t.id === taskId);
  for (const path of task?.resourcePaths ?? []) {
    const workspace = agent.workspaces
      .filter((w) => contains(w.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    assert(
      workspace,
      "resource_path_detached",
      `${agent.name} no longer has a folder containing ${path}, which this task declares; attach it again or change the task`,
      409,
    );
    try {
      const info = await stat(path);
      assert(
        info.isDirectory(),
        "resource_path_not_directory",
        `Task resource paths must be directories; "${path}" is a file`,
        400,
      );
      assert(
        samePath(await realpath(path), path),
        "resource_path_changed",
        `Task resource folder ${path} now resolves through a symlink or has moved`,
        409,
      );
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const rel = relative(workspace.path, path).replace(/\\/g, "/");
    const access = decideBoth(workspace, rel, rel).access;
    assert(
      workspace.access === "write" && access === "write",
      "resource_path_read_only",
      `Cannot create ${path}; ${agent.name} needs write access to that folder`,
      403,
    );
    const workspaceReal = await realpath(workspace.path);
    let parent = dirname(path);
    for (;;) {
      try {
        const parentReal = await realpath(parent);
        assert(
          containsPath(workspaceReal, parentReal),
          "resource_path_changed",
          `The parent of ${path} now resolves outside ${workspace.path}`,
          409,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const next = dirname(parent);
        assert(
          next !== parent && contains(workspace.path, next),
          "resource_path_changed",
          `No safe attached parent exists for ${path}`,
          409,
        );
        parent = next;
      }
    }
    await mkdir(path, { recursive: true });
    assert(
      samePath(await realpath(path), path),
      "resource_path_changed",
      `Task resource folder ${path} resolved through a symlink after creation`,
      409,
    );
  }
}
