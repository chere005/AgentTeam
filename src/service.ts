import { Approvals } from "./approvals.ts";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ResourceCoordinator } from "./resources.ts";
import { ValidationService } from "./validation.ts";
import { LimitsService } from "./limits.ts";
import { RecoveryService } from "./checkpoints.ts";
import { Store } from "./store.ts";
import { SkillCatalog } from "./skills.ts";
import {
  agentSchema,
  edgeSchema,
  ruleSchema,
  workflowSchema,
  taskSchema,
  routeSchema,
  assert,
  type Agent,
  type Edge,
  type Rule,
  type Workflow,
  type Task,
  type Session,
  type Message,
} from "./model.ts";
export class TeamService {
  store: Store;
  skills: SkillCatalog;
  resources: ResourceCoordinator;
  validation: ValidationService;
  limits: LimitsService;
  approvals: Approvals;
  recovery: RecoveryService;
  constructor(store: Store, skills: SkillCatalog) {
    this.store = store;
    this.approvals = new Approvals(store);
    this.skills = skills;
    this.resources = new ResourceCoordinator(store);
    this.validation = new ValidationService(store, this.resources);
    this.limits = new LimitsService(this);
    this.recovery = new RecoveryService(this);
  }
  async saveAgent(input: unknown, id?: string) {
    const data = agentSchema.parse(input);
    const previous = id ? this.store.get<Agent>("agent", id) : undefined;
    if (id)
      assert(
        !this.store
          .list<Session>("session")
          .some((s) => s.agentId === id && s.state === "running"),
        "agent_busy",
        "Stop the active session before changing its configuration",
      );
    if (data.parentId) {
      let parent: Agent | null = this.store.get<Agent>("agent", data.parentId);
      const visited = new Set<string>();
      while (parent) {
        assert(
          parent.id !== id && !visited.has(parent.id),
          "parent_cycle",
          "Agent hierarchy must not contain a cycle",
        );
        visited.add(parent.id);
        parent = parent.parentId
          ? this.store.get<Agent>("agent", parent.parentId)
          : null;
      }
    }
    for (const ws of data.workspaces) {
      assert(
        isAbsolute(ws.path),
        "invalid_path",
        "Workspace paths must be absolute",
        400,
      );
      ws.path = await realpath(ws.path);
      assert(
        (await stat(ws.path)).isDirectory(),
        "invalid_path",
        "Workspace must be a directory",
        400,
      );
    }
    assert(
      new Set(data.workspaces.map((w) => w.path)).size ===
        data.workspaces.length,
      "duplicate_workspace",
      "Do not attach the same directory twice",
      400,
    );
    for (const assignment of data.skills) {
      const skill = this.skills.get(assignment.id);
      assert(
        skill.environments.includes(data.environment) ||
          assignment.allowUnverified,
        "incompatible_skill",
        `${skill.name} has no declared or source-inferred support for ${data.environment}`,
        400,
      );
      for (const tool of skill.requiresTools)
        assert(
          data.tools.includes(tool),
          "missing_tool",
          `${skill.name} requires ${tool}`,
          400,
        );
    }
    if (data.kind === "team-assistant")
      assert(
        !this.store
          .list<Agent>("agent")
          .some((a) => a.kind === "team-assistant" && a.id !== id),
        "duplicate_assistant",
        "Only one team assistant is allowed",
      );
    const agent: Agent = {
      ...data,
      id: id ?? randomUUID(),
      control: previous?.control ?? "team",
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    return this.store.transaction(() => {
      this.store.put("agent", agent);
      this.store.emit(previous ? "agent.updated" : "agent.created", agent.id);
      return agent;
    });
  }
  saveEdge(input: unknown, id?: string) {
    if (id) this.store.get<Edge>("edge", id);
    const data = edgeSchema.parse(input);
    this.store.get<Agent>("agent", data.from);
    this.store.get<Agent>("agent", data.to);
    assert(
      data.from !== data.to,
      "self_edge",
      "Edges must connect different agents",
      400,
    );
    return this.store.transaction(() => {
      const edge = { ...data, id: id ?? randomUUID() };
      this.store.put("edge", edge);
      this.store.emit(id ? "edge.updated" : "edge.created", edge.id);
      return edge;
    });
  }
  saveRule(input: unknown) {
    const data = ruleSchema.parse(input);
    this.store.get<Agent>("agent", data.agentId);
    if (data.targetId) this.store.get<Agent>("agent", data.targetId);
    return this.store.transaction(() => {
      const rule = { ...data, id: randomUUID() };
      this.store.put("rule", rule);
      this.store.emit("rule.created", rule.id);
      return rule;
    });
  }
  permitted(from: string, to: string, kind: Edge["kind"]) {
    return this.store
      .list<Edge>("edge")
      .some(
        (e) =>
          e.enabled &&
          e.kind === kind &&
          ((e.from === from && e.to === to) ||
            (e.bidirectional && e.to === from && e.from === to)),
      );
  }
  route(input: unknown) {
    const request = routeSchema.parse(input);
    if (request.fromAgentId)
      this.store.get<Agent>("agent", request.fromAgentId);
    if (request.targetId) {
      this.store.get<Agent>("agent", request.targetId);
      assert(
        !request.fromAgentId ||
          this.permitted(request.fromAgentId, request.targetId, request.kind),
        "connection_denied",
        "The graph does not allow this communication",
        403,
      );
      return {
        status: "selected" as const,
        agentId: request.targetId,
        reason: "Explicit recipient",
        matches: [],
      };
    }
    const matches = this.store
      .list<Rule>("rule")
      .filter(
        (r) =>
          r.enabled &&
          r.kind === request.kind &&
          (r.scope === "intake" || r.agentId === request.fromAgentId),
      )
      .filter((r) => {
        const target = r.scope === "intake" ? r.agentId : r.targetId!;
        if (
          request.fromAgentId &&
          !this.permitted(request.fromAgentId, target, request.kind)
        )
          return false;
        const m = r.match;
        return (
          m.catchAll ||
          m.textIncludes.some((t) =>
            request.text.toLowerCase().includes(t.toLowerCase()),
          ) ||
          m.tagsAny.some((t) => request.tags.includes(t))
        );
      })
      .map((r) => ({
        ruleId: r.id,
        agentId: r.scope === "intake" ? r.agentId : r.targetId!,
        priority: r.priority,
        scope: r.scope,
      }))
      .sort(
        (a, b) => b.priority - a.priority || a.ruleId.localeCompare(b.ruleId),
      );
    if (!matches.length)
      return {
        status: "unmatched" as const,
        reason: "No eligible matching rule",
        matches,
      };
    const winners = matches.filter((m) => m.priority === matches[0].priority);
    const targets = [...new Set(winners.map((w) => w.agentId))];
    if (targets.length > 1)
      return {
        status: "ambiguous" as const,
        reason: "Equal-priority rules select different agents",
        matches,
      };
    return {
      status: "selected" as const,
      agentId: targets[0],
      reason: `Highest matching priority: ${matches[0].priority}`,
      matches,
    };
  }
  workflow(input: unknown) {
    const data = workflowSchema.parse(input);
    this.store.get<Agent>("agent", data.ownerId);
    return this.store.transaction(() => {
      const workflow: Workflow = { ...data, id: randomUUID(), paused: false };
      this.store.put("workflow", workflow);
      this.store.emit("workflow.created", workflow.id);
      return workflow;
    });
  }
  workflowStatus(id: string) {
    const workflow = this.store.get<Workflow>("workflow", id),
      tasks = this.store.list<Task>("task").filter((t) => t.workflowId === id);
    return {
      ...workflow,
      tasks,
      status: workflow.paused
        ? "paused"
        : tasks.length && tasks.every((t) => t.status === "completed")
          ? "completed"
          : tasks.some((t) =>
                ["failed", "interrupted", "blocked"].includes(t.status),
              )
            ? "needs-attention"
            : tasks.some((t) => t.status === "running")
              ? "running"
              : "queued",
    };
  }
  pauseWorkflow(id: string, paused: boolean) {
    return this.store.transaction(() => {
      const wf = this.store.get<
        Workflow & {
          setup?: {
            requiresModelVerification?: boolean;
            modelCheck?: {
              verified: boolean;
              resolved: {
                agentId: string;
                environment: string;
                model: string;
              }[];
            };
          };
        }
      >("workflow", id);
      // Samples stay paused until their model mapping was verified and still covers every
      // participating agent (owner and task agents) with an unchanged environment and model.
      if (!paused && wf.setup?.requiresModelVerification) {
        const check = wf.setup.modelCheck;
        const ids = new Set([wf.ownerId]);
        for (const t of this.store.list<Task>("task"))
          if (t.workflowId === id) ids.add(t.agentId);
        assert(
          check?.verified &&
            [...ids].every((agentId) => {
              const r = check.resolved.find((x) => x.agentId === agentId);
              const a = this.store.get<Agent>("agent", agentId);
              return (
                !!r && a.model === r.model && a.environment === r.environment
              );
            }),
          "models_unverified",
          "Verify the model mapping before resuming this sample workflow",
        );
      }
      wf.paused = paused;
      this.store.put("workflow", wf);
      this.store.emit(paused ? "workflow.paused" : "workflow.resumed", id);
      return wf;
    });
  }
  task(input: unknown) {
    const data = taskSchema.parse(input);
    const workflow = this.store.get<
      Workflow & {
        coordination?: {
          enabled: boolean;
          coordinatorId: string;
          planTaskId?: string;
        };
      }
    >("workflow", data.workflowId);
    if (
      workflow.coordination?.enabled &&
      workflow.coordination.planTaskId &&
      data.agentId !== workflow.coordination.coordinatorId &&
      !data.dependsOn.includes(workflow.coordination.planTaskId)
    )
      data.dependsOn.push(workflow.coordination.planTaskId);
    this.store.get<Agent>("agent", data.agentId);
    if (data.invokedBy) {
      this.store.get<Agent>("agent", data.invokedBy);
      assert(
        this.permitted(data.invokedBy, data.agentId, "delegate"),
        "connection_denied",
        "An invoking agent needs a delegation edge",
        403,
      );
    }
    // Delegation bounds: parent resolution, depth, loops, handoff/spawn totals, children cap.
    const delegation = this.limits.beforeCreate(data);
    if (delegation.parentTaskId) data.parentTaskId = delegation.parentTaskId;
    for (const id of data.dependsOn) {
      const dep = this.store.get<Task>("task", id);
      assert(
        dep.workflowId === data.workflowId,
        "invalid_dependency",
        "Dependencies must belong to the same workflow",
        400,
      );
    }
    return this.store.transaction(() => {
      const task: Task = {
        ...data,
        id: randomUUID(),
        status: "queued",
        queuedAt: new Date().toISOString(),
      };
      this.store.put("task", task);
      this.store.emit("task.created", task.id, { agentId: task.agentId });
      if (task.invokedBy) this.flow(task, "request");
      this.limits.recordCreate(task);
      return task;
    });
  }
  taskState(id: string) {
    const task = this.store.get<Task>("task", id);
    const agent = this.store.get<Agent>("agent", task.agentId),
      wf = this.store.get<Workflow>("workflow", task.workflowId);
    const blockers = task.dependsOn.filter(
      (d) => this.store.get<Task>("task", d).status !== "completed",
    );
    return {
      ...task,
      blockers,
      waitReason:
        task.status !== "queued"
          ? null
          : wf.paused
            ? "workflow-paused"
            : agent.control === "human"
              ? "human-control"
              : blockers.length
                ? "dependencies"
                : !this.validation.gate(task).open
                  ? "validation-required"
                  : task.invokedBy && !this.capacity(task.invokedBy).available
                    ? "invocation-limit"
                    : this.resources.conflicts(
                          task.agentId,
                          task.workflowId,
                          task.id,
                        ).length
                      ? "resource-busy"
                      : null,
    };
  }
  transitionTask(id: string, input: unknown) {
    const data = z
      .object({
        status: z.enum([
          "running",
          "completed",
          "failed",
          "cancelled",
          "queued",
          "interrupted",
          "blocked",
        ]),
        result: z.string().max(100_000).optional(),
      })
      .strict()
      .parse(input);
    // Limit checks record their trip in their own transaction, so run them before ours.
    if (data.status === "running")
      this.limits.enforceStart(this.store.get<Task>("task", id));
    if (data.status === "queued") this.limits.beforeRetry(id);
    this.recovery.beforeTransition(
      this.store.get<Task>("task", id),
      data.status,
    );
    return this.store.transaction(() => {
      const task = this.store.get<Task>("task", id);
      const allowed: Record<Task["status"], Task["status"][]> = {
        queued: ["running", "cancelled"],
        running: ["completed", "failed", "cancelled", "interrupted", "blocked"],
        failed: ["queued", "cancelled"],
        interrupted: ["queued", "cancelled", "blocked"],
        blocked: ["queued", "cancelled", "interrupted"],
        completed: [],
        cancelled: [],
      };
      assert(
        allowed[task.status].includes(data.status),
        "invalid_transition",
        `Cannot transition ${task.status} to ${data.status}`,
      );
      if (data.status === "running") {
        if (task.invokedBy)
          assert(
            this.capacity(task.invokedBy).available,
            "invocation_limit",
            "Invoking agent has reached its concurrent invocation limit",
          );
        const agent = this.store.get<Agent>("agent", task.agentId);
        assert(
          agent.control === "team",
          "human_control",
          "Agent is under human control; team tasks remain queued",
        );
        assert(
          !this.store.get<Workflow>("workflow", task.workflowId).paused,
          "workflow_paused",
          "Workflow is paused",
        );
        assert(
          task.dependsOn.every(
            (d) => this.store.get<Task>("task", d).status === "completed",
          ),
          "dependency_pending",
          "Dependencies must complete first",
        );
        assert(
          this.validation.gate(task).open,
          "validation_required",
          "Required validation has not passed for the task's current inputs",
        );
        assert(
          !this.store
            .list<Task>("task")
            .some((t) => t.agentId === task.agentId && t.status === "running"),
          "agent_busy",
          "Agent already owns running work",
        );
        assert(
          !this.store
            .list<Session>("session")
            .some((s) => s.agentId === task.agentId && s.state === "running"),
          "agent_busy",
          "Agent session is running",
        );
        this.resources.acquire(task.id, task.agentId, task.workflowId);
        this.limits.recordTurn(task);
      }
      if (data.status === "completed") {
        assert(
          data.result?.trim(),
          "result_required",
          "Provide a completion result",
          400,
        );
        this.limits.assertCompletion(task, data.result);
      }
      const from = task.status;
      task.status = data.status;
      if (data.status !== "running") this.resources.release(task.id);
      if (data.status === "queued") {
        // Resuming an interrupted/blocked task is not a retry, but a limit stop recorded before the
        // restart is cleared either way (recordRetry only clears it in that case).
        if (from === "failed" || this.limits.meta(task.id).stoppedByLimit)
          this.limits.recordRetry(task);
        delete task.result;
        task.queuedAt = new Date().toISOString();
      } else if (data.result) task.result = data.result;
      this.store.put("task", task);
      this.store.emit("task.status", id, {
        agentId: task.agentId,
        status: task.status,
        result: task.result,
      });
      if (
        task.invokedBy &&
        (task.status === "completed" || task.status === "failed")
      )
        this.flow(task, task.status === "completed" ? "result" : "failure");
      this.limits.onTransition(task);
      this.recovery.onTransition(task, from);
      return task;
    });
  }
  private flow(task: Task, kind: "request" | "result" | "failure") {
    const edge = this.store
      .list<Edge>("edge")
      .find(
        (e) =>
          e.enabled &&
          e.kind === "delegate" &&
          ((e.from === task.invokedBy && e.to === task.agentId) ||
            (e.bidirectional &&
              e.to === task.invokedBy &&
              e.from === task.agentId)),
      );
    this.store.emit("flow.transferred", task.id, {
      edgeId: edge?.id ?? null,
      workflowId: task.workflowId,
      taskId: task.id,
      fromAgentId: kind === "request" ? task.invokedBy : task.agentId,
      toAgentId: kind === "request" ? task.agentId : task.invokedBy,
      kind,
    });
  }
  activity(id: string) {
    const agent = this.store.get<Agent>("agent", id);
    const tasks = this.store.list<Task>("task").filter((t) => t.agentId === id);
    const sessions = this.store
      .list<Session>("session")
      .filter((s) => s.agentId === id);
    const running = tasks
      .filter((t) => t.status === "running")
      .map((t) => t.id);
    const queued = tasks
      .filter((t) => t.status === "queued")
      .map((t) => this.taskState(t.id));
    const processing =
      sessions.some((s) => s.state === "running") || running.length > 0;
    // Interrupted/blocked tasks keep their provider session for resume; the agent is not idle.
    const interrupted = tasks
      .filter((t) => t.status === "interrupted" || t.status === "blocked")
      .map((t) => t.id);
    const queuedMessages = this.store
      .list<Message>("message")
      .filter(
        (m) =>
          m.status === "queued" && sessions.some((s) => s.id === m.sessionId),
      ).length;
    return {
      agentId: id,
      state: processing
        ? "processing"
        : agent.control === "human"
          ? "human-control"
          : interrupted.length
            ? "interrupted"
            : queued.length || queuedMessages
              ? "waiting"
              : "idle",
      runningTaskIds: running,
      interruptedTaskIds: interrupted,
      queuedTasks: queued.map((t) => ({ id: t.id, waitReason: t.waitReason })),
      queuedMessages,
      failedTaskIds: tasks
        .filter((t) => t.status === "failed")
        .map((t) => t.id),
      capacity: this.capacity(id),
    };
  }
  capacity(id: string) {
    const agent = this.store.get<Agent>("agent", id);
    const tasks = this.store
      .list<Task>("task")
      .filter((t) => t.invokedBy === id);
    const running = tasks.filter((t) => t.status === "running").length;
    const limit = agent.maxConcurrentInvocations ?? null;
    return {
      agentId: id,
      limit,
      running,
      queued: tasks.filter((t) => t.status === "queued").length,
      available: limit === null || running < limit,
    };
  }
  control(id: string, control: "team" | "human") {
    return this.store.transaction(() => {
      const agent = this.store.get<Agent>("agent", id);
      assert(
        !this.store
          .list<Session>("session")
          .some((s) => s.agentId === id && s.state === "running") &&
          !this.store
            .list<Task>("task")
            .some((t) => t.agentId === id && t.status === "running"),
        "agent_busy",
        "Finish or stop active work before transferring control",
      );
      agent.control = control;
      this.store.put("agent", agent);
      this.store.emit(
        control === "human" ? "agent.control_taken" : "agent.returned",
        id,
      );
      return agent;
    });
  }
  session(agentId: string) {
    this.store.get<Agent>("agent", agentId);
    return this.store.transaction(() => {
      const existing = this.store
        .list<Session>("session")
        .find((s) => s.agentId === agentId);
      if (existing) return existing;
      const session: Session = {
        id: randomUUID(),
        agentId,
        providerSessionId: null,
        state: "idle",
      };
      this.store.put("session", session);
      this.store.emit("session.created", session.id, { agentId });
      return session;
    });
  }
  message(sessionId: string, input: unknown) {
    const data = z
      .object({ text: z.string().trim().min(1).max(100_000) })
      .strict()
      .parse(input);
    this.store.get<Session>("session", sessionId);
    return this.store.transaction(() => {
      const message: Message = {
        id: randomUUID(),
        sessionId,
        role: "user",
        text: data.text,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      this.store.put("message", message);
      this.store.emit("message.queued", sessionId, { messageId: message.id });
      return message;
    });
  }
  connection(environment: string): {
    transport: "direct" | "acp";
    executable: string;
    args: string[];
  } {
    try {
      return (
        this.store.get<any>("settings", "connections").providers[
          environment
        ] ?? { transport: "direct", executable: "", args: [] }
      );
    } catch {
      return { transport: "direct", executable: "", args: [] };
    }
  }
  async launchPlan(agentId: string) {
    const agent = this.store.get<Agent>("agent", agentId);
    await this.skills.scan();
    const loaded = agent.skills.map((assignment) => {
      const skill = this.skills.get(assignment.id);
      assert(
        skill.environments.includes(agent.environment) ||
          assignment.allowUnverified,
        "incompatible_skill",
        `Skill ${skill.name} is incompatible`,
        400,
      );
      for (const tool of skill.requiresTools)
        assert(
          agent.tools.includes(tool),
          "missing_tool",
          `Skill ${skill.name} requires ${tool}`,
          400,
        );
      return { ...assignment, skill };
    });
    const sections = [
      `Agent: ${agent.name}\nRole: ${agent.role}`,
      agent.instructions,
    ];
    for (const { mode, skill } of loaded)
      sections.push(
        mode === "always"
          ? `Assigned skill: ${skill.name}\nResource base: ${skill.baseDir}\n${skill.body}`
          : `Available skill: ${skill.name}\n${skill.description}\nRead ${skill.path} when needed. Resources are relative to ${skill.baseDir}.`,
      );
    const cwd = agent.workspaces.find((w) => w.active)?.path ?? null;
    if (cwd) {
      const canonical = await realpath(cwd);
      assert(
        canonical === cwd && (await stat(cwd)).isDirectory(),
        "workspace_changed",
        "Active workspace path changed; reattach it",
      );
    }
    return {
      agentId,
      connection: this.connection(agent.environment),
      environment: agent.environment,
      model: agent.model,
      effort: agent.effort,
      cwd,
      instructions: sections.filter(Boolean).join("\n\n"),
      skills: loaded.map(({ mode, skill }) => ({
        id: skill.id,
        name: skill.name,
        mode,
        hash: skill.hash,
        path: skill.path,
        compatibility: skill.compatibility,
      })),
      workspaces: agent.workspaces,
      tools: agent.tools,
      warnings: loaded
        .filter((l) => l.skill.compatibility !== "declared")
        .map((l) => `${l.skill.name}: compatibility inferred or unverified`),
    };
  }
}
export type LaunchPlan = Awaited<ReturnType<TeamService["launchPlan"]>>;
