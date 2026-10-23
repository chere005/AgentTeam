// Team project profiles: what a TEAM (the persistent org of agents) can be assigned as a PROJECT.
//
// A team template may carry a `project` section (schema v3, src/teams.ts). When the template is
// inserted, it becomes a `team-profile` entity keyed by the new team's id that records, with live
// agent ids, which agent plays which project role (planner, implement workers, adjudicator, lead,
// Wolfram validators, ...), how the project workspace is attached to each agent, the team settings
// chosen at insert (worker caps, efforts) and the model expectations used for verification.
// Projects (src/projects.ts) are then created against these existing agents, any number of times.
// Teams without a profile (Main, hand-built teams, older templates) take free-form projects.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AppError, assert, type Agent, type Session } from "./model.ts";
import type { ModelCheck, ModelExpectation } from "./samples.ts";
import type { TeamTemplate } from "./teams.ts";
import type { Store } from "./store.ts";
import { filesystemPolicy } from "./filesystem-policy.ts";

export const PROJECT_TYPES = [
  "pipeline",
  "wolfram-validated",
  "free-form",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  pipeline:
    "Plan → implement → parallel reviews → adjudication → fixes → final reviews → report",
  "wolfram-validated": "Plan → Wolfram-validated derivation → validated answer",
  "free-form": "Goal, workspace and an optional task list",
};

export type TeamProfile = {
  /** The team id (one profile per team). */
  id: string;
  type: ProjectType;
  /** Agent that owns (coordinates) the team's projects. */
  leadId: string;
  /** Project role -> agent ids, in order (e.g. implement: [worker 1, worker 2]). */
  roles: Record<string, string[]>;
  /** How the project workspace is attached per agent id; absent = derived from each agent. */
  workspace?: { label: string; access: Record<string, "read" | "write"> };
  /** Team settings chosen at insert (worker caps, Codex effort, number of validators...). */
  settings: Record<string, string | number | boolean>;
  /** Model expectations by agent id (family/version/effort), re-checked at every project start. */
  expectations: Record<string, ModelExpectation>;
  intendedLead?: string;
  source: { template: string; example?: string };
  /** Model verification done when the team was inserted (informational; projects re-verify). */
  modelCheck?: ModelCheck;
  /**
   * Workers removed from a role in Team settings that could not be deleted because finished
   * project history refers to them (src/team-settings.ts); new projects no longer use them and
   * adding a worker to that role again reinstates them first.
   */
  retired?: { agentId: string; role: string; at: string }[];
  createdAt: string;
  updatedAt?: string;
};

const mapIds = <T>(rec: Record<string, T>, ids: Map<string, string>) =>
  Object.fromEntries(
    Object.entries(rec)
      .filter(([k]) => ids.has(k))
      .map(([k, v]) => [ids.get(k)!, v]),
  );

/** Profile for a freshly inserted team (`ids`: template key -> new agent id). */
export function profileFromTemplate(
  teamId: string,
  t: TeamTemplate,
  ids: Map<string, string>,
): TeamProfile {
  const p = t.project!;
  return {
    id: teamId,
    type: p.type,
    leadId: ids.get(p.lead)!,
    roles: Object.fromEntries(
      Object.entries(p.roles).map(([role, keys]) => [
        role,
        keys.map((k) => ids.get(k)!),
      ]),
    ),
    ...(p.workspace
      ? {
          workspace: {
            label: p.workspace.label,
            access: mapIds(p.workspace.access, ids),
          },
        }
      : {}),
    settings: { ...p.settings },
    expectations: mapIds(p.expectations, ids),
    ...(p.intendedLead ? { intendedLead: p.intendedLead } : {}),
    source: { template: t.name },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Template `project` section for a saved selection (`keyOf`: agent id -> template key), or
 * undefined when the selection does not contain every agent the profile names.
 */
export function templateProjectFromProfile(
  profile: TeamProfile,
  keyOf: Map<string, string>,
) {
  const named = [
    profile.leadId,
    ...Object.values(profile.roles).flat(),
    ...Object.keys(profile.workspace?.access ?? {}),
    ...Object.keys(profile.expectations),
  ];
  if (!named.every((id) => keyOf.has(id))) return undefined;
  const k = (id: string) => keyOf.get(id)!;
  const rekey = <T>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).map(([id, v]) => [k(id), v]));
  return {
    type: profile.type,
    lead: k(profile.leadId),
    roles: Object.fromEntries(
      Object.entries(profile.roles).map(([r, ids]) => [r, ids.map(k)]),
    ),
    ...(profile.workspace
      ? {
          workspace: {
            label: profile.workspace.label,
            access: rekey(profile.workspace.access),
          },
        }
      : {}),
    settings: { ...profile.settings },
    expectations: rekey(profile.expectations),
    ...(profile.intendedLead ? { intendedLead: profile.intendedLead } : {}),
  };
}

