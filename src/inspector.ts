import { z } from "zod";
import { basename, dirname, isAbsolute, join } from "node:path";
import { realpath } from "node:fs/promises";
import { overlaps, contains } from "./resources.ts";
import { priorityName } from "./priorities.ts";
import { invocationSummary } from "./invocation-view.ts";
import { Redactor } from "./redact.ts";
import type { Event } from "./store.ts";
import type { TeamService } from "./service.ts";
import type { Agent, Edge, Session, Task, Workflow } from "./model.ts";
import type { Lease } from "./resources.ts";
import type { ApprovalRecord } from "./approvals.ts";

/**
 * Run inspector read-model. Everything here derives from existing events and entities; nothing
 * mutates state. The same functions back the HTTP routes (inspector-routes.ts), the UI and the
 * diagnostic export (diagnostics.ts).
 */
export type Severity = "debug" | "info" | "warn" | "error";
const SEVERITY_ORDER: Severity[] = ["debug", "info", "warn", "error"];
export type Category =
  | "message"
  | "tool"
  | "setting"
  | "task"
  | "transfer"
  | "lock"
  | "approval"
  | "result"
  | "limit"
  | "workflow"
  | "validation"
  | "effect"
  | "checkpoint"
  | "agent"
  | "other";
export type TimelineEntry = {
  seq: number;
  at: string;
  type: string;
  category: Category;
  severity: Severity;
  summary: string;
  /** Groups everything that belongs to one task run / conversation / workflow. */
  correlationId: string;
  agentId: string | null;
  agentName: string | null;
  /** Every agent involved (a transfer touches two). */
  agentIds: string[];
  taskId: string | null;
  workflowId: string | null;
  sessionId: string | null;
  approvalId: string | null;
  files: string[];
  /** Conversation the event belongs to (the agent's chat session), when one exists. */
  conversation: { sessionId: string; agentId: string } | null;
  data: unknown;
};
export type Readiness =
  | { state: "resolving" }
  | { state: "ready" }
  | { state: "unavailable"; message: string };
/** Runtime facts the service itself does not own (RunManager is wired in http.ts / desktop). */
export type InspectorContext = {
  liveEnabled: () => boolean;
  readiness?: (environment: string) => Readiness;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const FILE_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "file_path",
  "cwd",
  "locations",
  "uri",
]);
/** File paths named by event data. Only names; contents are never read. */
export function filesIn(data: unknown, out = new Set<string>(), depth = 0) {
  if (depth > 5 || out.size >= 12) return [...out];
  if (Array.isArray(data)) {
    for (const v of data) filesIn(v, out, depth + 1);
  } else if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (FILE_KEYS.has(k.toLowerCase().replace(/-/g, "_"))) {
        const list = Array.isArray(v) ? v : [v];
        for (const item of list) {
          if (typeof item === "string" && item.length < 500) {
            out.add(item.replace(/^file:\/\//, ""));
          } else if (item && typeof item === "object")
            filesIn(item, out, depth + 1);
        }
      } else if (typeof v === "object") filesIn(v, out, depth + 1);
    }
  }
  return [...out].slice(0, 12);
}

type Lookups = {
  agents: Map<string, Agent>;
  tasks: Map<string, Task>;
  sessions: Map<string, Session>;
  sessionByAgent: Map<string, Session>;
  approvals: Map<string, ApprovalRecord>;
};
function lookups(service: TeamService): Lookups {
  const store = service.store;
  const sessions = store.list<Session>("session");
  return {
    agents: new Map(store.list<Agent>("agent").map((a) => [a.id, a])),
    tasks: new Map(store.list<Task>("task").map((t) => [t.id, t])),
    sessions: new Map(sessions.map((s) => [s.id, s])),
    sessionByAgent: new Map(sessions.map((s) => [s.agentId, s])),
    approvals: new Map(
      store.list<ApprovalRecord>("approval").map((a) => [a.id, a]),
    ),
  };
}
const TERMINAL_TASK = new Set(["completed", "failed", "cancelled"]);

