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
  permission?: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
};
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
