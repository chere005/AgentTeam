// Team spaces: the "active team" container the UI shows one at a time.
//
// Design (kept deliberately small, see docs/CONTINUATION.md "Team spaces"):
// - One database. Agents and workflows carry an optional `teamId`; a missing or dangling value
//   means the built-in Main team (`MAIN_TEAM_ID`), so records written before teams existed stay
//   readable without a migration and simply belong to Main.
// - The single Team Assistant (kind "team-assistant") belongs to no team (`teamId` null) and is
//   visible in every team.
// - A team is a `team-space` entity {id, name, description, createdAt, updatedAt}. Main is
//   virtual until it is first renamed (then stored under the same id).
// - The active team is a backend setting (`settings/active-team`), so it survives restarts and a
//   sample/template/pack that creates its own team can make it active for every client.
// - Teams are presentation and ownership only. Communication permissions, locks, limits,
//   validation/review gates and scheduler fairness stay global and are never read per team;
//   switching teams never pauses, cancels or reorders work.
// - Edges between agents of different teams ("cross-team links") are created only with an
//   explicit `crossTeam: true` from the user (TeamService.saveEdge); existing edges keep working
//   when an agent is moved, and the UI marks them as cross-team.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Session,
  type Task,
  type Workflow,
} from "./model.ts";
import type { TeamService } from "./service.ts";

export const MAIN_TEAM_ID = "main";
export const MAIN_TEAM_NAME = "Main team";
/** IPC-path safe (desktop/main.ts accepts [a-z0-9/-?=&%] only): UUIDs and "main". */
export const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const teamIdSchema = z
  .string()
  .regex(TEAM_ID, "Team ids are lowercase letters, digits and dashes");

export type TeamSpace = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};
export type TeamSummary = TeamSpace & {
  main: boolean;
  agents: number;
  workflows: number;
  /** Running tasks of the team's workflows plus running chat sessions of its agents. */
  running: number;
  queued: number;
  /** Failed, interrupted or blocked tasks plus paused workflows with work left. */
  attention: number;
  status: "running" | "attention" | "idle";
};

const nameSchema = z.string().trim().min(1).max(80);
const createSchema = z
  .object({ name: nameSchema, description: z.string().max(2000).default("") })
  .strict();
const updateSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();
const deleteSchema = z
  .object({
    /** What happens to the team's agents: moved (default) or deleted when unused. */
    agents: z.enum(["move", "delete"]).default("move"),
    /** Destination for moved agents and for the team's workflows (always moved). */
    moveTo: teamIdSchema.default(MAIN_TEAM_ID),
  })
  .strict();
const membersSchema = z
  .object({
    agentIds: z.array(z.string().min(1).max(200)).max(500).default([]),
    workflowIds: z.array(z.string().min(1).max(200)).max(500).default([]),
  })
  .strict();

