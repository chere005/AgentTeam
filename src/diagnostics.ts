import { createHash } from "node:crypto";
import { platform, arch, release } from "node:os";
import {
  buildTimeline,
  type InspectorContext,
  type TimelineEntry,
  type TimelineFilter,
} from "./inspector.ts";
import { Redactor, type RedactionOptions } from "./redact.ts";
import { zip } from "./zip.ts";
import type { TeamService } from "./service.ts";
import type { Agent, Edge, Rule, Task, Workflow } from "./model.ts";
import type { Effect } from "./checkpoints.ts";
import type { ApprovalRecord } from "./approvals.ts";
import type { Lease, Resource } from "./resources.ts";

/**
 * Redacted diagnostic bundle. Contains configuration shape, statuses, counters, event timeline
 * and bounded text snippets. It never contains: the API token or any file named as a secret
 * source, values of environment variables, provider auth headers, prompt text (agent role and
 * instructions, workflow goals, task instructions), raw tool inputs, diff content, provider output
 * or task results, or the contents of any workspace file (only paths the events already name).
 * Timeline entries are exported through an allow-list (exportEntry), never with their raw data.
 */
const sha = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 12);
const digest = (s: string) => ({ length: s.length, sha256: sha(s) });
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** Short identifier-like strings only (status, kind, state); anything longer is dropped. */
const word = (v: unknown) =>
  typeof v === "string" && v.length <= 40 && /^[\w.:/ -]*$/.test(v) ? v : null;

/**
 * Allow-listed view of one timeline entry. `data` (provider events: ACP rawInput, diff old/new
 * text, output text, task results, prompts) is never copied; only status/kind/state words, a short
 * redacted title and the location paths the entry already names survive.
 */