export function teamProfile(store: Store, teamId: string): TeamProfile | null {
  return (
    store.list<TeamProfile>("team-profile").find((p) => p.id === teamId) ?? null
  );
}

const WRITE_TOOLS = ["edit", "write", "shell"];
/**
 * Workspace access for an agent of a team without an explicit mapping: read-only roles
 * (coordinator, reviewer, adjudicator) read; implementers and agents that already write
 * somewhere (or hold write tools) write; everyone else reads.
 */
export function defaultProjectAccess(a: Agent): "read" | "write" {
  if (["coordinator", "reviewer", "adjudicator"].includes(a.roleType))
    return "read";
  if (a.roleType === "implementer") return "write";
  if (a.workspaces.some((w) => w.access === "write")) return "write";
  if (a.tools.some((t) => WRITE_TOOLS.includes(t))) return "write";
  return "read";
}

const segments = (p: string) => p.split(/[\\/]+/);
/** Refuses NUL, `..` segments and anything inside (or naming) a `.git` directory. */
export function assertPlainPath(p: string, what: string) {
  assert(
    !p.includes("\0") && !segments(p).includes(".."),
    "path_traversal",
    `${what} must not contain ".." segments`,
    400,
  );
  assert(
    !segments(p).some((x) => x.toLowerCase() === ".git"),
    "git_dir_blocked",
    `${what} must not be or lie inside a .git directory`,
    400,
  );
}

/**
 * A project workspace: an existing absolute directory, no traversal, never a .git directory (also
 * after resolving symlinks). Returns the real path. Async: call it before the transaction.
 */
export async function resolveProjectWorkspace(raw: string, store?: Store) {
  if (store) filesystemPolicy(store).assertPath(raw);
  assert(
    typeof raw === "string" && isAbsolute(raw) && !raw.includes("\0"),
    "invalid_path",
    "Workspace must be an absolute path",
    400,
  );
  assertPlainPath(raw, "Workspace");
  const real = await realpath(raw).catch(() => {
    throw new AppError(400, "invalid_path", "Workspace folder does not exist");
  });
  assertPlainPath(real, "Workspace");
  if (store) filesystemPolicy(store).assertPath(real);
  assert(
    (await stat(real)).isDirectory(),
    "invalid_path",
    "Workspace must be a directory",
    400,
  );
  return real;
}

/**
 * Inside a transaction: attach the project workspace to the given agents with the given access.
 * An agent that already has the folder keeps its existing attachment (access and rules are never
 * widened or narrowed here); the folder becomes active only for agents without an active one.
 * Refused while any of these agents has a running conversation (same rule as the agent editor).
 * Returns the attachments it actually added (recorded on the project as `setup.attachments`, so
 * detaching later never touches a folder that was attached before the project).
 */
export function attachProjectWorkspaceInTx(
  store: Store,
  access: Record<string, "read" | "write">,
  path: string,
): ProjectAttachment[] {
  filesystemPolicy(store).assertPath(path);
  const added: ProjectAttachment[] = [];
  const at = new Date().toISOString();
  const running = new Set(
    store
      .list<Session>("session")
      .filter((s) => s.state === "running")
      .map((s) => s.agentId),
  );
  for (const [agentId, mode] of Object.entries(access)) {
    const a = store.get<Agent>("agent", agentId);
    if (a.workspaces.some((w) => w.path === path)) continue;
    assert(
      !running.has(agentId),
      "agent_busy",
      `Stop ${a.name}'s active session before assigning a project that attaches a folder to it`,
    );
    const next: Agent = {
      ...a,
      workspaces: [
        ...a.workspaces,
        {
          path,
          access: mode,
          active: !a.workspaces.some((w) => w.active),
        },
      ],
    };
    store.put("agent", next);
    store.emit("agent.updated", agentId, { workspaceAttached: path });
    added.push({ agentId, path, access: mode, at });
  }
  return added;
}

/** A folder attachment a project added to one agent (absent `detachedAt` = still attached). */
export type ProjectAttachment = {
  agentId: string;
  path: string;
  access: "read" | "write";
  at: string;
  detachedAt?: string;
};
