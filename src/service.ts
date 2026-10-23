import { Approvals } from "./approvals.ts";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ResourceCoordinator } from "./resources.ts";
import { normalizeRules, normalizeRelPath } from "./access.ts";
import { canonicalDeclaredPaths } from "./declared-paths.ts";
import { ValidationService } from "./validation.ts";
import { LimitsService } from "./limits.ts";
import { RecoveryService } from "./checkpoints.ts";
import { SharedStateService } from "./shared-state.ts";
import { ArtifactRegistry } from "./artifacts.ts";
import { WorkflowGraphService } from "./workflow-graph.ts";
import { Orchestration, matchEvidence } from "./orchestration.ts";
import { OwnershipService } from "./ownership.ts";
import { LockRecovery } from "./lock-recovery.ts";
import { ParallelWork } from "./parallel.ts";
import { HandoffNotes } from "./handoffs.ts";
import { PipelineService } from "./pipeline.ts";
import { TeamSpaces } from "./team-spaces.ts";
import { taskWorkingFolder } from "./project-worktrees.ts";
import { withRoleDefaults } from "./roles.ts";
import { Store } from "./store.ts";
import { SkillCatalog } from "./skills.ts";
import { adapterFor } from "./skill-adapters.ts";
import {
  attachContext,
  classifySkills,
  composeSections,
  decideSkills,
  sectionsText,
} from "./skill-loading.ts";
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
import { decideRouting } from "./routing-decision.ts";
import { ensureWorkspaceBaseline } from "./workspace-changes.ts";
export class TeamService {
  store: Store;
  skills: SkillCatalog;
  resources: ResourceCoordinator;
  validation: ValidationService;
  limits: LimitsService;
  approvals: Approvals;
  recovery: RecoveryService;
  shared: SharedStateService;
  artifacts: ArtifactRegistry;
  orchestration: Orchestration;
  /** Who drives each agent's session (team, embedded chat, CLI, native app): src/ownership.ts. */
  ownership: OwnershipService;
  /** Crash/ownership lock reconciliation (src/lock-recovery.ts). */
  locks: LockRecovery;
  /** Guided parallel work: assignments, integration, write-conflict routing (src/parallel.ts). */
  parallel: ParallelWork;
  /** Executable workflow graphs (src/workflow-graph.ts). */
  graphs: WorkflowGraphService;
  /** Immutable Markdown handoff/attempt notes (src/handoffs.ts). */
  handoffs: HandoffNotes;
  /** Multi-stage plan/implement/review/adjudicate sample (src/pipeline.ts). */
  pipelines: PipelineService;
  /** Team containers and the active team (src/team-spaces.ts); presentation/ownership only. */
  teamSpaces: TeamSpaces;
  constructor(store: Store, skills: SkillCatalog) {
    this.store = store;
    this.approvals = new Approvals(store);
    this.skills = skills;
    this.resources = new ResourceCoordinator(store);
    this.validation = new ValidationService(store, this.resources);
    this.limits = new LimitsService(this);
    this.recovery = new RecoveryService(this);
    this.shared = new SharedStateService(this);
    this.artifacts = new ArtifactRegistry(this);
    this.orchestration = new Orchestration(this);
    this.ownership = new OwnershipService(this);
    this.locks = new LockRecovery(this);
    this.parallel = new ParallelWork(this);
    this.graphs = new WorkflowGraphService(this);
    this.handoffs = new HandoffNotes(this);
    this.pipelines = new PipelineService(this);
    this.teamSpaces = new TeamSpaces(this);
  }
  /**
   * Create (no `id`) or replace an agent. `teamId` is accepted next to the agent fields: a new
   * agent joins it (default: the active team); on update it moves the agent, absent keeps the
   * agent's team. The Team Assistant is global and never gets a team.
   */
  async saveAgent(input: unknown, id?: string) {
    const { teamId: rawTeam, ...fields } = (
      input && typeof input === "object" ? input : {}
    ) as Record<string, unknown>;
    const data = agentSchema.parse(
      withRoleDefaults(input && typeof input === "object" ? fields : input),
    );
    const previous = id
      ? this.store.get<Agent & { teamId?: string }>("agent", id)
      : undefined;
    const teamId =
      data.kind === "team-assistant"
        ? undefined
        : previous && rawTeam === undefined
          ? previous.teamId
          : this.teamSpaces.forCreate(rawTeam);
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
      if (ws.rules) ws.rules = normalizeRules(ws.rules);
      if (
        ws.sharing?.scope === "selected" ||
        ws.shareRules?.some((r) => r.scope === "selected")
      ) {
        const agentIds = new Set([
          ...(ws.sharing?.agentIds ?? []),
          ...(ws.shareRules ?? []).flatMap((rule) => rule.agentIds),
        ]);
        for (const agentId of agentIds) {
          assert(
            agentId !== id,
            "invalid_share_target",
            "An agent cannot share a resource with itself",
            400,
          );
          this.store.get<Agent>("agent", agentId);
        }
      }
      if (ws.shareRules) {
        const seen = new Set<string>();
        ws.shareRules = ws.shareRules.map((rule) => {
          const path = normalizeRelPath(rule.path);
          assert(
            !seen.has(path.toLowerCase()),
            "duplicate_share_rule",
            `Duplicate sharing rule for "${path}"`,
            400,
          );
          seen.add(path.toLowerCase());
          return { ...rule, path };
        });
      }
      if (ws.explicitOnly)
        assert(
          ws.rules?.some((r) => r.access !== "none"),
          "invalid_rule",
          "An explicit-only attachment needs at least one file or folder rule",
          400,
        );
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
      ...(teamId ? { teamId } : {}),
      id: id ?? randomUUID(),
      control: previous?.control ?? "team",
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    await Promise.all(
      agent.workspaces.map((workspace) =>
        ensureWorkspaceBaseline(this.store, agent, workspace.path),
      ),
    );
    return this.store.transaction(() => {
      this.store.put("agent", agent);
      this.store.emit(previous ? "agent.updated" : "agent.created", agent.id);
      return agent;
    });
  }
  /**
   * Create or replace a communication edge. An edge between agents of different teams (a
   * cross-team link) needs an explicit `crossTeam: true` when it is created or re-pointed; it is
   * stored with that marker. Permissions are evaluated exactly like any other edge (`permitted`).
   */
  saveEdge(input: unknown, id?: string) {
    const before = id ? this.store.get<Edge>("edge", id) : undefined;
    const { crossTeam, ...fields } = (
      input && typeof input === "object" ? input : {}
    ) as Record<string, unknown>;
    const data = edgeSchema.parse(
      input && typeof input === "object" ? fields : input,
    );
    const from = this.store.get<Agent>("agent", data.from);
    const to = this.store.get<Agent>("agent", data.to);
    assert(
      data.from !== data.to,
      "self_edge",
      "Edges must connect different agents",
      400,
    );
    const teamFrom = this.teamSpaces.teamOfAgent(from),
      teamTo = this.teamSpaces.teamOfAgent(to);
    const cross = !!teamFrom && !!teamTo && teamFrom !== teamTo;
    const repointed =
      !before ||
      new Set([before.from, before.to]).size !==
        new Set([before.from, before.to, data.from, data.to]).size;
    if (cross && repointed)
      assert(
        crossTeam === true,
        "cross_team_edge",
        "These agents belong to different teams. Create a cross-team link explicitly (crossTeam: true) if they should communicate.",
        409,
      );
    return this.store.transaction(() => {
      const edge: Edge = {
        ...data,
        ...(cross && (crossTeam === true || before?.crossTeam)
          ? { crossTeam: true }
          : {}),
        id: id ?? randomUUID(),
      };
      this.store.put("edge", edge);
      this.store.emit(id ? "edge.updated" : "edge.created", edge.id);
      return edge;
    });
  }
  /**
   * Create a rule, or replace rule `id` with the same validation as creation. Changing a rule's
   * mode never reopens a required-review gate that was already planned: specialist triggers keep
   * the mode they were planned with (src/orchestration.ts), so a mandatory requirement recorded
   * for a task stays until its review approves. A mode change is recorded in the event.
   */
  saveRule(input: unknown, id?: string) {
    const before = id ? this.store.get<Rule>("rule", id) : undefined;
    const data = ruleSchema.parse(input);
    this.store.get<Agent>("agent", data.agentId);
    if (data.targetId) this.store.get<Agent>("agent", data.targetId);
    return this.store.transaction(() => {
      const rule = { ...data, id: id ?? randomUUID() };
      this.store.put("rule", rule);
      const modeFrom = before?.mode ?? "advisory",
        modeTo = rule.mode ?? "advisory";
      this.store.emit(
        id ? "rule.updated" : "rule.created",
        rule.id,
        before && modeFrom !== modeTo ? { modeFrom, modeTo } : {},
      );
      return rule;
    });
  }
  /**
   * Turns the Wolfram validation requirement on or off for an existing task. Same state rule as
   * completion checks (never while running or finished); a `validation-gate` completion check needs
   * the requirement, so it cannot be switched off underneath one.
   */
  setRequiresValidation(taskId: string, input: unknown) {
    const data = z
      .object({ requiresValidation: z.boolean() })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const task = this.store.get<Task>("task", taskId);
      assert(
        ["queued", "failed", "interrupted", "blocked"].includes(task.status),
        "task_started",
        `Task is ${task.status}; the validation requirement can only change while a task is waiting, failed, interrupted or blocked`,
        409,
      );
      assert(
        data.requiresValidation ||
          !(task.completionChecks ?? []).some(
            (c) => c.type === "validation-gate",
          ),
        "validation_gate_check",
        "Remove the validation-gate completion check before turning the validation requirement off",
        409,
      );
      // Fail closed: once validation was attempted (or is running) and the gate is not open, the
      // toggle must not become a way around a failed, inconclusive or stale result.
      if (!data.requiresValidation && task.requiresValidation) {
        assert(
          !this.validation.activeRuns().some((r) => r.taskId === taskId),
          "validation_running",
          "A validation run for this task is in progress; wait for it or cancel it first",
          409,
        );
        assert(
          !this.validation.records(taskId).length ||
            this.validation.gate(task).open,
          "validation_not_passed",
          "Validation was already attempted for this task and has not passed; the requirement cannot be switched off (fix the inputs and validate again, or create a new task)",
          409,
        );
      }
      if (data.requiresValidation) task.requiresValidation = true;
      else delete task.requiresValidation;
      this.store.put("task", task);
      this.store.emit("task.updated", taskId, { agentId: task.agentId });
      return this.taskState(taskId);
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
        // Mandatory rules are required reviews (src/orchestration.ts), not routing suggestions.
        if ((r.mode ?? "advisory") === "mandatory") return false;
        return (
          matchEvidence(r.match, {
            text: request.text,
            tags: request.tags,
            changedFiles: request.changedFiles,
          }).length > 0
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
  /**
   * Create a workflow. `teamId` may be given next to the workflow fields; otherwise the workflow
   * joins its owner's team (or the active team when the owner is the global Team Assistant).
   */
  workflow(input: unknown) {
    const { teamId: rawTeam, ...fields } = (
      input && typeof input === "object" ? input : {}
    ) as Record<string, unknown>;
    const data = workflowSchema.parse(
      input && typeof input === "object" ? fields : input,
    );
    const owner = this.store.get<Agent>("agent", data.ownerId);
    const teamId =
      rawTeam !== undefined
        ? this.teamSpaces.forCreate(rawTeam)
        : (this.teamSpaces.teamOfAgent(owner) ?? this.teamSpaces.active());
    return this.store.transaction(() => {
      const workflow: Workflow = {
        ...data,
        teamId,
        id: randomUUID(),
        paused: false,
      };
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
      // An archived project stays paused until it is reopened (src/project-lifecycle.ts).
      assert(
        paused ||
          (wf as { lifecycle?: { state: string } }).lifecycle?.state !==
            "archived",
        "project_archived",
        "This project is archived; reopen it before resuming",
      );
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
      // Pipeline sample: parallel resource access, caps and read-only roles were verified for the
      // current configuration (src/pipeline.ts).
      if (!paused) this.pipelines.assertReady(wf);
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
    const assignee = this.store.get<Agent>("agent", data.agentId);
    this.assertNotRetired(assignee);
    const declared = canonicalDeclaredPaths(assignee, data.resourcePaths);
    if (declared) data.resourcePaths = declared;
    else delete data.resourcePaths;
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
        ...(data.invokedBy
          ? {
              routing: decideRouting(this, {
                ...data,
                invokedBy: data.invokedBy,
              }),
            }
          : {}),
      };
      this.store.put("task", task);
      this.store.emit("task.created", task.id, { agentId: task.agentId });
      if (task.invokedBy) this.flow(task, "request");
      this.limits.recordCreate(task);
      this.orchestration.onTaskCreated(task);
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
                : this.orchestration.blockingReviews(task).length
                  ? "review-required"
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
    // A retired worker (Team settings) takes no new work: no start, no retry.
    if (data.status === "running" || data.status === "queued")
      this.assertNotRetired(
        this.store.get<Agent>(
          "agent",
          this.store.get<Task>("task", id).agentId,
        ),
      );
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
          !this.orchestration.blockingReviews(task).length,
          "review_required",
          "A required review of a dependency has not been approved",
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
        this.pipelines.assertStart(task); // adjudication/assignment/read-only gates of the pipeline sample
        this.resources.acquire(task.id, task.agentId, task.workflowId);
        this.limits.recordTurn(task);
        // Run inspector: the settings this run actually started with (agent config may change later).
        this.store.emit("task.settings", task.id, {
          agentId: agent.id,
          environment: agent.environment,
          model: agent.model,
          effort: agent.effort,
          priority: this.resources.priority(agent.id),
          access: agent.workspaces.map((w) => ({
            path: w.path,
            access: w.access,
            active: w.active,
          })),
        });
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
      this.handoffs.onTransition(task); // immutable attempt note (workflows that opted in)
      if (task.status === "completed") this.orchestration.onTaskCompleted(task);
      return task;
    });
  }
  /** Start a conversational manager task alongside its own provider session.
   * It has no workspace lease: the session lock is the manager's lock, while delegated workers
   * acquire their own declared resources through the normal scheduler path.
   */
  startConversationTask(id: string, sessionId: string) {
    const task = this.store.get<Task>("task", id),
      session = this.store.get<Session>("session", sessionId);
    assert(
      task.agentId === session.agentId && session.state === "running",
      "invalid_conversation_task",
      "A conversation task must belong to its active agent session",
      403,
    );
    assert(
      task.status === "queued" && !task.parentTaskId,
      "invalid_transition",
      "A conversation root task must be queued and have no parent",
    );
    this.assertNotRetired(this.store.get<Agent>("agent", task.agentId));
    this.limits.enforceStart(task);
    this.recovery.beforeTransition(task, "running");
    return this.store.transaction(() => {
      const current = this.store.get<Task>("task", id),
        workflow = this.store.get<Workflow>("workflow", current.workflowId),
        agent = this.store.get<Agent>("agent", current.agentId);
      assert(
        agent.control === "team",
        "human_control",
        "Agent is under human control",
      );
      assert(!workflow.paused, "workflow_paused", "Workflow is paused");
      assert(
        current.dependsOn.every(
          (dependency) =>
            this.store.get<Task>("task", dependency).status === "completed",
        ),
        "dependency_pending",
        "Dependencies must complete first",
      );
      assert(
        !this.orchestration.blockingReviews(current).length,
        "review_required",
        "A required review is still pending",
      );
      assert(
        this.validation.gate(current).open,
        "validation_required",
        "Required validation has not passed",
      );
      assert(
        !this.store
          .list<Task>("task")
          .some(
            (other) => other.agentId === agent.id && other.status === "running",
          ),
        "agent_busy",
        "Agent already owns running work",
      );
      this.pipelines.assertStart(current);
      current.status = "running";
      this.store.put("task", current);
      this.limits.recordTurn(current);
      this.store.emit("task.status", id, {
        agentId: agent.id,
        status: "running",
      });
      this.store.emit("task.settings", id, {
        agentId: agent.id,
        environment: agent.environment,
        model: agent.model,
        effort: agent.effort,
        priority: this.resources.priority(agent.id),
        access: agent.workspaces.map((w) => ({
          path: w.path,
          access: w.access,
          active: w.active,
        })),
      });
      this.limits.onTransition(current);
      this.recovery.onTransition(current, "queued");
      this.handoffs.onTransition(current);
      return current;
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
  /**
   * Same rule as DELETE /agents: an agent with tasks, sessions, child agents or owned workflows
   * cannot be deleted. `leaving` ignores children that are being deleted together with it.
   */
  agentInUse(aid: string, leaving: ReadonlySet<string> = new Set()) {
    return (
      this.store.list<Task>("task").some((t) => t.agentId === aid) ||
      this.store.list<Session>("session").some((s) => s.agentId === aid) ||
      this.store
        .list<Agent>("agent")
        .some((a) => a.parentId === aid && !leaving.has(a.id)) ||
      this.store.list<Workflow>("workflow").some((w) => w.ownerId === aid)
    );
  }
  /** Inside a transaction: delete an agent and its edges/rules (caller checked `agentInUse`). */
  removeAgentInTx(aid: string) {
    this.store.remove("agent", aid);
    for (const e of this.store.list<Edge>("edge"))
      if (e.from === aid || e.to === aid) this.store.remove("edge", e.id);
    for (const r of this.store.list<Rule>("rule"))
      if (r.agentId === aid || r.targetId === aid)
        this.store.remove("rule", r.id);
    this.store.emit("agent.deleted", aid);
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
      assert(
        !this.resources.drainingFor(id).length,
        "lease_draining",
        "A previous run's process may still be writing in this agent's folders; wait for its lease to drain (or force-release it after confirming it stopped) before transferring control",
      );
      agent.control = control;
      this.store.put("agent", agent);
      this.ownership.onControl(id, control);
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
      .object({
        text: z.string().trim().min(1).max(100_000),
        groupChatId: z.string().optional(),
      })
      .strict()
      .parse(input);
    const session = this.store.get<Session>("session", sessionId);
    if (data.groupChatId) {
      const chat = this.store.get<{ participantIds: string[] }>(
        "group-chat",
        data.groupChatId,
      );
      assert(
        chat.participantIds.includes(session.agentId),
        "group_chat_membership_required",
        "This agent is not a participant in the group conversation",
        403,
      );
    }
    return this.store.transaction(() => {
      const message: Message = {
        id: randomUUID(),
        sessionId,
        ...(data.groupChatId ? { groupChatId: data.groupChatId } : {}),
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
  /**
   * Refuses work for an agent retired from its role in Team settings (src/team-settings.ts): it
   * stays for the history that refers to it, but is never assigned, delegated to, started or
   * chatted with until the role grows again and reinstates it.
   */
  assertNotRetired(agent: Agent) {
    const retired = this.store
      .list<{ retired?: { agentId: string }[] }>("team-profile")
      .some((p) => p.retired?.some((r) => r.agentId === agent.id));
    assert(
      !retired,
      "agent_retired",
      `${agent.name} was retired from its role in Team settings and takes no new work; add a worker to that role to reinstate it`,
      409,
    );
  }
  /** `taskId`: the task about to run; its declared paths select the working folder. */
  async launchPlan(agentId: string, taskId?: string) {
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
    const connection = this.connection(agent.environment);
    const adapter = adapterFor(agent.environment, connection.transport);
    // Change detection: first use pins a skill; a changed one is skipped until the user accepts it.
    const entries = await classifySkills(this.store, loaded, {
      persist: true,
    });
    const decisions = decideSkills(entries, undefined);
    const sections = composeSections(agent, entries, decisions, adapter);
    const cwd =
      taskWorkingFolder(this.store, agent, taskId) ??
      agent.workspaces.find((w) => w.active)?.path ??
      null;
    if (cwd) {
      const canonical = await realpath(cwd);
      assert(
        canonical === cwd && (await stat(cwd)).isDirectory(),
        "workspace_changed",
        "Active workspace path changed; reattach it",
      );
    }
    const plan = {
      agentId,
      connection,
      environment: agent.environment,
      model: agent.model,
      effort: agent.effort,
      cwd,
      instructions: sectionsText(sections),
      skills: loaded.map(({ mode, skill }, i) => ({
        id: skill.id,
        name: skill.name,
        mode,
        hash: skill.hash,
        path: skill.path,
        compatibility: skill.compatibility,
        version: skill.version ?? null,
        state: decisions[i].state,
        reason: decisions[i].reason,
      })),
      workspaces: agent.workspaces,
      tools: agent.tools,
      warnings: [
        ...loaded
          .filter((l) => l.skill.compatibility !== "declared")
          .map((l) => `${l.skill.name}: compatibility inferred or unverified`),
        ...decisions
          .filter((d) => d.state === "skipped")
          .map((d) => `${d.name}: ${d.reason}`),
      ],
    };
    return attachContext(plan, {
      agent,
      entries,
      adapter,
      baseInstructions: plan.instructions,
    });
  }
}
export type LaunchPlan = Awaited<ReturnType<TeamService["launchPlan"]>>;
