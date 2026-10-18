import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { Store } from "./store.ts";
import { assert, type Agent, type Task, type Workflow } from "./model.ts";
export type Resource = {
  id: string;
  name: string;
  path: string;
  priorities: { agentId: string; priority: number }[];
};
export type Coordination = {
  enabled: boolean;
  coordinatorId: string;
  resourceIds: string[];
  maxConcurrent: number;
  planTaskId?: string;
};
export type Lease = {
  id: string;
  agentId: string;
  workflowId: string | null;
  paths: string[];
  acquiredAt: string;
};
export function contains(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !/^\.\.[\\/]/.test(rel))
  );
}
export function overlaps(a: string, b: string) {
  return contains(a, b) || contains(b, a);
}
export class ResourceCoordinator {
  store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  priority(agentId: string) {
    const agent = this.store.get<Agent>("agent", agentId);
    const values = this.store
      .list<Resource>("resource")
      .filter((r) => agent.workspaces.some((w) => overlaps(r.path, w.path)))
      .flatMap((r) =>
        r.priorities
          .filter((p) => p.agentId === agentId)
          .map((p) => p.priority),
      );
    return values.length
      ? Math.max(...values)
      : (agent.schedulingPriority ?? 50);
  }
  score(task: Task, now = Date.now()) {
    return (
      this.priority(task.agentId) +
      Math.max(
        0,
        now - Date.parse(task.queuedAt ?? new Date(now).toISOString()),
      ) /
        5000
    );
  }
  ordered(tasks: Task[]) {
    const now = Date.now();
    return [...tasks].sort((a, b) => this.score(b, now) - this.score(a, now));
  }
  conflicts(agentId: string, workflowId: string | null, id: string) {
    const agent = this.store.get<Agent>("agent", agentId),
      paths = agent.workspaces.map((w) => w.path);
    const coordination = workflowId
      ? (
          this.store.get<Workflow>("workflow", workflowId) as Workflow & {
            coordination?: Coordination;
          }
        ).coordination
      : undefined;
    const resources = this.store.list<Resource>("resource");
    const leases = this.store.list<Lease>("lease").filter((l) => l.id !== id);
    return leases.filter((lease) => {
      const pairs = paths.flatMap((path) =>
        lease.paths
          .filter((other) => overlaps(path, other))
          .map((other) => [path, other]),
      );
      if (!pairs.length) return false;
      if (coordination?.enabled && lease.workflowId === workflowId) {
        const shared = resources.filter((r) =>
          coordination.resourceIds.includes(r.id),
        );
        const covered = pairs.every(([a, b]) =>
          shared.some((r) => contains(r.path, a) && contains(r.path, b)),
        );
        const active = leases.filter(
          (l) =>
            l.workflowId === workflowId &&
            l.paths.some((path) => shared.some((r) => overlaps(r.path, path))),
        ).length;
        if (covered && active < coordination.maxConcurrent) return false;
      }
      return true;
    });
  }
  acquire(id: string, agentId: string, workflowId: string | null) {
    return this.store.transaction(() => {
      const conflicts = this.conflicts(agentId, workflowId, id);
      assert(
        !conflicts.length,
        "resource_busy",
        "Waiting for shared resources held by " +
          conflicts
            .map((l) => this.store.get<Agent>("agent", l.agentId).name)
            .join(", "),
      );
      const agent = this.store.get<Agent>("agent", agentId);
      const lease: Lease = {
        id,
        agentId,
        workflowId,
        paths: agent.workspaces.map((w) => w.path),
        acquiredAt: new Date().toISOString(),
      };
      this.store.put("lease", lease);
      this.store.emit("resource.acquired", id, lease);
      return lease;
    });
  }
  release(id: string) {
    if (this.store.list<Lease>("lease").some((l) => l.id === id)) {
      this.store.remove("lease", id);
      this.store.emit("resource.released", id);
    }
  }
  async save(input: unknown) {
    const value = z
      .object({
        id: z.string().optional(),
        name: z.string().trim().min(1),
        path: z.string().min(1),
        priorities: z
          .array(
            z
              .object({
                agentId: z.string(),
                priority: z.number().int().min(0).max(100),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .parse(input);
    const path = await realpath(value.path);
    assert(
      this.store
        .list<Agent>("agent")
        .some((a) => a.workspaces.some((w) => overlaps(w.path, path))),
      "resource_unattached",
      "Attach this resource to at least one agent first",
      400,
    );
    for (const p of value.priorities) this.store.get<Agent>("agent", p.agentId);
    assert(
      new Set(value.priorities.map((p) => p.agentId)).size ===
        value.priorities.length,
      "duplicate_priority",
      "Only one priority per agent",
      400,
    );
    const existing = this.store
      .list<Resource>("resource")
      .find((r) => r.path === path);
    const resource: Resource = {
      ...value,
      path,
      id: existing?.id ?? value.id ?? randomUUID(),
    };
    if (value.id) this.store.get<Resource>("resource", value.id);
    this.store.put("resource", resource);
    this.store.emit("resource.configured", resource.id);
    return resource;
  }
  configureWorkflow(id: string, input: unknown) {
    const data = z
      .object({
        enabled: z.boolean(),
        coordinatorId: z.string(),
        resourceIds: z.array(z.string()).min(1),
        maxConcurrent: z.number().int().min(2).max(32),
      })
      .strict()
      .parse(input);
    this.store.get<Agent>("agent", data.coordinatorId);
    for (const rid of data.resourceIds)
      this.store.get<Resource>("resource", rid);
    assert(
      !this.store.list<Lease>("lease").some((l) => l.workflowId === id),
      "workflow_running",
      "Wait for active workflow tasks to finish before changing parallel access",
    );
    const workflow = this.store.get<Workflow & { coordination?: Coordination }>(
      "workflow",
      id,
    );
    return this.store.transaction(() => {
      const oldPlan = workflow.coordination?.planTaskId;
      const coordination: Coordination = { ...data };
      if (data.enabled) {
        const task: Task = {
          id: randomUUID(),
          workflowId: id,
          agentId: data.coordinatorId,
          title: "Coordinate parallel work: " + workflow.name,
          instructions:
            "Design a concrete division of work for the following workflow. Assign distinct files or responsibilities to workers, identify collision risks, and define integration checks. Your plan will be passed to each worker as a dependency result. Workflow: " +
            JSON.stringify(workflow) +
            "\nTasks: " +
            JSON.stringify(
              this.store.list<Task>("task").filter((t) => t.workflowId === id),
            ),
          completionCriteria:
            "A clear work allocation, shared-resource rules and integration checklist",
          dependsOn: [],
          status: "queued",
          queuedAt: new Date().toISOString(),
        };
        this.store.put("task", task);
        coordination.planTaskId = task.id;
        this.store.emit("task.created", task.id, { agentId: task.agentId });
      }
      for (const task of this.store
        .list<Task>("task")
        .filter(
          (t) =>
            t.workflowId === id &&
            t.status === "queued" &&
            t.id !== coordination.planTaskId,
        )) {
        if (task.id === oldPlan) {
          task.status = "cancelled";
        } else {
          task.dependsOn = task.dependsOn.filter((d) => d !== oldPlan);
          if (coordination.planTaskId && task.agentId !== data.coordinatorId)
            task.dependsOn.push(coordination.planTaskId);
        }
        this.store.put("task", task);
      }
      this.store.put("workflow", { ...workflow, coordination });
      this.store.emit("workflow.coordination", id, coordination);
      return coordination;
    });
  }
  snapshot() {
    const agents = this.store.list<Agent>("agent"),
      leases = this.store.list<Lease>("lease"),
      tasks = this.ordered(
        this.store.list<Task>("task").filter((t) => t.status === "queued"),
      );
    return {
      resources: this.store.list<Resource>("resource"),
      attached: agents.flatMap((a) =>
        a.workspaces.map((w) => ({ ...w, agentId: a.id, agentName: a.name })),
      ),
      leases,
      chatQueue: this.store
        .list<any>("run-request")
        .map((r) => ({
          ...r,
          priority: this.priority(r.agentId),
          effectivePriority: Math.floor(
            this.priority(r.agentId) +
              Math.max(0, Date.now() - Date.parse(r.queuedAt)) / 5000,
          ),
        })),
      queue: tasks.map((t) => ({
        id: t.id,
        agentId: t.agentId,
        workflowId: t.workflowId,
        title: t.title,
        priority: this.priority(t.agentId),
        effectivePriority: Math.floor(this.score(t)),
        waitingSince: t.queuedAt,
        blockers: this.conflicts(t.agentId, t.workflowId, t.id).map(
          (l) => l.agentId,
        ),
      })),
      fairness:
        "Effective priority increases by one every five seconds waiting. Existing work is never interrupted. Priorities range from 0 to 100.",
    };
  }
}