function classify(
  e: Event,
  d: Record<string, unknown>,
): { category: Category; severity: Severity; summary: string } {
  const t = e.type;
  const status = str(d.status);
  if (t === "task.runtime") {
    const inner = str(d.type) ?? "event";
    const innerData = asRecord(d.data);
    if (inner === "tool")
      return {
        category: "tool",
        severity: innerData.status === "failed" ? "error" : "info",
        summary: `Tool ${str(innerData.title) ?? str(innerData.kind) ?? "call"} (${str(innerData.status) ?? "update"})`,
      };
    if (inner === "text")
      return {
        category: "message",
        severity: "debug",
        summary: "Agent output",
      };
    if (inner === "usage")
      return {
        category: "setting",
        severity: "debug",
        summary: "Usage reported",
      };
    return {
      category: inner === "permission" ? "approval" : "task",
      severity: "debug",
      summary: `Runtime ${inner}`,
    };
  }
  if (t === "task.status") {
    const bad = status === "failed";
    const warn =
      status === "interrupted" ||
      status === "blocked" ||
      status === "cancelled";
    return {
      category: status && TERMINAL_TASK.has(status) ? "result" : "task",
      severity: bad ? "error" : warn ? "warn" : "info",
      summary: `Task ${status ?? "updated"}`,
    };
  }
  if (t === "task.settings")
    return {
      category: "setting",
      severity: "info",
      summary: `Run settings: ${str(d.environment) ?? "?"} / ${str(d.model) ?? "default"}${d.effort ? " / " + String(d.effort) : ""} / priority ${String(d.priority ?? "?")}`,
    };
  if (t === "session.started")
    return {
      category: "setting",
      severity: "info",
      summary: `Conversation run started${d.model ? ` (${String(d.model)}${d.effort ? " / " + String(d.effort) : ""})` : ""}`,
    };
  if (t === "flow.transferred")
    return {
      category: "transfer",
      severity: d.kind === "failure" ? "error" : "info",
      summary: `Transfer ${str(d.kind) ?? ""}`,
    };
  if (t.startsWith("runtime.")) {
    const inner = t.slice(8);
    return {
      category:
        inner === "tool" ? "tool" : inner === "text" ? "message" : "setting",
      severity: inner === "tool" || inner === "text" ? "info" : "debug",
      summary: `Conversation ${inner}`,
    };
  }
  if (t === "message.queued")
    return { category: "message", severity: "info", summary: "Message queued" };
  if (t.startsWith("session.")) {
    const failed = t === "session.failed" || t === "session.interrupted";
    return {
      category: t === "session.completed" || failed ? "result" : "message",
      severity: t === "session.failed" ? "error" : failed ? "warn" : "info",
      summary: t.replace("session.", "Conversation ").replace("_", " "),
    };
  }
  if (t.startsWith("resource."))
    return {
      category: "lock",
      severity: "info",
      summary: t.endsWith("acquired")
        ? "Lock acquired"
        : t.endsWith("released")
          ? "Lock released"
          : "Resource configured",
    };
  if (t.startsWith("approval."))
    return {
      category: "approval",
      severity:
        t === "approval.requested" || t === "approval.expired"
          ? "warn"
          : "info",
      summary: t.replace("approval.", "Approval "),
    };
  if (t.startsWith("validation."))
    return {
      category: "validation",
      severity:
        status === "fail"
          ? "error"
          : status && status !== "pass"
            ? "warn"
            : "info",
      summary: `Validation ${t.slice(11)}${status ? " (" + status + ")" : ""}`,
    };
  if (t.startsWith("effect."))
    return {
      category: "effect",
      severity:
        d.state === "uncertain"
          ? "warn"
          : d.state === "failed"
            ? "error"
            : "info",
      summary: `Effect ${str(d.state) ?? t.slice(7)}`,
    };
  if (t.startsWith("checkpoint."))
    return {
      category: "checkpoint",
      severity: "debug",
      summary: "Checkpoint saved",
    };
  if (t === "workflow.limit_tripped")
    return {
      category: "limit",
      severity: "warn",
      summary: `Limit tripped: ${str(d.reason) ?? str(d.kind) ?? ""}`,
    };
  if (t.startsWith("workflow.")) {
    return {
      category: t.includes("limit") ? "limit" : "workflow",
      severity: t === "workflow.paused" ? "warn" : "info",
      summary: t.replace("workflow.", "Workflow ").replace("_", " "),
    };
  }
  if (t === "tasks.recovered")
    return {
      category: "task",
      severity: "warn",
      summary: "Tasks recovered after restart",
    };
  if (t.startsWith("task.") || t === "delegation.returned")
    return {
      category: "task",
      severity: "info",
      summary: t.replace("task.", "Task ").replace("_", " "),
    };
  if (t.startsWith("agent."))
    return {
      category: "agent",
      severity: "info",
      summary: t.replace("agent.", "Agent ").replace("_", " "),
    };
  if (t === "connections.updated" || t === "execution.changed")
    return {
      category: "setting",
      severity: "info",
      summary: t.replace(".", " "),
    };
  const failed = /failed|error|denied/.test(t);
  return { category: "other", severity: failed ? "error" : "info", summary: t };
}

