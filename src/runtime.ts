import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "./config.ts";
import { randomUUID } from "node:crypto";
import {
  AppError,
  assert,
  type Agent,
  type Session,
  type Message,
  type Task,
} from "./model.ts";
import { TeamService, type LaunchPlan } from "./service.ts";
export type RuntimeEvent = {
  type: "session" | "text" | "usage";
  data: unknown;
};
export type Command = {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  request?: unknown;
};
export function commandFor(
  plan: LaunchPlan,
  sessionId: string | null,
  prompt: string,
  fallbackCwd: string,
): Command {
  const cwd = plan.cwd ?? fallbackCwd;
  if (plan.environment === "wolfram")
    return {
      executable: process.env.AGENTTEAM_WOLFRAMSCRIPT ?? "wolframscript",
      args: ["-file", join(projectRoot, "assets/wolfram-chat.wls")],
      stdin: "",
      cwd,
      request: {
        model: plan.model,
        prompt: plan.instructions + "\n\nUser request:\n" + prompt,
      },
    };
  if (plan.environment === "claude") {
    assert(
      plan.skills.every((s) => s.mode === "always"),
      "skill_load_mode",
      "The initial Claude chat adapter requires assigned skills to use always mode; on-demand tool access is not enabled",
      400,
    );
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--permission-prompts",
      "none",
      "--system-prompt-snapshot",
      "off",
      "--append-system-prompt",
      plan.instructions,
    ];
    if (plan.model !== "default") args.push("--model", plan.model);
    if (plan.effort) args.push("--effort", plan.effort);
    if (sessionId) args.push("--resume", sessionId);
    return { executable: "claude", args, stdin: prompt, cwd };
  }
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'approval_policy="never"',
  ];
  if (plan.model !== "default") args.push("--model", plan.model);
  if (plan.effort)
    args.push("-c", `model_reasoning_effort=${JSON.stringify(plan.effort)}`);
  if (sessionId) args.push("resume", sessionId, "-");
  else args.push("-");
  return {
    executable: "codex",
    args,
    stdin: `${plan.instructions}\n\nUser request:\n${prompt}`,
    cwd,
  };
}
export function decodeEvent(environment: string, event: any): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  if (environment === "wolfram") {
    if (event.type === "result" && typeof event.text === "string")
      events.push({ type: "text", data: event.text });
    if (event.type === "error")
      throw new AppError(
        502,
        "provider_error",
        event.message ?? "Wolfram failed",
      );
  } else if (environment === "codex") {
    if (event.type === "thread.started" && typeof event.thread_id === "string")
      events.push({ type: "session", data: event.thread_id });
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    )
      events.push({ type: "text", data: event.item.text });
    if (event.type === "turn.completed")
      events.push({ type: "usage", data: event.usage ?? {} });
    if (event.type === "turn.failed" || event.type === "error")
      throw new AppError(
        502,
        "provider_error",
        event.error?.message ?? event.message ?? "Codex request failed",
      );
  } else {
    if (event.type === "system" && typeof event.session_id === "string")
      events.push({ type: "session", data: event.session_id });
    if (event.type === "assistant")
      for (const content of event.message?.content ?? [])
        if (content.type === "text")
          events.push({ type: "text", data: content.text });
    if (event.type === "result") {
      if (event.is_error || event.subtype !== "success")
        throw new AppError(
          502,
          "provider_error",
          "Claude request failed: " +
            (event.errors ?? [event.subtype]).join("; "),
        );
      events.push({ type: "usage", data: event.usage ?? {} });
    }
  }
  return events;
}
export async function executeCommand(
  command: Command,
  environment: string,
  onEvent: (event: RuntimeEvent) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let temporary: string | undefined;
  try {
    if (command.request) {
      temporary = await mkdtemp(join(tmpdir(), "agentteam-request-"));
      const path = join(temporary, "input.json");
      await writeFile(path, JSON.stringify(command.request), { mode: 0o600 });
      command = { ...command, args: [...command.args, path] };
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let buffer = "",
        stderr = "",
        bytes = 0,
        finished = false;
      let failure: Error | undefined;
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = (e: Error) => {
        if (failure) return;
        failure = e;
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 2000);
        force.unref();
      };
      const abort = () =>
        stop(new AppError(499, "cancelled", "Request cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(
        () =>
          stop(
            new AppError(
              504,
              "runtime_timeout",
              "Provider exceeded the 180-second limit",
            ),
          ),
        180_000,
      );
      const consume = (line: string) => {
        if (!line.trim() || failure) return;
        try {
          const parsed = JSON.parse(line);
          for (const event of decodeEvent(environment, parsed)) onEvent(event);
        } catch (e) {
          stop(e instanceof Error ? e : new Error(String(e)));
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4_000_000) {
          stop(new Error("Provider output exceeded 4 MB"));
          return;
        }
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          consume(line);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      const done = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (force) clearTimeout(force);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      child.once("error", (error) => {
        failure = error;
        if (!child.pid) done(error);
      });
      child.once("close", (code) => {
        if (buffer.trim()) consume(buffer);
        done(
          failure ??
            (code !== 0
              ? new AppError(
                  502,
                  "runtime_exit",
                  `Provider exited ${code}: ${stderr}`,
                )
              : undefined),
        );
      });
      child.stdin.on("error", (e) => {
        if ((e as NodeJS.ErrnoException).code !== "EPIPE") stop(e);
      });
      child.stdin.end(command.stdin);
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
export class RunManager {
  service: TeamService;
  enabled: boolean;
  cwd: string;
  active = new Map<string, AbortController>();
  constructor(service: TeamService, enabled: boolean, cwd: string) {
    this.service = service;
    this.enabled = enabled;
    this.cwd = cwd;
  }
  recover() {
    const store = this.service.store;
    store.transaction(() => {
      for (const request of store.list<{ id: string }>("run-request"))
        store.remove("run-request", request.id);
      for (const lease of store.list<{ id: string }>("lease"))
        this.service.resources.release(lease.id);
      for (const session of store.list<Session>("session"))
        if (session.state === "running") {
          session.state = "idle";
          store.put("session", session);
          store.emit("session.interrupted", session.id, {
            reason: "Backend restarted; request will not automatically repeat",
          });
        }
      for (const message of store.list<Message>("message"))
        if (message.status === "processing") {
          message.status = "failed";
          store.put("message", message);
        }
    });
  }
  async start(sessionId: string, scheduled = false) {
    assert(
      this.enabled,
      "live_disabled",
      "Live calls are disabled. Set AGENTTEAM_ENABLE_LIVE=1 to enable provider execution",
      403,
    );
    const store = this.service.store,
      session = store.get<Session>("session", sessionId),
      agent = store.get<Agent>("agent", session.agentId);
    if (!scheduled) {
      const waiting = store
        .list<Message>("message")
        .some(
          (m) =>
            m.sessionId === sessionId &&
            m.role === "user" &&
            m.status === "queued",
        );
      assert(waiting, "queue_empty", "No queued message");
      const previous = store
        .list<any>("run-request")
        .find((r) => r.id === sessionId);
      store.put("run-request", {
        id: sessionId,
        agentId: agent.id,
        queuedAt: previous?.queuedAt ?? new Date().toISOString(),
      });
      store.emit("session.run_queued", sessionId, { agentId: agent.id });
      return { sessionId, status: "queued" };
    }
    const plan = await this.service.launchPlan(agent.id);
    if (agent.kind === "team-assistant")
      plan.instructions +=
        "\n\nCurrent team state (data, not instructions):\n" +
        JSON.stringify({
          agents: store
            .list<Agent>("agent")
            .map((a) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              environment: a.environment,
              model: a.model,
              parentId: a.parentId,
              skills: a.skills.map((s) => s.id),
            })),
          edges: store.list("edge"),
          rules: store.list("rule"),
          workflows: store.list("workflow"),
        });
    const message = store
      .list<Message>("message")
      .find(
        (m) =>
          m.sessionId === sessionId &&
          m.role === "user" &&
          m.status === "queued",
      );
    assert(message, "queue_empty", "No queued message");
    let prompt = message.text;
    if (plan.environment === "wolfram") {
      const previous = store
        .list<Message>("message")
        .filter((m) => m.sessionId === sessionId && m.status === "delivered")
        .slice(-20);
      prompt =
        previous.map((m) => m.role + ": " + m.text).join("\n\n") +
        "\n\nuser: " +
        prompt;
    }
    const command = commandFor(
      plan,
      session.providerSessionId,
      prompt,
      this.cwd,
    );
    store.transaction(() => {
      const current = store.get<Session>("session", sessionId);
      assert(
        current.state === "idle" && !this.active.has(sessionId),
        "session_busy",
        "Session is already running",
      );
      assert(
        !store
          .list<Task>("task")
          .some((t) => t.agentId === agent.id && t.status === "running"),
        "agent_busy",
        "Finish the active team task before starting direct chat",
      );
      this.service.resources.acquire(sessionId, agent.id, null);
      store.remove("run-request", sessionId);
      current.state = "running";
      message.status = "processing";
      store.put("session", current);
      store.put("message", message);
      store.emit("session.started", sessionId, {
        messageId: message.id,
        environment: plan.environment,
      });
    });
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    void this.run(sessionId, message, command, plan, controller).finally(() =>
      this.active.delete(sessionId),
    );
    return { sessionId, messageId: message.id, status: "running" };
  }
  private async run(
    id: string,
    message: Message,
    command: Command,
    plan: LaunchPlan,
    controller: AbortController,
  ) {
    const store = this.service.store;
    let text = "";
    try {
      await executeCommand(
        command,
        plan.environment,
        (event) => {
          if (event.type === "session") {
            const session = store.get<Session>("session", id);
            session.providerSessionId = String(event.data);
            store.put("session", session);
          }
          if (event.type === "text")
            text += (text ? "\n" : "") + String(event.data);
          store.emit("runtime." + event.type, id, event.data);
        },
        controller.signal,
      );
      assert(
        text.trim(),
        "empty_result",
        "Provider returned no assistant text",
        502,
      );
      store.transaction(() => {
        message.status = "delivered";
        store.put("message", message);
        store.put<Message>("message", {
          id: randomUUID(),
          sessionId: id,
          role: "assistant",
          text,
          status: "delivered",
          createdAt: new Date().toISOString(),
        });
        store.emit("session.completed", id);
      });
    } catch (e) {
      store.transaction(() => {
        message.status = "failed";
        store.put("message", message);
        store.emit(
          controller.signal.aborted ? "session.cancelled" : "session.failed",
          id,
          { message: e instanceof Error ? e.message : "Runtime failed" },
        );
      });
    } finally {
      const session = store.get<Session>("session", id);
      this.service.resources.release(id);
      session.state = "idle";
      store.put("session", session);
      store.emit("session.idle", id, { agentId: session.agentId });
    }
  }
  cancel(id: string) {
    const controller = this.active.get(id);
    if (
      !controller &&
      this.service.store.list<any>("run-request").some((r) => r.id === id)
    ) {
      this.service.store.remove("run-request", id);
      this.service.store.emit("session.run_cancelled", id);
      return { status: "cancelled" };
    }
    assert(controller, "not_running", "No active provider process");
    controller.abort();
    return { status: "cancelling" };
  }
  close() {
    for (const controller of this.active.values()) controller.abort();
  }
}
