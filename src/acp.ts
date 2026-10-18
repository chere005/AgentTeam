import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { assert } from "./model.ts";
import { killPlanned, planSpawn } from "./runtime-spawn.ts";
import type { RuntimeAdapter } from "./runtime-types.ts";

export function acpSessionPrefix(executable: string, args: string[]) {
  return (
    "acp:" +
    createHash("sha256")
      .update(JSON.stringify([executable, args]))
      .digest("hex")
      .slice(0, 16) +
    ":"
  );
}
export const acpAdapter: RuntimeAdapter = {
  async execute(command, _environment, emit, signal, hooks) {
    signal.throwIfAborted();
    const request = command.acp!;
    const plan = await planSpawn(command.executable, command.args);
    signal.throwIfAborted();
    const child = spawn(plan.command, plan.args, {
      cwd: command.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...plan.options,
    });
    if (child.pid) hooks?.onSpawn?.(child.pid);
    let stderr = "",
      bytes = 0,
      replay = false,
      sessionId: string | undefined;
    let context: ClientContext | undefined, failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    let rejectExit: (error: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      rejectExit = reject;
    });
    const closed = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        failure = error;
        rejectExit(error);
      });
      child.once("close", (code) => {
        resolve();
        rejectExit(
          failure ??
            new Error(`ACP adapter exited (${code}): ${stderr.slice(-1000)}`),
        );
      });
    });
    const terminate = () => {
      killPlanned(child, plan, "SIGTERM");
      if (!force) {
        force = setTimeout(() => killPlanned(child, plan, "SIGKILL"), 2000);
        force.unref();
      }
    };
    const abort = () => {
      failure = new Error("ACP request cancelled");
      if (context && sessionId)
        void context.notify("session/cancel", { sessionId }).catch(() => {});
      terminate();
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-8000);
    });
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 4_000_000) {
        failure = new Error("ACP output exceeds 4 MB limit");
        terminate();
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      failure = new Error("ACP runtime exceeded the 180-second limit");
      terminate();
    }, 180000);
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 1_000_000 },
    );
    const app = client({ name: "agentteam" })
      .onRequest("session/request_permission", async ({ params }) => {
        emit({ type: "permission", data: params });
        if (signal.aborted || !hooks?.permission)
          return { outcome: { outcome: "cancelled" } };
        return hooks.permission(params, signal);
      })
      .onNotification(
        "session/update",
        async ({ params: { sessionId: updatedId, update } }) => {
          if (replay || (sessionId && updatedId !== sessionId)) return;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          )
            emit({ type: "text", data: update.content.text });
          else if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          )
            emit({ type: "tool", data: update });
          else if (update.sessionUpdate === "plan")
            emit({ type: "plan", data: update });
          else if (update.sessionUpdate === "config_option_update")
            emit({ type: "config", data: update });
        },
      );
    try {
      await Promise.race([
        failed,
        app.connectWith(stream, async (ctx) => {
          context = ctx;
          const initialized = await ctx.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "agentteam", version: "0.1.0" },
          });
          assert(
            initialized.protocolVersion === PROTOCOL_VERSION,
            "acp_version",
            "Unsupported ACP protocol version",
            400,
          );
          emit({ type: "capabilities", data: initialized });
          let options: SessionConfigOption[];
          if (request.sessionId) {
            assert(
              initialized.agentCapabilities?.loadSession,
              "acp_resume_unsupported",
              "This ACP adapter cannot reload sessions; create a new agent conversation",
              400,
            );
            sessionId = request.sessionId;
            replay = true;
            const loaded = await ctx.request("session/load", {
              sessionId,
              cwd: command.cwd,
              mcpServers: [],
            });
            replay = false;
            options = loaded.configOptions ?? [];
          } else {
            const created = await ctx.request("session/new", {
              cwd: command.cwd,
              mcpServers: [],
            });
            sessionId = created.sessionId;
            options = created.configOptions ?? [];
          }
          emit({
            type: "session",
            data:
              acpSessionPrefix(command.executable, command.args) + sessionId,
          });
          emit({ type: "config", data: options });
          for (const [category, value] of [
            ["model", request.model === "default" ? null : request.model],
            ["thought_level", request.effort],
          ]) {
            if (!value) continue;
            const option = options.find((o) => o.category === category);
            assert(
              option?.type === "select",
              "acp_config_unsupported",
              `Adapter does not advertise ${category} selection. Use provider default.`,
              400,
            );
            const choices = option.options.flatMap((o) =>
              "options" in o ? o.options : [o],
            );
            assert(
              choices.some((o) => o.value === value),
              "acp_config_value",
              `Adapter does not offer ${category}: ${value}`,
              400,
            );
            const result = await ctx.request("session/set_config_option", {
              sessionId,
              configId: option.id,
              value,
            });
            options = result.configOptions;
          }
          signal.throwIfAborted();
          const result = await ctx.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: request.prompt }],
          });
          assert(
            result.stopReason === "end_turn",
            "acp_incomplete",
            `ACP turn stopped: ${result.stopReason}`,
            502,
          );
        }),
      ]);
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      terminate();
      await closed;
      if (force) clearTimeout(force);
    }
  },
};