/** Resolves ownership of one event: agent(s), task, workflow, conversation, approval. */
function correlate(e: Event, d: Record<string, unknown>, l: Lookups) {
  let taskId: string | null = null,
    workflowId: string | null = str(d.workflowId),
    sessionId: string | null = null,
    approvalId: string | null = null;
  const agents = new Set<string>();
  const t = e.type;
  const addAgent = (v: unknown) => {
    const a = str(v);
    if (a) agents.add(a);
  };
  addAgent(d.agentId);
  if (t === "flow.transferred") {
    taskId = str(d.taskId) ?? e.entityId;
    addAgent(d.fromAgentId);
    addAgent(d.toAgentId);
  } else if (t.startsWith("approval.")) {
    approvalId = str(d.id);
    const rec = approvalId ? l.approvals.get(approvalId) : undefined;
    taskId = str(d.taskId) ?? rec?.taskId ?? null;
    addAgent(e.entityId);
  } else if (
    t.startsWith("task.") ||
    t.startsWith("checkpoint.") ||
    t.startsWith("effect.") ||
    t === "delegation.returned"
  ) {
    taskId = e.entityId;
  } else if (t.startsWith("resource.slot")) {
    taskId = str(d.taskId);
  } else if (t.startsWith("resource.")) {
    if (l.tasks.has(e.entityId)) taskId = e.entityId;
    else if (l.sessions.has(e.entityId)) sessionId = e.entityId;
    const lease = asRecord(d);
    addAgent(lease.agentId);
    workflowId = workflowId ?? str(lease.workflowId);
  } else if (t.startsWith("validation.")) {
    taskId = str(d.taskId);
  } else if (
    t.startsWith("session.") ||
    t.startsWith("runtime.") ||
    t === "message.queued"
  ) {
    sessionId = e.entityId;
  } else if (t.startsWith("workflow.")) {
    workflowId = workflowId ?? e.entityId;
  } else if (t.startsWith("agent.")) {
    addAgent(e.entityId);
  }
  const task = taskId ? l.tasks.get(taskId) : undefined;
  if (task) {
    addAgent(task.agentId);
    workflowId = workflowId ?? task.workflowId;
  }
  const session = sessionId ? l.sessions.get(sessionId) : undefined;
  if (session) addAgent(session.agentId);
  const agentIds = [...agents];
  const primary = agentIds[0] ?? null;
  const convo = agentIds.map((a) => l.sessionByAgent.get(a)).find(Boolean);
  return {
    taskId,
    workflowId,
    sessionId: sessionId ?? null,
    approvalId,
    agentIds,
    agentId: primary,
    agentName: primary ? (l.agents.get(primary)?.name ?? null) : null,
    correlationId: taskId
      ? "task:" + taskId
      : sessionId
        ? "session:" + sessionId
        : workflowId
          ? "workflow:" + workflowId
          : "entity:" + e.entityId,
    conversation: convo
      ? { sessionId: convo.id, agentId: convo.agentId }
      : null,
  };
}

export const timelineFilterSchema = z
  .object({
    agentId: z.string().optional(),
    workflowId: z.string().optional(),
    taskId: z.string().optional(),
    sessionId: z.string().optional(),
    correlationId: z.string().optional(),
    /** Comma list of exact severities. */
    severity: z.string().optional(),
    minSeverity: z.enum(["debug", "info", "warn", "error"]).optional(),
    /** Comma list; each item matches an exact event type, a type prefix ("task.") or a category. */
    type: z.string().optional(),
    q: z.string().max(200).optional(),
    file: z.string().max(500).optional(),
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(5000).default(500),
  })
  .strict();
export type TimelineFilter = z.infer<typeof timelineFilterSchema>;

export function allEvents(service: TeamService, after = 0, cap = 100_000) {
  const out: Event[] = [];
  let cursor = after;
  for (;;) {
    const page = service.store.history(cursor, 500);
    out.push(...page);
    if (page.length < 500 || out.length >= cap) break;
    cursor = page[page.length - 1].seq;
  }
  return out;
}

