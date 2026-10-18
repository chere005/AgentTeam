// Team settings: view and change a TEAM's project profile after insert (src/team-profiles.ts).
// Shows the project type, lead, roles -> agents, worker counts, model expectations and workspace
// access defaults; changes worker counts by adding or removing worker agents following the role's
// preset (a copy of the role's last agent: role type, runtime, model, effort, tools, skills,
// instructions, parent in the org tree, connections and routing rules it starts); re-runs the
// team's model check. Rename/description use PUT /team-spaces/:id.
//
// Existing projects are never changed: a project keeps the agents it was built on, and projects
// assigned later use the new counts. Removal is refused (as a whole) for an agent with unfinished
// work (running, queued, interrupted, blocked or failed tasks), an external effect whose outcome is
// uncertain, a running conversation, agents reporting to it or a project it leads. An agent whose
// finished history other records refer to is retired instead of deleted: it leaves the role (new
// projects no longer use it) and is reinstated first when the role grows again. Verification of
// paused pipeline projects stays bound to their own agents (src/pipeline.ts fingerprint); the
// response lists each affected paused project with its verification state.
//
// Routes (behind the bearer-token check in http.ts):
//   GET  /team-spaces/:id/settings               profile view
//   PUT  /team-spaces/:id/settings/workers       {counts: {role: n}, remove?: [agentId]}
//   POST /team-spaces/:id/settings/model-check   re-run the model check (stored on the profile)
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DetectedRuntime } from "./discovery.ts";
import {
  AppError,
  assert,
  type Agent,
  type Edge,
  type Rule,
  type Session,
  type Task,
  type Workflow,
} from "./model.ts";
import { MAX_WORKERS } from "./pipeline.ts";
import { projectState, type ProjectWorkflow } from "./project-lifecycle.ts";
import { assessModels, type ModelCheck } from "./samples.ts";
import type { TeamService } from "./service.ts";
import {
  PROJECT_TYPE_LABEL,
  defaultProjectAccess,
  teamProfile,
  type ProjectType,
  type TeamProfile,
} from "./team-profiles.ts";
import { teamIdSchema } from "./team-spaces.ts";

/** Roles whose size is a team setting, per project type (bounds and the profile setting key). */
export const COUNTABLE_ROLES: Record<
  ProjectType,
  Record<string, { label: string; min: number; max: number; setting: string }>
> = {
  pipeline: {
    implement: {
      label: "Implementation workers",
      min: 1,
      max: MAX_WORKERS,
      setting: "implementationWorkers",
    },
    fix: {
      label: "Fix workers",
      min: 1,
      max: MAX_WORKERS,
      setting: "fixWorkers",
    },
  },
  "wolfram-validated": {
    validators: {
      label: "Wolfram validators",
      min: 1,
      max: 2,
      setting: "wolframAgents",
    },
  },
  "free-form": {},
};

const ROLE_LABEL: Record<string, string> = {
  planner: "Planner",
  integrator: "Integrator",
  implement: "Implementation workers",
  codexReview: "Codex review",
  fableReview: "Fable review",
  adjudicator: "Adjudicator",
  fix: "Fix workers",
  finalCodex: "Final Codex review",
  finalFable: "Final Fable review",
  reporter: "Reporter",
  lead: "Lead",
  validators: "Wolfram validators",
  test: "Tests",
  review: "Code review",
  security: "Security review",
  docs: "Documentation",
};
const roleLabel = (r: string) =>
  ROLE_LABEL[r] ?? r.charAt(0).toUpperCase() + r.slice(1);

const workersSchema = z
  .object({
    counts: z.record(z.string().min(1).max(60), z.number().int()),
    /** Which agents to remove where a count goes down (default: the role's last agents). */
    remove: z.array(z.string().min(1).max(200)).max(20).optional(),
  })
  .strict();

const UNFINISHED: Task["status"][] = [
  "running",
  "queued",
  "interrupted",
  "blocked",
  "failed",
];

/** "Implementation Worker 3 (Sonnet 5.5)" for the 3rd agent of a role (unique in the team). */
function workerName(template: string, n: number, taken: Set<string>) {
  const make = (k: number) =>
    /\d+/.test(template)
      ? template.replace(/\d+/, String(k))
      : `${template} ${k}`;
  let k = n;
  while (taken.has(make(k))) k++;
  return make(k);
}

