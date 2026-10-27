import { executablePaths } from "./discovery.ts";
import { killPlanned, planSpawn } from "./runtime-spawn.ts";
import type { Readiness } from "./runtime-scan.ts";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot, providerLimits } from "./config.ts";
import { toProviderError, errorKindOf } from "./provider-errors.ts";
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
export type { RuntimeEvent, Command } from "./runtime-types.ts";
import type { RuntimeEvent, Command, RuntimeHooks } from "./runtime-types.ts";
import { acpAdapter, acpSessionPrefix } from "./acp.ts";
import { prepareRunContext } from "./run-context.ts";
import { assistantContext } from "./assistant-context.ts";
import { ToolSessions } from "./tool-endpoint.ts";
import { GroupChats } from "./group-chat.ts";
import { ensureWorkspaceBaseline } from "./workspace-changes.ts";
import { codexTaskPermissions } from "./provider-filesystem.ts";
import { assertProviderCapabilities } from "./provider-capabilities.ts";
import { noteRuntimeWait } from "./runtime-waits.ts";
import { classifyRequest } from "./execution-contract.ts";
import { launchManifest } from "./capability-context.ts";
import {
  claudeFileTools,
  providerRootsOf as providerRoots,
  workspaceCapabilities,
} from "./launch-capability.ts";

