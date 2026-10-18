import { Coordination } from "./coordination.ts";
import { explainWaiting, type InspectorContext } from "./inspector.ts";
import { Redactor } from "./redact.ts";
import {
  UNTRUSTED_NOTICE,
  clip,
  hardClip,
  untrusted,
} from "./shared-common.ts";
import {
  type Agent,
  type Edge,
  type Rule,
  type Session,
  type Task,
  type Workflow,
} from "./model.ts";
import type { Proposal } from "./assistant.ts";
import type { TeamService } from "./service.ts";

/**
 * Read-only inspection block for the Team Assistant: workflow states, queues, leases, failures
 * and available skills/tools as ONE bounded JSON document wrapped as untrusted data. Names, roles,
 * goals and failure texts come from users and agents, so the whole block is data, never
 * instructions. Task results and raw event data are not included; failure reasons are redacted
 * and clipped. Every list reports how many rows were omitted.
 */
export const CONTEXT_CAPS = {
  agents: 60,
  edges: 120,
  rules: 80,
  workflows: 30,
  queue: 40,
  chatQueue: 20,
  waiting: 20,
  leases: 40,
  failures: 20,
  skills: 60,
  tools: 80,
  proposals: 10,
} as const;
const T = { name: 120, text: 240, reason: 300 };

const rows = <T>(items: T[], cap: number) => ({
  items: items.slice(0, cap),
  total: items.length,
  omitted: Math.max(0, items.length - cap),
});
const c = (v: unknown, n: number) =>
  typeof v === "string" ? clip(v, n).text : v;