export class TeamSettings {
  service: TeamService;
  runtimes: () => DetectedRuntime[] | undefined;
  constructor(
    service: TeamService,
    runtimes: () => DetectedRuntime[] | undefined = () => undefined,
  ) {
    this.service = service;
    this.runtimes = runtimes;
  }
  private get store() {
    return this.service.store;
  }
  private teamAgents(teamId: string) {
    return this.service.teamSpaces
      .members(teamId)
      .agents.filter((a) => a.kind !== "team-assistant");
  }

  /** Why `agentId` cannot be removed now (empty = it can). */
  removalBlockers(agentId: string, leaving: ReadonlySet<string>) {
    const out: string[] = [];
    const tasks = this.store
      .list<Task>("task")
      .filter((t) => t.agentId === agentId);
    const open = tasks.filter((t) => UNFINISHED.includes(t.status));
    if (open.length)
      out.push(
        `${open.length} unfinished task(s) (“${open[0].title}” ${open[0].status})`,
      );
    if (
      tasks.some((t) => this.service.recovery.ledger.uncertainFor(t.id).length)
    )
      out.push("an external effect whose outcome is uncertain");
    if (
      this.store
        .list<Session>("session")
        .some((s) => s.agentId === agentId && s.state === "running")
    )
      out.push("a running conversation");
    if (
      this.store
        .list<Agent>("agent")
        .some((a) => a.parentId === agentId && !leaving.has(a.id))
    )
      out.push("agents report to it");
    if (
      this.store.list<Workflow>("workflow").some((w) => w.ownerId === agentId)
    )
      out.push("it leads a project");
    return out;
  }

  /** Paused, active (not archived/completed) pipeline projects and whether their verification holds. */
  pausedPipelines(teamId: string) {
    return this.service.teamSpaces
      .members(teamId)
      .workflows.filter(
        (w) =>
          w.paused &&
          projectState(w as ProjectWorkflow) === "active" &&
          !!this.service.pipelines.maybeRecord(w.id),
      )
      .map((w) => ({
        id: w.id,
        name: w.name,
        verification: this.service.pipelines.verification(w.id),
      }));
  }

  view(teamId: string) {
    const team = this.service.teamSpaces.get(teamId);
    const profile = teamProfile(this.store, teamId);
    const agents = this.teamAgents(teamId);
    const byId = new Map(agents.map((a) => [a.id, a]));
    const brief = (id: string) => {
      const a = byId.get(id);
      return a
        ? {
            id,
            name: a.name,
            roleType: a.roleType,
            environment: a.environment,
            model: a.model,
            effort: a.effort,
          }
        : { id, name: "(missing agent)", missing: true };
    };
    const type: ProjectType = profile?.type ?? "free-form";
    const countable = COUNTABLE_ROLES[type];
    const lead = profile?.leadId ?? null;
    return {
      team: { id: team.id, name: team.name, description: team.description },
      hasProfile: !!profile,
      projectType: type,
      projectLabel: PROJECT_TYPE_LABEL[type],
      source: profile?.source ?? null,
      lead: lead ? brief(lead) : null,
      intendedLead: profile?.intendedLead ?? null,
      roles: profile
        ? Object.entries(profile.roles).map(([role, ids]) => ({
            role,
            label: roleLabel(role),
            agents: ids.map(brief),
            count: profile ? ids.length : 0,
            ...(countable[role] ? { countable: countable[role] } : {}),
          }))
        : [],
      retired: (profile?.retired ?? []).map((r) => ({
        ...r,
        name: byId.get(r.agentId)?.name ?? "(deleted)",
      })),
      settings: profile?.settings ?? {},
      // Workspace access a project gives each agent: the profile's mapping, else derived per agent.
      workspaceAccess: profile?.workspace
        ? {
            label: profile.workspace.label,
            derived: false,
            agents: Object.entries(profile.workspace.access).map(
              ([id, access]) => ({ ...brief(id), access }),
            ),
          }
        : {
            label: "Project workspace",
            derived: true,
            agents: agents.map((a) => ({
              ...brief(a.id),
              access: defaultProjectAccess(a),
            })),
          },
      expectations: Object.entries(profile?.expectations ?? {}).map(
        ([id, e]) => ({ ...brief(id), expectation: e }),
      ),
      modelCheck: profile?.modelCheck ?? null,
      projects: this.service.teamSpaces.members(teamId).workflows.map((w) => ({
        id: w.id,
        name: w.name,
        paused: w.paused,
        state: projectState(w as ProjectWorkflow),
      })),
      pausedPipelines: this.pausedPipelines(teamId),
    };
  }

