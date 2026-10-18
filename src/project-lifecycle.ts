// Project lifecycle: a PROJECT (a workflow assigned to a team, src/projects.ts) is active until the
// user completes or archives it; both can be reopened. When a project is archived, completed or
// all its tasks finished, the UI OFFERS (never forces) to detach the project workspace from the
// team's agents. Only attachments the project itself added are candidates (recorded on the project
// as `setup.attachments` by attachProjectWorkspaceInTx), and a folder is never detached while
// another active project of the same team uses it, while the agent works, or while an unfinished
// task elsewhere declares a path inside it. Reopening re-attaches what the project detached.
//
// Routes (behind the bearer-token check in http.ts):
//   GET  /projects/:id             {state, finished, verification, detach: {offer, candidates, kept}}
//   POST /projects/:id/lifecycle   {action: "complete" | "archive" | "reopen"}
//   POST /projects/:id/detach      {items?: [{agentId, path}]} detaches (default: every candidate)
//                                  {dismiss: true} declines the offer (not asked again)
import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Session,
  type Task,
  type Workflow,
} from "./model.ts";
import { overlaps } from "./resources.ts";
import type { WorkflowSetup } from "./samples.ts";
import type { TeamService } from "./service.ts";
import {
  attachProjectWorkspaceInTx,
  type ProjectAttachment,
} from "./team-profiles.ts";

export const PROJECT_STATES = ["active", "completed", "archived"] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];
export type ProjectLifecycle = {
  state: ProjectState;
  at: string;
};
export type ProjectWorkflow = Workflow & {
  setup?: WorkflowSetup;
  lifecycle?: ProjectLifecycle;
};

/** Lifecycle state of a workflow record (records without one are active). */
export const projectState = (w: { lifecycle?: ProjectLifecycle }) =>
  w.lifecycle?.state ?? "active";

const FINISHED: Task["status"][] = ["completed", "cancelled"];

export type DetachItem = {
  agentId: string;
  agentName: string;
  path: string;
  access: "read" | "write";
};
export type KeptItem = DetachItem & { reason: string };

const lifecycleSchema = z
  .object({ action: z.enum(["complete", "archive", "reopen"]) })
  .strict();
const detachSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            agentId: z.string().min(1).max(200),
            path: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    dismiss: z.literal(true).optional(),
  })
  .strict();

export class ProjectLifecycleService {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  private workflow(id: string) {
    return this.store.get<ProjectWorkflow>("workflow", id);
  }
  private tasks(id: string) {
    return this.store.list<Task>("task").filter((t) => t.workflowId === id);
  }
  /** Every task finished (completed or cancelled), and there is at least one. */
  finished(id: string) {
    const tasks = this.tasks(id);
    return tasks.length > 0 && tasks.every((t) => FINISHED.includes(t.status));
  }
  /** Active = neither archived nor completed by the user, and not every task finished. */
  isActive(w: ProjectWorkflow) {
    return projectState(w) === "active" && !this.finished(w.id);
  }