export function exportEntry(e: TimelineEntry, redactor: Redactor) {
  const d = rec(e.data);
  const inner = rec(d.data);
  const pick = (k: string) => word(inner[k]) ?? word(d[k]);
  const title =
    typeof inner.title === "string"
      ? inner.title
      : typeof d.title === "string"
        ? d.title
        : null;
  return {
    seq: e.seq,
    at: e.at,
    type: e.type,
    category: e.category,
    severity: e.severity,
    summary: redactor.string(e.summary.slice(0, 200)),
    correlationId: e.correlationId,
    agentId: e.agentId,
    agentName: e.agentName,
    agentIds: e.agentIds,
    taskId: e.taskId,
    workflowId: e.workflowId,
    sessionId: e.sessionId,
    approvalId: e.approvalId,
    conversation: e.conversation,
    files: e.files,
    detail: {
      runtimeEvent: e.type === "task.runtime" ? word(d.type) : null,
      status: pick("status"),
      kind: pick("kind"),
      state: pick("state"),
      title: title === null ? null : redactor.string(title.slice(0, 120)),
    },
  };
}
export type BundleOptions = {
  format: "json" | "zip";
  timeline?: Partial<TimelineFilter>;
  redaction?: RedactionOptions;
  runtimes?: () => unknown;
  version?: string;
};
export type Bundle = {
  filename: string;
  contentType: string;
  encoding: "utf8" | "base64";
  data: string;
  bytes: number;
  files: string[];
  redaction: {
    literalsRemoved: number;
    patternsRemoved: number;
    keysRemoved: number;
    truncated: number;
    secretEnvNames: string[];
  };
};
export function bundleContent(
  service: TeamService,
  ctx: InspectorContext,
  redactor: Redactor,
  options: Pick<BundleOptions, "timeline" | "runtimes" | "version">,
) {
  const store = service.store;
  const r = (v: unknown) => redactor.value(v);
  const snippet = (s: string | undefined, n = 400) =>
    redactor.string((s ?? "").slice(0, n));
  const agents = store.list<Agent>("agent");
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const spaces = service.teamSpaces;
  const config = {
    // Team containers (src/team-spaces.ts): id and name only.
    teams: spaces.list().map((t) => ({ id: t.id, name: t.name })),
    activeTeamId: spaces.active(),
    agents: agents.map((a) => ({
      id: a.id,
      teamId: spaces.teamOfAgent(a),
      name: a.name,
      kind: a.kind,
      environment: a.environment,
      model: a.model,
      effort: a.effort,
      control: a.control,
      schedulingPriority: a.schedulingPriority,
      maxConcurrentInvocations: a.maxConcurrentInvocations,
      parentId: a.parentId,
      tools: a.tools,
      skills: a.skills,
      // Prompts are summarised, never exported verbatim.
      role: digest(a.role ?? ""),
      instructions: digest(a.instructions),
      workspaces: a.workspaces.map((w) => ({
        path: w.path,
        access: w.access,
        active: w.active,
      })),
    })),
    edges: store.list<Edge>("edge"),
    rules: store.list<Rule>("rule"),
    connections: Object.fromEntries(
      ["codex", "claude", "wolfram"].map((e) => {
        const c = service.connection(e);
        return [
          e,
          {
            transport: c.transport,
            executable: c.executable,
            argCount: c.args.length,
          },
        ];
      }),
    ),
  };
  const workflows = store.list<Workflow>("workflow").map((w) => ({
    id: w.id,
    teamId: spaces.teamOfWorkflow(w),
    name: w.name,
    goal: digest(w.goal ?? ""),
    paused: w.paused,
    status: service.workflowStatus(w.id).status,
    limits: service.limits.status(w.id),
  }));
  const tasks = store.list<Task>("task").map((t) => ({
    id: t.id,
    workflowId: t.workflowId,
    agent: name(t.agentId),
    invokedBy: t.invokedBy ? name(t.invokedBy) : null,
    title: snippet(t.title, 200),
    status: t.status,
    dependsOn: t.dependsOn,
    requiresValidation: !!t.requiresValidation,
    queuedAt: t.queuedAt ?? null,
    // Provider output is never exported; length/hash identify it without revealing it.
    result: t.result ? digest(t.result) : null,
    recovery: service.recovery.state(t.id),
    waiting: service.taskState(t.id).waitReason,
  }));
  const recovery = {
    checkpoints: tasks.flatMap((t) =>
      service.recovery.checkpoints(t.id).map((c) => ({
        taskId: c.taskId,
        seq: c.seq,
        attempt: c.attempt,
        boundary: c.boundary,
        nextStep: c.nextStep,
        createdAt: c.createdAt,
      })),
    ),
    effects: store.list<Effect>("effect").map((e) => ({
      id: e.id,
      taskId: e.taskId,
      kind: e.kind,
      mutating: e.mutating,
      state: e.state,
      attempts: e.attempts,
      description: snippet(e.description, 200),
      error: e.error ? snippet(e.error, 300) : undefined,
      decision: e.decision,
    })),
  };
  const approvals = store.list<ApprovalRecord>("approval").map((a) => {
    const call = (a.request.toolCall ?? {}) as Record<string, unknown>;
    return {
      id: a.id,
      agent: name(a.agentId),
      taskId: a.taskId ?? null,
      status: a.status,
      title: snippet(String(call.title ?? ""), 200),
      kind: call.kind ?? null,
      // rawInput (commands, file contents) is deliberately left out.
      locations: call.locations ?? [],
      outcome: a.response?.outcome ?? null,
      createdAt: a.createdAt,
      resolvedAt: a.resolvedAt ?? null,
    };
  });
  const validation = store
    .list<Record<string, unknown>>("validation")
    .map((v) => ({
      id: v.id,
      taskId: v.taskId,
      status: v.status,
      reason: snippet(String(v.reason ?? ""), 300),
      startedAt: v.startedAt,
      finishedAt: v.finishedAt,
    }));
  const locks = {
    leases: store
      .list<Lease>("lease")
      .map((l) => ({ ...l, agent: name(l.agentId) })),
    resources: store.list<Resource>("resource"),
    slots: store.list("slot"),
    queue: service.resources.snapshot().queue,
  };
  const timeline = buildTimeline(
    service,
    { limit: 2000, minSeverity: "info", ...options.timeline },
    redactor,
  );
  const environment = {
    app: options.version ?? "0.1.0",
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    node: process.version,
    liveExecution: ctx.liveEnabled(),
    // Names only: values of secret-named variables never leave the process.
    maskedEnvironmentVariableNames: Redactor.secretEnvNames(),
    runtimes: options.runtimes ? options.runtimes() : undefined,
  };
  const counts = {
    teams: config.teams.length,
    agents: agents.length,
    tasks: tasks.length,
    workflows: workflows.length,
    events: timeline.total,
  };
  return {
    manifest: {
      kind: "agentteam-diagnostic-bundle",
      schema: 1,
      generatedAt: new Date().toISOString(),
      counts,
      note: "Redacted export: credentials, tokens, API keys, auth headers, environment secrets, prompts (role, instructions, goals), raw tool input, diff content, provider output, task results and file contents are excluded; timeline entries carry only allow-listed fields.",
    },
    files: {
      "config.json": r(config),
      "workflows.json": r(workflows),
      "tasks.json": r(tasks),
      "recovery.json": r(recovery),
      "approvals.json": r(approvals),
      "validation.json": r(validation),
      "locks.json": r(locks),
      "timeline.json": {
        total: timeline.total,
        truncated: timeline.truncated,
        entries: timeline.entries.map((e) => exportEntry(e, redactor)),
      },
      "environment.json": r(environment),
    } as Record<string, unknown>,
  };
}