  /** Change the size of countable roles (atomically; any refusal leaves the team unchanged). */
  changeWorkers(teamId: string, input: unknown) {
    const data = workersSchema.parse(input);
    this.service.teamSpaces.get(teamId);
    const result = this.store.transaction(() => {
      const profile = teamProfile(this.store, teamId);
      assert(
        profile,
        "no_profile",
        "This team has no project profile, so it has no worker roles to resize",
        400,
      );
      const spec = COUNTABLE_ROLES[profile!.type];
      const roles: Record<string, string[]> = Object.fromEntries(
        Object.entries(profile!.roles).map(([r, ids]) => [r, [...ids]]),
      );
      for (const [role, n] of Object.entries(data.counts)) {
        const s = spec[role];
        assert(
          s,
          "role_not_countable",
          `“${roleLabel(role)}” is not a worker role of this team`,
          400,
        );
        assert(
          n >= s.min && n <= s.max,
          "invalid_count",
          `${s.label} must be from ${s.min} to ${s.max}`,
          400,
        );
      }
      const shrinking = new Set(
        Object.entries(data.counts)
          .filter(([role, n]) => n < roles[role].length)
          .map(([role]) => role),
      );
      for (const id of data.remove ?? [])
        assert(
          [...shrinking].some((r) => roles[r].includes(id)),
          "invalid_removal",
          "Only agents of a role whose count goes down can be removed",
          400,
        );
      // Choose who leaves, then check every one of them before anything is written.
      const leaving = new Map<string, string>(); // agent id -> role
      for (const role of shrinking) {
        const ids = roles[role];
        const count = ids.length - data.counts[role];
        const named = ids.filter((id) => data.remove?.includes(id));
        assert(
          !named.length || named.length === count,
          "invalid_removal",
          `Choose exactly ${count} agent(s) to remove from ${spec[role].label}, or none to remove the last ones`,
          400,
        );
        for (const id of named.length ? named : ids.slice(-count))
          leaving.set(id, role);
      }
      const leavingIds = new Set(leaving.keys());
      const refused = [...leaving.keys()]
        .map((id) => {
          const why = this.removalBlockers(id, leavingIds);
          const name =
            this.store.list<Agent>("agent").find((a) => a.id === id)?.name ??
            id;
          return why.length ? `${name}: ${why.join(", ")}` : null;
        })
        .filter(Boolean);
      if (refused.length)
        throw new AppError(
          409,
          "agent_in_use",
          `Cannot remove ${refused.join("; ")}. Finish or cancel that work first (existing projects are never changed silently).`,
        );
      const now = new Date().toISOString();
      const expectations = { ...profile!.expectations };
      const access = profile!.workspace
        ? { ...profile!.workspace.access }
        : undefined;
      let retired = [...(profile!.retired ?? [])];
      const added: string[] = [],
        reinstated: string[] = [],
        deleted: string[] = [],
        retiredNow: string[] = [];
      // Removal: delete agents nothing refers to; retire the ones finished history refers to.
      for (const [id, role] of leaving) {
        roles[role] = roles[role].filter((x) => x !== id);
        if (this.service.agentInUse(id, leavingIds)) {
          retired.push({ agentId: id, role, at: now });
          retiredNow.push(id);
        } else {
          this.service.removeAgentInTx(id);
          delete expectations[id];
          if (access) delete access[id];
          deleted.push(id);
        }
      }
      // Growth: reinstate retired agents of the role first, then copy the role's preset.
      const agentsNow = () =>
        this.store.list<Agent & { teamId?: string }>("agent");
      for (const [role, n] of Object.entries(data.counts)) {
        const ids = roles[role];
        if (n <= ids.length) continue;
        for (const r of retired.filter((x) => x.role === role)) {
          if (ids.length >= n) break;
          const a = agentsNow().find((x) => x.id === r.agentId);
          if (!a || this.service.teamSpaces.teamOfAgent(a) !== teamId) continue;
          ids.push(a.id);
          reinstated.push(a.id);
          retired = retired.filter((x) => x.agentId !== a.id);
        }
        const template = this.store.get<Agent & { teamId?: string }>(
          "agent",
          ids[ids.length - 1] ?? profile!.roles[role][0],
        );
        while (ids.length < n) {
          const taken = new Set(agentsNow().map((a) => a.name));
          const {
            id: _id,
            createdAt: _c,
            workspaces: _w,
            control: _ctl,
            ...preset
          } = template;
          const agent = {
            ...preset,
            id: randomUUID(),
            name: workerName(template.name, ids.length + 1, taken),
            workspaces: [],
            control: "team" as const,
            createdAt: now,
          };
          this.store.put("agent", agent);
          this.store.emit("agent.created", agent.id, { teamSettings: teamId });
          // The connections and routing rules the preset agent has, re-pointed to the new one.
          for (const e of this.store.list<Edge>("edge")) {
            if (e.from !== template.id && e.to !== template.id) continue;
            const edge: Edge = {
              ...e,
              id: randomUUID(),
              from: e.from === template.id ? agent.id : e.from,
              to: e.to === template.id ? agent.id : e.to,
            };
            if (edge.from === edge.to) continue;
            this.store.put("edge", edge);
            this.store.emit("edge.created", edge.id);
          }
          for (const r of this.store.list<Rule & { id: string }>("rule")) {
            if (r.agentId !== template.id) continue;
            const rule = { ...r, id: randomUUID(), agentId: agent.id };
            this.store.put("rule", rule);
            this.store.emit("rule.created", rule.id);
          }
          if (expectations[template.id])
            expectations[agent.id] = expectations[template.id];
          if (access && access[template.id])
            access[agent.id] = access[template.id];
          ids.push(agent.id);
          added.push(agent.id);
        }
      }
      const settings = { ...profile!.settings };
      for (const [role] of Object.entries(data.counts))
        settings[spec[role].setting] = roles[role].length;
      const next: TeamProfile = {
        ...profile!,
        roles,
        settings,
        expectations,
        ...(access ? { workspace: { ...profile!.workspace!, access } } : {}),
        retired,
        updatedAt: now,
      };
      this.store.put("team-profile", next);
      this.store.emit("team-profile.updated", teamId, {
        added: added.length + reinstated.length,
        removed: deleted.length + retiredNow.length,
      });
      return { added, reinstated, deleted, retired: retiredNow };
    });
    return {
      ...result,
      settings: this.view(teamId),
    };
  }