  setState(id: string, input: unknown) {
    const { action } = lifecycleSchema.parse(input);
    const at = new Date().toISOString();
    const result = this.store.transaction(() => {
      const wf = this.workflow(id);
      const state = projectState(wf);
      const tasks = this.tasks(id);
      if (action === "reopen") {
        assert(
          state !== "active",
          "project_active",
          "This project is already active",
        );
        // Re-attach what this project detached (same access as when it was assigned). Agents that
        // were deleted or moved to another team are skipped; a running conversation refuses.
        const attachments = wf.setup?.attachments ?? [];
        const teamId = this.service.teamSpaces.teamOfWorkflow(wf);
        const back: ProjectAttachment[] = [];
        for (const a of attachments) {
          if (!a.detachedAt) {
            back.push(a);
            continue;
          }
          const agent = this.store
            .list<Agent & { teamId?: string }>("agent")
            .find((x) => x.id === a.agentId);
          if (!agent || this.service.teamSpaces.teamOfAgent(agent) !== teamId) {
            back.push(a);
            continue;
          }
          const added = attachProjectWorkspaceInTx(
            this.store,
            { [a.agentId]: a.access },
            a.path,
          );
          back.push(added.length ? { ...added[0] } : a);
        }
        const next: ProjectWorkflow = {
          ...wf,
          lifecycle: { state: "active", at },
          ...(wf.setup
            ? {
                setup: {
                  ...wf.setup,
                  attachments: back,
                  detachDismissedAt: undefined,
                },
              }
            : {}),
        };
        this.store.put("workflow", next);
      } else if (action === "complete") {
        assert(
          state !== "completed",
          "project_completed",
          "This project is already completed",
        );
        const open = tasks.filter((t) => !FINISHED.includes(t.status));
        assert(
          !open.length,
          "project_unfinished",
          `${open.length} task(s) are not finished (${open
            .slice(0, 3)
            .map((t) => `"${t.title}" ${t.status}`)
            .join(
              ", ",
            )}); finish or cancel them first, or archive the project instead`,
        );
        this.store.put("workflow", {
          ...wf,
          lifecycle: { state: "completed", at },
        });
      } else {
        assert(
          state !== "archived",
          "project_archived",
          "This project is already archived",
        );
        const running = tasks.filter((t) => t.status === "running");
        assert(
          !running.length,
          "project_running",
          `"${running[0]?.title}" is running; stop it before archiving the project`,
        );
        // Archived projects never run: they stay paused until reopened and resumed through the
        // usual gates.
        this.store.put("workflow", {
          ...wf,
          paused: true,
          lifecycle: { state: "archived", at },
        });
        if (!wf.paused) this.store.emit("workflow.paused", id);
      }
      const after = this.workflow(id);
      this.store.emit("workflow.lifecycle", id, {
        from: state,
        to: projectState(after),
      });
      return after;
    });
    return {
      ...this.service.workflowStatus(result.id),
      project: this.view(id),
    };
  }

  /** Which of the project's own attachments may be detached now, and why the others stay. */
  detachPlan(id: string) {
    const wf = this.workflow(id);
    const teamId = this.service.teamSpaces.teamOfWorkflow(wf);
    const agents = new Map(
      this.store.list<Agent>("agent").map((a) => [a.id, a]),
    );
    const sessions = this.store.list<Session>("session");
    const allTasks = this.store.list<Task>("task");
    // Other active projects: of the same team, or of any team when they involve the agent (a
    // task assigned to it or a folder they attached to it; teams are presentation only).
    const workflows = new Map(
      this.store.list<ProjectWorkflow>("workflow").map((w) => [w.id, w]),
    );
    const others = [...workflows.values()].filter(
      (w) => w.id !== id && this.isActive(w),
    );
    const involves = (w: ProjectWorkflow, agentId: string) =>
      this.service.teamSpaces.teamOfWorkflow(w) === teamId ||
      allTasks.some((t) => t.workflowId === w.id && t.agentId === agentId) ||
      (w.setup?.attachments ?? []).some(
        (b) => !b.detachedAt && b.agentId === agentId,
      );
    const candidates: DetachItem[] = [];
    const kept: KeptItem[] = [];
    for (const a of wf.setup?.attachments ?? []) {
      if (a.detachedAt) continue;
      const agent = agents.get(a.agentId);
      if (!agent || !agent.workspaces.some((w) => w.path === a.path)) continue;
      const item: DetachItem = {
        agentId: agent.id,
        agentName: agent.name,
        path: a.path,
        access: a.access,
      };
      const user = others.find(
        (w) =>
          involves(w, agent.id) &&
          ((!!w.setup?.workspace && overlaps(w.setup.workspace, a.path)) ||
            (w.setup?.attachments ?? []).some(
              (b) => !b.detachedAt && overlaps(b.path, a.path),
            )),
      );
      const busy =
        sessions.some((s) => s.agentId === agent.id && s.state === "running") ||
        allTasks.some((t) => t.agentId === agent.id && t.status === "running");
      // An unfinished task elsewhere (archived projects included: reopening them does not
      // re-attach folders they did not add) that declares a path in the folder, or declares
      // nothing (it leases every attached folder and runs in the active one) while its project's
      // workspace is this folder or unknown.
      const needed = allTasks.find((t) => {
        if (
          t.workflowId === id ||
          t.agentId !== agent.id ||
          FINISHED.includes(t.status)
        )
          return false;
        if (t.resourcePaths?.length)
          return t.resourcePaths.some((p) => overlaps(p, a.path));
        const ws = workflows.get(t.workflowId)?.setup?.workspace;
        return !ws || overlaps(ws, a.path);
      });
      if (user)
        kept.push({ ...item, reason: `Used by active project “${user.name}”` });
      else if (busy)
        kept.push({
          ...item,
          reason: `${agent.name} is working; stop its active work first`,
        });
      else if (needed)
        kept.push({
          ...item,
          reason: `Needed by unfinished task “${needed.title}”`,
        });
      else candidates.push(item);
    }
    const state = projectState(wf);
    const finished = this.finished(id);
    return {
      /** Offer the detach (UI prompt): the project ended and something can be detached. */
      offer:
        (state !== "active" || finished) &&
        !wf.setup?.detachDismissedAt &&
        candidates.length > 0,
      dismissed: !!wf.setup?.detachDismissedAt,
      recorded: !!wf.setup?.attachments,
      candidates,
      kept,
    };
  }

