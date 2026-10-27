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
import { taskFilesystem } from "./provider-filesystem.ts";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { withRoleDefaults } from "./roles.ts";
import {
  explicitlyReportsIncompleteExecution,
  explicitlyReportsNoWork,
  explicitlyReportsUnapprovedReview,
  taskCompletionProblem,
} from "./task-results.ts";
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
import { DelegatedWork } from "./delegated-work.ts";
import {
  blockerCode,
  isCapabilityWait,
  type RuntimeWait,
} from "./runtime-waits.ts";
import { ContractService } from "./execution-contract.ts";
import { ExecutionVerification } from "./execution-verification.ts";
import {
  LaunchReadiness,
  requiredFor,
  roleClassOf,
} from "./launch-readiness.ts";
import { ProjectSetupService } from "./project-setup.ts";
import { capabilityContext } from "./capability-context.ts";
import type { PlanFacts } from "./launch-capability.ts";
import type { Readiness } from "./runtime-scan.ts";
import { simpleTaskSupport } from "./simple-task-capabilities.ts";
import { runtimeGuidance } from "./runtime-instructions.ts";
import { ExecutionProjects } from "./execution-projects.ts";
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
  delegations: DelegatedWork;
  /** Persisted execution contracts of projects and tasks (src/execution-contract.ts). */
  contracts: ContractService;
  verification: ExecutionVerification;
  /** The one readiness evaluator against the actual launch plan (src/launch-readiness.ts). */
  launchReadiness: LaunchReadiness;
  /** Project-folder setup state and the action that applies approved grants (src/project-setup.ts). */
  setups: ProjectSetupService;
  executionProjects: ExecutionProjects;
  /**
   * Whether a provider runtime is installed and signed in, as the app currently knows it. Wired by
   * the RunManager; the setup and notice views report it, the launch has its own path for it.
   */
  runtimeReadiness?: (environment: string) => Readiness | undefined;
  /** The platform provider processes run on (the RunManager's; fixtures may simulate another). */
  hostPlatform?: () => NodeJS.Platform;
  constructor(store: Store, skills: SkillCatalog) {
    this.store = store;
    this.approvals = new Approvals(store);
    this.skills = skills;
    this.skills.assertPath = (path) => filesystemPolicy(store).assertPath(path);
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
    this.delegations = new DelegatedWork(this);
    this.contracts = new ContractService(this);
    this.verification = new ExecutionVerification(this);
    this.launchReadiness = new LaunchReadiness(this);
    this.setups = new ProjectSetupService(this);
    this.executionProjects = new ExecutionProjects(this);
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
    if (id)
      assert(
        !this.store
          .list<Task>("task")
          .some((task) => task.agentId === id && task.status === "running"),
        "agent_busy",
        "Stop the active task before changing its configuration",
        409,
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
      filesystemPolicy(this.store).assertPath(ws.path);
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
      if (id) {
        assert(
          !this.store
            .list<Session>("session")
            .some((s) => s.agentId === id && s.state === "running"),
          "agent_busy",
          "Stop the active session before changing its configuration",
          409,
        );
        assert(
          !this.store
            .list<Task>("task")
            .some((task) => task.agentId === id && task.status === "running"),
          "agent_busy",
          "Stop the active task before changing its configuration",
          409,
        );
      }
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
    const effectiveStatus = (task: Task) => this.taskOutcome(task);
    const executionStatus = this.executionProjects.status(id);
    const pipelineApproval = this.store
      .list<{ id: string; workflowId: string }>("pipeline")
      .find((p) => p.workflowId === id);
    const approval = pipelineApproval
      ? this.pipelines.reviewStatus(pipelineApproval.id)
      : null;
    return {
      ...workflow,
      tasks: tasks.map((task) => this.taskState(task.id)),
      executionStatus,
      approval,
      status: workflow.paused
        ? "paused"
        : (executionStatus ??
          (tasks.length &&
          tasks.every((t) =>
            ["completed", "superseded"].includes(effectiveStatus(t)),
          )
            ? approval && !approval.approved
              ? "needs-attention"
              : "completed"
            : tasks.some((t) =>
                  ["failed", "interrupted", "blocked"].includes(
                    effectiveStatus(t),
                  ),
                )
              ? "needs-attention"
              : tasks.some((t) => t.status === "running")
                ? "running"
                : "queued")),
    };
  }
  private isSuccessfulTask(task: Task) {
    if (task.status !== "completed" || taskCompletionProblem(task))
      return false;
    try {
      this.limits.assertCompletion(task, task.result);
      return true;
    } catch {
      return false;
    }
  }
  private isSupersededTask(task: Task) {
    if (!task.supersededBy) return false;
    try {
      const replacement = this.store.get<Task>("task", task.supersededBy);
      return (
        replacement.id !== task.id &&
        replacement.workflowId === task.workflowId &&
        !replacement.supersededBy &&
        this.isSuccessfulTask(replacement)
      );
    } catch {
      return false;
    }
  }
  taskOutcome(task: Task): Task["status"] | "superseded" {
    if (this.isSupersededTask(task)) return "superseded";
    if (task.status === "completed" && !this.isSuccessfulTask(task))
      return "failed";
    return task.status;
  }
  /** A dependency is satisfied by a valid completion or its explicitly linked replacement. */
  taskDependencySatisfied(id: string) {
    const task = this.store.get<Task>("task", id);
    return this.isSuccessfulTask(task) || this.isSupersededTask(task);
  }
  /** Preserve failed attempt evidence while explicitly resolving it against a verified result. */
  supersedeTask(id: string, supersededBy: string | null) {
    return this.store.transaction(() => {
      const task = this.store.get<Task>("task", id);
      if (supersededBy === null) {
        delete task.supersededBy;
        this.store.put("task", task);
        this.store.emit("task.superseded", id, { supersededBy: null });
        return task;
      }
      const replaceable =
        task.status === "failed" ||
        task.status === "interrupted" ||
        (task.status === "completed" && !this.isSuccessfulTask(task));
      assert(
        replaceable,
        "task_not_supersedable",
        "Only a failed or explicitly incomplete task can be marked superseded",
        409,
      );
      const replacement = this.store.get<Task>("task", supersededBy);
      assert(
        replacement.id !== task.id &&
          replacement.workflowId === task.workflowId &&
          !replacement.supersededBy &&
          this.isSuccessfulTask(replacement),
        "invalid_superseding_task",
        "Choose a successfully completed task in the same project",
        400,
      );
      task.supersededBy = replacement.id;
      this.store.put("task", task);
      this.store.emit("task.superseded", id, {
        supersededBy: replacement.id,
      });
      return task;
    });
  }
  pauseWorkflow(id: string, paused: boolean) {
    return this.store.transaction(() => {
      const wf = this.store.get<
        Workflow & {
          setup?: {
            executionMode?: "file-only";
            requiresModelVerification?: boolean;
            modelCheck?: {
              verified: boolean;
              checkedAt?: string | null;
              issues?: string[];
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
        const ids = new Set<string>(
          wf.setup.executionMode === "file-only" ? [] : [wf.ownerId],
        );
        for (const t of this.store.list<Task>("task"))
          if (t.workflowId === id) ids.add(t.agentId);
        // The refusal names what failed so the UI can show it next to Resume.
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
          check?.issues?.length
            ? `The model check did not pass: ${check.issues.join("; ")}`
            : check?.checkedAt
              ? "The model check is out of date: an agent's model or runtime changed after it ran. It runs again automatically; press Resume again in a moment"
              : "The models have not been checked yet: they are checked automatically once installed providers were detected (Settings shows the scan)",
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
        setup?: { executionMode?: "file-only"; workspace?: string };
        coordination?: {
          enabled: boolean;
          coordinatorId: string;
          planTaskId?: string;
        };
      }
    >("workflow", data.workflowId);
    if (workflow.setup?.executionMode === "file-only") {
      data.executionMode = "file-only";
      if (!data.resourcePaths?.length && workflow.setup.workspace)
        data.resourcePaths = [workflow.setup.workspace];
    }
    if (
      workflow.coordination?.enabled &&
      workflow.coordination.planTaskId &&
      data.agentId !== workflow.coordination.coordinatorId &&
      !data.dependsOn.includes(workflow.coordination.planTaskId)
    )
      data.dependsOn.push(workflow.coordination.planTaskId);
    const assignee = this.store.get<Agent>("agent", data.agentId);
    this.assertNotRetired(assignee);
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
    if (
      data.parentTaskId &&
      this.store.get<Task>("task", data.parentTaskId).executionMode ===
        "file-only"
    )
      data.executionMode = "file-only";
    if (data.executionMode === "file-only") {
      const support = simpleTaskSupport(this, assignee);
      assert(
        support.available,
        "simple_task_unsupported",
        `${assignee.name}: ${support.reason}`,
        409,
      );
    }
    const declared = canonicalDeclaredPaths(
      assignee,
      data.resourcePaths,
      (path) => filesystemPolicy(this.store).assertPath(path),
    );
    if (declared) data.resourcePaths = declared;
    else delete data.resourcePaths;
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
      (d) => !this.taskDependencySatisfied(d),
    );
    const dependencyBlockers = blockers.map((taskId) => {
      const dependency = this.store.get<Task>("task", taskId);
      const owner = this.store.get<Agent>("agent", dependency.agentId);
      return {
        taskId,
        title: dependency.title,
        agentId: owner.id,
        agentName: owner.nickname || owner.name,
        status: this.taskOutcome(dependency),
        reason:
          dependency.result?.slice(0, 1000) || `Task is ${dependency.status}`,
      };
    });
    const runtimeWait =
      task.status === "blocked"
        ? this.store
            .list<RuntimeWait>("runtime-wait")
            .find(
              (wait) =>
                wait.kind === "task" &&
                wait.targetId === id &&
                isCapabilityWait(wait) &&
                wait.attempt === this.recovery.state(id).attempt,
            )
        : undefined;
    const delegation = this.delegations.view(id);
    return {
      ...task,
      blockers,
      dependencyBlockers,
      ...(delegation ? { delegation } : {}),
      ...(runtimeWait
        ? {
            runtimeBlocker: {
              code: blockerCode(runtimeWait),
              message:
                runtimeWait.message ??
                "The required provider sandbox is unavailable.",
              ...(runtimeWait.issues?.length
                ? {
                    issues: runtimeWait.issues,
                    action: runtimeWait.issues[0].fix,
                  }
                : {}),
            },
          }
        : {}),
      waitReason:
        task.status !== "queued"
          ? null
          : filesystemPolicy(this.store).blocks().length
            ? "global-filesystem-block"
            : wf.paused
              ? "workflow-paused"
              : agent.control === "human"
                ? "human-control"
                : blockers.length
                  ? dependencyBlockers.some((blocker) =>
                      [
                        "failed",
                        "cancelled",
                        "blocked",
                        "interrupted",
                      ].includes(blocker.status),
                    )
                    ? "dependency-failed"
                    : "dependencies"
                  : this.orchestration.blockingReviews(task).length
                    ? "review-required"
                    : !this.validation.gate(task).open
                      ? "validation-required"
                      : task.invokedBy &&
                          !this.capacity(task.invokedBy).available
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
  /**
   * `context.launchManifest`: the redacted record of what the run was given, emitted beside the
   * `task.settings` event in the same transaction (src/capability-context.ts).
   */
  transitionTask(
    id: string,
    input: unknown,
    context: { launchManifest?: unknown } = {},
  ) {
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
    const existing = this.store.get<Task>("task", id);
    const completedButInvalid =
      existing.status === "completed" && !this.isSuccessfulTask(existing);
    // A retired worker (Team settings) takes no new work: no start, no retry.
    if (data.status === "running" || data.status === "queued")
      this.assertNotRetired(
        this.store.get<Agent>(
          "agent",
          this.store.get<Task>("task", id).agentId,
        ),
      );
    if (
      data.status === "completed" &&
      (explicitlyReportsNoWork(data.result) ||
        explicitlyReportsIncompleteExecution(
          this.store.get<Task>("task", id),
          data.result,
        ) ||
        explicitlyReportsUnapprovedReview(
          this.store.get<Task>("task", id),
          data.result,
        ))
    )
      assert(
        false,
        "execution_not_reported",
        "The task result does not satisfy its acceptance criteria: required execution or review approval is missing.",
      );
    // Limit checks record their trip in their own transaction, so run them before ours.
    if (data.status === "running")
      this.limits.enforceStart(this.store.get<Task>("task", id));
    if (data.status === "queued")
      this.limits.beforeRetry(id, completedButInvalid);
    if (data.status === "queued") this.delegations.assertCanQueue(existing);
    if (data.status === "completed")
      assert(
        !this.delegations.pending(existing).length,
        "delegated_work_pending",
        "Required delegated tasks and their reviews must succeed before the parent can complete.",
      );
    this.recovery.beforeTransition(
      this.store.get<Task>("task", id),
      data.status,
    );
    return this.store.transaction(() => {
      const task = this.store.get<Task>("task", id);
      const allowed: Record<Task["status"], Task["status"][]> = {
        // queued -> blocked: stopped by the readiness gate before it ever started (src/launch-readiness.ts)
        queued: ["running", "cancelled", "blocked"],
        running: ["completed", "failed", "cancelled", "interrupted", "blocked"],
        failed: ["queued", "cancelled"],
        interrupted: ["queued", "cancelled", "blocked"],
        blocked: ["queued", "cancelled", "interrupted"],
        completed: completedButInvalid ? ["queued", "cancelled"] : [],
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
          task.dependsOn.every((d) => this.taskDependencySatisfied(d)),
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
        const scopeHash = (
          context.launchManifest as { scopeHash?: string } | undefined
        )?.scopeHash;
        if (scopeHash) this.recovery.recordLaunchScope(task.id, scopeHash);
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
        if (context.launchManifest)
          this.store.emit(
            "task.launch_manifest",
            task.id,
            context.launchManifest,
          );
      }
      if (data.status === "completed") {
        assert(
          data.result?.trim(),
          "result_required",
          "Provide a completion result",
          400,
        );
        this.limits.assertCompletion(task, data.result);
        this.pipelines.assertCompletion(task);
        // A required check a model invented stays a slot until the user confirms it: the
        // task cannot complete around it (src/execution-contract.ts).
        this.contracts.assertCompletable(task);
      }
      const from = task.status;
      task.status = data.status;
      if (data.status !== "running") this.resources.release(task.id);
      if (data.status === "queued") {
        // Resuming an interrupted/blocked task is not a retry, but a limit stop recorded before the
        // restart is cleared either way (recordRetry only clears it in that case).
        if (
          from === "failed" ||
          completedButInvalid ||
          this.limits.meta(task.id).stoppedByLimit
        )
          this.limits.recordRetry(task);
        delete task.result;
        delete task.supersededBy;
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
      this.delegations.onTransition(task);
      return task;
    });
  }
  /** Start a conversational manager task alongside its own provider session.
   * It has no workspace lease: the session lock is the manager's lock, while delegated workers
   * acquire their own declared resources through the normal scheduler path.
   */
  startConversationTask(
    id: string,
    sessionId: string,
    context: { launchManifest?: unknown } = {},
  ) {
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
        current.dependsOn.every((dependency) =>
          this.taskDependencySatisfied(dependency),
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
      const scopeHash = (
        context.launchManifest as { scopeHash?: string } | undefined
      )?.scopeHash;
      if (scopeHash) this.recovery.recordLaunchScope(current.id, scopeHash);
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
      if (context.launchManifest)
        this.store.emit("task.launch_manifest", id, context.launchManifest);
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
    const interrupted = tasks
      .filter((t) => t.status === "interrupted")
      .map((t) => t.id);
    const waitingDelegations = tasks
      .filter(
        (t) =>
          t.status === "blocked" &&
          this.delegations.view(t.id)?.state === "waiting",
      )
      .map((t) => t.id);
    const blocked = tasks
      .filter(
        (t) =>
          (t.status === "blocked" && !waitingDelegations.includes(t.id)) ||
          queued.some(
            (queuedTask) =>
              queuedTask.id === t.id &&
              queuedTask.waitReason === "dependency-failed",
          ),
      )
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
          : blocked.length
            ? "blocked"
            : interrupted.length
              ? "interrupted"
              : queued.length || queuedMessages || waitingDelegations.length
                ? "waiting"
                : "idle",
      runningTaskIds: running,
      interruptedTaskIds: interrupted,
      blockedTaskIds: blocked,
      waitingTaskIds: waitingDelegations,
      queuedTasks: queued.map((t) => ({ id: t.id, waitReason: t.waitReason })),
      queuedMessages,
      failedTaskIds: tasks
        .filter((t) => this.taskOutcome(t) === "failed")
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
  /**
   * The text a run's instructions get after the agent's own: the simple-assignment notes, the
   * direct file-assignment note, the runtime guidance and the generated capability line. One
   * function for launch and for the instructions preview, so they cannot drift apart.
   */
  instructionTail(agent: Agent, task: Task | undefined, facts: PlanFacts) {
    const directAssignment = task
      ? this.store.get<Workflow & { setup?: { executionMode?: string } }>(
          "workflow",
          task.workflowId,
        ).setup?.executionMode === "file-only"
      : false;
    const assignedFiles = [
      ...new Set(
        (task?.completionChecks ?? []).flatMap((check) =>
          check.type === "artifact-exists" || check.type === "artifact-matches"
            ? [check.path]
            : [],
        ),
      ),
    ];
    const explicitFileWork =
      directAssignment &&
      assignedFiles.length > 0 &&
      facts.tools.includes("read") &&
      (facts.tools.includes("write") || facts.tools.includes("edit")) &&
      (facts.workspaces ?? []).some((folder) => folder.access === "write");
    return (
      (facts.executionMode === "file-only"
        ? "\n\nThis is a simple file-and-reply task. Terminal tools are unavailable for this assignment. Use only your existing file tools and permissions; do not create a pipeline or extra work unless explicitly requested."
        : "") +
      (explicitFileWork
        ? `\n\nCURRENT USER ASSIGNMENT: The user assigned you this file task directly. Complete your own declared deliverables: ${JSON.stringify(assignedFiles)}. For this assignment these file deliverables take precedence over a general planning-only or review-only role and its usual 'never modify files' guidance. Use the actual file tools and writable task folders already granted to this run; this instruction adds no tools or access. Do not delegate your own file to another agent. Your normal role and saved instructions remain unchanged for other work.`
        : "") +
      "\n\n" +
      runtimeGuidance +
      "\n\n" +
      capabilityContext(this, agent, facts, undefined, task?.id).line
    );
  }
  /** `taskId`: the task about to run; its declared paths select the working folder. */
  async launchPlan(agentId: string, taskId?: string) {
    filesystemPolicy(this.store).assertConfinedExecution();
    const agent = this.store.get<Agent>("agent", agentId);
    const agentSnapshot = JSON.stringify(agent);
    const taskSnapshot = taskId
      ? JSON.stringify(this.store.get<Task>("task", taskId))
      : null;
    const task = taskId ? this.store.get<Task>("task", taskId) : undefined;
    const executionMode = task?.executionMode;
    if (executionMode === "file-only") {
      const support = simpleTaskSupport(this, agent);
      assert(
        support.available,
        "simple_task_unsupported",
        `${agent.name}: ${support.reason}`,
        409,
      );
    }
    const tools =
      executionMode === "file-only"
        ? agent.tools.filter((tool) => tool !== "shell")
        : agent.tools;
    const skippedSkills: string[] = [];
    await this.skills.scan();
    const loaded = agent.skills.flatMap((assignment) => {
      const skill = this.skills.get(assignment.id);
      if (
        executionMode === "file-only" &&
        skill.requiresTools.includes("shell")
      ) {
        skippedSkills.push(
          `${skill.name}: terminal-dependent skill not loaded for this file-only task`,
        );
        return [];
      }
      assert(
        skill.environments.includes(agent.environment) ||
          assignment.allowUnverified,
        "incompatible_skill",
        `Skill ${skill.name} is incompatible`,
        400,
      );
      for (const tool of skill.requiresTools)
        assert(
          tools.includes(tool),
          "missing_tool",
          `Skill ${skill.name} requires ${tool}`,
          400,
        );
      return [{ ...assignment, skill }];
    });
    const connection = this.connection(agent.environment);
    assert(
      executionMode !== "file-only" ||
        (connection.transport === "direct" &&
          ["claude", "codex"].includes(agent.environment)),
      "simple_task_unsupported",
      `${agent.name}: simple file tasks require a direct Claude or Codex runtime; this adapter cannot disable terminal tools.`,
      409,
    );
    const adapter = adapterFor(agent.environment, connection.transport);
    // Change detection: first use pins a skill; a changed one is skipped until the user accepts it.
    const entries = await classifySkills(this.store, loaded, {
      persist: true,
    });
    const decisions = decideSkills(entries, undefined);
    const contract = task ? this.contracts.effective(task) : null;
    const needsFolder =
      requiredFor({
        contract,
        roleClass: roleClassOf(this, agent),
        tools,
        adapter:
          connection.transport === "acp"
            ? "acp"
            : (agent.environment as "claude" | "codex" | "wolfram"),
      }).required.length > 0;
    const filesystem = await taskFilesystem(
      this.store,
      agent,
      taskId,
      needsFolder && contract?.projectFolder
        ? [contract.projectFolder]
        : undefined,
    );
    const fsWorkspaces = filesystem?.workspaces ?? agent.workspaces;
    const fsCwd =
      filesystem?.cwd ?? agent.workspaces.find((w) => w.active)?.path ?? null;
    // What this run can really do, stated to the model from the same facts the command is built
    // from (src/capability-context.ts); leaf workers learn that they have no teammates.
    const facts: PlanFacts = {
      environment: agent.environment,
      connection,
      cwd: fsCwd,
      taskScoped: filesystem !== null,
      executionMode,
      tools,
      providerRoots: fsWorkspaces.map((workspace) => ({
        path: workspace.path,
        access: workspace.access,
        active: workspace.active,
        restricted: !!workspace.explicitOnly || !!workspace.rules?.length,
      })),
      workspaces: fsWorkspaces,
    };
    const runAgent = {
      ...agent,
      tools,
      workspaces: fsWorkspaces,
      instructions:
        agent.instructions + this.instructionTail(agent, task, facts),
    };
    const sections = composeSections(runAgent, entries, decisions, adapter);
    const providerRoots = runAgent.workspaces.map((workspace) => ({
      path: workspace.path,
      access: workspace.access,
      active: workspace.active,
      restricted: !!workspace.explicitOnly || !!workspace.rules?.length,
    }));
    const cwd = fsCwd;
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
      taskScoped: filesystem !== null,
      executionMode,
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
      workspaces: filesystem?.workspaces ?? agent.workspaces,
      providerRoots,
      tools,
      warnings: [
        ...skippedSkills,
        ...loaded
          .filter((l) => l.skill.compatibility !== "declared")
          .map((l) => `${l.skill.name}: compatibility inferred or unverified`),
        ...decisions
          .filter((d) => d.state === "skipped")
          .map((d) => `${d.name}: ${d.reason}`),
      ],
    };
    const readyPlan = attachContext(plan, {
      agent: runAgent,
      entries,
      adapter,
      baseInstructions: plan.instructions,
    });
    assert(
      JSON.stringify(this.store.get<Agent>("agent", agentId)) === agentSnapshot,
      "agent_changed",
      "Agent configuration changed while preparing the launch; retry the task",
      409,
    );
    if (taskId)
      assert(
        JSON.stringify(this.store.get<Task>("task", taskId)) === taskSnapshot,
        "task_changed",
        "Task changed while preparing the launch; retry it",
        409,
      );
    // Close the window in which a permanent block could be added while launch preparation awaits
    // skills or filesystem metadata. The scheduler marks the task running immediately afterwards,
    // which then prevents adding a global block during execution.
    filesystemPolicy(this.store).assertConfinedExecution();
    return readyPlan;
  }
}
export type LaunchPlan = Awaited<ReturnType<TeamService["launchPlan"]>>;
