import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { decideBoth } from "./access.ts";
import { canonicalDeclaredPaths } from "./declared-paths.ts";
import { SAFE_GIT_CONFIG } from "./git-workflow.ts";
import { AppError, assert, type Agent, type Task } from "./model.ts";
import { repoLockKey } from "./repo-lock.ts";
import {
  contains,
  overlaps,
  type Coordination,
  type Resource,
} from "./resources.ts";
import type { TeamService } from "./service.ts";
import type { WorktreeService } from "./worktrees.ts";

const exec = promisify(execFile);

/**
 * Guided parallel work beyond the coordinator's prerequisite plan:
 *  - `assign` gives each worker task disjoint declared paths (leased individually, so workers truly
 *    run concurrently) or its own Git worktree, and adds a final integration task that depends on
 *    every worker;
 *  - `begin`/`check` snapshot each worker's checkouts when it starts and compare the changed files
 *    when it completes (changed-file comparison, including commits made by the worker): a write
 *    outside the worker's assignment or to a file another worker also changed is a conflict;
 *  - conflicts are persisted (`parallel-conflict`) and routed to the coordinator as a task the
 *    integration step waits for.
 * Detection compares file contents and Git state; it cannot see transient writes that were undone,
 * non-Git folders, or edits by tools outside AgentTeam (reported as "unavailable" per worker).
 * Workers that share one checkout see each other's in-flight edits in their own diff, so a
 * worker that finishes first can be blamed for a neighbour's write (use worktrees for strict
 * isolation); content identical to an earlier worker's recorded result is attributed to that worker.
 */
