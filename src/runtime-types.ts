import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
export type RuntimeEvent = {
  type:
    | "session"
    | "text"
    | "usage"
    | "capabilities"
    | "tool"
    | "plan"
    | "permission"
    | "config";
  data: unknown;
};
export type RuntimeHooks = {
  /** Selects provider timeout/output bounds; defaults to "chat". */
  profile?: "chat" | "task";
  /** Called with the provider process id once spawned (lease/process reconciliation, src/lock-recovery.ts). */
  onSpawn?: (pid: number) => void;
  permission?: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
};
export type TeammateTools = { url: string; token: string };
export type AcpRequest = {
  sessionId: string | null;
  prompt: string;
  model: string;
  effort: string | null;
};
export type Command = {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  request?: unknown;
  acp?: AcpRequest;
  /** Claude Code tools granted by an explicit tool and writable workspace assignment. */
  allowedTools?: string[];
  /** Per-run authenticated AgentTeam HTTP MCP tools; never persisted or logged. */
  teammateTools?: TeammateTools;
};
export interface RuntimeAdapter {
  execute(
    command: Command,
    environment: string,
    onEvent: (event: RuntimeEvent) => void,
    signal: AbortSignal,
    hooks?: RuntimeHooks,
  ): Promise<void>;
}