export class TeamSpaces {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  private stored(): TeamSpace[] {
    return this.store.list<TeamSpace>("team-space");
  }
  /** Main first (virtual until stored), then the others in creation order. */
  list(): TeamSpace[] {
    const all = this.stored();
    const main = all.find((t) => t.id === MAIN_TEAM_ID) ?? {
      id: MAIN_TEAM_ID,
      name: MAIN_TEAM_NAME,
      description: "",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    return [main, ...all.filter((t) => t.id !== MAIN_TEAM_ID)];
  }
  exists(id: string) {
    return id === MAIN_TEAM_ID || this.stored().some((t) => t.id === id);
  }
  get(id: string): TeamSpace {
    const team = this.list().find((t) => t.id === id);
    if (!team)
      throw new AppError(404, "team_not_found", `Team ${id} not found`);
    return team;
  }
  /** null for the global Team Assistant; Main for legacy or dangling ids. */
  teamOfAgent(agent: Pick<Agent, "kind"> & { teamId?: string | null }) {
    if (agent.kind === "team-assistant") return null;
    const id = agent.teamId;
    return id && this.exists(id) ? id : MAIN_TEAM_ID;
  }
  teamOfWorkflow(workflow: { teamId?: string | null }) {
    const id = workflow.teamId;
    return id && this.exists(id) ? id : MAIN_TEAM_ID;
  }
  /** Team for a newly created record: an explicit, existing id or else the active team. */
  forCreate(teamId: unknown): string {
    if (teamId === undefined || teamId === null) return this.active();
    const id = teamIdSchema.parse(teamId);
    assert(this.exists(id), "team_not_found", `Team ${id} not found`, 404);
    return id;
  }
  /** "Name", "Name 2", "Name 3"… (case-insensitive, ignoring `except`). */
  uniqueName(base: string, except?: string) {
    const clean = base.trim().slice(0, 74) || "Team";
    const taken = new Set(
      this.list()
        .filter((t) => t.id !== except)
        .map((t) => t.name.toLowerCase()),
    );
    if (!taken.has(clean.toLowerCase())) return clean;
    for (let n = 2; ; n++)
      if (!taken.has(`${clean} ${n}`.toLowerCase())) return `${clean} ${n}`;
  }
  active(): string {
    try {
      const id = this.store.get<{ teamId: string }>(
        "settings",
        "active-team",
      ).teamId;
      return this.exists(id) ? id : MAIN_TEAM_ID;
    } catch {
      return MAIN_TEAM_ID;
    }
  }
  setActive(input: unknown) {
    const { teamId } = z.object({ teamId: teamIdSchema }).strict().parse(input);
    assert(
      this.exists(teamId),
      "team_not_found",
      `Team ${teamId} not found`,
      404,
    );
    return this.store.transaction(() => {
      this.activateInTx(teamId);
      return { teamId };
    });
  }
  /** Inside a transaction: make `teamId` the active team (no-op when it already is). */
  activateInTx(teamId: string) {
    if (this.active() === teamId) return;
    this.store.put("settings", { id: "active-team", teamId });
    this.store.emit("team.activated", teamId);
  }
  create(input: unknown) {
    const data = createSchema.parse(input);
    return this.store.transaction(() =>
      this.createInTx(data.name, data.description),
    );
  }
  /** Inside an existing transaction (samples, templates, packs): a new team with a unique name. */
  createInTx(name: string, description = ""): TeamSpace {
    const now = new Date().toISOString();
    const team: TeamSpace = {
      id: randomUUID(),
      name: this.uniqueName(nameSchema.parse(name.slice(0, 80))),
      description: description.slice(0, 2000),
      createdAt: now,
      updatedAt: now,
    };
    this.store.put("team-space", team);
    this.store.emit("team.created", team.id, { name: team.name });
    return team;
  }
  update(id: string, input: unknown) {
    const data = updateSchema.parse(input);
    const current = this.get(id);
    return this.store.transaction(() => {
      const next: TeamSpace = {
        ...current,
        ...(data.name !== undefined
          ? { name: this.uniqueName(data.name, id) }
          : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      this.store.put("team-space", next);
      this.store.emit("team.updated", id, { name: next.name });
      return next;
    });
  }
  members(teamId: string) {
    const agents = this.store
      .list<Agent>("agent")
      .filter((a) => this.teamOfAgent(a) === teamId);
    const workflows = this.store
      .list<Workflow>("workflow")
      .filter((w) => this.teamOfWorkflow(w) === teamId);
    return { agents, workflows };
  }
  /** Running work that belongs to the team (its workflows' tasks, its agents' tasks and chats). */
  runningWork(teamId: string) {
    const { agents, workflows } = this.members(teamId);
    const agentIds = new Set(agents.map((a) => a.id)),
      workflowIds = new Set(workflows.map((w) => w.id));
    const tasks = this.store
      .list<Task>("task")
      .filter(
        (t) =>
          t.status === "running" &&
          (workflowIds.has(t.workflowId) || agentIds.has(t.agentId)),
      );
    const sessions = this.store
      .list<Session>("session")
      .filter((s) => s.state === "running" && agentIds.has(s.agentId));
    return { tasks, sessions };
  }
  /**
   * Move agents and/or workflows into `teamId`. The Team Assistant is global and cannot be moved.
   * Edges and rules are untouched: links to agents left behind become cross-team links.
   */
  move(teamId: string, input: unknown) {
    const data = membersSchema.parse(input);
    this.get(teamId);
    return this.store.transaction(() => {
      for (const id of data.agentIds) {
        const agent = this.store.get<Agent & { teamId?: string }>("agent", id);
        assert(
          agent.kind !== "team-assistant",
          "assistant_global",
          "The Team Assistant belongs to every team and cannot be moved",
          400,
        );
        this.store.put("agent", { ...agent, teamId });
        this.store.emit("agent.updated", id, { teamId });
      }
      for (const id of data.workflowIds) {
        const wf = this.store.get<Workflow & { teamId?: string }>(
          "workflow",
          id,
        );
        this.store.put("workflow", { ...wf, teamId });
        this.store.emit("workflow.moved", id, { teamId });
      }
      return { teamId, ...data };
    });
  }
  /**
   * Delete a team. Refused for Main and while any of its work runs. Workflows always move to
   * `moveTo`; agents move there too unless `agents: "delete"` is chosen explicitly, which deletes
   * them with the same rules as DELETE /agents (refused as a whole when any agent is in use).
   */
  delete(id: string, input: unknown) {
    const data = deleteSchema.parse(input ?? {});
    assert(
      id !== MAIN_TEAM_ID,
      "main_team",
      "The Main team cannot be deleted",
      409,
    );
    this.get(id);
    assert(
      data.moveTo !== id && this.exists(data.moveTo),
      "invalid_destination",
      "Choose another existing team to receive the workflows and agents",
      400,
    );
    return this.store.transaction(() => {
      const running = this.runningWork(id);
      assert(
        !running.tasks.length && !running.sessions.length,
        "team_busy",
        `This team has running work (${running.tasks.length} task(s), ${running.sessions.length} conversation(s)); wait for it or stop it before deleting the team`,
        409,
      );
      const { agents, workflows } = this.members(id);
      if (data.agents === "delete") {
        const leaving = new Set(agents.map((a) => a.id));
        const busy = agents.filter((a) =>
          this.service.agentInUse(a.id, leaving),
        );
        assert(
          !busy.length,
          "agent_in_use",
          `Cannot delete agents with sessions, tasks, child agents or workflows: ${busy
            .map((a) => a.name)
            .join(", ")}. Move them to another team instead.`,
          409,
        );
      }
      for (const w of workflows) {
        this.store.put("workflow", { ...w, teamId: data.moveTo });
        this.store.emit("workflow.moved", w.id, { teamId: data.moveTo });
      }
      if (data.agents === "delete")
        for (const a of agents) this.service.removeAgentInTx(a.id);
      else
        for (const a of agents) {
          this.store.put("agent", { ...a, teamId: data.moveTo });
          this.store.emit("agent.updated", a.id, { teamId: data.moveTo });
        }
      const wasActive = this.active() === id;
      this.store.remove("team-space", id);
      // The project profile describes this team's roles; it does not follow moved agents.
      this.store.remove("team-profile", id);
      if (wasActive) {
        this.store.put("settings", { id: "active-team", teamId: data.moveTo });
        this.store.emit("team.activated", data.moveTo);
      }
      this.store.emit("team.deleted", id, {
        agents: data.agents,
        moveTo: data.moveTo,
        agentIds: agents.map((a) => a.id),
        workflowIds: workflows.map((w) => w.id),
      });
      return {
        status: "deleted" as const,
        moveTo: data.moveTo,
        agents: data.agents,
        agentIds: agents.map((a) => a.id),
        workflowIds: workflows.map((w) => w.id),
      };
    });
  }
  /** Per-team counts for the switcher (read-only; computed from tasks, sessions and workflows). */
  summaries(): TeamSummary[] {
    const agents = this.store.list<Agent>("agent");
    const workflows = this.store.list<Workflow>("workflow");
    const tasks = this.store.list<Task>("task");
    const sessions = this.store.list<Session>("session");
    const agentTeam = new Map(agents.map((a) => [a.id, this.teamOfAgent(a)]));
    const wfTeam = new Map(
      workflows.map((w) => [w.id, this.teamOfWorkflow(w)]),
    );
    return this.list().map((team) => {
      const mine = (t: Task) => wfTeam.get(t.workflowId) === team.id;
      const running =
        tasks.filter((t) => mine(t) && t.status === "running").length +
        sessions.filter(
          (s) => s.state === "running" && agentTeam.get(s.agentId) === team.id,
        ).length;
      const queued = tasks.filter(
        (t) => mine(t) && t.status === "queued",
      ).length;
      const attention =
        tasks.filter(
          (t) =>
            mine(t) && ["failed", "interrupted", "blocked"].includes(t.status),
        ).length +
        workflows.filter(
          (w) =>
            wfTeam.get(w.id) === team.id &&
            w.paused &&
            tasks.some((t) => t.workflowId === w.id && t.status === "queued"),
        ).length;
      return {
        ...team,
        main: team.id === MAIN_TEAM_ID,
        agents: agents.filter((a) => agentTeam.get(a.id) === team.id).length,
        workflows: workflows.filter((w) => wfTeam.get(w.id) === team.id).length,
        running,
        queued,
        attention,
        status: running ? "running" : attention ? "attention" : "idle",
      };
    });
  }
  /**
   * Teams an event belongs to (for `?teamId=` filters of /events). Agent-, workflow-, task- and
   * session-scoped events resolve through their entity; team events through their id. Events of
   * the global assistant or of global settings belong to no team and are left out of a filter.
   */
  eventTeams(
    event: { type: string; entityId: string; data: unknown },
    index = this.index(),
  ): Set<string> {
    const out = new Set<string>();
    const d = (
      event.data && typeof event.data === "object" ? event.data : {}
    ) as Record<string, unknown>;
    const add = (t: string | null | undefined) => t && out.add(t);
    const ids = [
      event.entityId,
      d.agentId,
      d.workflowId,
      d.taskId,
      d.fromAgentId,
      d.toAgentId,
    ].filter((v): v is string => typeof v === "string");
    for (const id of ids) {
      add(index.agent.get(id));
      add(index.workflow.get(id));
      add(index.task.get(id));
      add(index.session.get(id));
    }
    if (event.type.startsWith("team.") && this.exists(event.entityId))
      out.add(event.entityId);
    return out;
  }
  index() {
    const agent = new Map<string, string | null>(),
      workflow = new Map<string, string>(),
      task = new Map<string, string>(),
      session = new Map<string, string | null>();
    for (const a of this.store.list<Agent>("agent"))
      agent.set(a.id, this.teamOfAgent(a));
    for (const w of this.store.list<Workflow>("workflow"))
      workflow.set(w.id, this.teamOfWorkflow(w));
    for (const t of this.store.list<Task>("task"))
      task.set(t.id, workflow.get(t.workflowId) ?? MAIN_TEAM_ID);
    for (const s of this.store.list<Session>("session"))
      session.set(s.id, agent.get(s.agentId) ?? null);
    return { agent, workflow, task, session };
  }
}

/**
 * Team routes (behind the bearer-token check in http.ts). `/teams` is the saved-template library;
 * these manage the live team containers.
 *
 *   GET    /team-spaces                         {teams: TeamSummary[], activeTeamId}
 *   POST   /team-spaces                         {name, description?} → 201 (name made unique)
 *   GET|PUT /team-spaces/active                 {teamId}
 *   GET|PUT /team-spaces/:id                    {name?, description?}
 *   DELETE /team-spaces/:id                     {agents?: move|delete, moveTo?} (Main refused, running refused)
 *   POST   /team-spaces/:id/members             {agentIds?, workflowIds?} moves them into the team
 */
export async function teamSpaceRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  if (path !== "/team-spaces" && !path.startsWith("/team-spaces/"))
    return undefined;
  const teams = service.teamSpaces;
  const parts = path.split("/").slice(2).map(decodeURIComponent);
  if (!parts.length) {
    if (method === "GET")
      return {
        data: { teams: teams.summaries(), activeTeamId: teams.active() },
      };
    if (method === "POST")
      return { data: teams.create(await readBody()), status: 201 };
  }
  if (parts.length === 1 && parts[0] === "active") {
    if (method === "GET") return { data: { teamId: teams.active() } };
    if (method === "PUT") return { data: teams.setActive(await readBody()) };
  }
  if (parts.length >= 1 && parts[0] !== "active") {
    const id = teamIdSchema.parse(parts[0]);
    if (parts.length === 1) {
      if (method === "GET")
        return {
          data: teams.summaries().find((t) => t.id === id) ?? teams.get(id),
        };
      if (method === "PUT") return { data: teams.update(id, await readBody()) };
      if (method === "DELETE")
        return { data: teams.delete(id, await readBody()) };
    }
    if (parts.length === 2 && parts[1] === "members" && method === "POST")
      return { data: teams.move(id, await readBody()) };
  }
  throw new AppError(404, "not_found", "Unknown team endpoint");
}