export type ChangedFile = {
  root: string;
  rel: string;
  repo: string;
  /** Fingerprint of the file when the worker finished (content hash, "deleted" or "dir"). */
  fp: string;
};
export type Violation = {
  kind: "out-of-scope" | "overlap";
  file: string;
  taskIds: string[];
  detail: string;
};
export type Assignment = {
  taskId: string;
  agentId: string;
  isolation: "paths" | "worktree";
  /** Absolute paths this worker may write (the worktree root for worktree isolation). */
  paths: string[];
  worktreeId?: string;
  worktreePath?: string;
  changed?: ChangedFile[];
  violations?: Violation[];
  checkedAt?: string;
  detection?: "ok" | "unavailable";
  note?: string;
};
export type ParallelPlan = {
  id: string; // workflow id
  workflowId: string;
  assignments: Assignment[];
  integrationTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ParallelConflict = {
  id: string;
  workflowId: string;
  kind: Violation["kind"];
  files: string[];
  taskIds: string[];
  detail: string;
  coordinatorTaskId: string;
  createdAt: string;
};
type Snapshot = { head: string | null; files: Record<string, string> };
type Baseline = {
  id: string; // task id
  roots: { root: string; snapshot: Snapshot | null }[];
};

export const assignSchema = z
  .object({
    assignments: z
      .array(
        z
          .object({
            taskId: z.string(),
            paths: z.array(z.string().min(1).max(1000)).max(50).default([]),
            worktree: z.boolean().default(false),
            /** Attached repository root to branch the worktree from (default: the active/first write folder). */
            workspace: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    integration: z
      .object({
        agentId: z.string().optional(),
        title: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Separates a task's own instructions from the scope text an assignment appends. */
export const PARALLEL_MARK = "[Parallel assignment]";
const MARK = PARALLEL_MARK;
async function git(cwd: string, args: string[]) {
  const r = await exec("git", ["-C", cwd, ...SAFE_GIT_CONFIG, ...args], {
    encoding: "utf8",
    maxBuffer: 16_000_000,
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return r.stdout;
}
async function fingerprint(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return "dir";
    if (info.size > 2_000_000) return `s:${info.size}:${info.mtimeMs}`;
    return createHash("sha1")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return "deleted";
  }
}
export async function snapshotRoot(root: string): Promise<Snapshot | null> {
  try {
    const status = await git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const parts = status.split("\0").filter(Boolean);
    const files: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i].slice(0, 2);
      const path = parts[i].slice(3);
      files[path] = await fingerprint(resolve(root, path));
      if (/[RC]/.test(code)) {
        const from = parts[++i];
        files[from] = "deleted";
      }
    }
    let head: string | null = null;
    try {
      head = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).trim();
    } catch {
      head = null;
    }
    return { head, files };
  } catch {
    return null;
  }
}

export class ParallelWork {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  plan(workflowId: string): ParallelPlan | null {
    try {
      return this.store.get<ParallelPlan>("parallel-plan", workflowId);
    } catch {
      return null;
    }
  }
  /** True when the task is a worker in a guided parallel plan (callers skip the async hooks otherwise). */
  isAssigned(taskId: string) {
    return !!this.assignmentFor(taskId);
  }
  private assignmentFor(taskId: string) {
    const task = this.store.list<Task>("task").find((t) => t.id === taskId);
    if (!task) return null;
    const plan = this.plan(task.workflowId);
    const assignment = plan?.assignments.find((a) => a.taskId === taskId);
    return plan && assignment ? { plan, assignment } : null;
  }
  private coordination(workflowId: string) {
    return (
      this.store.get<{ coordination?: Coordination }>("workflow", workflowId)
        .coordination ?? null
    );
  }

  // ---- assignment ---------------------------------------------------------------------------
  async assign(
    workflowId: string,
    input: unknown,
    deps: { worktrees?: WorktreeService } = {},
  ) {
    const data = assignSchema.parse(input);
    const coordination = this.coordination(workflowId);
    assert(
      coordination?.enabled,
      "parallel_disabled",
      "Enable guided parallel work for this workflow first",
      409,
    );
    const shared = this.store
      .list<Resource>("resource")
      .filter((r) => coordination.resourceIds.includes(r.id));
    const tasks = new Map(
      this.store
        .list<Task>("task")
        .filter((t) => t.workflowId === workflowId)
        .map((t) => [t.id, t]),
    );
    assert(
      new Set(data.assignments.map((a) => a.taskId)).size ===
        data.assignments.length,
      "duplicate_assignment",
      "Assign each task once",
      400,
    );
    const resolved: Assignment[] = [];
    for (const a of data.assignments) {
      const task = tasks.get(a.taskId);
      assert(
        task,
        "not_found",
        `Task ${a.taskId} is not in this workflow`,
        404,
      );
      assert(
        task.id !== coordination.planTaskId && task.status === "queued",
        "not_assignable",
        `"${task.title}" must be a queued worker task`,
        409,
      );
      const agent = this.store.get<Agent>("agent", task.agentId);
      if (a.worktree) {
        resolved.push({
          taskId: task.id,
          agentId: agent.id,
          isolation: "worktree",
          paths: [],
        });
        continue;
      }
      assert(
        a.paths.length > 0,
        "paths_required",
        `Name the files or folders for "${task.title}", or give it its own worktree`,
        400,
      );
      const paths = canonicalDeclaredPaths(agent, a.paths)!;
      for (const p of paths) {
        const ws = agent.workspaces
          .filter((w) => contains(w.path, p))
          .sort((x, y) => y.path.length - x.path.length)[0];
        const rel = relative(ws.path, p).replace(/\\/g, "/");
        assert(
          decideBoth(ws, rel, rel).access === "write",
          "read_only_assignment",
          `${agent.name} cannot write ${p}; assign a path it may write`,
          403,
        );
        assert(
          shared.some((r) => contains(r.path, p)),
          "outside_shared_resource",
          `${p} is not inside a resource shared by this workflow's parallel access`,
          400,
        );
      }
      resolved.push({
        taskId: task.id,
        agentId: agent.id,
        isolation: "paths",
        paths,
      });
    }
    // Disjointness: report the exact overlapping pairs.
    const clashes: string[] = [];
    for (let i = 0; i < resolved.length; i++)
      for (let j = i + 1; j < resolved.length; j++)
        for (const p of resolved[i].paths)
          for (const q of resolved[j].paths)
            if (overlaps(p, q))
              clashes.push(
                `"${tasks.get(resolved[i].taskId)!.title}" ${p} ~ "${tasks.get(resolved[j].taskId)!.title}" ${q}`,
              );
    if (clashes.length)
      throw new AppError(
        409,
        "assignment_overlap",
        "Assignments must be disjoint; these paths overlap: " +
          clashes.join("; "),
      );
    // Worktrees (created outside any transaction: they run Git and attach through saveAgent).
    for (const [i, a] of data.assignments.entries()) {
      if (!a.worktree) continue;
      const agent = this.store.get<Agent>("agent", resolved[i].agentId);
      assert(
        deps.worktrees,
        "worktrees_unavailable",
        "Worktree service is not available",
        500,
      );
      const source =
        a.workspace ??
        (
          agent.workspaces.find((w) => w.active && w.access === "write") ??
          agent.workspaces.find((w) => w.access === "write")
        )?.path;
      assert(
        source,
        "no_workspace",
        `${agent.name} has no writable attached folder to branch a worktree from`,
        409,
      );
      const made = (await deps.worktrees.create(agent.id, {
        workspace: source,
        attach: true,
        taskId: a.taskId,
      })) as { path: string; worktree: { id: string } };
      resolved[i].paths = [made.path];
      resolved[i].worktreePath = made.path;
      resolved[i].worktreeId = made.worktree.id;
    }
    return this.store.transaction(() => {
      const previous = this.plan(workflowId);
      const kept = (previous?.assignments ?? []).filter(
        (x) => !resolved.some((r) => r.taskId === x.taskId),
      );
      const all = [...kept, ...resolved];
      for (const a of resolved) {
        const task = this.store.get<Task>("task", a.taskId);
        const agent = this.store.get<Agent>("agent", a.agentId);
        const scope =
          a.isolation === "worktree"
            ? `Work only in your own Git worktree ${a.worktreePath}; it is attached to you as ${agent.name}'s folder. The integration step merges it.`
            : `You may modify only these paths: ${a.paths.join(", ")}. Other workers own the rest; changes outside your paths are detected and sent to the coordinator.`;
        const base = task.instructions.split(`\n\n${MARK}`)[0];
        this.store.put("task", {
          ...task,
          instructions: `${base}\n\n${MARK}\n${scope}`,
          resourcePaths: a.paths,
        });
        this.store.emit("parallel.assigned", task.id, {
          agentId: a.agentId,
          isolation: a.isolation,
          paths: a.paths,
        });
      }
      // The integration step depends on every assigned worker (and on open conflict resolutions).
      const integratorId =
        data.integration?.agentId ?? coordination.coordinatorId;
      this.store.get<Agent>("agent", integratorId);
      let integrationTaskId = previous?.integrationTaskId ?? null;
      const existing = integrationTaskId
        ? this.store.list<Task>("task").find((t) => t.id === integrationTaskId)
        : undefined;
      const deps2 = [...new Set(all.map((x) => x.taskId))];
      if (existing && existing.status === "queued") {
        this.store.put("task", {
          ...existing,
          dependsOn: [...new Set([...existing.dependsOn, ...deps2])],
        });
      } else {
        const created = this.service.task({
          workflowId,
          agentId: integratorId,
          title:
            data.integration?.title ??
            "Integrate parallel work: " +
              this.store.get<{ name: string }>("workflow", workflowId).name,
          instructions:
            "All parallel workers have finished. Review each worker's result and changed files, merge worktree branches or reconcile their paths, resolve any conflict reported to you, and run the integration checks from the coordinator's plan. Assignments: " +
            JSON.stringify(
              all.map((x) => ({
                task: tasks.get(x.taskId)?.title ?? x.taskId,
                isolation: x.isolation,
                paths: x.paths,
                branch: x.worktreePath,
              })),
            ),
          completionCriteria:
            "Worker changes are integrated, conflicts resolved and integration checks pass",
          dependsOn: deps2,
        });
        integrationTaskId = created.id;
      }
      const plan: ParallelPlan = {
        id: workflowId,
        workflowId,
        assignments: all,
        integrationTaskId,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.store.put("parallel-plan", plan);
      this.store.emit("parallel.planned", workflowId, {
        workers: all.length,
        integrationTaskId,
      });
      return plan;
    });
  }

  // ---- change detection ---------------------------------------------------------------------
  private rootsFor(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    return this.store
      .get<Agent>("agent", task.agentId)
      .workspaces.map((w) => w.path);
  }
  /** Worker starts: remember the state of every attached checkout (no-op for unassigned tasks). */
  async begin(task: Task) {
    if (!this.assignmentFor(task.id)) return;
    const roots = await Promise.all(
      this.rootsFor(task.id).map(async (root) => ({
        root,
        snapshot: await snapshotRoot(root),
      })),
    );
    this.store.put<Baseline>("parallel-baseline", { id: task.id, roots });
  }
  /**
   * Worker finishes: compare against the baseline, record changed files, detect conflicts and route
   * them to the coordinator. Never throws into the task (detection problems are recorded).
   */
  async check(task: Task) {
    const found = this.assignmentFor(task.id);
    if (!found) return null;
    try {
      return await this.checkInner(task, found.plan, found.assignment);
    } catch (e) {
      this.updateAssignment(task.workflowId, task.id, {
        detection: "unavailable",
        note:
          "Change detection failed: " +
          (e instanceof Error ? e.message : String(e)),
        checkedAt: new Date().toISOString(),
      });
      return null;
    }
  }
  private updateAssignment(
    workflowId: string,
    taskId: string,
    patch: Partial<Assignment>,
  ) {
    const plan = this.plan(workflowId);
    if (!plan) return;
    this.store.put("parallel-plan", {
      ...plan,
      updatedAt: new Date().toISOString(),
      assignments: plan.assignments.map((a) =>
        a.taskId === taskId ? { ...a, ...patch } : a,
      ),
    });
  }
  private async checkInner(task: Task, plan: ParallelPlan, me: Assignment) {
    let baseline: Baseline | null = null;
    try {
      baseline = this.store.get<Baseline>("parallel-baseline", task.id);
    } catch {
      baseline = null;
    }
    const changed: ChangedFile[] = [];
    let any = false;
    for (const { root, snapshot: before } of baseline?.roots ?? []) {
      if (!before) continue;
      const after = await snapshotRoot(root);
      if (!after) continue;
      any = true;
      const repo = await repoLockKey(root);
      const rels = new Set<string>();
      for (const p of new Set([
        ...Object.keys(before.files),
        ...Object.keys(after.files),
      ]))
        if ((before.files[p] ?? "clean") !== (after.files[p] ?? "clean"))
          rels.add(p);
      if (before.head && after.head && before.head !== after.head) {
        const names = await git(root, [
          "diff",
          "--name-only",
          "-z",
          "--no-ext-diff",
          before.head,
          after.head,
        ]);
        for (const p of names.split("\0").filter(Boolean)) rels.add(p);
      }
      for (const rel of rels)
        changed.push({
          root,
          rel,
          repo,
          fp: after.files[rel] ?? (await fingerprint(resolve(root, rel))),
        });
    }
    const violations: Violation[] = [];
    const others = plan.assignments.filter((a) => a.taskId !== task.id);
    const title = (id: string) =>
      this.store.list<Task>("task").find((t) => t.id === id)?.title ?? id;
    for (const c of changed) {
      const abs = resolve(c.root, c.rel);
      const theirs = others.flatMap((o) =>
        (o.changed ?? [])
          .filter((x) => x.repo === c.repo && x.rel === c.rel)
          .map((x) => ({ o, x })),
      );
      // Workers sharing one checkout see each other's edits in their own diff. A file that finished
      // with exactly the content an earlier worker recorded is attributed to that worker.
      if (theirs.some(({ x }) => x.fp === c.fp)) continue;
      if (me.isolation === "paths" && !me.paths.some((p) => contains(p, abs))) {
        const owner = others.find(
          (o) =>
            o.isolation === "paths" && o.paths.some((p) => contains(p, abs)),
        );
        violations.push({
          kind: "out-of-scope",
          file: abs,
          taskIds: [task.id, ...(owner ? [owner.taskId] : [])],
          detail: `"${title(task.id)}" changed ${abs}, outside its assigned paths (${me.paths.join(", ")})${owner ? `; that path is assigned to "${title(owner.taskId)}"` : ""}`,
        });
      }
      for (const { o } of theirs)
        violations.push({
          kind: "overlap",
          file: abs,
          taskIds: [o.taskId, task.id],
          detail: `"${title(o.taskId)}" and "${title(task.id)}" both changed ${c.rel} with different results`,
        });
    }
    this.updateAssignment(task.workflowId, task.id, {
      changed,
      violations,
      detection: any ? "ok" : "unavailable",
      note: any
        ? undefined
        : "No attached folder is a readable Git checkout, so changed files could not be compared",
      checkedAt: new Date().toISOString(),
    });
    for (const group of this.group(violations)) this.route(task, plan, group);
    return { changed, violations };
  }
  private group(violations: Violation[]) {
    const byKind = new Map<string, Violation[]>();
    for (const v of violations) {
      const key = v.kind + ":" + [...v.taskIds].sort().join(",");
      byKind.set(key, [...(byKind.get(key) ?? []), v]);
    }
    return [...byKind.values()];
  }
  /** Send one conflict to the coordinator and make the integration step wait for its resolution. */
  private route(task: Task, plan: ParallelPlan, group: Violation[]) {
    const coordination = this.coordination(task.workflowId)!;
    const files = [...new Set(group.map((v) => v.file))];
    const taskIds = [...new Set(group.flatMap((v) => v.taskIds))];
    const key = group[0].kind + files.join("|") + [...taskIds].sort().join(",");
    const dup = this.store
      .list<ParallelConflict>("parallel-conflict")
      .find(
        (c) =>
          c.workflowId === task.workflowId &&
          c.kind + c.files.join("|") + [...c.taskIds].sort().join(",") === key,
      );
    if (dup) return dup;
    const detail = group.map((v) => v.detail).join("; ");
    const resolution = this.service.task({
      workflowId: task.workflowId,
      agentId: coordination.coordinatorId,
      title: `Resolve parallel write conflict: ${files.length} file${files.length === 1 ? "" : "s"}`,
      instructions: `Parallel workers wrote to overlapping or unassigned files (${group[0].kind}). ${detail}. Decide which change wins or how to merge them, apply the resolution, and record the decision for the integration step. Files: ${files.join(", ")}`,
      completionCriteria:
        "Each conflicting file has one agreed final content and the decision is recorded",
      dependsOn: [task.id],
    });
    const conflict: ParallelConflict = {
      id: randomUUID(),
      workflowId: task.workflowId,
      kind: group[0].kind,
      files,
      taskIds,
      detail,
      coordinatorTaskId: resolution.id,
      createdAt: new Date().toISOString(),
    };
    this.store.put("parallel-conflict", conflict);
    this.store.emit("parallel.conflict", conflict.id, {
      workflowId: conflict.workflowId,
      files,
      coordinatorTaskId: resolution.id,
    });
    const integration = plan.integrationTaskId
      ? this.store
          .list<Task>("task")
          .find((t) => t.id === plan.integrationTaskId)
      : undefined;
    if (integration && integration.status === "queued")
      this.store.put("task", {
        ...integration,
        dependsOn: [...new Set([...integration.dependsOn, resolution.id])],
      });
    return conflict;
  }

  // ---- view ---------------------------------------------------------------------------------
  view(workflowId: string) {
    const plan = this.plan(workflowId);
    const tasks = new Map(this.store.list<Task>("task").map((t) => [t.id, t]));
    const agents = new Map(
      this.store.list<Agent>("agent").map((a) => [a.id, a]),
    );
    return {
      workflowId,
      enabled: !!this.coordination(workflowId)?.enabled,
      plan,
      integration: plan?.integrationTaskId
        ? {
            taskId: plan.integrationTaskId,
            status: tasks.get(plan.integrationTaskId)?.status ?? "missing",
          }
        : null,
      workers: (plan?.assignments ?? []).map((a) => ({
        ...a,
        title: tasks.get(a.taskId)?.title ?? a.taskId,
        status: tasks.get(a.taskId)?.status ?? "missing",
        agent: agents.get(a.agentId)?.name ?? a.agentId,
      })),
      conflicts: this.store
        .list<ParallelConflict>("parallel-conflict")
        .filter((c) => c.workflowId === workflowId)
        .map((c) => ({
          ...c,
          coordinatorTaskStatus:
            tasks.get(c.coordinatorTaskId)?.status ?? "missing",
        })),
      limits:
        "Conflicts are found by comparing changed files when a worker completes; non-Git folders, undone writes and tools outside AgentTeam are not detected.",
    };
  }
}
