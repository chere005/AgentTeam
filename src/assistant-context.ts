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
import { proposalProtocol } from "./assistant-protocol.ts";
import type { TeamService } from "./service.ts";
import { simpleTaskSupport } from "./simple-task-capabilities.ts";

/**
 * Read-only inspection block for the Team Assistant: the ACTIVE team's agents (ids, roles, current
 * skills with load mode, tools), its connections, rules, workflows, queues, leases and failures,
 * plus the skill catalog (id, name, one-line description, environments, required tools) as ONE
 * bounded JSON document wrapped as untrusted data. The assistant is global; the active team comes
 * from `settings/active-team`, and other teams appear only as name + agent count. Names, roles,
 * goals, skill descriptions and failure texts come from users, agents and skill authors, so the
 * whole block is data, never instructions. Task results and raw event data are not included;
 * failure reasons are redacted and clipped. Every list reports how many rows were omitted.
 * The proposal protocol (src/assistant-protocol.ts) precedes the block as application
 * instructions, so clipping the data never cuts it.
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
  teams: 20,
  tools: 80,
  proposals: 10,
} as const;
const T = { name: 120, text: 240, reason: 300, description: 160 };

const rows = <T>(items: T[], cap: number) => ({
  items: items.slice(0, cap),
  total: items.length,
  omitted: Math.max(0, items.length - cap),
});
const c = (v: unknown, n: number) =>
  typeof v === "string" ? clip(v, n).text : v;
/** First line/sentence-ish of a description, whitespace collapsed, clipped. */
const oneLine = (v: string, n: number) => {
  const flat = v.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1).trimEnd() + "…";
};

export function assistantContext(
  service: TeamService,
  ctx: InspectorContext,
  options: { maxChars?: number; now?: () => number } = {},
) {
  const store = service.store;
  const maxChars = options.maxChars ?? 40_000;
  const redactor = new Redactor({ maxString: T.reason });
  const spaces = service.teamSpaces;
  const activeTeamId = spaces.active();
  const allAgents = store.list<Agent>("agent");
  // The active team's agents plus the (global) Team Assistant itself.
  const agents = allAgents.filter((a) => {
    const team = spaces.teamOfAgent(a);
    return team === null || team === activeTeamId;
  });
  const agentIds = new Set(agents.map((a) => a.id));
  const teamWorkflows = store
    .list<Workflow>("workflow")
    .filter((w) => spaces.teamOfWorkflow(w) === activeTeamId);
  const workflowIds = new Set(teamWorkflows.map((w) => w.id));
  const sessions = store.list<Session>("session");
  const tasks = store
    .list<Task>("task")
    .filter((t) => workflowIds.has(t.workflowId) || agentIds.has(t.agentId));
  const coord = new Coordination(service);
  const snapshot = service.resources.snapshot();

  const workflows = teamWorkflows.map((w) => {
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
  // Skills usable by the team's environments first (bundled before installed), then the rest.
  const teamEnvs = new Set(
    agents.filter((a) => a.kind !== "team-assistant").map((a) => a.environment),
  );
  const skills = (() => {
    const g = service.skills.grouped();
    const seen = new Map<
      string,
      {
        id: string;
        name: string;
        description: string;
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
          description: oneLine(s.description, T.description),
          environments: s.environments,
          origin: s.origin,
          requiresTools: s.requiresTools,
        });
    const rank = (s: { environments: string[]; origin: string }) =>
      (s.environments.some((e) => teamEnvs.has(e as Agent["environment"]))
        ? 0
        : 2) + (s.origin === "bundled" ? 0 : 1);
    return [...seen.values()].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    );
  })();
  const tools = [
    ...new Set([
      ...agents.flatMap((a) => a.tools),
      ...skills.flatMap((s) => s.requiresTools),
    ]),
  ].sort();

  const teams = spaces.list();
  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const body = {
    schema: 2,
    generatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    liveExecution: ctx.liveEnabled(),
    activeTeam: {
      id: activeTeamId,
      name: c(activeTeam?.name ?? activeTeamId, T.name),
    },
    otherTeams: rows(
      teams
        .filter((t) => t.id !== activeTeamId)
        .map((t) => ({
          id: t.id,
          name: c(t.name, T.name),
          agents: allAgents.filter((a) => spaces.teamOfAgent(a) === t.id)
            .length,
        })),
      CONTEXT_CAPS.teams,
    ),
    agents: rows(
      agents.map((a) => ({
        id: a.id,
        name: c(a.name, T.name),
        role: c(a.role, T.text),
        roleType: a.roleType,
        kind: a.kind,
        environment: a.environment,
        simpleTask: simpleTaskSupport(service, a),
        model: a.model,
        control: a.control,
        parentId: a.parentId,
        skills: a.skills.map((s) => ({ id: s.id, mode: s.mode })),
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
      store
        .list<Edge>("edge")
        .filter((e) => agentIds.has(e.from) || agentIds.has(e.to))
        .map((e) => ({
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
      store
        .list<Rule>("rule")
        .filter((r) => agentIds.has(r.agentId))
        .map((r) => ({
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
      snapshot.queue
        .filter((q) => agentIds.has(q.agentId))
        .map((q) => ({
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
      snapshot.chatQueue
        .filter((q: { agentId: string }) => agentIds.has(q.agentId))
        .map((q: { id: string; agentId: string; queuedAt: string }) => ({
          sessionId: q.id,
          agentId: q.agentId,
          queuedAt: q.queuedAt,
        })),
      CONTEXT_CAPS.chatQueue,
    ),
    waiting: rows(waiting, CONTEXT_CAPS.waiting),
    leases: rows(
      snapshot.leases
        .filter((l) => agentIds.has(l.agentId))
        .map((l) => ({
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
    "You are the Team Assistant. Below is a read-only inspection of the active team. You cannot apply changes. To change the team, write a proposal as described next; the user reviews the diff and applies it. Never claim a proposal was applied.\n" +
    proposalProtocol() +
    "\n" +
    UNTRUSTED_NOTICE;
  const text = hardClip(
    preamble + "\n" + untrusted("team-state", { schema: "2" }, json),
    maxChars,
  );
  return {
    text: text.text,
    clipped: text.clipped,
    chars: text.text.length,
    body,
  };
}
