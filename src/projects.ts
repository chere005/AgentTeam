// PROJECTS: units of work assigned to a TEAM. A team (src/team-spaces.ts container + optional
// project profile, src/team-profiles.ts) persists; each project is a workflow created against
// the team's EXISTING agents with its own goal, workspace, tasks and stage gates. Every project is
// created paused and stays paused until its gates pass (model verification for all project types;
// for pipeline projects also "Prepare and verify"). A team can be assigned any number of projects
// over time; each is listed in the team's Projects pane.
//
// - pipeline team          -> staged pipeline project (src/pipeline.ts createPipelineProject)
// - wolfram-validated team -> validated-reasoning project (src/samples.ts createWolframProject)
// - any other team         -> free-form project: goal + workspace + optional simple task list
//
// Routes (behind the bearer-token check in http.ts):
//   GET  /team-spaces/:id/projects   {teamId, projectType, profile, agents, projects, defaults}
//   POST /team-spaces/:id/projects   assign a project (body depends on the team's project type)
import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Task,
  type Workflow,
} from "./model.ts";
import { MAX_WORKERS, createPipelineProject } from "./pipeline.ts";
import {
  createWolframProject,
  projectName,
  type ModelExpectation,
  type WorkflowSetup,
} from "./samples.ts";
import type { TeamService } from "./service.ts";
import {
  PROJECT_TYPE_LABEL,
  attachProjectWorkspaceInTx,
  defaultProjectAccess,
  resolveProjectWorkspace,
  teamProfile,
  type ProjectType,
} from "./team-profiles.ts";
import { teamIdSchema } from "./team-spaces.ts";
import { projectState, type ProjectWorkflow } from "./project-lifecycle.ts";
import { completionCheckSchema } from "./limits-schema.ts";
import { simpleTaskSupport } from "./simple-task-capabilities.ts";

export const FREE_FORM_PROJECT = "free-form-project";
export const SIMPLE_TASK_PROJECT = "simple-task-project";

const freeFormSchema = z
  .object({
    goal: z.string().trim().min(10).max(20_000),
    workspace: z.string().min(1).max(4096),
    name: z.string().trim().min(1).max(120).optional(),
    completionCriteria: z.string().trim().min(1).max(4000).optional(),
    /** Coordinator of the project; default: the team's lead (profile) or its top agent. */
    ownerId: z.string().min(1).max(200).optional(),
    tasks: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            agentId: z.string().min(1).max(200),
            instructions: z.string().max(20_000).default(""),
            completionChecks: z.array(completionCheckSchema).max(20).optional(),
            /** Indexes (0-based) of other tasks in this list that must finish first. */
            dependsOn: z
              .array(z.number().int().min(0).max(29))
              .max(29)
              .optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    /**
     * Each task waits for the previous one (default) or all start together. Explicit per-task
     * `dependsOn` lists need `sequential: false` (the two would contradict each other).
     */
    sequential: z.boolean().default(true),
  })
  .strict();

type FreeFormTask = z.infer<typeof freeFormSchema>["tasks"][number];
/**
 * Dependencies of a free-form task list as index lists (validated: in range, not the task itself,
 * no duplicates, no cycle) and an order in which every task comes after its dependencies (stable:
 * list order among ready tasks). Shared by the API and its tests; the form reports these errors.
 */
export function planTaskOrder(tasks: FreeFormTask[], sequential: boolean) {
  const explicit = tasks.some((t) => t.dependsOn !== undefined);
  assert(
    !(sequential && explicit),
    "invalid_dependencies",
    'Choose either "run tasks in order" or explicit dependencies per task, not both',
    400,
  );
  const deps = tasks.map((t, i) => {
    const d = sequential ? (i > 0 ? [i - 1] : []) : (t.dependsOn ?? []);
    for (const j of d) {
      assert(
        j < tasks.length,
        "invalid_dependencies",
        `Task ${i + 1} ("${t.title}") depends on task ${j + 1}, which does not exist`,
        400,
      );
      assert(
        j !== i,
        "invalid_dependencies",
        `Task ${i + 1} ("${t.title}") cannot depend on itself`,
        400,
      );
    }
    assert(
      new Set(d).size === d.length,
      "invalid_dependencies",
      `Task ${i + 1} ("${t.title}") lists the same dependency twice`,
      400,
    );
    return d;
  });
  const order: number[] = [];
  const done = new Set<number>();
  while (order.length < tasks.length) {
    const next = tasks.findIndex(
      (_, i) => !done.has(i) && deps[i].every((j) => done.has(j)),
    );
    if (next < 0) {
      const stuck = tasks
        .map((t, i) => (done.has(i) ? null : `${i + 1} ("${t.title}")`))
        .filter(Boolean);
      throw new AppError(
        400,
        "dependency_cycle",
        `Task dependencies form a cycle among tasks ${stuck.join(", ")}`,
      );
    }
    done.add(next);
    order.push(next);
  }
  return { deps, order };
}