  /** Re-run the team's model check against the discovered runtimes; stored on the profile. */
  modelCheck(teamId: string): ModelCheck {
    this.service.teamSpaces.get(teamId);
    const profile = teamProfile(this.store, teamId);
    const agents = this.teamAgents(teamId);
    const subjects = profile
      ? agents.filter(
          (a) =>
            a.id === profile.leadId ||
            Object.values(profile.roles).some((ids) => ids.includes(a.id)) ||
            !!profile.expectations[a.id],
        )
      : agents;
    const r = assessModels(subjects, this.runtimes(), {
      ...(profile?.intendedLead
        ? { leadId: profile.leadId, intendedLead: profile.intendedLead }
        : {}),
      expectations: profile?.expectations ?? {},
    });
    const check: ModelCheck = {
      verified: !r.issues.length,
      checkedAt: new Date().toISOString(),
      ...r,
    };
    if (profile)
      this.store.transaction(() => {
        const p = teamProfile(this.store, teamId)!;
        this.store.put("team-profile", { ...p, modelCheck: check });
        this.store.emit("team-profile.model_check", teamId, {
          verified: check.verified,
        });
      });
    return check;
  }
}

export async function teamSettingsRoute(
  service: TeamService,
  runtimes: () => DetectedRuntime[] | undefined,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const m = url.pathname.match(
    /^\/team-spaces\/([^/]+)\/settings(?:\/(workers|model-check))?$/,
  );
  if (!m) return undefined;
  const teamId = teamIdSchema.parse(decodeURIComponent(m[1]));
  const settings = new TeamSettings(service, runtimes);
  if (method === "GET" && !m[2]) return { data: settings.view(teamId) };
  if (method === "PUT" && m[2] === "workers")
    return { data: settings.changeWorkers(teamId, await readBody()) };
  if (method === "POST" && m[2] === "model-check")
    return {
      data: {
        modelCheck: settings.modelCheck(teamId),
        settings: settings.view(teamId),
      },
    };
  return undefined;
}
