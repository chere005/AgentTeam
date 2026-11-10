import { createHash } from "node:crypto";
import type { Command } from "./runtime-types.ts";
import type { Store } from "./store.ts";
import { Redactor } from "./redact.ts";
import { providerRootsOf, type PlanFacts } from "./launch-capability.ts";

/**
 * The effective launch of one provider run, recorded as a `task.launch` (task runs) or
 * `session.launch` (chat runs) event just before the provider starts. Everything passes through
 * the redactor: secret-looking arguments are masked, home folders shortened, long arguments
 * (system prompts) replaced by length + hash. The prompt (stdin) and environment VALUES are never
 * recorded; only the names of variables AgentTeam set or overrode for the child.
 */
export const LAUNCH_ARG_MAX = 240;
export type LaunchRecord = ReturnType<typeof launchRecord>;

const digest = (s: string) =>
  `<${s.length} chars sha256:${createHash("sha256").update(s).digest("hex").slice(0, 12)}>`;

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function codexSetting(args: string[], key: string) {
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === "-c" && args[i + 1].startsWith(key + "="))
      return args[i + 1].slice(key.length + 1);
  return undefined;
}

export function launchRecord(
  command: Command,
  plan: PlanFacts & {
    environment: string;
    model?: string;
    effort?: string | null;
    taskScoped?: boolean;
    connection?: { transport?: string };
  },
  options: { sessionId?: string | null; redactor?: Redactor } = {},
) {
  const redactor =
    options.redactor ??
    new Redactor({
      literals: command.teammateTools ? [command.teammateTools.token] : [],
    });
  const clean = (value: string) =>
    redactor.string(value.length > LAUNCH_ARG_MAX ? digest(value) : value);
  const args = command.args;
  const transport = plan.connection?.transport ?? "direct";
  let sandbox: Record<string, unknown>;
  let roots = providerRootsOf(plan).map((r) => ({
    path: r.path,
    access: r.access,
  }));
  if (plan.environment === "codex" && transport !== "acp") {
    const table = codexSetting(args, "permissions.agentteam-task.filesystem");
    if (table) {
      // The effective table (task roots plus anything executing Node needs), not the plan's view.
      roots = [...table.matchAll(/"([^"]+)"="(read|write)"/g)]
        .filter((m) => m[1] !== ":minimal")
        .map((m) => ({ path: m[1], access: m[2] as "read" | "write" }));
    }
    sandbox = {
      mode: table
        ? "permission-profile:agentteam-task"
        : (codexSetting(args, "sandbox_mode")?.replace(/"/g, "") ??
          "provider-default"),
      network: codexSetting(args, "permissions.agentteam-task.network.enabled")
        ? "disabled"
        : "provider-default",
      shellTool: codexSetting(args, "features.shell_tool") !== "false",
    };
  } else if (plan.environment === "claude" && transport !== "acp") {
    sandbox = {
      mode: flag(args, "--permission-mode") ?? "provider-default",
      restricted: args.includes("--restricted"),
      allowedTools: command.allowedTools ?? [],
    };
  } else {
    sandbox = { mode: transport === "acp" ? "acp-transport" : "none" };
  }
  const resumed =
    options.sessionId && args.some((a) => a === options.sessionId)
      ? options.sessionId
      : null;
  return {
    version: 1 as const,
    environment: plan.environment,
    transport,
    executable: redactor.string(command.executable),
    args: args.map(clean),
    cwd: redactor.string(command.cwd),
    sandbox,
    readRoots: roots.map((r) => redactor.string(r.path)),
    writeRoots: roots
      .filter((r) => r.access === "write")
      .map((r) => redactor.string(r.path)),
    model: plan.model ?? null,
    effort: plan.effort ?? null,
    providerSessionId: resumed ? redactor.string(resumed) : null,
    // Names only: AgentTeam passes the rest of its environment through unchanged.
    envNames: {
      set: command.teammateTools ? ["AGENTTEAM_TOOL_TOKEN"] : [],
      inherited: true,
    },
    teammateTools: !!command.teammateTools,
    stdin: command.stdin ? { chars: command.stdin.length } : null,
    limitations: (command.limitations ?? []).map((l) => redactor.string(l)),
  };
}

export function recordLaunch(
  store: Store,
  entity: "task" | "session",
  id: string,
  command: Command,
  plan: Parameters<typeof launchRecord>[1],
  sessionId?: string | null,
) {
  try {
    store.emit(
      `${entity}.launch`,
      id,
      launchRecord(command, plan, { sessionId }),
    );
  } catch {
    /* an inspector record must never stop a run */
  }
}