/** Agents of the team (never the global Team Assistant). */
function teamAgents(service: TeamService, teamId: string) {
  return service.teamSpaces
    .members(teamId)
    .agents.filter((a) => a.kind !== "team-assistant");
}

/** Default project lead: the profile's lead, else the root agent with the largest subtree. */
export function defaultLead(service: TeamService, teamId: string) {
  const agents = teamAgents(service, teamId);
  const profile = teamProfile(service.store, teamId);
  if (profile && agents.some((a) => a.id === profile.leadId))
    return profile.leadId;
  const ids = new Set(agents.map((a) => a.id));
  const size = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return (
      1 +
      agents
        .filter((a) => a.parentId === id)
        .reduce((n, c) => n + size(c.id, seen), 0)
    );
  };
  const roots = agents.filter((a) => !a.parentId || !ids.has(a.parentId));
  return [...roots].sort((a, b) => size(b.id) - size(a.id))[0]?.id ?? null;
}

/** Free-form project on the team's existing agents (created paused, model check gates resume). */
export async function createFreeFormProject(
  service: TeamService,
  teamId: string,
  input: unknown,
  options: {
    simple?: boolean;
    confirmedChecks?: boolean;
    trustedRequest?: string;
  } = {},
) {
  const schema = options.simple
    ? freeFormSchema.extend({ goal: z.string().trim().min(1).max(20_000) })
    : freeFormSchema;
  const o = schema.parse(
    options.simple && input && typeof input === "object"
      ? {
          ...input,
          sequential: "sequential" in input ? input.sequential : false,
        }
      : input,
  );
  const { deps, order } = planTaskOrder(o.tasks, o.sequential);
  const workspace = await resolveProjectWorkspace(o.workspace, service.store);
  const store = service.store;
  const id = store.transaction(() => {
    const agents = teamAgents(service, teamId);
    assert(
      agents.length > 0,
      "team_empty",
      "This team has no agents yet; add agents or insert a team first",
      400,
    );
    const inTeam = (agentId: string, what: string) =>
      assert(
        agents.some((a) => a.id === agentId),
        "not_in_team",
        `${what} must be an agent of this team`,
        400,
      );
    const ownerId = o.ownerId ?? defaultLead(service, teamId)!;
    inTeam(ownerId, "The project lead");
    for (const t of o.tasks) inTeam(t.agentId, `The agent of "${t.title}"`);
    const profile = teamProfile(store, teamId);
    const involved = new Set(
      o.tasks.length
        ? [
            ...o.tasks.map((t) => t.agentId),
            ...(options.simple ? [] : [ownerId]),
          ]
        : [ownerId],
    );
    if (options.simple)
      for (const agent of agents.filter((a) => involved.has(a.id))) {
        const support = simpleTaskSupport(service, agent);
        assert(
          support.available,
          "simple_task_unsupported",
          `${agent.name}: ${support.reason}`,
          409,
        );
      }
    // The workspace goes to the agents the profile names (with its access), or to every agent
    // of the team with an access derived from its role (read-only roles read).
    const access: Record<string, "read" | "write"> = options.simple
      ? Object.fromEntries(
          agents
            .filter((a) => involved.has(a.id))
            .map((a) => [a.id, defaultProjectAccess(a)]),
        )
      : profile?.workspace
        ? Object.fromEntries(
            Object.entries(profile.workspace.access).filter(([aid]) =>
              agents.some((a) => a.id === aid),
            ),
          )
        : Object.fromEntries(
            agents.map((a) => [a.id, defaultProjectAccess(a)]),
          );
    // An explicit role map can intentionally leave the coordinator without the project folder.
    // Giving it a fallback read attachment still creates a folder lease for the whole manager
    // run, which blocks the writers it has just delegated work to.
    if (!options.simple && !profile?.workspace && !access[ownerId])
      access[ownerId] = defaultProjectAccess(
        agents.find((a) => a.id === ownerId)!,
      );
    const attachments = attachProjectWorkspaceInTx(store, access, workspace);
    const owner = store.get<Agent>("agent", ownerId);
    const workflow = service.workflow({
      name: o.name ?? projectName("Project", o.goal),
      goal: o.goal,
      ownerId,
      teamId,
      completionCriteria:
        o.completionCriteria ??
        "The goal is met; the lead reports what was done, what was checked and what remains unverified.",
    });
    const expectations: Record<string, ModelExpectation> = {};
    for (const aid of involved) {
      const a = agents.find((agent) => agent.id === aid)!;
      expectations[aid] = (!options.simple
        ? profile?.expectations[aid]
        : undefined) ?? {
        label: "its configured model",
        family: "",
        version: "",
        ...(a.effort ? { effort: a.effort } : {}),
      };
    }
    const setup: WorkflowSetup = {
      sample: options.simple ? SIMPLE_TASK_PROJECT : FREE_FORM_PROJECT,
      intendedLead: owner.name,
      requiresModelVerification: true,
      modelCheck: {
        verified: false,
        checkedAt: null,
        issues: [],
        warnings: [],
        resolved: [],
      },
      expectations,
      workspace,
      attachments,
      ...(options.simple ? { executionMode: "file-only" as const } : {}),
    };
    store.put("workflow", { ...workflow, paused: true, setup });
    store.emit("workflow.paused", workflow.id);
    // Classify the assignment prose, but ground literal checks only in the separate human request.
    // User-authored form checks are authoritative; model-authored checks still need provenance.
    service.contracts.seedProject({
      workflowId: workflow.id,
      text: [o.goal, ...o.tasks.map((t) => t.instructions)].join("\n"),
      source: "assignment",
      trustedRequest:
        options.trustedRequest ??
        ((options.confirmedChecks ?? true)
          ? [o.goal, ...o.tasks.map((t) => t.instructions)].join("\n")
          : ""),
      projectFolder: workspace,
      owner,
      teamId,
    });
    const tasks = o.tasks.length
      ? o.tasks
      : [
          {
            title: options.simple
              ? o.goal.slice(0, 200)
              : "Plan and coordinate",
            agentId: ownerId,
            instructions: options.simple
              ? `TASK WORKSPACE (absolute path): ${workspace}\n\nTASK:\n${o.goal}\n\nComplete this small task directly using your existing file tools and replies. Terminal access is unavailable for this task. Do not create a pipeline or delegate the entire team unless the user explicitly requested delegation. Report the actual result and any checks that passed.`
              : `PROJECT WORKSPACE (absolute path): ${workspace}\n\nGOAL:\n${o.goal}\n\nRestate the goal as acceptance criteria, then plan and delegate the work to the team through AgentTeam. Report what was done, what was checked and what remains unverified.`,
          },
        ];
    // Created in dependency order so every dependency exists when its dependent is created.
    const ids: string[] = [];
    for (const i of o.tasks.length ? order : [0]) {
      const t = tasks[i];
      const created: Task = service.task({
        workflowId: workflow.id,
        agentId: t.agentId,
        title: t.title,
        instructions:
          t.instructions || `Contribute to the project goal:\n${o.goal}`,
        completionCriteria: "Done as described, with evidence",
        ...("completionChecks" in t && t.completionChecks
          ? { completionChecks: t.completionChecks }
          : {}),
        ...(options.simple
          ? { executionMode: "file-only", resourcePaths: [workspace] }
          : {}),
        ...(o.tasks.length && deps[i].length
          ? { dependsOn: deps[i].map((j) => ids[j]) }
          : {}),
        // Recorded as delegated by the lead only where the graph allows that delegation.
        ...(t.agentId !== ownerId &&
        service.permitted(ownerId, t.agentId, "delegate")
          ? { invokedBy: ownerId }
          : {}),
      });
      service.contracts.seedTask({
        task: created,
        text: t.instructions || o.goal,
        source: "assignment",
        confirmedChecks: options.confirmedChecks ?? true,
        trustedRequest:
          options.trustedRequest ??
          ((options.confirmedChecks ?? true)
            ? [o.goal, ...o.tasks.map((t) => t.instructions)].join("\n")
            : ""),
      });
      ids[i] = created.id;
    }
    return workflow.id;
  });
  return service.workflowStatus(id);
}

