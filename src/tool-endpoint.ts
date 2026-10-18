// MCP-style JSON-RPC handler for the teammate tools, authenticated by a per-run token.
// Transport wiring (an HTTP mount plus injecting URL/token into a provider's MCP configuration)
// is deliberately not done here: see TODO.md. The token is random, kept only as a SHA-256 digest in
// memory, bound to one agent/task, revoked when the run ends and never written to events or logs.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "./model.ts";
import type { Orchestration, ToolContext } from "./orchestration.ts";

const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class ToolSessions {
  private sessions = new Map<string, ToolContext>();
  /** Issue a token for one running task of one agent. Hand it to the provider process only. */
  issue(ctx: ToolContext) {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(digest(token), { ...ctx });
    return token;
  }
  revoke(token: string) {
    this.sessions.delete(digest(token));
  }
  revokeTask(taskId: string) {
    for (const [key, ctx] of this.sessions)
      if (ctx.taskId === taskId) this.sessions.delete(key);
  }
  authenticate(token: string | undefined) {
    const ctx = token ? this.sessions.get(digest(token)) : undefined;
    if (!ctx)
      throw new AppError(401, "unauthorized", "A valid run token is required");
    return ctx;
  }
}

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};
const rpcSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string(),
    params: z.any().optional(),
  })
  .passthrough();

/** Handles one JSON-RPC message; returns null for notifications. Throws 401 for a bad token. */
export function handleToolRpc(
  orchestration: Orchestration,
  sessions: ToolSessions,
  token: string | undefined,
  message: unknown,
) {
  const ctx = sessions.authenticate(token);
  const parsed = rpcSchema.safeParse(message);
  const id = (message as Rpc | null)?.id ?? null;
  const error = (code: number, text: string) => ({
    jsonrpc: "2.0" as const,
    id,
    error: { code, message: text },
  });
  if (!parsed.success) return error(-32600, "Invalid request");
  const rpc = parsed.data as Rpc & { method: string };
  const result = (value: unknown) => ({
    jsonrpc: "2.0" as const,
    id,
    result: value,
  });
  if (rpc.id === undefined) return null; // notification
  if (rpc.method === "initialize")
    return result({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "agentteam-teammates", version: "1" },
    });
  if (rpc.method === "ping") return result({});
  const tools = orchestration.tools();
  if (rpc.method === "tools/list")
    return result({
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  if (rpc.method === "tools/call") {
    const tool = tools.find((t) => t.name === rpc.params?.name);
    if (!tool) return error(-32602, "Unknown tool");
    const text = (value: unknown, isError = false) =>
      result({
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError,
      });
    try {
      // Identity comes from the token, never from arguments.
      return text(tool.handler(ctx, rpc.params?.arguments ?? {}));
    } catch (e) {
      if (e instanceof AppError)
        return text({ error: e.code, message: e.message }, true);
      if (e instanceof z.ZodError)
        return text({ error: "validation_error", issues: e.issues }, true);
      throw e;
    }
  }
  return error(-32601, "Method not found");
}