export function buildTimeline(
  service: TeamService,
  input: Partial<z.input<typeof timelineFilterSchema>> = {},
  redactor = new Redactor({ secretFiles: [], literals: [] }),
) {
  const f = timelineFilterSchema.parse(input);
  const l = lookups(service);
  const wanted = new Set(
    (f.severity ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const types = (f.type ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const minRank = f.minSeverity ? SEVERITY_ORDER.indexOf(f.minSeverity) : 0;
  const q = f.q?.toLowerCase();
  const matched: TimelineEntry[] = [];
  for (const e of allEvents(service, f.after)) {
    const d = asRecord(e.data);
    const c = correlate(e, d, l);
    const k = classify(e, d);
    if (f.agentId && !c.agentIds.includes(f.agentId)) continue;
    if (f.workflowId && c.workflowId !== f.workflowId) continue;
    if (f.taskId && c.taskId !== f.taskId) continue;
    if (f.sessionId && c.sessionId !== f.sessionId) continue;
    if (f.correlationId && c.correlationId !== f.correlationId) continue;
    if (wanted.size && !wanted.has(k.severity)) continue;
    if (SEVERITY_ORDER.indexOf(k.severity) < minRank) continue;
    if (
      types.length &&
      !types.some(
        (t) =>
          e.type === t ||
          k.category === t ||
          (t.endsWith(".") && e.type.startsWith(t)) ||
          (t.endsWith("*") && e.type.startsWith(t.slice(0, -1))),
      )
    )
      continue;
    const files = filesIn(e.data);
    if (f.file && !files.some((x) => x.includes(f.file!))) continue;
    if (q) {
      const hay = (
        e.type +
        " " +
        k.summary +
        " " +
        (c.agentName ?? "") +
        " " +
        JSON.stringify(e.data)
      ).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    matched.push({
      seq: e.seq,
      at: e.createdAt,
      type: e.type,
      ...k,
      summary: redactor.string(k.summary),
      correlationId: c.correlationId,
      agentId: c.agentId,
      agentName: c.agentName,
      agentIds: c.agentIds,
      taskId: c.taskId,
      workflowId: c.workflowId,
      sessionId: c.sessionId,
      approvalId: c.approvalId,
      files: files.map((x) => redactor.string(x)),
      conversation: c.conversation,
      data: redactor.value(e.data),
    });
  }
  const entries = matched.slice(-f.limit);
  const correlations = new Map<
    string,
    { id: string; count: number; first: string; last: string }
  >();
  for (const x of entries) {
    const c = correlations.get(x.correlationId);
    if (c) {
      c.count++;
      c.last = x.at;
    } else
      correlations.set(x.correlationId, {
        id: x.correlationId,
        count: 1,
        first: x.at,
        last: x.at,
      });
  }
  return {
    entries,
    total: matched.length,
    truncated: matched.length > entries.length,
    correlations: [...correlations.values()],
  };
}

// ---- why is this waiting? -------------------------------------------------------------------
export type WaitReason = {
  code: string;
  /** True when this cause alone prevents starting; false for context (queue position, priority). */
  blocking: boolean;
  title: string;
  detail: string;
  taskId?: string;
  refs?: Record<string, unknown>;
};
export type WaitExplanation = {
  subject: { kind: "task" | "agent"; id: string; name: string };
  status: string;
  waiting: boolean;
  headline: string;
  reasons: WaitReason[];
};
const AGING_SECONDS = 5; // keep in step with ResourceCoordinator.score (5 s per priority point)

export function explainWaiting(
  service: TeamService,
  ctx: InspectorContext,
  target: { taskId: string } | { agentId: string },
): WaitExplanation {
  if ("taskId" in target) return explainTask(service, ctx, target.taskId);
  const agent = service.store.get<Agent>("agent", target.agentId);
  const tasks = service.store
    .list<Task>("task")
    .filter(
      (t) =>
        t.agentId === agent.id &&
        ["queued", "interrupted", "blocked", "failed"].includes(t.status),
    );
  const reasons: WaitReason[] = [];
  const activity = service.activity(agent.id);
  if (agent.control === "human")
    reasons.push({
      code: "human-control",
      blocking: true,
      title: "Under human control",
      detail: `${agent.name} was taken over by you; team tasks stay queued until control is returned.`,
    });
  if (activity.runningTaskIds.length || activity.state === "processing")
    reasons.push({
      code: "agent-busy",
      blocking: false,
      title: "Agent is working",
      detail: `${agent.name} is processing ${activity.runningTaskIds.length ? "task(s) " + activity.runningTaskIds.join(", ") : "a conversation"}; further work waits its turn.`,
      refs: { runningTaskIds: activity.runningTaskIds },
    });
  if (activity.queuedMessages)
    reasons.push({
      code: "queued-messages",
      blocking: false,
      title: "Chat messages queued",
      detail: `${activity.queuedMessages} message(s) await a run slot.`,
    });
  for (const t of tasks) {
    const sub = explainTask(service, ctx, t.id);
    for (const r of sub.reasons) reasons.push({ ...r, taskId: t.id });
  }
  const blocking = reasons.find((r) => r.blocking);
  const waiting = !!blocking || tasks.some((t) => t.status === "queued");
  return {
    subject: { kind: "agent", id: agent.id, name: agent.name },
    status: activity.state,
    waiting,
    headline: blocking
      ? `${agent.name} is waiting: ${blocking.title.toLowerCase()}`
      : waiting
        ? `${agent.name} has queued work that can start on the next scheduler tick`
        : `${agent.name} is not waiting on anything`,
    reasons,
  };
}

function explainTask(
  service: TeamService,
  ctx: InspectorContext,
  taskId: string,
): WaitExplanation {
  const store = service.store;
  const task = store.get<Task>("task", taskId);
  const agent = store.get<Agent>("agent", task.agentId);
  const wf = store.get<Workflow>("workflow", task.workflowId);
  const reasons: WaitReason[] = [];
  const push = (r: WaitReason) => reasons.push({ taskId, ...r });
  const subject = { kind: "task" as const, id: task.id, name: task.title };
  const finish = (waiting: boolean, fallback: string): WaitExplanation => {
    const first = reasons.find((r) => r.blocking);
    return {
      subject,
      status: task.status,
      waiting,
      headline: first ? `Waiting: ${first.title}` : fallback,
      reasons,
    };
  };
  const name = (id: string) => store.get<Agent>("agent", id).name;
  const approvals = service.approvals.pendingFor(task.id);
  if (approvals.length)
    push({
      code: "approval-pending",
      blocking: true,
      title: "Waiting for your approval",
      detail: `${approvals.length} permission request(s): ${approvals
        .map(
          (a) =>
            (a.request.toolCall as { title?: string } | undefined)?.title ??
            "tool action",
        )
        .join("; ")}.`,
      refs: { approvalIds: approvals.map((a) => a.id) },
    });
  const uncertain = service.recovery.ledger.uncertainFor(task.id);
  if (uncertain.length)
    push({
      code: "uncertain-effect",
      blocking: true,
      title: "An external effect is uncertain",
      detail: `It is unknown whether this was applied: ${uncertain.map((e) => e.description).join("; ")}. Decide retry, completed or abandon before the task can continue.`,
      refs: { effectIds: uncertain.map((e) => e.id) },
    });
  if (task.status === "running") {
    push({
      code: "running",
      blocking: false,
      title: "Running",
      detail: `${agent.name} holds the work and its resource lease.`,
    });
    return finish(false, `Running: ${agent.name} owns this task now`);
  }
  if (task.status === "completed" || task.status === "cancelled")
    return finish(false, `Task ${task.status}; nothing is pending`);
  if (task.status === "failed") {
    const gate = service.recovery.retryGate(task);
    push({
      code: "failed",
      blocking: !gate.allowed,
      title: gate.allowed
        ? "Failed; retry is available"
        : "Failed; retry is blocked",
      detail: gate.reason,
      refs: { notBefore: gate.notBefore, attemptsLeft: gate.attemptsLeft },
    });
    return finish(false, "Task failed; it will not start without a retry");
  }
  if (task.status === "interrupted" || task.status === "blocked") {
    const s = service.recovery.state(task.id);
    push({
      code: task.status,
      blocking: true,
      title:
        task.status === "blocked"
          ? "Blocked on an uncertain effect"
          : "Interrupted; needs an explicit resume",
      detail:
        s.interruptReason ??
        (task.status === "blocked"
          ? "A mutating step may or may not have happened; resolve the effect first."
          : "The backend stopped while this ran; resume it from its checkpoint."),
    });
  }
  // ---- queued: assemble every cause, not just the first one the scheduler would report ------
  const trip = service.limits.status(wf.id);
  if (trip.trip)
    push({
      code: "workflow-limit",
      blocking: true,
      title: "Workflow stopped by a limit",
      detail: `${trip.trip.reason} Raise the limit and resume the workflow.`,
      refs: { kind: trip.trip.kind },
    });
  else if (wf.paused)
    push({
      code: "workflow-paused",
      blocking: true,
      title: "Workflow is paused",
      detail: `Workflow "${wf.name}" is paused; resume it to let queued work start.`,
    });
  const lim = trip.limits as Record<string, number | null>;
  if (
    lim.maxAgentTurns !== null &&
    trip.counters.agentTurns >= lim.maxAgentTurns
  )
    push({
      code: "workflow-limit",
      blocking: true,
      title: "Turn limit reached",
      detail: `${trip.counters.agentTurns} of ${lim.maxAgentTurns} agent turns are used; starting this task would trip the limit.`,
      refs: { kind: "turns" },
    });
  if (agent.control === "human")
    push({
      code: "human-control",
      blocking: true,
      title: "Agent is under human control",
      detail: `${agent.name} is controlled by you, so team tasks stay queued.`,
    });
  const unfinished = task.dependsOn
    .map((id) => store.get<Task>("task", id))
    .filter((d) => d.status !== "completed");
  if (unfinished.length)
    push({
      code: "dependencies",
      blocking: true,
      title: `Waiting for ${unfinished.length} dependenc${unfinished.length === 1 ? "y" : "ies"}`,
      detail: unfinished
        .map((d) => `"${d.title}" (${name(d.agentId)}) is ${d.status}`)
        .join("; "),
      refs: { dependencyIds: unfinished.map((d) => d.id) },
    });
  const gate = service.validation.gate(task);
  if (gate.required && !gate.open)
    push({
      code: "validation-required",
      blocking: true,
      title: "Required validation has not passed",
      detail: `Gate is ${gate.reason}; ${gate.attemptsUsed} of ${gate.maxAttempts} attempts used for the current inputs.`,
      refs: { reason: gate.reason, latestRecordId: gate.latestRecordId },
    });
  if (task.invokedBy) {
    const cap = service.capacity(task.invokedBy);
    if (!cap.available) {
      const all = store.list<Task>("task");
      const names: Record<string, string> = Object.fromEntries(
        store.list<Agent>("agent").map((a) => [a.id, a.name]),
      );
      const summary = invocationSummary(task.invokedBy, cap.limit, all, names);
      push({
        code: "invocation-limit",
        blocking: true,
        title: "Invoking agent is at its capacity",
        detail: `${name(task.invokedBy)}: ${summary.explanation}`,
        refs: { limit: cap.limit, running: summary.running },
      });
    }
  }
  const busyTask = store
    .list<Task>("task")
    .find(
      (t) =>
        t.agentId === agent.id && t.status === "running" && t.id !== task.id,
    );
  const busySession = store
    .list<Session>("session")
    .find((s) => s.agentId === agent.id && s.state === "running");
  if (busyTask || busySession)
    push({
      code: "agent-busy",
      blocking: true,
      title: "Agent already owns running work",
      detail: busyTask
        ? `${agent.name} is running "${busyTask.title}"; one task per agent at a time.`
        : `${agent.name} is in a running conversation.`,
      refs: { taskId: busyTask?.id, sessionId: busySession?.id },
    });
  const conflicts = service.resources.conflicts(
    agent.id,
    task.workflowId,
    task.id,
  );
  if (conflicts.length) {
    const mine = agent.workspaces.map((w) => w.path);
    push({
      code: "resource-busy",
      blocking: true,
      title: "Shared files or folders are leased",
      detail: conflicts
        .map((lease: Lease) => {
          const pairs = mine.flatMap((p) =>
            lease.paths
              .filter((o) => overlaps(p, o))
              .map((o) => (p === o ? p : `${p} ~ ${o}`)),
          );
          const kind = store.list<Task>("task").some((t) => t.id === lease.id)
            ? "task"
            : "conversation";
          return `${name(lease.agentId)} holds the lease (${kind} ${lease.id.slice(0, 8)}, since ${lease.acquiredAt}) over ${pairs.join(", ")}`;
        })
        .join("; "),
      refs: {
        leases: conflicts.map((l: Lease) => ({
          id: l.id,
          agentId: l.agentId,
          paths: l.paths.filter((o) => mine.some((p) => overlaps(p, o))),
        })),
      },
    });
  }
  const recovery = service.recovery.state(task.id);
  if (recovery.notBefore && Date.parse(recovery.notBefore) > Date.now())
    push({
      code: "retry-backoff",
      blocking: true,
      title: "Retry backoff is running",
      detail: `The automatic retry may not start before ${recovery.notBefore}.`,
    });
  const connection = service.connection(agent.environment);
  if (ctx.readiness && connection.transport !== "acp") {
    const ready = ctx.readiness(agent.environment);
    if (ready.state === "resolving")
      push({
        code: "runtime-resolving",
        blocking: true,
        title: `${agent.environment} runtime is still being detected`,
        detail:
          "The installation scan has not settled, so direct-CLI work stays queued.",
      });
    else if (ready.state === "unavailable")
      push({
        code: "runtime-unavailable",
        blocking: true,
        title: `${agent.environment} runtime is unavailable`,
        detail: `${ready.message}. The task will fail with runtime_unavailable when started.`,
      });
  }
  if (!ctx.liveEnabled())
    push({
      code: "live-disabled",
      blocking: true,
      title: "Live execution is paused",
      detail: "The scheduler does not start tasks while execution is disabled.",
    });
  // ---- queue position, priority and aging (context, not a blocker) ----------------------------
  const queued = service.resources.ordered(
    store.list<Task>("task").filter((t) => t.status === "queued"),
  );
  const position = queued.findIndex((t) => t.id === task.id);
  if (position >= 0) {
    const priority = service.resources.priority(agent.id);
    const waited = Math.max(
      0,
      (Date.now() - Date.parse(task.queuedAt ?? new Date().toISOString())) /
        1000,
    );
    const score = service.resources.score(task);
    const ahead = queued
      .slice(0, position)
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        title: t.title,
        agent: name(t.agentId),
        priority: priorityName(service.resources.priority(t.agentId)),
      }));
    push({
      code: "queue-position",
      blocking: false,
      title: `Queue position ${position + 1} of ${queued.length}`,
      detail: `${priorityName(priority)} priority (${priority}); waited ${Math.round(waited)} s, aging adds ${(waited / AGING_SECONDS).toFixed(1)} points, effective score ${score.toFixed(1)}.${priority === 101 ? " Preempt gets queue precedence but never interrupts running work." : ""}${position ? " Ahead: " + ahead.map((a) => `"${a.title}" (${a.agent})`).join(", ") + "." : ""}`,
      refs: {
        position: position + 1,
        total: queued.length,
        priority,
        effectivePriority: score,
        waitedSeconds: Math.round(waited),
        ahead,
      },
    });
  }
  return finish(
    true,
    "Eligible: nothing blocks this task; the next scheduler tick can start it",
  );
}

// ---- transfers (canvas edge pulses) ---------------------------------------------------------
export type Transfer = {
  taskId: string;
  edgeId: string | null;
  workflowId: string | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  request: { seq: number; at: string; title: string; text: string } | null;
  response: {
    seq: number;
    at: string;
    kind: "result" | "failure";
    text: string;
  } | null;
  durationMs: number | null;
  state: "pending" | "returned" | "failed";
  /** What authorised this transfer: the delegation edge, plus rules that would route the same text. */
  rule: {
    edge: {
      id: string;
      kind: string;
      bidirectional: boolean;
      enabled: boolean;
    } | null;
    matchedRules: {
      ruleId: string;
      priority: number;
      scope: string;
      agentId: string;
    }[];
    note: string;
  };
};
export function transfers(
  service: TeamService,
  filter: { edgeId?: string; taskId?: string; workflowId?: string } = {},
  redactor = new Redactor({ secretFiles: [], literals: [] }),
): Transfer[] {
  const flows = allEvents(service).filter((e) => e.type === "flow.transferred");
  const byTask = new Map<string, Event[]>();
  for (const e of flows) {
    const id = String(asRecord(e.data).taskId ?? e.entityId);
    byTask.set(id, [...(byTask.get(id) ?? []), e]);
  }
  const out: Transfer[] = [];
  for (const [taskId, events] of byTask) {
    const req = events.find((e) => asRecord(e.data).kind === "request");
    const res = [...events]
      .reverse()
      .find((e) => asRecord(e.data).kind !== "request");
    const base = asRecord((req ?? events[0]).data);
    if (filter.edgeId && base.edgeId !== filter.edgeId) continue;
    if (filter.taskId && taskId !== filter.taskId) continue;
    if (filter.workflowId && base.workflowId !== filter.workflowId) continue;
    let task: Task | null = null;
    try {
      task = service.store.get<Task>("task", taskId);
    } catch {
      /* task removed */
    }
    const edge = base.edgeId
      ? (service.store.list<Edge>("edge").find((e) => e.id === base.edgeId) ??
        null)
      : null;
    let matched: Transfer["rule"]["matchedRules"] = [];
    if (task?.invokedBy) {
      try {
        const routed = service.route({
          text: `${task.title}\n${task.instructions}`,
          fromAgentId: task.invokedBy,
          kind: "delegate",
        });
        matched = routed.matches
          .filter((m) => m.agentId === task!.agentId)
          .map((m) => ({
            ruleId: m.ruleId,
            priority: m.priority,
            scope: m.scope,
            agentId: m.agentId,
          }));
      } catch {
        /* routing preview is best effort */
      }
    }
    const rs = res ? asRecord(res.data) : null;
    out.push({
      taskId,
      edgeId: str(base.edgeId),
      workflowId: str(base.workflowId),
      fromAgentId: str(base.fromAgentId),
      toAgentId: str(base.toAgentId),
      request: req
        ? {
            seq: req.seq,
            at: req.createdAt,
            title: String(redactor.value(task?.title ?? "")),
            text: String(
              redactor.value((task?.instructions ?? "").slice(0, 4000)),
            ),
          }
        : null,
      response: res
        ? {
            seq: res.seq,
            at: res.createdAt,
            kind: rs!.kind === "failure" ? "failure" : "result",
            text: String(redactor.value((task?.result ?? "").slice(0, 4000))),
          }
        : null,
      durationMs:
        req && res
          ? Date.parse(res.createdAt) - Date.parse(req.createdAt)
          : null,
      state: !res ? "pending" : rs!.kind === "failure" ? "failed" : "returned",
      rule: {
        edge: edge
          ? {
              id: edge.id,
              kind: edge.kind,
              bidirectional: edge.bidirectional,
              enabled: edge.enabled,
            }
          : null,
        matchedRules: matched,
        note: matched.length
          ? "Authorised by the delegation edge; the rules listed would also route this text to the same agent (inferred from the current rules, not recorded at the time)."
          : "Authorised by the delegation edge. The task named its recipient explicitly; no routing rule is recorded for it.",
      },
    });
  }
  return out.sort((a, b) => (a.request?.seq ?? 0) - (b.request?.seq ?? 0));
}

// ---- routing + access preview ---------------------------------------------------------------
export const accessPreviewSchema = z
  .object({
    agentId: z.string(),
    invokedBy: z.string().optional(),
    workflowId: z.string().optional(),
    paths: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2000),
            access: z.enum(["read", "write"]).default("read"),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();
export type AccessDecision = {
  kind:
    "communication" | "workspace" | "path" | "lease" | "runtime" | "approval";
  allowed: boolean;
  /** advisory: configuration intent only, not an OS sandbox. */
  enforcement: "backend" | "advisory";
  subject: string;
  reason: string;
};
/** realpath of the nearest existing ancestor plus the not-yet-existing remainder (symlink-safe). */
async function canonicalize(path: string): Promise<string> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}
export async function previewAccess(
  service: TeamService,
  ctx: InspectorContext,
  input: unknown,
) {
  const req = accessPreviewSchema.parse(input);
  const store = service.store;
  const agent = store.get<Agent>("agent", req.agentId);
  const decisions: AccessDecision[] = [];
  if (req.invokedBy) {
    const inv = store.get<Agent>("agent", req.invokedBy);
    const ok = service.permitted(req.invokedBy, agent.id, "delegate");
    decisions.push({
      kind: "communication",
      allowed: ok,
      enforcement: "backend",
      subject: `${inv.name} -> ${agent.name}`,
      reason: ok
        ? "An enabled delegation edge connects them."
        : "No enabled delegation edge; the backend rejects the task with connection_denied.",
    });
  }
  if (agent.control === "human")
    decisions.push({
      kind: "communication",
      allowed: false,
      enforcement: "backend",
      subject: agent.name,
      reason: "The agent is under human control; team tasks stay queued.",
    });
  const active = agent.workspaces.find((w) => w.active);
  decisions.push({
    kind: "workspace",
    allowed: !!active || !agent.workspaces.length,
    enforcement: "advisory",
    subject: agent.name,
    reason: active
      ? `Runs in ${active.path} with ${active.access} access (configuration intent).`
      : agent.workspaces.length
        ? "Folders are attached but none is active; the provider would start in the application folder."
        : "No folders attached; the provider runs in the application folder.",
  });
  for (const want of req.paths) {
    const canonical = isAbsolute(want.path)
      ? await canonicalize(want.path)
      : want.path;
    const ws = agent.workspaces
      .filter((w) => contains(w.path, canonical))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const insideGit = /(^|[\\/])\.git([\\/]|$)/.test(canonical);
    let allowed = true,
      reason = `Inside ${ws?.path} (${ws?.access}).`;
    if (!isAbsolute(want.path)) {
      allowed = false;
      reason = "Paths must be absolute.";
    } else if (!ws) {
      allowed = false;
      reason = "Outside every folder attached to this agent.";
    } else if (want.access === "write" && ws.access !== "write") {
      allowed = false;
      reason = `The folder ${ws.path} is attached read-only.`;
    } else if (insideGit) {
      allowed = false;
      reason = "AgentTeam file browsing blocks .git; use the Git tools.";
    }
    decisions.push({
      kind: "path",
      allowed,
      enforcement: "advisory",
      subject: `${want.access} ${want.path}`,
      reason,
    });
  }
  const wfId =
    req.workflowId ??
    store.list<Workflow>("workflow").find((w) => !w.paused)?.id ??
    null;
  const conflicts = service.resources.conflicts(agent.id, wfId, "preview");
  decisions.push({
    kind: "lease",
    allowed: !conflicts.length,
    enforcement: "backend",
    subject: agent.workspaces.map((w) => w.path).join(", ") || "(no folders)",
    reason: conflicts.length
      ? `Would wait: ${conflicts.map((c) => store.get<Agent>("agent", c.agentId).name).join(", ")} currently lease overlapping folders.`
      : "No other lease overlaps the agent's folders right now.",
  });
  if (
    ctx.readiness &&
    service.connection(agent.environment).transport !== "acp"
  ) {
    const r = ctx.readiness(agent.environment);
    decisions.push({
      kind: "runtime",
      allowed: r.state === "ready",
      enforcement: "backend",
      subject: agent.environment,
      reason:
        r.state === "ready"
          ? "Runtime resolved."
          : r.state === "resolving"
            ? "Runtime scan not settled; the task would stay queued."
            : r.message,
    });
  }
  decisions.push({
    kind: "approval",
    allowed: true,
    enforcement: "backend",
    subject: `${agent.environment} tools: ${agent.tools.join(", ") || "none"}`,
    reason:
      "Provider permission requests surface as approvals you answer; nothing is auto-approved by AgentTeam.",
  });
  return {
    agentId: agent.id,
    allowed: decisions.every((d) => d.allowed),
    decisions,
    note: "Per-folder sandbox enforcement is not implemented: path decisions describe the configured intent; leases, edges and control are enforced by the backend.",
  };
}

/** Routing preview (service.route) plus access decisions, so one call previews a run before it starts. */
export async function previewRun(
  service: TeamService,
  ctx: InspectorContext,
  input: unknown,
) {
  const body = z
    .object({
      route: z.unknown(),
      access: z.unknown().optional(),
    })
    .strict()
    .parse(input);
  let routing: Record<string, unknown>;
  try {
    routing = { ...service.route(body.route) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (!err.code) throw e;
    routing = {
      status: "denied",
      reason: err.message ?? err.code,
      code: err.code,
      matches: [],
    };
  }
  const agentId =
    (routing.agentId as string | undefined) ??
    (asRecord(body.access).agentId as string | undefined);
  const access = agentId
    ? await previewAccess(service, ctx, {
        ...asRecord(body.access),
        agentId,
        invokedBy:
          asRecord(body.access).invokedBy ??
          asRecord(body.route).fromAgentId ??
          undefined,
      })
    : null;
  return { routing, access };
}
