/**
 * Pure active-team filtering (no React/DOM; node tests import this file). The backend snapshot
 * holds every team; the UI shows one team at a time: its agents (plus the global Team
 * Assistant, `teamId: null`), the edges between them, its workflows and the sessions/activity
 * of its agents. Edges that leave the team are reported separately as cross-team links.
 */
export const MAIN_TEAM_ID = "main";

export type TeamSummaryLike = {
  id: string;
  name: string;
  description?: string;
  main?: boolean;
  agents: number;
  workflows: number;
  running: number;
  queued: number;
  attention: number;
  status: "running" | "attention" | "idle";
};
type AgentLike = { id: string; name: string; teamId?: string | null };
type EdgeLike = { id: string; from: string; to: string };
type SnapshotLike = {
  agents: AgentLike[];
  edges: EdgeLike[];
  rules: { agentId: string; targetId?: string }[];
  workflows: { id: string; teamId?: string | null; tasks: { id: string }[] }[];
  sessions: { id: string; agentId: string }[];
  activity: { agentId: string }[];
  teams?: TeamSummaryLike[];
  activeTeamId?: string;
};
export type CrossTeamLink<E> = {
  edge: E;
  /** The endpoint in this team and the one outside it. */
  inside: string;
  outside: string;
  outsideName: string;
  outsideTeamId: string;
  outsideTeamName: string;
};
export type TeamView<S extends SnapshotLike> = S & {
  activeTeamId: string;
  teamView: {
    team: TeamSummaryLike;
    teams: TeamSummaryLike[];
    /** Every agent of every team (names for cross-team links, inbox items, events). */
    allAgents: S["agents"];
    crossTeam: CrossTeamLink<S["edges"][number]>[];
    /** Agents of other teams (choices for an explicit cross-team link). */
    otherAgents: S["agents"];
    /** Entity id → team over the whole snapshot (events, inbox items of other teams). */
    index: Map<string, string | null>;
  };
};

/** `teamId` on a snapshot record: missing = Main; null = global (Team Assistant). */
export const agentTeam = (a: { teamId?: string | null }) =>
  a.teamId === null ? null : (a.teamId ?? MAIN_TEAM_ID);
export const workflowTeam = (w: { teamId?: string | null }) =>
  w.teamId ?? MAIN_TEAM_ID;

export function fallbackTeam(id: string): TeamSummaryLike {
  return {
    id,
    name: id === MAIN_TEAM_ID ? "Main team" : "Team",
    main: id === MAIN_TEAM_ID,
    agents: 0,
    workflows: 0,
    running: 0,
    queued: 0,
    attention: 0,
    status: "idle",
  };
}

/** The team to show: the requested one if it exists, else Main. */
export function resolveTeam(
  teams: TeamSummaryLike[] | undefined,
  id: string | undefined,
): TeamSummaryLike {
  const list = teams ?? [];
  return (
    list.find((t) => t.id === id) ??
    list.find((t) => t.id === MAIN_TEAM_ID) ??
    fallbackTeam(MAIN_TEAM_ID)
  );
}

export function filterSnapshot<S extends SnapshotLike>(
  data: S,
  teamId: string | undefined,
): TeamView<S> {
  const teams = data.teams ?? [];
  const team = resolveTeam(teams, teamId);
  const inTeam = (a: AgentLike) => {
    const t = agentTeam(a);
    return t === null || t === team.id;
  };
  const visible = new Set(data.agents.filter(inTeam).map((a) => a.id));
  const byId = new Map(data.agents.map((a) => [a.id, a]));
  const teamName = (id: string) =>
    teams.find((t) => t.id === id)?.name ?? fallbackTeam(id).name;
  const crossTeam: CrossTeamLink<S["edges"][number]>[] = [];
  for (const e of data.edges) {
    const f = visible.has(e.from),
      t = visible.has(e.to);
    if (f === t) continue;
    const outside = f ? e.to : e.from;
    const other = byId.get(outside);
    if (!other) continue;
    const otherTeam = agentTeam(other) ?? MAIN_TEAM_ID;
    crossTeam.push({
      edge: e,
      inside: f ? e.from : e.to,
      outside,
      outsideName: other.name,
      outsideTeamId: otherTeam,
      outsideTeamName: teamName(otherTeam),
    });
  }
  return {
    ...data,
    agents: data.agents.filter((a) => visible.has(a.id)),
    edges: data.edges.filter((e) => visible.has(e.from) && visible.has(e.to)),
    rules: data.rules.filter(
      (r) => visible.has(r.agentId) && (!r.targetId || visible.has(r.targetId)),
    ),
    workflows: data.workflows.filter((w) => workflowTeam(w) === team.id),
    sessions: data.sessions.filter((s) => visible.has(s.agentId)),
    activity: data.activity.filter((a) => visible.has(a.agentId)),
    activeTeamId: team.id,
    teamView: {
      team,
      teams,
      allAgents: data.agents,
      crossTeam,
      otherAgents: data.agents.filter((a) => !visible.has(a.id)),
      index: teamIndex(data),
    },
  };
}

/** Lookup from entity id (agent, workflow, task, session) to its team; null = global. */
export function teamIndex(data: SnapshotLike) {
  const index = new Map<string, string | null>();
  for (const a of data.agents) index.set(a.id, agentTeam(a));
  for (const w of data.workflows) {
    index.set(w.id, workflowTeam(w));
    for (const t of w.tasks) index.set(t.id, workflowTeam(w));
  }
  for (const s of data.sessions) index.set(s.id, index.get(s.agentId) ?? null);
  return index;
}

/**
 * Team of an item that names an agent and/or a workflow (inbox items, timeline entries). The
 * workflow decides when present; null means it belongs to no particular team.
 */
export function itemTeam(
  index: Map<string, string | null>,
  item: { agentId?: string | null; workflowId?: string | null },
): string | null {
  if (item.workflowId && index.has(item.workflowId))
    return index.get(item.workflowId) ?? null;
  if (item.agentId && index.has(item.agentId))
    return index.get(item.agentId) ?? null;
  return null;
}

/** Events of the team (or global, e.g. settings): hides other teams' activity in the log. */
export function eventVisible(
  index: Map<string, string | null>,
  teamId: string,
  event: { entityId: string; data?: unknown },
) {
  const d = (
    event.data && typeof event.data === "object" ? event.data : {}
  ) as Record<string, unknown>;
  const ids = [event.entityId, d.agentId, d.workflowId, d.taskId].filter(
    (v): v is string => typeof v === "string",
  );
  const teams = ids
    .filter((id) => index.has(id))
    .map((id) => index.get(id) ?? null)
    .filter((t): t is string => t !== null);
  return !teams.length || teams.includes(teamId);
}

/** "2 running · 1 needs attention" style label for the switcher (empty when idle). */
export function teamActivityLabel(t: TeamSummaryLike) {
  const parts: string[] = [];
  if (t.running) parts.push(`${t.running} running`);
  if (t.attention)
    parts.push(`${t.attention} need${t.attention === 1 ? "s" : ""} attention`);
  if (t.queued) parts.push(`${t.queued} queued`);
  return parts.join(" · ");
}

/** Per-team storage key: Main keeps the legacy key so existing layouts/groups stay with it. */
export const teamKey = (base: string, teamId: string) =>
  teamId === MAIN_TEAM_ID ? base : `${base}.team-${teamId}`;
