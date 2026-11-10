import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPolicyPath } from "./filesystem-policy.ts";
import { assert, type Agent, type Task } from "./model.ts";
import { hasRestrictions } from "./access.ts";
import { contains } from "./resources.ts";
import type { Store } from "./store.ts";

/**
 * The synchronous part of a task's filesystem scope: the folders a task that declares paths runs
 * in, taken from the agent's attachments. It refuses a declared path no attachment contains
 * (`resource_path_detached`) and attachments a directory-wide provider grant cannot represent.
 * `taskFilesystem` adds the checks that need the disk; readiness evaluation uses this one alone.
 */
export function taskScope(
  agent: Agent,
  declared: string[] | undefined,
): { cwd: string; workspaces: Agent["workspaces"] } | null {
  if (!declared?.length) return null;
  const workspaces: Agent["workspaces"] = [];
  for (const path of declared) {
    const attachment = agent.workspaces
      .filter((w) => contains(w.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    assert(
      attachment,
      "resource_path_detached",
      `${agent.name} no longer has a folder containing ${path}, which this task declares; attach it again or change the task`,
      409,
    );
    assert(
      canonicalPolicyPath(attachment.path) === attachment.path &&
        canonicalPolicyPath(path) === path,
      "workspace_changed",
      "Task folder target changed; reattach it and reassign the task",
      409,
    );
    // A directory-wide CLI grant cannot represent per-file or nested attachment overrides.
    assert(
      !hasRestrictions(attachment) &&
        !agent.workspaces.some(
          (w) => w !== attachment && contains(path, w.path),
        ),
      "provider_access_unsupported",
      "Task folder has access rules or nested attachments that the provider cannot enforce; assign unrestricted, disjoint directories instead",
      409,
    );
    workspaces.push({
      path,
      access: attachment.access,
      active: workspaces.length === 0,
    });
  }
  return { cwd: workspaces[0].path, workspaces };
}

/** Revalidate at launch: attachments, rules and symlink targets may have changed since assignment. */
export async function taskFilesystem(
  store: Store,
  agent: Agent,
  taskId?: string,
  fallbackPaths?: string[],
) {
  if (!taskId) return null;
  const task = store.get<Task>("task", taskId);
  assert(
    task.agentId === agent.id,
    "task_agent",
    "Task belongs to another agent",
    403,
  );
  const declared = task.resourcePaths?.length
    ? task.resourcePaths
    : fallbackPaths;
  if (!declared?.length) return null;
  for (const path of declared) {
    const attachment = agent.workspaces
      .filter((w) => contains(w.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    assert(
      attachment,
      "resource_path_detached",
      `${agent.name} no longer has a folder containing ${path}, which this task declares; attach it again or change the task`,
      409,
    );
    assert(
      (await realpath(attachment.path)) === attachment.path &&
        (await realpath(path)) === path,
      "workspace_changed",
      "Task folder target changed; reattach it and reassign the task",
      409,
    );
    assert(
      (await stat(path)).isDirectory(),
      "resource_path_not_directory",
      `Task resource paths must be directories to isolate provider access; "${path}" is a file`,
      400,
    );
  }
  return taskScope(agent, declared);
}

/**
 * Shared scratch locations a Codex permission profile (`:minimal`) leaves readable and writable
 * on top of the task roots. Probed on macOS with Codex 0.167: `/private/tmp` and `/private/var/tmp`
 * (hence `/tmp`) are open to read and write, so they would be a side channel between tasks and to
 * every other program's scratch files. An explicit `deny` loses to a more specific task root, so a
 * root that lives under one of them keeps working.
 */
export function codexScratchDenials(platform = process.platform) {
  if (platform === "darwin") return ["/private/tmp", "/private/var/tmp"];
  if (platform === "linux") return ["/tmp", "/var/tmp"];
  return [];
}

/**
 * A scoped Codex launch needs an OS sandbox that restricts READS. Verified model-free on macOS
 * (seatbelt via `codex sandbox`, test/provider-boundary-probe.test.ts). Linux (bubblewrap) and
 * Windows (MXC; the legacy sandbox needs broad read access) were not verified on a real host, so a
 * scoped launch there is refused instead of silently running with whatever the sandbox does.
 * `AGENTTEAM_UNVERIFIED_SANDBOX=1` is the explicit opt-in for hosts someone has verified.
 */
export function codexReadBoundaryIssue(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform === "darwin" || env.AGENTTEAM_UNVERIFIED_SANDBOX === "1")
    return null;
  return `Task-scoped Codex runs need a read-restricting sandbox, which AgentTeam has verified only on macOS; on ${platform} it cannot confirm that files outside the task folders are unreadable. Set AGENTTEAM_UNVERIFIED_SANDBOX=1 to run anyway after verifying the sandbox yourself, or use a macOS host.`;
}

/** Exact read AND write roots. No :root, :workspace or implicit writable temp grants. */
export function codexTaskPermissions(
  workspaces: Agent["workspaces"],
  tools: string[],
  platform = process.platform,
  /** Read-only roots needed to execute Node (src/node-runtime.ts); never added over a task root. */
  extraReadRoots: string[] = [],
) {
  const writable =
    tools.includes("read") &&
    (tools.includes("write") || tools.includes("edit"));
  const filesystem: Record<string, string> = { ":minimal": "read" };
  for (const path of codexScratchDenials(platform)) filesystem[path] = "deny";
  if (tools.includes("read"))
    for (const ws of workspaces) {
      filesystem[ws.path] =
        writable && ws.access === "write" ? "write" : "read";
      filesystem[join(ws.path, ".git")] = "deny";
    }
  if (tools.includes("read"))
    for (const root of extraReadRoots) filesystem[root] ??= "read";
  // TOML inline tables, not JSON objects. JSON quoting is valid for these individual TOML strings.
  const table = `{${Object.entries(filesystem)
    .map(
      ([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`,
    )
    .join(",")}}`;
  return [
    'default_permissions="agentteam-task"',
    `permissions.agentteam-task.filesystem=${table}`,
    "permissions.agentteam-task.network.enabled=false",
    "agents.enabled=false",
    "project_doc_max_bytes=0",
    ...(platform === "win32" ? ['windows.sandbox="mxc"'] : []),
  ];
}
