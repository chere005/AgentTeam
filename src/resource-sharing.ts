import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { Agent, Workspace } from "./model.ts";
import { decide, normalizeRelPath } from "./access.ts";

type Sharing = {
  scope: "nobody" | "selected" | "team" | "all";
  agentIds?: string[];
};

export function sharingAllows(
  grant: Sharing | undefined,
  agentId: string,
  owner: Agent,
  recipient: Agent,
) {
  if (!grant || grant.scope === "nobody") return false;
  if (grant.scope === "all") return true;
  if (grant.scope === "team")
    return (owner.teamId ?? "main") === (recipient.teamId ?? "main");
  return (grant.agentIds ?? []).includes(agentId);
}

function grantFor(workspace: Workspace, rel: string): Sharing | undefined {
  const matching = (workspace.shareRules ?? [])
    .filter((rule) => {
      const path = rule.path.replace(/\\/g, "/").replace(/^\.\//, "");
      return rel === path || rel.startsWith(path + "/");
    })
    .sort((a, b) => b.path.length - a.path.length);
  return matching[0] ?? workspace.sharing;
}

function covers(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function reads(agent: Agent, path: string) {
  let actual: string;
  try {
    actual = realpathSync(path);
  } catch {
    return false;
  }
  for (const workspace of agent.workspaces) {
    let root: string;
    try {
      root = realpathSync(workspace.path);
    } catch {
      continue;
    }
    if (!covers(root, actual)) continue;
    const rel = relative(root, actual).replace(/\\/g, "/");
    if (
      decide(workspace, rel).access === "read" ||
      decide(workspace, rel).access === "write"
    )
      return true;
  }
  return false;
}

/** A resource may cross an agent handoff only when the recipient has read access or an explicit share grant. */
export function mayShareResource(
  owner: Agent,
  recipient: Agent,
  rawPath: string,
) {
  const requestedPath = resolve(rawPath);
  for (const workspace of owner.workspaces) {
    let root: string, path: string;
    try {
      root = realpathSync(workspace.path);
      path = realpathSync(requestedPath);
    } catch {
      continue;
    }
    if (!covers(root, path)) continue;
    const rel = relative(root, path).replace(/\\/g, "/");
    const sourceAccess = decide(workspace, rel).access;
    if (sourceAccess !== "read" && sourceAccess !== "write") continue;
    if (reads(recipient, path)) return true;
    if (sharingAllows(grantFor(workspace, rel), recipient.id, owner, recipient))
      return true;
  }
  return false;
}

export function mayShareExcerpt(
  owner: Agent,
  recipient: Agent,
  workspacePath: string,
  relativePath: string,
) {
  const rel = normalizeRelPath(relativePath);
  const workspace = owner.workspaces.find(
    (candidate) => resolve(candidate.path) === resolve(workspacePath),
  );
  if (!workspace || decide(workspace, rel).access === "none") return false;
  return mayShareResource(owner, recipient, join(workspace.path, rel));
}