export function exportBundle(
  service: TeamService,
  ctx: InspectorContext,
  options: BundleOptions,
): Bundle {
  const redactor = new Redactor(options.redaction);
  const content = bundleContent(service, ctx, redactor, options);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestFiles = Object.keys(content.files);
  const finish = (text: string) => redactor.scrubLiterals(text);
  const out: { name: string; text: string }[] = [
    {
      name: "manifest.json",
      text: finish(
        JSON.stringify({ ...content.manifest, files: manifestFiles }, null, 2),
      ),
    },
    ...manifestFiles.map((name) => ({
      name,
      text: finish(JSON.stringify(content.files[name], null, 2)),
    })),
  ];
  const redaction = {
    literalsRemoved: redactor.stats.literal,
    patternsRemoved: redactor.stats.pattern,
    keysRemoved: redactor.stats.key,
    truncated: redactor.stats.truncated,
    secretEnvNames: Redactor.secretEnvNames(options.redaction?.env),
  };
  // Verification: no known secret may remain in any output file.
  for (const f of out)
    if (redactor.leaks(f.text))
      throw new Error("Redaction verification failed for " + f.name);
  if (options.format === "json") {
    const merged = finish(
      JSON.stringify(
        {
          ...content.manifest,
          redaction,
          files: Object.fromEntries(
            out.slice(1).map((f) => [f.name, JSON.parse(f.text)]),
          ),
        },
        null,
        2,
      ),
    );
    return {
      filename: `agentteam-diagnostics-${stamp}.json`,
      contentType: "application/json",
      encoding: "utf8",
      data: merged,
      bytes: Buffer.byteLength(merged),
      files: manifestFiles,
      redaction,
    };
  }
  const buffer = zip([
    ...out.map((f) => ({ name: f.name, data: f.text })),
    { name: "redaction.json", data: JSON.stringify(redaction, null, 2) },
  ]);
  return {
    filename: `agentteam-diagnostics-${stamp}.zip`,
    contentType: "application/zip",
    encoding: "base64",
    data: buffer.toString("base64"),
    bytes: buffer.length,
    files: [...out.map((f) => f.name), "redaction.json"],
    redaction,
  };
}