  detach(id: string, input: unknown) {
    const data = detachSchema.parse(input ?? {});
    const at = new Date().toISOString();
    if (data.dismiss) {
      this.store.transaction(() => {
        const wf = this.workflow(id);
        assert(wf.setup, "not_a_project", "Nothing to detach", 400);
        this.store.put("workflow", {
          ...wf,
          setup: { ...wf.setup!, detachDismissedAt: at },
        });
        this.store.emit("workflow.detach_dismissed", id);
      });
      return { detached: [], kept: [], project: this.view(id) };
    }
    return this.store.transaction(() => {
      const wf = this.workflow(id);
      assert(
        projectState(wf) !== "active" || this.finished(id),
        "project_active",
        "Detach the project's folders after it is archived, completed or all its tasks finished",
      );
      const plan = this.detachPlan(id);
      const key = (x: { agentId: string; path: string }) =>
        `${x.agentId}\0${x.path}`;
      const wanted = data.items ?? plan.candidates;
      for (const w of wanted) {
        if (plan.candidates.some((c) => key(c) === key(w))) continue;
        const k = plan.kept.find((c) => key(c) === key(w));
        throw new AppError(
          409,
          "not_detachable",
          k
            ? `${k.agentName}: ${k.path} stays attached (${k.reason})`
            : `${w.path} was not attached to that agent by this project`,
        );
      }
      const done = new Set(wanted.map(key));
      for (const w of wanted) {
        const agent = this.store.get<Agent>("agent", w.agentId);
        const removed = agent.workspaces.find((x) => x.path === w.path)!;
        let workspaces = agent.workspaces.filter((x) => x.path !== w.path);
        if (
          removed.active &&
          workspaces.length &&
          !workspaces.some((x) => x.active)
        )
          workspaces = workspaces.map((x, i) => ({ ...x, active: i === 0 }));
        this.store.put("agent", { ...agent, workspaces });
        this.store.emit("agent.updated", agent.id, {
          workspaceDetached: w.path,
          workflowId: id,
        });
      }
      this.store.put("workflow", {
        ...wf,
        setup: {
          ...wf.setup!,
          attachments: (wf.setup?.attachments ?? []).map((a) =>
            done.has(key(a)) && !a.detachedAt ? { ...a, detachedAt: at } : a,
          ),
        },
      });
      this.store.emit("workflow.detached", id, { count: wanted.length });
      return {
        detached: wanted.map((w) => ({ agentId: w.agentId, path: w.path })),
        kept: plan.kept,
        project: this.view(id),
      };
    });
  }

  view(id: string) {
    const wf = this.workflow(id);
    return {
      id,
      state: projectState(wf),
      at: wf.lifecycle?.at ?? null,
      finished: this.finished(id),
      verification: this.service.pipelines.maybeRecord(id)
        ? this.service.pipelines.verification(id)
        : null,
      detach: this.detachPlan(id),
    };
  }
}

export async function projectLifecycleRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const m = url.pathname.match(
    /^\/projects\/([^/]+)(?:\/(lifecycle|detach))?$/,
  );
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]);
  service.store.get("workflow", id);
  const projects = new ProjectLifecycleService(service);
  if (method === "GET" && !m[2]) return { data: projects.view(id) };
  if (method === "POST" && m[2] === "lifecycle")
    return { data: projects.setState(id, await readBody()) };
  if (method === "POST" && m[2] === "detach")
    return { data: projects.detach(id, await readBody()) };
  return undefined;
}
