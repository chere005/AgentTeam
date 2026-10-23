import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { tmpdir } from "node:os";
import { z } from "zod";
import { AppError, type Agent } from "./model.ts";
import { Redactor } from "./redact.ts";
import { killPlanned, planSpawn } from "./runtime-spawn.ts";
import type { Store } from "./store.ts";

/**
 * MCP / tool registry.
 *
 *  - `tool-server`: a stdio MCP server definition. Credentials are never stored: authentication is a
 *    list of environment-variable REFERENCES (`{name, fromEnv}`); values are read from AgentTeam's own
 *    environment only at connection-test time and never persisted, logged or put in events. Arguments
 *    that look like inline secrets are refused. (No OS-keychain integration exists in this codebase.)
 *  - `tool-grant`: per-agent permission to use a server (optionally limited to named tools). Grants are
 *    AgentTeam policy; the adapters do not yet pass MCP servers to providers (ACP sends `mcpServers: []`,
 *    Claude runs `--strict-mcp-config`), which `adapterExposure` states plainly.
 *  - `tool-connection`: result of the last "Test connection": metadata only (initialize + tools/list).
 *    The test NEVER sends tools/call and never exposes any tool to an agent.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_FLAG =
  /(token|secret|passw(or)?d|api[-_]?key|apikey|authorization|credential|bearer)/i;
const SECRET_VALUE =
  /(\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_|\bxox[abprs]-|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+\S{6,}|eyJ[A-Za-z0-9_-]{8,}\.)/;
export const serverInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1).max(1000),
    args: z.array(z.string().max(2000)).max(50).default([]),
    cwd: z.string().max(1000).nullable().default(null),
    /** Auth configuration: child env NAME is filled from AgentTeam's environment variable `fromEnv`. */
    envRefs: z
      .array(
        z
          .object({
            name: z.string().regex(ENV_NAME),
            fromEnv: z.string().regex(ENV_NAME),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    notes: z.string().max(500).default(""),
  })
  .strict()
  .superRefine((v, ctx) => {
    const parts = [v.command, ...v.args];
    parts.forEach((part, i) => {
      const prev = i > 0 ? parts[i - 1] : "";
      const inline = part.match(/^--?([A-Za-z0-9_-]+)=(.+)$/s);
      const flagValue =
        (inline &&
          SECRET_FLAG.test(inline[1]) &&
          !/^\$\{?[A-Z_]+\}?$/.test(inline[2])) ||
        (/^--?[A-Za-z0-9_-]+$/.test(prev) &&
          SECRET_FLAG.test(prev) &&
          !part.startsWith("-"));
      if (flagValue || SECRET_VALUE.test(part))
        ctx.addIssue({
          code: "custom",
          message:
            "Arguments must not contain secrets; reference an environment variable in envRefs instead",
        });
    });
  });
export type ToolServer = z.infer<typeof serverInputSchema> & {
  id: string;
  transport: "stdio";
  createdAt: string;
  updatedAt: string;
};
export type ToolInfo = { name: string; description: string };
export type ToolConnection = {
  id: string;
  serverId: string;
  state: "untested" | "connected" | "failed";
  checkedAt: string | null;
  durationMs: number | null;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  tools: ToolInfo[];
  toolCount: number;
  error: string | null;
};
export type ToolGrant = {
  id: string;
  agentId: string;
  serverId: string;
  /** null = every tool the server advertises. */
  allowedTools: string[] | null;
  grantedAt: string;
};
const grantSchema = z
  .object({
    serverId: z.string().min(1),
    allowedTools: z
      .array(z.string().min(1).max(200))
      .max(200)
      .nullable()
      .default(null),
  })
  .strict();
const CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
];
export type TestOptions = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};
export class ToolRegistry {
  store: Store;
  testing = new Set<string>();
  constructor(store: Store) {
    this.store = store;
  }
  servers() {
    return this.store.list<ToolServer>("tool-server");
  }
  server(id: string) {
    return this.store.get<ToolServer>("tool-server", id);
  }
  connection(serverId: string): ToolConnection {
    try {
      return this.store.get<ToolConnection>("tool-connection", serverId);
    } catch {
      return {
        id: serverId,
        serverId,
        state: "untested",
        checkedAt: null,
        durationMs: null,
        protocolVersion: null,
        serverInfo: null,
        tools: [],
        toolCount: 0,
        error: null,
      };
    }
  }
  /** Server records for display. Env reference NAMES and whether they are set; never values. */
  view(
    server: ToolServer,
    env: Record<string, string | undefined> = process.env,
  ) {
    return {
      ...server,
      envRefs: server.envRefs.map((r) => ({ ...r, set: !!env[r.fromEnv] })),
      connection: this.connection(server.id),
      grants: this.store
        .list<ToolGrant>("tool-grant")
        .filter((g) => g.serverId === server.id).length,
    };
  }
  save(input: unknown, id?: string) {
    const data = serverInputSchema.parse(input);
    const now = new Date().toISOString();
    let previous: ToolServer | null = null;
    if (id) previous = this.server(id);
    const server: ToolServer = {
      ...data,
      id: id ?? randomUUID(),
      transport: "stdio",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.put("tool-server", server);
      // A changed command invalidates the last test result.
      if (
        previous &&
        (previous.command !== server.command ||
          JSON.stringify(previous.args) !== JSON.stringify(server.args))
      )
        this.store.remove("tool-connection", server.id);
      this.store.emit(
        previous ? "tools.server_updated" : "tools.server_added",
        server.id,
        {
          name: server.name,
          // No args or env values: only reference names are audit-relevant.
          envRefNames: server.envRefs.map((r) => r.fromEnv),
        },
      );
    });
    return server;
  }
  remove(id: string) {
    const server = this.server(id);
    this.store.transaction(() => {
      this.store.remove("tool-server", id);
      this.store.remove("tool-connection", id);
      for (const g of this.store.list<ToolGrant>("tool-grant"))
        if (g.serverId === id) this.store.remove("tool-grant", g.id);
      this.store.emit("tools.server_removed", id, { name: server.name });
    });
  }
  grants(agentId: string) {
    return this.store
      .list<ToolGrant>("tool-grant")
      .filter((g) => g.agentId === agentId);
  }
  grant(agentId: string, input: unknown) {
    const data = grantSchema.parse(input);
    this.store.get<Agent>("agent", agentId);
    const server = this.server(data.serverId);
    const grant: ToolGrant = {
      id: `${agentId}:${server.id}`,
      agentId,
      serverId: server.id,
      allowedTools: data.allowedTools,
      grantedAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.put("tool-grant", grant);
      this.store.emit("tools.granted", agentId, {
        agentId,
        serverId: server.id,
        server: server.name,
        allowedTools: data.allowedTools,
      });
    });
    return grant;
  }
  revoke(agentId: string, serverId: string) {
    const id = `${agentId}:${serverId}`;
    this.store.get<ToolGrant>("tool-grant", id);
    this.store.transaction(() => {
      this.store.remove("tool-grant", id);
      this.store.emit("tools.revoked", agentId, { agentId, serverId });
    });
  }
  /** Grants for an agent joined with server and last-known connection state. */
  agentView(agentId: string) {
    return this.grants(agentId).flatMap((g) => {
      let server: ToolServer;
      try {
        server = this.server(g.serverId);
      } catch {
        return [];
      }
      const connection = this.connection(server.id);
      return [
        {
          ...g,
          server: server.name,
          state: connection.state,
          tools: connection.tools.filter(
            (t) => !g.allowedTools || g.allowedTools.includes(t.name),
          ),
        },
      ];
    });
  }
  /**
   * Metadata-only connection test: start the server, `initialize`, `notifications/initialized`,
   * `tools/list` (paged), then stop it. Never sends `tools/call`.
   */
  async test(id: string, options: TestOptions = {}): Promise<ToolConnection> {
    filesystemPolicy(this.store).assertConfinedExecution();
    const server = this.server(id);
    if (this.testing.has(id))
      throw new AppError(
        409,
        "test_in_progress",
        "A connection test is already running",
      );
    this.testing.add(id);
    const started = Date.now();
    const hostEnv = options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const key of CHILD_ENV_KEYS)
      if (hostEnv[key]) env[key] = hostEnv[key]!;
    const secrets: string[] = [];
    const missing: string[] = [];
    for (const ref of server.envRefs) {
      const value = hostEnv[ref.fromEnv];
      if (!value) missing.push(ref.fromEnv);
      else {
        env[ref.name] = value;
        secrets.push(value);
      }
    }
    const redactor = new Redactor({ literals: secrets, env: {} });
    const result: ToolConnection = {
      ...this.connection(id),
      state: "failed",
      checkedAt: new Date().toISOString(),
      tools: [],
      toolCount: 0,
      error: null,
      serverInfo: null,
      protocolVersion: null,
    };
    try {
      if (missing.length)
        throw new Error(
          `Environment variable(s) not set in AgentTeam's environment: ${missing.join(", ")}`,
        );
      const found = await converse(server, env, options.timeoutMs ?? 10_000);
      result.state = "connected";
      result.serverInfo = found.serverInfo;
      result.protocolVersion = found.protocolVersion;
      result.tools = found.tools;
      result.toolCount = found.tools.length;
    } catch (e) {
      result.error = redactor
        .string(e instanceof Error ? e.message : "Connection failed")
        .slice(0, 400);
    } finally {
      this.testing.delete(id);
    }
    result.durationMs = Date.now() - started;
    this.store.transaction(() => {
      this.store.put("tool-connection", result);
      this.store.emit("tools.connection_tested", id, {
        server: server.name,
        state: result.state,
        toolCount: result.toolCount,
        durationMs: result.durationMs,
        error: result.error,
      });
    });
    return result;
  }
}
const MAX_LINE = 1_000_000;
async function converse(
  server: ToolServer,
  env: Record<string, string>,
  timeoutMs: number,
) {
  const plan = await planSpawn(server.command, server.args);
  const child = spawn(plan.command, plan.args, {
    cwd: server.cwd ?? tmpdir(),
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...plan.options,
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    if (stderr.length < 2000) stderr += String(d).slice(0, 2000);
  });
  const pending = new Map<number, (m: any) => void>();
  let buffer = "";
  let ended: Error | null = null;
  child.stdout.on("data", (d) => {
    buffer += String(d);
    if (buffer.length > MAX_LINE * 4) {
      ended = new Error("Server output exceeded the size limit");
      killPlanned(child, plan);
      return;
    }
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.length > MAX_LINE) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg?.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* non-JSON log lines on stdout are ignored */
      }
    }
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      ended ??= new Error(
        "Server exited before answering" +
          (stderr.trim() ? ": " + stderr.trim().slice(0, 200) : ""),
      );
      for (const fn of pending.values())
        fn({ error: { message: ended.message } });
      resolve();
    });
    child.once("error", (e) => {
      ended ??= new Error("Could not start server: " + e.message);
      for (const fn of pending.values())
        fn({ error: { message: ended.message } });
      resolve();
    });
  });
  const timer = setTimeout(() => {
    ended = new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s`);
    killPlanned(child, plan);
    for (const fn of pending.values())
      fn({ error: { message: ended.message } });
  }, timeoutMs);
  let nextId = 1;
  const send = (message: object) => {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify(message) + "\n");
  };
  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) =>
        m.error
          ? reject(new Error(String(m.error.message ?? "error")))
          : resolve(m.result),
      );
      send({ jsonrpc: "2.0", id, method, params });
    });
  try {
    child.stdin.on("error", () => {});
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agentteam", version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const listed = await request("tools/list", cursor ? { cursor } : {});
      for (const t of Array.isArray(listed?.tools) ? listed.tools : [])
        if (tools.length < 500 && typeof t?.name === "string")
          tools.push({
            name: t.name.slice(0, 200),
            description: String(t.description ?? "").slice(0, 300),
          });
      cursor =
        typeof listed?.nextCursor === "string" ? listed.nextCursor : undefined;
      if (!cursor) break;
    }
    return {
      serverInfo:
        init?.serverInfo && typeof init.serverInfo.name === "string"
          ? {
              name: String(init.serverInfo.name).slice(0, 100),
              version: String(init.serverInfo.version ?? "").slice(0, 50),
            }
          : null,
      protocolVersion:
        typeof init?.protocolVersion === "string"
          ? init.protocolVersion.slice(0, 40)
          : null,
      tools,
    };
  } finally {
    clearTimeout(timer);
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    killPlanned(child, plan);
    await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
/** Per-adapter statement of what grants actually do today. */
export function adapterExposure(adapter: string) {
  return `Grants are recorded in AgentTeam and govern the registry only. ${
    adapter === "acp"
      ? "AgentTeam sends mcpServers: [] to ACP agents, so a granted server is not exposed to the agent."
      : adapter === "claude-cli"
        ? "The Claude adapter runs with --strict-mcp-config and no MCP config, so a granted server is not exposed."
        : adapter === "codex-cli"
          ? "The Codex adapter does not pass MCP servers, so a granted server is not exposed."
          : "LLMSynthesize cannot use MCP servers, so a granted server is not exposed."
  }`;
}
