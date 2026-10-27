import { createHash } from "node:crypto";
// What a provider launch can actually do. Pure functions over the facts of a `LaunchPlan`
// (`TeamService.launchPlan`): saved role names and saved tool checkboxes are never capabilities by
// themselves, only the grants a run really receives are. `src/runtime.ts` `commandFor` builds the
// provider arguments from the same helpers, so the readiness evaluator, the generated
// "Tools in this run" line, the launch manifest and the real command cannot drift apart.
import { isAbsolute, relative, sep } from "node:path";
import { providerCapabilityIssue } from "./provider-capabilities.ts";

export const CAPABILITIES = ["read", "write", "shell"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type PlanRoot = {
  path: string;
  access: "read" | "write";
  active: boolean;
  restricted: boolean;
};
/** The part of a launch plan the capability derivation reads (a `LaunchPlan` satisfies it). */
export type PlanFacts = {
  environment: string;
  connection?: { transport: "direct" | "acp" } | null;
  cwd: string | null;
  taskScoped?: boolean;
  executionMode?: "standard" | "file-only";
  tools: string[];
  providerRoots?: PlanRoot[];
  workspaces?: {
    path: string;
    access: "read" | "write";
    active: boolean;
    rules?: unknown[];
    explicitOnly?: boolean;
  }[];
};

export function providerRootsOf(plan: PlanFacts): PlanRoot[] {
  return (
    plan.providerRoots ??
    (plan.workspaces ?? []).map((w) => ({
      path: w.path,
      access: w.access,
      active: w.active,
      restricted: !!w.rules?.length || !!w.explicitOnly,
    }))
  );
}

/** Provider file access is available only inside the current unrestricted attachment. */
export function workspaceCapabilities(plan: PlanFacts) {
  if (!plan.cwd) return { read: false, write: false };
  const roots = providerRootsOf(plan);
  const workspace = roots
    .filter((candidate) => {
      const path = relative(candidate.path, plan.cwd!);
      return (
        path === "" ||
        (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
      );
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!workspace || roots.some((root) => root.restricted))
    return { read: false, write: false };
  const read = plan.tools.includes("read");
  return {
    read,
    write:
      read &&
      roots.every((root) => root.access === "write") &&
      (plan.tools.includes("edit") || plan.tools.includes("write")),
  };
}

/** The Claude built-in tools a launch names (`--tools`), in the order the command line uses. */
export function claudeFileTools(plan: PlanFacts) {
  const access = workspaceCapabilities(plan);
  if (!access.read) return [];
  return [
    ...(plan.tools.includes("read") ? ["Read"] : []),
    ...(plan.tools.includes("glob") ? ["Glob"] : []),
    ...(plan.tools.includes("grep") ? ["Grep"] : []),
    ...(access.write && plan.tools.includes("edit") ? ["Edit"] : []),
    ...(access.write && plan.tools.includes("write") ? ["Write"] : []),
    ...(access.write && plan.tools.includes("shell") ? ["Bash"] : []),
  ];
}

/** Typed reasons a capability a run needs is missing. They name the real cause, not a symptom. */
export type CapabilityIssueCode =
  | "no-folder"
  | "no-active-folder"
  | "folder-read-only"
  | "folder-restricted"
  | "folder-outside-task"
  | "grant-missing"
  | "adapter-unsupported"
  | "shell-withheld"
  | "sandbox-unavailable";
export type CapabilityGap = { code: CapabilityIssueCode; message: string };

export type EffectiveCapabilities = {
  adapter: "claude" | "codex" | "wolfram" | "acp";
  transport: "direct" | "acp";
  available: Record<Capability, boolean>;
  /** Why each unavailable capability is unavailable (absent when it is available). */
  gaps: Partial<Record<Capability, CapabilityGap>>;
  /** Provider tool names a launch exposes (Claude `--tools`; Codex sandbox and shell as capability names). */
  toolNames: string[];
  folders: { path: string; access: "read" | "write" }[];
  taskRoot: string | null;
  sandbox: string;
};

export type HostFacts = { platform?: NodeJS.Platform };

/**
 * Effective capabilities of one launch, mirroring `commandFor`: Claude gets file tools only inside
 * the current unrestricted attachment, Edit/Write/Bash only on write access with the matching
 * grant; Codex gets a workspace-write sandbox only on write access (and no shell in a file-only
 * assignment); Wolfram and ACP adapters expose nothing AgentTeam can establish or confine.
 */
export function effectiveCapabilities(
  plan: PlanFacts,
  host: HostFacts = {},
): EffectiveCapabilities {
  const roots = providerRootsOf(plan);
  const transport = plan.connection?.transport === "acp" ? "acp" : "direct";
  const adapter =
    transport === "acp"
      ? "acp"
      : plan.environment === "claude" ||
          plan.environment === "codex" ||
          plan.environment === "wolfram"
        ? plan.environment
        : "acp";
  const base = {
    adapter,
    transport,
    folders: roots.map((r) => ({ path: r.path, access: r.access })),
    taskRoot: plan.cwd,
  } as const;
  const unsupported = (message: string): EffectiveCapabilities => ({
    ...base,
    available: { read: false, write: false, shell: false },
    gaps: {
      read: { code: "adapter-unsupported", message },
      write: { code: "adapter-unsupported", message },
      shell: { code: "adapter-unsupported", message },
    },
    toolNames: [],
    sandbox: adapter === "acp" ? "adapter-managed" : "none",
  });
  if (adapter === "acp")
    return unsupported(
      "An ACP adapter manages its own file and terminal tools; AgentTeam cannot verify or confine them for this assignment.",
    );
  if (adapter === "wolfram")
    return unsupported(
      "The Wolfram runtime answers prompts and has no file or shell tools.",
    );
  const access = workspaceCapabilities(plan);
  const hasTool = (...names: string[]) =>
    names.some((name) => plan.tools.includes(name));
  // The first reason file access is unavailable, in the order a person would repair it.
  const folderGap = (): CapabilityGap | null => {
    if (!plan.cwd)
      return roots.length
        ? {
            code: "no-active-folder",
            message:
              "It has folders attached but none is the active one for this task, so the provider receives no file tools.",
          }
        : {
            code: "no-folder",
            message:
              "No folder is attached, so the provider receives no file tools.",
          };
    if (roots.some((root) => root.restricted))
      return {
        code: "folder-restricted",
        message:
          "A folder uses per-file rules or explicit-only access, which the provider cannot enforce, so file tools are withheld.",
      };
    if (!access.read && hasTool("read"))
      return {
        code: "folder-outside-task",
        message: `The task folder ${plan.cwd} is not inside an attached folder, so file tools are withheld.`,
      };
    return null;
  };
  const gaps: EffectiveCapabilities["gaps"] = {};
  const available: Record<Capability, boolean> = {
    read: false,
    write: false,
    shell: false,
  };
  const folder = folderGap();
  if (access.read) available.read = true;
  else
    gaps.read = folder ?? {
      code: "grant-missing",
      message: 'The "read" tool is not granted.',
    };
  if (access.write) available.write = true;
  else
    gaps.write = folder
      ? folder
      : !access.read
        ? gaps.read
        : !hasTool("edit", "write")
          ? {
              code: "grant-missing",
              message: 'Neither the "edit" nor the "write" tool is granted.',
            }
          : {
              code: "folder-read-only",
              message:
                "The folder is attached read-only (or a task folder is not writable), so the provider cannot create or change files.",
            };
  if (plan.executionMode === "file-only")
    gaps.shell = {
      code: "shell-withheld",
      message:
        "A simple (file-only) assignment withholds the shell, so it cannot compile or run programs. Use a team assignment for work that must run code.",
    };
  else if (!hasTool("shell"))
    gaps.shell = {
      code: "grant-missing",
      message: 'The "shell" tool is not granted.',
    };
  else if (adapter === "codex")
    // Codex's own shell tool is not tied to a folder; whether it can WRITE is the write capability.
    available.shell = true;
  else if (!available.write)
    // Claude's Bash is enabled only with write access, inside the required sandbox.
    gaps.shell = gaps.write ?? {
      code: "folder-read-only",
      message: "Running programs needs a writable folder.",
    };
  else {
    const sandboxIssue = providerCapabilityIssue(
      { allowedTools: ["Bash"] },
      "claude",
      host.platform,
    );
    if (sandboxIssue)
      gaps.shell = {
        code: "sandbox-unavailable",
        message: sandboxIssue.message,
      };
    else available.shell = true;
  }
  const toolNames =
    adapter === "claude"
      ? claudeFileTools(plan).filter(
          (name) => name !== "Bash" || available.shell,
        )
      : [
          ...(available.read ? ["read-files"] : []),
          ...(available.write ? ["write-files"] : []),
          ...(available.shell ? ["shell"] : []),
        ];
  const sandbox =
    adapter === "claude"
      ? available.shell
        ? "claude-sandbox-required"
        : "claude-file-tools-only"
      : available.write
        ? plan.taskScoped
          ? "codex-task-permissions-write"
          : "codex-workspace-write"
        : "codex-read-only";
  return { ...base, available, gaps, toolNames, sandbox };
}

/** Stable effective access identity; provider sessions never inherit silently widened scope. */
export function capabilityScopeHash(plan: PlanFacts, host: HostFacts = {}) {
  const caps = effectiveCapabilities(plan, host);
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapter: caps.adapter,
        root: caps.taskRoot,
        folders: [...caps.folders].sort((a, b) => a.path.localeCompare(b.path)),
        tools: [...caps.toolNames].sort(),
        sandbox: caps.sandbox,
      }),
    )
    .digest("hex");
}