/** Assign a project to the team according to its project type. */
export async function assignProject(
  service: TeamService,
  teamId: string,
  input: unknown,
  provenance: { confirmedChecks?: boolean; trustedRequest?: string } = {},
) {
  const { mode, ...projectInput } = z
    .object({ mode: z.enum(["simple", "team"]).optional() })
    .passthrough()
    .parse(input);
  if (mode === "simple")
    return createFreeFormProject(service, teamId, projectInput, {
      simple: true,
      confirmedChecks: provenance.confirmedChecks ?? true,
      trustedRequest: provenance.trustedRequest,
    });
  const profile = teamProfile(service.store, teamId);
  const type: ProjectType = profile?.type ?? "free-form";
  if (type === "pipeline")
    return createPipelineProject(service, teamId, projectInput);
  if (type === "wolfram-validated")
    return createWolframProject(service, teamId, projectInput);
  return createFreeFormProject(service, teamId, projectInput, {
    confirmedChecks: provenance.confirmedChecks ?? true,
    trustedRequest: provenance.trustedRequest,
  });
}

/** What the "Assign project" form needs for this team. */
export function projectInfo(service: TeamService, teamId: string) {
  service.teamSpaces.get(teamId);
  const profile = teamProfile(service.store, teamId);
  const type: ProjectType = profile?.type ?? "free-form";
  const members = teamAgents(service, teamId);
  const leadId = defaultLead(service, teamId);
  const lead = members.find((agent) => agent.id === leadId);
  const workspace =
    lead?.workspaces.find((folder) => folder.active)?.path ??
    members.flatMap((agent) => agent.workspaces).find((folder) => folder.active)
      ?.path ??
    "";
  const agents = members.map((a) => ({
    id: a.id,
    name: a.name,
    roleType: a.roleType,
    parentId: a.parentId,
    simpleAvailable: simpleTaskSupport(service, a).available,
    simpleBlocker: simpleTaskSupport(service, a).reason,
    canWriteFiles:
      a.tools.includes("read") &&
      (a.tools.includes("write") || a.tools.includes("edit")) &&
      (a.workspaces.some((folder) => folder.access === "write") ||
        defaultProjectAccess(a) === "write"),
  }));
  const projects = service.teamSpaces
    .members(teamId)
    .workflows.map((w: ProjectWorkflow) => ({
      id: w.id,
      name: w.name,
      paused: w.paused,
      kind: w.setup?.sample ?? null,
      lifecycle: projectState(w),
    }));
  return {
    teamId,
    projectType: type,
    projectLabel: PROJECT_TYPE_LABEL[type],
    profile,
    leadId,
    agents,
    projects,
    defaults: {
      workspace,
      ...(type === "pipeline"
        ? {
            implementationWorkers: (profile?.roles.implement ?? []).length,
            fixWorkers: (profile?.roles.fix ?? []).length,
            maxWorkers: MAX_WORKERS,
            isolation: ["worktree", "paths"],
          }
        : type === "wolfram-validated"
          ? { validators: (profile?.roles.validators ?? []).length }
          : {}),
    },
  };
}

export async function projectRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const m = url.pathname.match(/^\/team-spaces\/([^/]+)\/projects$/);
  if (!m) return undefined;
  const teamId = teamIdSchema.parse(decodeURIComponent(m[1]));
  service.teamSpaces.get(teamId);
  if (method === "GET") return { data: projectInfo(service, teamId) };
  if (method === "POST")
    return {
      data: await assignProject(service, teamId, await readBody()),
      status: 201,
    };
  return undefined;
}