export function commandFor(
  plan: LaunchPlan,
  sessionId: string | null,
  prompt: string,
  fallbackCwd: string,
): Command {
  const cwd = plan.cwd ?? fallbackCwd;
  const roots = providerRoots(plan);
  assert(
    !plan.taskScoped || !roots.some((root) => root.restricted),
    "resource_scope_unsupported",
    "This provider cannot enforce file-level access rules inside a task folder. Remove the rules or use an unrestricted folder attachment.",
    409,
  );
  if (plan.taskScoped) {
    assert(
      plan.connection?.transport !== "acp" &&
        (plan.environment === "claude" || plan.environment === "codex"),
      "provider_access_unsupported",
      "This provider adapter cannot enforce task-scoped filesystem access",
      409,
    );
    // A resumed session can carry old directories and file contents from a broader grant.
    // Recovery still receives its bounded continuation note, but starts a fresh provider session.
    sessionId = null;
  }
  if (plan.connection?.transport === "acp") {
    const prefix = acpSessionPrefix(
      plan.connection.executable,
      plan.connection.args,
    );
    assert(
      !sessionId || sessionId.startsWith(prefix),
      "session_transport",
      "Existing conversation belongs to a different adapter; use a new agent for this connection",
      409,
    );
    return {
      executable: plan.connection.executable,
      args: plan.connection.args,
      cwd,
      stdin: "",
      acp: {
        sessionId: sessionId?.slice(prefix.length) ?? null,
        prompt: `${plan.instructions}\n\nUser request:\n${prompt}`,
        model: plan.model,
        effort: plan.effort,
      },
    };
  }
  assert(
    !sessionId?.startsWith("acp:"),
    "session_transport",
    "Existing conversation belongs to ACP; keep its ACP connection or use a new agent",
    409,
  );

  if (plan.environment === "wolfram")
    return {
      executable:
        executablePaths.wolfram ??
        process.env.AGENTTEAM_WOLFRAMSCRIPT ??
        "wolframscript",
      args: ["-file", join(projectRoot, "assets/wolfram-chat.wls")],
      stdin: "",
      cwd,
      request: {
        model: plan.model,
        prompt: plan.instructions + "\n\nUser request:\n" + prompt,
      },
    };
  if (plan.environment === "claude") {
    // On-demand skills are selected by AgentTeam. Restricted mode confines built-in tools to the
    // assigned directories; Bash is named only for an explicit shell grant on writable access.
    // Per-file rules cannot be represented by Claude's filesystem tools, so those roots stay off.
    const capabilities = workspaceCapabilities(plan);
    const fileTools = claudeFileTools(plan);
    if (plan.taskScoped)
      assert(
        new Set(roots.map((w) => w.access)).size === 1,
        "provider_access_unsupported",
        "Claude cannot enforce mixed read/write task directories; split this task into separate assignments",
        409,
      );
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--tools",
      fileTools.join(","),
      "--permission-mode",
      capabilities.write ? "acceptEdits" : "dontAsk",
      "--strict-mcp-config",
      "--permission-prompts",
      "none",
      "--system-prompt-snapshot",
      "off",
      "--append-system-prompt",
      plan.instructions,
    ];
    if (
      plan.taskScoped ||
      (capabilities.write && plan.tools.includes("shell"))
    ) {
      args.push(
        "--settings",
        JSON.stringify({
          ...(capabilities.write && plan.tools.includes("shell")
            ? {
                sandbox: {
                  enabled: true,
                  failIfUnavailable: true,
                  allowUnsandboxedCommands: false,
                  autoAllowBashIfSandboxed: true,
                },
              }
            : {}),
          ...(plan.taskScoped ||
          (capabilities.write && plan.tools.includes("shell"))
            ? {
                permissions: {
                  ...(plan.taskScoped ? { additionalDirectories: [] } : {}),
                  blockReadsOutsideWorkingDirectories: true,
                },
              }
            : {}),
        }),
      );
    }
    const extraRoots = roots
      .map((root) => root.path)
      .filter((path) => path !== cwd);
    if (extraRoots.length) args.push("--add-dir", ...extraRoots);
    if (plan.model !== "default") args.push("--model", plan.model);
    if (plan.effort) args.push("--effort", plan.effort);
    if (sessionId) args.push("--resume", sessionId);
    return {
      executable: executablePaths.claude ?? "claude",
      args,
      stdin: prompt,
      cwd,
      ...(capabilities.write && plan.tools.includes("shell")
        ? { allowedTools: ["Bash"] }
        : {}),
    };
  }
  const writable = workspaceCapabilities(plan).write;
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    ...(plan.taskScoped
      ? [
          "--strict-config",
          "--ephemeral",
          ...codexTaskPermissions(roots, plan.tools).flatMap((setting) => [
            "-c",
            setting,
          ]),
        ]
      : [
          "-c",
          `sandbox_mode=${JSON.stringify(writable ? "workspace-write" : "read-only")}`,
        ]),
    "-c",
    'approval_policy="never"',
    ...(plan.executionMode === "file-only" || !plan.tools.includes("shell")
      ? ["-c", "features.shell_tool=false"]
      : []),
  ];
  if (writable && !plan.taskScoped)
    for (const root of roots)
      if (root.path !== cwd) args.push("--add-dir", root.path);
  if (plan.model !== "default") args.push("--model", plan.model);
  if (plan.effort)
    args.push("-c", `model_reasoning_effort=${JSON.stringify(plan.effort)}`);
  if (sessionId) args.push("resume", sessionId, "-");
  else args.push("-");
  return {
    executable: executablePaths.codex ?? "codex",
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
        if (content.type === "text") {
          // Claude can emit an auth refresh failure as assistant text and then exit with a
          // misleading `success` result. Catch the provider diagnostic before it is shown as a
          // normal answer so the conversation can give the user a useful sign-in instruction.
          if (
            /failed to authenticate:.*oauth session expired|oauth session expired.*could not be refreshed/i.test(
              content.text,
            )
          )
            throw new AppError(
              401,
              "authentication_required",
              "Claude Code needs you to sign in again. Press Sign in (top bar or Settings) or run `claude auth login` in a terminal, then retry this message.",
            );
          events.push({ type: "text", data: content.text });
        }
    if (event.type === "result") {
      if (event.is_error || event.subtype !== "success") {
        const detail = [
          event.error?.message,
          typeof event.error === "string" ? event.error : undefined,
          typeof event.message === "string" ? event.message : undefined,
          Array.isArray(event.errors)
            ? event.errors
                .map((item: unknown) =>
                  typeof item === "string"
                    ? item
                    : (item as { message?: unknown })?.message,
                )
                .filter(
                  (item: unknown): item is string => typeof item === "string",
                )
                .join("; ")
            : typeof event.errors === "string"
              ? event.errors
              : undefined,
        ].find((value) => typeof value === "string" && value.length);
        throw new AppError(
          502,
          "provider_error",
          `Claude request failed: ${detail ?? (event.subtype === "success" ? "the CLI reported an error without details" : (event.subtype ?? "unknown error"))}`,
        );
      }
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
  hooks?: RuntimeHooks,
) {
  try {
    await executeCommandRaw(command, environment, onEvent, signal, hooks);
  } catch (e) {
    throw toProviderError(e, { cancelled: signal.aborted });
  }
}
async function executeCommandRaw(
  command: Command,
  environment: string,
  onEvent: (event: RuntimeEvent) => void,
  signal: AbortSignal,
  hooks?: RuntimeHooks,
) {
  const limits = providerLimits(hooks?.profile ?? "chat");
  if (command.acp)
    return acpAdapter.execute(command, environment, onEvent, signal, hooks);
  signal.throwIfAborted();
  let temporary: string | undefined;
  try {
    let args = [...command.args];
    if (command.request || command.teammateTools) {
      temporary = await mkdtemp(join(tmpdir(), "agentteam-request-"));
    }
    if (command.request) {
      const path = join(temporary!, "input.json");
      await writeFile(path, JSON.stringify(command.request), { mode: 0o600 });
      args.push(path);
    }
    if (command.teammateTools && environment === "claude") {
      const path = join(temporary!, "mcp.json");
      await writeFile(
        path,
        JSON.stringify({
          mcpServers: {
            agentteam: {
              type: "http",
              url: command.teammateTools.url,
              headers: {
                Authorization: "Bearer ${AGENTTEAM_TOOL_TOKEN}",
              },
            },
          },
        }),
        { mode: 0o600 },
      );
      args.push("--mcp-config", path);
    } else if (command.teammateTools && environment === "codex") {
      const settings = [
        `mcp_servers.agentteam.url=${JSON.stringify(command.teammateTools.url)}`,
        'mcp_servers.agentteam.bearer_token_env_var="AGENTTEAM_TOOL_TOKEN"',
      ];
      args.splice(1, 0, ...settings.flatMap((setting) => ["-c", setting]));
    }
    if (environment === "claude") {
      const allowedTools = [
        ...(command.allowedTools ?? []),
        ...(command.teammateTools
          ? [
              "mcp__agentteam__invoke_teammate",
              "mcp__agentteam__teammate_result",
            ]
          : []),
      ];
      if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
    }
    const plan = await planSpawn(command.executable, args);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(plan.command, plan.args, {
        cwd: command.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        ...(command.teammateTools
          ? {
              env: {
                ...process.env,
                AGENTTEAM_TOOL_TOKEN: command.teammateTools.token,
              },
            }
          : {}),
        ...plan.options,
      });
      if (child.pid) hooks?.onSpawn?.(child.pid);
      let buffer = "",
        stderr = "",
        bytes = 0,
        finished = false;
      let failure: Error | undefined;
      let force: ReturnType<typeof setTimeout> | undefined;
      const stop = (e: Error) => {
        if (failure) return;
        failure = e;
        killPlanned(child, plan, "SIGTERM");
        force = setTimeout(() => killPlanned(child, plan, "SIGKILL"), 2000);
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
              `Provider exceeded the ${limits.timeoutMs / 1000}-second limit`,
            ),
          ),
        limits.timeoutMs,
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
        if (bytes > limits.maxOutputBytes) {
          stop(
            new Error(
              `Provider output exceeded ${limits.maxOutputBytes / 1_000_000} MB`,
            ),
          );
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
/**
 * Provider prompt for the queued user messages of one run: the message itself when there is one;
 * otherwise all of them in order, the last marked as the current request, so the reply covers
 * everything the user sent while no run was active.
 */
export function pendingPrompt(pending: { text: string }[]) {
  if (pending.length === 1) return pending[0].text;
  return (
    "The user sent several messages since your last reply. Answer them together; the last one is the current request.\n\n" +
    pending
      .map(
        (m, i) =>
          `${i === pending.length - 1 ? "Current request" : `Earlier message ${i + 1}`}:\n${m.text}`,
      )
      .join("\n\n")
  );
}
export class RunManager {
  service: TeamService;
  enabled: boolean;
  cwd: string;
  active = new Map<string, AbortController>();
  private pauseMode: "draining" | "stopping" | "paused" = "paused";
  readonly executionInterrupts = new Set<string>();
  executionState() {
    const active =
      this.active.size +
      this.service.graphs.activeCommandCount() +
      this.service.validation.active.size;
    if (!this.enabled && !active && this.pauseMode !== "paused") {
      this.pauseMode = "paused";
      this.service.store.put("settings", {
        id: "execution",
        enabled: false,
        mode: "paused",
      });
    }
    return {
      mode: this.enabled ? ("running" as const) : this.pauseMode,
      active,
      readyToClose: !this.enabled && active === 0,
    };
  }
  changeExecution(action: "resume" | "wrap-up" | "pause-now") {
    const store = this.service.store;
    assert(
      action === "pause-now" ||
        this.pauseMode !== "stopping" ||
        this.executionState().active === 0,
      "execution_stopping",
      "Wait for interrupted processes to stop before resuming",
      409,
    );
    this.enabled = action === "resume";
    if (action !== "resume")
      this.pauseMode = action === "wrap-up" ? "draining" : "stopping";
    if (action === "pause-now") {
      for (const [id, controller] of this.active) {
        this.executionInterrupts.add(id);
        store.put("execution-interrupted", {
          id,
          kind: id.startsWith("task:") ? "task" : "chat",
          createdAt: new Date().toISOString(),
        });
        controller.abort();
      }
      this.service.graphs.interruptCommands();
      for (const run of this.service.validation.activeRuns())
        this.service.validation.cancel(run.runId);
    }
    if (action === "resume") {
      for (const record of store.list<{ id: string; kind: string }>(
        "execution-interrupted",
      )) {
        if (record.kind !== "task") continue;
        const taskId = record.id.slice(5);
        try {
          const task = store.get<Task>("task", taskId);
          if (
            task.status === "interrupted" &&
            !this.service.recovery.ledger.uncertainFor(taskId).length
          )
            this.service.recovery.requeue(taskId);
          if (
            ["queued", "completed", "cancelled"].includes(
              store.get<Task>("task", taskId).status,
            )
          )
            store.remove("execution-interrupted", record.id);
        } catch {
          /* Recovery keeps tasks whose effects or gates need an explicit decision. */
        }
      }
    }
    const execution = this.executionState();
    store.put("settings", {
      id: "execution",
      enabled: this.enabled,
      mode: execution.mode,
    });
    store.emit("execution.changed", "execution", {
      enabled: this.enabled,
      ...execution,
      action,
    });
    return { enabled: this.enabled, ...execution };
  }
  finishActive(id: string) {
    this.active.delete(id);
    this.executionInterrupts.delete(id);
    if (!this.enabled)
      this.service.store.emit("execution.changed", "execution", {
        enabled: false,
        ...this.executionState(),
      });
  }
  readonly toolSessions = new ToolSessions();
  /** Resolved from the bound loopback HTTP server only while building a provider run. */
  teammateToolsUrl?: () => string | null;
  /**
   * Reports whether the provider runtime for an environment is resolved. When set, direct-CLI work
   * stays queued while resolving and fails with a clear message when the runtime is unavailable.
   */
  readiness?: (environment: string) => Readiness;
  /** Installed version of a runtime for the launch manifest (wired like `readiness`). */
  runtimeVersion?: (environment: string) => string | null | undefined;
  /** Internal dependency seam for provider/delegation fixtures; production always prepares code assignments. */
  prepareExecutableChats = true;
  /** Provider executor for chat runs; replaceable so sandboxes (playground) never reach real CLIs. */
  execute: typeof executeCommand = executeCommand;
  /** Actual provider host; fixture executors can explicitly select their simulated platform. */
  runtimePlatform: NodeJS.Platform = process.platform;
  assertCommandReady(command: Command, environment: string) {
    assertProviderCapabilities(command, environment, this.runtimePlatform);
  }
  constructor(service: TeamService, enabled: boolean, cwd: string) {
    this.service = service;
    this.enabled = enabled;
    this.cwd = cwd;
    this.service.graphs.enabled = () => this.enabled;
    this.service.runtimeReadiness = (environment) =>
      this.readiness?.(environment);
    this.service.hostPlatform = () => this.runtimePlatform;
  }
  recover() {
    const store = this.service.store;
    store.transaction(() => {
      // A run request that never started has no external effect, so it survives the restart
      // (e.g. delivered review feedback); stale ones without a queued message are dropped.
      for (const request of store.list<{ id: string }>("run-request"))
        if (
          !store
            .list<Message>("message")
            .some(
              (m) =>
                m.sessionId === request.id &&
                m.role === "user" &&
                m.status === "queued",
            )
        )
          store.remove("run-request", request.id);
      this.service.locks.reconcile();
      for (const session of store.list<Session>("session"))
        if (session.state === "running") {
          session.state = "idle";
          delete session.startedAt;
          delete session.timeoutMs;
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
    // A CLI or native app already drives this agent: never drive the session twice.
    this.service.ownership.assertEmbeddedMayRun(agent.id);
    this.service.assertNotRetired(agent);
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
    let plan = await this.service.launchPlan(agent.id);
    this.assertRuntimeReady(plan);
    await Promise.all(
      plan.workspaces
        .filter((workspace) => workspace.access === "write")
        .map((workspace) =>
          ensureWorkspaceBaseline(store, agent, workspace.path),
        ),
    );
    if (agent.kind === "team-assistant")
      plan.instructions +=
        "\n\n" +
        assistantContext(this.service, {
          liveEnabled: () => this.enabled,
          readiness: (environment) =>
            this.readiness?.(environment) ?? { state: "ready" },
        }).text;
    // EVERY queued user message of the session goes into this run, oldest first. Taking only the
    // oldest one left a backlog (a message sent while execution was paused stays queued), so each
    // later run answered the previous message and the newest one stayed queued.
    const pending = store
      .list<Message>("message")
      .filter(
        (m) =>
          m.sessionId === sessionId &&
          m.role === "user" &&
          m.status === "queued",
      );
    assert(pending.length, "queue_empty", "No queued message");
    const message = pending[pending.length - 1];
    const request = pendingPrompt(pending);
    // Skill selection (always/on-demand), cited knowledge and the per-run context record.
    const context = prepareRunContext(this.service, plan, request, sessionId);
    if (context instanceof Promise) await context;
    let prompt = request;
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
    let command = commandFor(plan, session.providerSessionId, prompt, this.cwd);
    this.assertCommandReady(command, plan.environment);
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
      current.startedAt = new Date().toISOString();
      current.timeoutMs = providerLimits("chat").timeoutMs;
      store.put("session", current);
      for (const m of pending) {
        m.status = "processing";
        store.put("message", m);
      }
      store.emit("session.started", sessionId, {
        messageId: message.id,
        messageIds: pending.map((m) => m.id),
        transport: plan.connection?.transport ?? "direct",
        environment: plan.environment,
        model: plan.model,
        effort: plan.effort,
      });
    });
    let conversationTask: Task | undefined;
    const toolsUrl = this.teammateToolsUrl?.();
    const canDelegate = this.service.store
      .list<Agent>("agent")
      .some(
        (other) =>
          other.id !== agent.id &&
          this.service.permitted(agent.id, other.id, "delegate"),
      );
    const prepared = store
      .list<{ id: string; workflowId: string }>("prepared-chat")
      .find((r) => r.id === sessionId);
    if (
      canDelegate ||
      prepared ||
      classifyRequest(request).workKind !== "response-only"
    ) {
      try {
        const title = request.trim().slice(0, 300) || "Agent conversation";
        const workflow = prepared
          ? store.get<{ id: string }>("workflow", prepared.workflowId)
          : this.service.workflow({
              kind: "conversation",
              name: `Chat: ${title}`.slice(0, 300),
              goal: request.slice(0, 5000) || "Respond to the user's message",
              ownerId: agent.id,
              completionCriteria:
                "Respond to the user and return any delegated results.",
            });
        conversationTask = this.service.task({
          workflowId: workflow.id,
          agentId: agent.id,
          title: request.slice(0, 1000) || "Respond to the user",
          instructions: request.slice(0, 50000),
          dependsOn: [],
          completionCriteria: "Return a direct response to the user.",
        });
        // Chat preparation (src/execution-contract.ts): an actionable request gets its contract
        // here, before any child can start, and the readiness of the workers it can reach is
        // recorded as one setup state. A model that omits or misclassifies the contract later
        // cannot lower what was established from the user's own words.
        if (!prepared)
          this.service.contracts.prepareConversation({
            workflowId: workflow.id,
            agent,
            text: request,
            origin: { sessionId, messageId: message.id },
          });
        if (!canDelegate)
          this.service.contracts.seedTask({
            task: conversationTask,
            text: request,
            source: "request",
          });
        this.service.setups.prepareConversation(workflow.id);
        if (
          this.prepareExecutableChats &&
          this.service.executionProjects.canStart(workflow.id)
        ) {
          const message =
            "Review the project folder, languages and independent verification plan in the assignment setup, then choose Start. No provider or implementation run has started.";
          this.service.setups.requirePreparation(workflow.id);
          noteRuntimeWait(store, {
            kind: "task",
            targetId: conversationTask.id,
            environment: agent.environment,
            reason: "assignment-preparation",
            capability: "prepared-project",
            message,
            attempt: this.service.recovery.state(conversationTask.id).attempt,
            issues: [
              {
                code: "project-preparation",
                capability: null,
                agentId: agent.id,
                agentName: agent.name,
                taskId: conversationTask.id,
                message,
                fix: {
                  kind: "choose-project-folder",
                  label: "Review assignment setup",
                  agentId: agent.id,
                },
              },
            ],
          });
          this.service.transitionTask(conversationTask.id, {
            status: "blocked",
            result: message,
          });
          store.transaction(() => {
            const current = store.get<Session>("session", sessionId);
            current.state = "idle";
            delete current.startedAt;
            delete current.timeoutMs;
            store.put("session", current);
            this.service.resources.release(sessionId);
            for (const pendingMessage of pending) {
              pendingMessage.status = "delivered";
              store.put("message", pendingMessage);
            }
            const reply = {
              id: randomUUID(),
              sessionId,
              role: "assistant" as const,
              text: message,
              status: "delivered" as const,
              createdAt: new Date().toISOString(),
            };
            store.put("message", reply);
            store.emit("message.delivered", reply.id, {
              sessionId,
              source: "project-preparation",
              workflowId: workflow.id,
            });
            store.emit("session.idle", sessionId, { agentId: agent.id });
          });
          store.remove("prepared-chat", sessionId);
          return {
            sessionId,
            messageId: pending[pending.length - 1].id,
            status: "setup-required",
            workflowId: workflow.id,
          };
        }
        if (prepared) {
          plan = await this.service.launchPlan(agent.id, conversationTask.id);
          command = commandFor(plan, null, prompt, this.cwd);
        }
        const decision = this.service.launchReadiness.evaluatePlan(
          agent,
          plan,
          { task: conversationTask },
        );
        if (!canDelegate && !decision.ready) {
          this.service.launchReadiness.blockTask(conversationTask, decision);
          store.transaction(() => {
            const current = store.get<Session>("session", sessionId);
            current.state = "idle";
            delete current.startedAt;
            delete current.timeoutMs;
            store.put("session", current);
            this.service.resources.release(sessionId);
            for (const pendingMessage of pending) {
              pendingMessage.status = "delivered";
              store.put("message", pendingMessage);
            }
            store.put<Message>("message", {
              id: randomUUID(),
              sessionId,
              role: "assistant",
              text: decision.message ?? "Setup required.",
              status: "delivered",
              createdAt: new Date().toISOString(),
            });
            store.emit("session.idle", sessionId, { agentId: agent.id });
          });
          store.remove("prepared-chat", sessionId);
          return {
            sessionId,
            messageId: message.id,
            status: "setup-required",
            workflowId: workflow.id,
          };
        }
        store.remove("prepared-chat", sessionId);
        const host = { platform: this.runtimePlatform };
        this.service.startConversationTask(conversationTask.id, sessionId, {
          launchManifest: launchManifest(this.service, {
            agent,
            task: conversationTask,
            plan,
            decision: this.service.launchReadiness.evaluatePlan(agent, plan, {
              task: conversationTask,
              host,
            }),
            host,
            adapterVersion: this.runtimeVersion?.(plan.environment),
            teammateTools: true,
          }),
        });
        if (
          toolsUrl &&
          plan.connection?.transport !== "acp" &&
          ["claude", "codex"].includes(plan.environment)
        ) {
          const toolToken = this.toolSessions.issue({
            agentId: agent.id,
            taskId: conversationTask.id,
          });
          command.teammateTools = { url: toolsUrl, token: toolToken };
        }
      } catch (error) {
        if (conversationTask?.status === "queued")
          this.service.transitionTask(conversationTask.id, {
            status: "cancelled",
          });
        conversationTask = undefined;
        const current = store.get<Session>("session", sessionId);
        current.state = "idle";
        delete current.startedAt;
        delete current.timeoutMs;
        store.put("session", current);
        this.service.resources.release(sessionId);
        for (const pendingMessage of pending) {
          pendingMessage.status = "queued";
          store.put("message", pendingMessage);
        }
        throw error;
      }
    }
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    void this.run(
      sessionId,
      pending,
      command,
      plan,
      controller,
      conversationTask,
    ).finally(() => this.finishActive(sessionId));
    return { sessionId, messageId: message.id, status: "running" };
  }
  /** Throws `runtime_resolving` (retryable) or `runtime_unavailable` for direct-CLI plans. */
  assertRuntimeReady(plan: LaunchPlan) {
    if (!this.readiness || plan.connection?.transport === "acp") return;
    const ready = this.readiness(plan.environment);
    assert(
      ready.state !== "resolving",
      "runtime_resolving",
      `Waiting for the ${plan.environment} runtime to be resolved`,
      409,
    );
    assert(
      ready.state === "ready",
      "runtime_unavailable",
      ready.state === "unavailable" ? ready.message : "",
      424,
    );
  }
  private async run(
    id: string,
    messages: Message[],
    command: Command,
    plan: LaunchPlan,
    controller: AbortController,
    conversationTask?: Task,
  ) {
    const store = this.service.store;
    const message = messages[messages.length - 1];
    const setStatus = (status: Message["status"]) => {
      for (const m of messages) {
        m.status = status;
        store.put("message", m);
      }
    };
    let text = "";
    let effectId: string | null = null;
    try {
      // Ledger: a mutating chat run interrupted by a crash needs a user decision before it is repeated.
      effectId = this.service.recovery.ledger.begin({
        taskId: id,
        key: "chat:" + message.id,
        kind: "chat-run",
        description: "Chat run for message " + message.id.slice(0, 8),
        mutating:
          plan.connection?.transport === "acp" ||
          plan.workspaces.some((w) => w.access === "write"),
        ref: { messageId: message.id },
      }).effect.id;
      await this.execute(
        command,
        plan.environment,
        (event) => {
          if (event.type === "session") {
            const session = store.get<Session>("session", id);
            session.providerSessionId = String(event.data);
            store.put("session", session);
            if (conversationTask)
              this.service.recovery.observe(conversationTask, event);
          }
          if (event.type === "text")
            text += (command.acp ? "" : text ? "\n" : "") + String(event.data);
          store.emit("runtime." + event.type, id, event.data);
        },
        controller.signal,
        {
          onSpawn: (pid) => this.service.resources.attachProcess(id, pid),
          permission: (request, signal) =>
            this.service.approvals.request(plan.agentId, request, signal),
        },
      );
      if (effectId) this.service.recovery.ledger.complete(effectId);
      assert(
        text.trim(),
        "empty_result",
        "Provider returned no assistant text",
        502,
      );
      store.transaction(() => {
        setStatus("delivered");
        store.put<Message>("message", {
          id: randomUUID(),
          sessionId: id,
          ...(message.groupChatId ? { groupChatId: message.groupChatId } : {}),
          role: "assistant",
          text,
          status: "delivered",
          createdAt: new Date().toISOString(),
        });
        if (message.groupChatId)
          new GroupChats(this.service).recordReply(
            message.groupChatId,
            plan.agentId,
            text,
          );
        store.emit("session.completed", id);
      });
      if (conversationTask) {
        await this.service.delegations.verifyChildren(conversationTask);
        if (
          !this.service.delegations.defer(
            conversationTask,
            text,
            command.cwd,
            id,
          )
        ) {
          const evidence = await this.service.limits.evaluate(
            conversationTask,
            text.slice(0, 100000),
            command.cwd,
          );
          if (evidence && !evidence.passed)
            throw new Error(this.service.limits.failedChecksText(evidence));
          this.service.transitionTask(conversationTask.id, {
            status: "completed",
            result: text.slice(0, 100000),
          });
        }
      }
    } catch (e) {
      if (effectId) this.service.recovery.failEffect(effectId, e);
      if (this.executionInterrupts.has(id) && text.trim()) {
        store.put("message", {
          id: randomUUID(),
          sessionId: id,
          ...(message.groupChatId ? { groupChatId: message.groupChatId } : {}),
          role: "assistant",
          text:
            "Paused immediately — partial response. Check any changes before continuing.\n\n" +
            text.slice(0, 100000),
          status: "delivered",
          createdAt: new Date().toISOString(),
        });
      }
      if (conversationTask) {
        try {
          this.service.transitionTask(conversationTask.id, {
            status: this.executionInterrupts.has(id)
              ? "interrupted"
              : controller.signal.aborted
                ? "cancelled"
                : "failed",
            result:
              e instanceof Error
                ? e.message.slice(0, 100000)
                : "Runtime failed",
          });
        } catch {}
      }
      store.transaction(() => {
        setStatus("failed");
        store.emit(
          controller.signal.aborted ? "session.cancelled" : "session.failed",
          id,
          {
            message: e instanceof Error ? e.message : "Runtime failed",
            kind: errorKindOf(e),
          },
        );
      });
    } finally {
      if (command.teammateTools)
        this.toolSessions.revoke(command.teammateTools.token);
      this.service.approvals.cancelAgent(plan.agentId);
      const session = store.get<Session>("session", id);
      this.service.resources.release(id);
      session.state = "idle";
      delete session.startedAt;
      delete session.timeoutMs;
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