export function assistantContext(
  service: TeamService,
  ctx: InspectorContext,
  options: { maxChars?: number; now?: () => number } = {},
) {
  const store = service.store;
  const maxChars = options.maxChars ?? 24_000;
  const redactor = new Redactor({ maxString: T.reason });
  const agents = store.list<Agent>("agent");
  const sessions = store.list<Session>("session");
  const tasks = store.list<Task>("task");
  const coord = new Coordination(service);
  const snapshot = service.resources.snapshot();

  const workflows = store.list<Workflow>("workflow").map((w) => {
    const view = coord.view(w.id);
    return {
      id: w.id,
      name: c(w.name, T.name),
      goal: c(view.currentGoal, T.text),
      ownerId: w.ownerId,
      status: view.status,
      paused: view.paused,
      tasks: view.tasks,
      stopping: view.stopping
        .filter((s) => s.limit !== null)
        .map((s) => ({ key: s.key, limit: s.limit, used: s.used })),
      trip: view.trip
        ? { kind: view.trip.kind, reason: c(view.trip.reason, T.text) }
        : null,
    };
  });
  const waiting = tasks
    .filter((t) => ["queued", "interrupted", "blocked"].includes(t.status))
    .map((t) => {
      const e = explainWaiting(service, ctx, { taskId: t.id });
      return {
        taskId: t.id,
        title: c(t.title, T.name),
        agentId: t.agentId,
        status: t.status,
        headline: c(e.headline, T.text),
        blockedBy: e.reasons.filter((r) => r.blocking).map((r) => r.code),
      };
    });
  const failures = tasks
    .filter((t) => t.status === "failed")
    .map((t) => ({
      taskId: t.id,
      title: c(t.title, T.name),
      agentId: t.agentId,
      workflowId: t.workflowId,
      reason: t.result ? redactor.string(clip(t.result, T.reason).text) : null,
    }));
  const skills = (() => {
    const g = service.skills.grouped();
    const seen = new Map<
      string,
      {
        id: string;
        name: string;
        environments: string[];
        origin: string;
        requiresTools: string[];
      }
    >();
    for (const group of Object.values(g.groups))
      for (const s of group)
        seen.set(s.id, {
          id: s.id,
          name: c(s.name, T.name) as string,
          environments: s.environments,
          origin: s.origin,
          requiresTools: s.requiresTools,
        });
    return [...seen.values()];
  })();
  const tools = [
    ...new Set([
      ...agents.flatMap((a) => a.tools),
      ...skills.flatMap((s) => s.requiresTools),
    ]),
  ].sort();

  const body = {
    schema: 1,
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    liveExecution: ctx.liveEnabled(),
    agents: rows(
      agents.map((a) => ({
        id: a.id,
        name: c(a.name, T.name),
        role: c(a.role, T.text),
        kind: a.kind,
        environment: a.environment,
        model: a.model,
        control: a.control,
        parentId: a.parentId,
        skills: a.skills.map((s) => s.id),
        tools: a.tools,
        folders: a.workspaces.map((w) => ({
          path: c(w.path, T.text),
          access: w.access,
          active: w.active,
        })),
        activity: service.activity(a.id).state,
        busy:
          sessions.some((s) => s.agentId === a.id && s.state === "running") ||
          tasks.some((t) => t.agentId === a.id && t.status === "running"),
      })),
      CONTEXT_CAPS.agents,
    ),
    edges: rows(
      store.list<Edge>("edge").map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        kind: e.kind,
        bidirectional: e.bidirectional,
        enabled: e.enabled,
      })),
      CONTEXT_CAPS.edges,
    ),
    rules: rows(
      store.list<Rule>("rule").map((r) => ({
        id: r.id,
        agentId: r.agentId,
        scope: r.scope,
        targetId: r.targetId,
        kind: r.kind,
        mode: r.mode,
        priority: r.priority,
        enabled: r.enabled,
        specialty: r.specialty,
      })),
      CONTEXT_CAPS.rules,
    ),
    workflows: rows(workflows, CONTEXT_CAPS.workflows),
    queue: rows(
      snapshot.queue.map((q) => ({
        taskId: q.id,
        agentId: q.agentId,
        workflowId: q.workflowId,
        title: c(q.title, T.name),
        effectivePriority: q.effectivePriority,
        waitingSince: q.waitingSince,
        blockedByAgents: q.blockers,
      })),
      CONTEXT_CAPS.queue,
    ),
    chatQueue: rows(
      snapshot.chatQueue.map(
        (q: { id: string; agentId: string; queuedAt: string }) => ({
          sessionId: q.id,
          agentId: q.agentId,
          queuedAt: q.queuedAt,
        }),
      ),
      CONTEXT_CAPS.chatQueue,
    ),
    waiting: rows(waiting, CONTEXT_CAPS.waiting),
    leases: rows(
      snapshot.leases.map((l) => ({
        id: l.id,
        agentId: l.agentId,
        workflowId: l.workflowId,
        paths: l.paths.slice(0, 10).map((p) => c(p, T.text)),
        acquiredAt: l.acquiredAt,
        scope: l.scope,
      })),
      CONTEXT_CAPS.leases,
    ),
    failures: rows(failures, CONTEXT_CAPS.failures),
    skills: rows(skills, CONTEXT_CAPS.skills),
    tools: rows(tools, CONTEXT_CAPS.tools),
    pendingProposals: rows(
      store
        .list<Proposal>("proposal")
        .filter((p) => p.status === "pending" || p.status === "approved")
        .map((p) => ({
          id: p.id,
          title: c(p.title, T.name),
          status: p.status,
        })),
      CONTEXT_CAPS.proposals,
    ),
  };
  const json = JSON.stringify(body);
  const preamble =
    "Read-only inspection of the current team. You cannot apply changes. To change the team, write a proposal as a fenced ```agentteam-proposal JSON block; the user reviews the diff and applies it. Never claim a proposal was applied.\n" +
    UNTRUSTED_NOTICE;
  const text = hardClip(
    preamble + "\n" + untrusted("team-state", { schema: "1" }, json),
    maxChars,
  );
  return {
    text: text.text,
    clipped: text.clipped,
    chars: text.text.length,
    body,
  };
}
