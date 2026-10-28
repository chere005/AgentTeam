// The one readiness evaluator (reliable-execution plan item 2).
//
// It compares what a role must be able to do (the execution contract, or, for work without a
// contract, the write and shell tools the role is granted) with what a launch can actually do
// (`effectiveCapabilities` of the real `LaunchPlan`). Chat preparation, Assign to team, pipeline
// preparation, the task API, `invoke_teammate`, resume and the scheduler all call it, so they
// reach the same decision for the same agent and requirements.
//
// A task that fails the evaluation is BLOCKED before it starts: no provider process, no effect
// ledger entry, no lease, no turn and no attempt is consumed. The blocker is a `runtime-wait` of
// reason `capability-missing` (the same record, "Setup required" label and automatic requeue the
// sandbox blocker already uses), so it needs no second requeue subsystem.
import { resolve } from "node:path";
import { AppError, type Agent, type Task } from "./model.ts";
import {
  effectiveCapabilities,
  providerRootsOf,
  type Capability,
  type CapabilityGap,
  type CapabilityIssueCode,
  type EffectiveCapabilities,
  type HostFacts,
  type PlanFacts,
} from "./launch-capability.ts";
import {
  kindCapabilities,
  type ContractLike,
  type RoleClass,
} from "./execution-contract.ts";
import {
  failureFromError,
  reportsDeniedPath,
  type FolderLookup,
  type FolderProbeCode,
  type FolderProbeFailure,
  type FolderProbeResult,
  type ProbeRequest,
} from "./folder-access.ts";
import { contains } from "./resources.ts";
import { taskScope } from "./provider-filesystem.ts";
import { simpleTaskSupport } from "./simple-task-capabilities.ts";
import { teamProfile } from "./team-profiles.ts";
import { noteRuntimeWait, type RuntimeWait } from "./runtime-waits.ts";
import type { Readiness } from "./runtime-scan.ts";
import type { TeamService } from "./service.ts";

export type SetupAction = {
  kind:
    | "choose-project-folder"
    | "allow-folder-access"
    | "attach-folder"
    | "grant-write-access"
    | "grant-tool"
    | "change-runtime"
    | "sign-in"
    | "change-assignment-mode"
    | "fix-sandbox"
    | "remove-access-rules"
    | "confirm-check";
  label: string;
  agentId?: string;
  path?: string;
  tool?: string;
  contractId?: string;
  slot?: string;
};
export type ReadinessIssueCode =
  | CapabilityIssueCode
  /** The system refuses the folder (a probe answered): denied, missing, not a folder, read-only disk. */
  | FolderProbeCode
  | "folder-detached"
  | "folder-changed"
  | "confinement-unsupported"
  | "global-denial"
  | "runtime-unavailable"
  | "check-unconfirmed"
  | "project-preparation";
export type ReadinessIssue = {
  code: ReadinessIssueCode;
  capability: Capability | null;
  agentId: string;
  agentName: string;
  taskId?: string;
  /** Names the real cause and the repair; this is the text a refused model or a person reads. */
  message: string;
  fix: SetupAction | null;
};
/** What readiness needs to know about a task (a delegated task before it exists has no id). */
export type TaskTraits = {
  id?: string;
  parentTaskId?: string;
  workflowId: string;
  resourcePaths?: string[];
  executionMode?: "standard" | "file-only";
};
export type ReadinessDecision = {
  ready: boolean;
  agentId: string;
  agentName: string;
  taskId?: string;
  /** "contract": what the contract requires; "grants": the role's own write/shell grants. */
  basis: "contract" | "grants";
  roleClass: RoleClass;
  required: Capability[];
  effective: Pick<
    EffectiveCapabilities,
    "available" | "toolNames" | "folders" | "taskRoot" | "sandbox" | "adapter"
  > | null;
  /** The folder probe answers this decision consulted (a folder never probed is absent). */
  folderAccess?: {
    path: string;
    write: boolean;
    ok: boolean;
    checkedAt: string;
    code?: FolderProbeCode;
    /** The programs AgentTeam starts could not be checked there (the folder itself is usable). */
    warning?: string;
  }[];
  issues: ReadinessIssue[];
  message: string | null;
};

/** What the system answered about the folders one launch needs, and the facts to judge it with. */
export type ProbedFolders = {
  /** One answer per folder, in the order the launch needs them. */
  results: FolderProbeResult[];
  /** Host facts whose folder lookup returns exactly these answers (then the shared ones). */
  host: HostFacts;
};
export type FolderProbeOptions = {
  task?: TaskTraits;
  contract?: ContractLike | null;
  host?: HostFacts;
  /** Probe again even when a fresh answer exists (Start, Retry, Resume, setup). */
  force?: boolean;
  /**
   * With `force`, probe a folder again only the first time this set sees it, so one action
   * over many tasks of one project asks the system once per folder.
   */
  forced?: Set<string>;
  /** Which path asks (stored with the answer). */
  source?: string;
  /** How long to wait for an answer, counted from when the probe was requested. */
  waitMs?: number;
  /** One budget (Date.now() scale) for every probe of a scheduler tick. */
  deadlineAt?: number;
};

const VERB: Record<Capability, string> = {
  read: "read files",
  write: "create or change files",
  shell: "run programs",
};
const uniq = <T>(items: T[]) => [...new Set(items)];

/** The class a role plays: the team profile's role map first, then the agent's own role type. */
export function roleClassOf(service: TeamService, agent: Agent): RoleClass {
  const teamId = service.teamSpaces.teamOfAgent(agent);
  const profile = teamId ? teamProfile(service.store, teamId) : null;
  if (profile)
    for (const [role, ids] of Object.entries(profile.roles))
      if (ids.includes(agent.id)) {
        if (["integrator", "implement", "fix"].includes(role))
          return "implementer";
        if (/review/i.test(role) || /^final/.test(role)) return "reviewer";
        if (role === "adjudicator") return "adjudicator";
        if (role === "planner") return "coordinator";
        if (role === "reporter") return "reporter";
      }
  switch (agent.roleType) {
    case "implementer":
    case "reviewer":
    case "adjudicator":
    case "coordinator":
      return agent.roleType;
    default:
      return "custom";
  }
}

/**
 * What a role must be able to do for a task. Without a contract (older projects, plain tasks) the
 * only known requirement is the role's own grants: write or shell granted but impossible to
 * enable (no writable folder) counts as missing, so a read-only role is never "enough tools" for
 * work that writes. A contract adds what its work kind needs; the grant floor stays unless the
 * user explicitly said the work is response-only.
 */
export function requiredFor(input: {
  contract: ContractLike | null;
  roleClass: RoleClass;
  tools: string[];
  adapter: EffectiveCapabilities["adapter"];
}): { required: Capability[]; basis: "contract" | "grants" } {
  // The grant floor applies to the adapters whose tools AgentTeam itself enables or withholds,
  // and not to roles defined as read-only: a reviewer's leftover write grant is a configuration
  // warning (src/roles.ts), never a reason to ask for write access.
  const floorApplies =
    (input.adapter === "claude" || input.adapter === "codex") &&
    input.roleClass !== "reviewer" &&
    input.roleClass !== "adjudicator" &&
    input.roleClass !== "reporter";
  const grants = (applies: boolean): Capability[] =>
    applies
      ? [
          ...(input.tools.includes("edit") || input.tools.includes("write")
            ? (["write"] as const)
            : []),
          ...(input.tools.includes("shell") ? (["shell"] as const) : []),
        ]
      : [];
  // Writing needs reading (the provider only enables Edit/Write alongside Read).
  const withRead = (caps: Capability[]) =>
    caps.includes("write") && !caps.includes("read")
      ? (["read", ...caps] as Capability[])
      : caps;
  if (!input.contract)
    return { required: withRead(grants(floorApplies)), basis: "grants" };
  const waived =
    input.contract.workKindSource === "user" &&
    input.contract.workKind === "response-only";
  const readonly = ["reviewer", "adjudicator", "reporter"].includes(
    input.roleClass,
  );
  if (readonly)
    return {
      required: waived
        ? []
        : input.contract.roles.some((r) => r.capabilities.includes("read")) ||
            input.contract.workKind !== "response-only"
          ? ["read"]
          : [],
      basis: "contract",
    };
  const needed: Capability[] =
    input.contract.scope === "task"
      ? [...kindCapabilities(input.contract.workKind)]
      : (input.contract.roles.find((r) => r.role === input.roleClass)
          ?.capabilities ?? []);
  return {
    required: withRead(
      uniq([...needed, ...(waived ? [] : grants(floorApplies))]),
    ),
    basis: "contract",
  };
}

const ERROR_CAUSES: Record<
  string,
  { code: ReadinessIssueCode; fix: (agent: Agent) => SetupAction | null }
> = {
  resource_path_detached: {
    code: "folder-detached",
    fix: (a) => ({
      kind: "attach-folder",
      label: `Attach the task folder to ${a.name}`,
      agentId: a.id,
    }),
  },
  workspace_changed: {
    code: "folder-changed",
    fix: (a) => ({
      kind: "attach-folder",
      label: `Re-attach the folder to ${a.name}`,
      agentId: a.id,
    }),
  },
  resource_path_changed: {
    code: "folder-changed",
    fix: (a) => ({
      kind: "attach-folder",
      label: `Re-attach the folder to ${a.name}`,
      agentId: a.id,
    }),
  },
  resource_path_not_directory: { code: "folder-changed", fix: () => null },
  resource_path_read_only: {
    code: "folder-read-only",
    fix: (a) => ({
      kind: "grant-write-access",
      label: `Give ${a.name} write access to the folder`,
      agentId: a.id,
    }),
  },
  provider_access_unsupported: {
    code: "confinement-unsupported",
    fix: (a) => ({
      kind: "remove-access-rules",
      label: `Remove the access rules or nested folders on ${a.name}`,
      agentId: a.id,
    }),
  },
  resource_scope_unsupported: {
    code: "confinement-unsupported",
    fix: (a) => ({
      kind: "remove-access-rules",
      label: `Remove the access rules on ${a.name}`,
      agentId: a.id,
    }),
  },
  simple_task_unsupported: {
    code: "adapter-unsupported",
    fix: (a) => ({
      kind: "change-runtime",
      label: `Choose a runtime ${a.name} can use for this assignment`,
      agentId: a.id,
    }),
  },
  filesystem_blocked: { code: "global-denial", fix: () => null },
  filesystem_sandbox_required: {
    code: "confinement-unsupported",
    fix: () => null,
  },
};

export class LaunchReadiness {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }

  /** The launch facts a task would get, from saved configuration alone (synchronous, no disk). */
  prospectivePlan(
    agent: Agent,
    task?: Partial<TaskTraits>,
    contract?: ContractLike | null,
  ): PlanFacts {
    const executionMode = task?.executionMode;
    const tools =
      executionMode === "file-only"
        ? agent.tools.filter((tool) => tool !== "shell")
        : agent.tools;
    const inherited =
      contract ??
      (task?.id && task.workflowId
        ? this.service.contracts.effective({
            id: task.id,
            workflowId: task.workflowId,
            parentTaskId: task.parentTaskId,
          })
        : task?.workflowId
          ? this.service.contracts.project(task.workflowId)
          : null);
    const needsFolder =
      requiredFor({
        contract: inherited,
        roleClass: roleClassOf(this.service, agent),
        tools,
        adapter:
          this.service.connection(agent.environment).transport === "acp"
            ? "acp"
            : (agent.environment as EffectiveCapabilities["adapter"]),
      }).required.length > 0;
    const paths = task?.resourcePaths?.length
      ? task.resourcePaths
      : needsFolder && agent.workspaces.length && inherited?.projectFolder
        ? [inherited.projectFolder]
        : undefined;
    const scope = taskScope(agent, paths);
    const workspaces = scope?.workspaces ?? agent.workspaces;
    return {
      environment: agent.environment,
      connection: this.service.connection(agent.environment),
      cwd: scope?.cwd ?? agent.workspaces.find((w) => w.active)?.path ?? null,
      taskScoped: scope !== null,
      executionMode,
      tools,
      providerRoots: workspaces.map((w) => ({
        path: w.path,
        access: w.access,
        active: w.active,
        restricted: !!w.explicitOnly || !!w.rules?.length,
      })),
      workspaces,
    };
  }

  /** Turn a launch-preparation error into the typed cause when it is a setup problem. */
  issueFromError(
    agent: Agent,
    error: unknown,
    taskId?: string,
  ): ReadinessIssue | null {
    if (!(error instanceof AppError)) return null;
    const cause = ERROR_CAUSES[error.code];
    if (!cause) return null;
    return {
      code: cause.code,
      capability: null,
      agentId: agent.id,
      agentName: agent.name,
      ...(taskId ? { taskId } : {}),
      message: error.message,
      fix: cause.fix(agent),
    };
  }

  private teamNeedsProject(agent: Agent) {
    const teamId = this.service.teamSpaces.teamOfAgent(agent);
    const profile = teamId ? teamProfile(this.store, teamId) : null;
    return profile && profile.type !== "free-form" ? profile : null;
  }

  private describeGap(
    agent: Agent,
    capability: Capability,
    gap: CapabilityGap,
    contract: ContractLike | null,
    taskId?: string,
  ): ReadinessIssue {
    const base = {
      code: gap.code as ReadinessIssueCode,
      capability,
      agentId: agent.id,
      agentName: agent.name,
      ...(taskId ? { taskId } : {}),
    };
    const lead = `${agent.name} cannot ${VERB[capability]}: ${gap.message}`;
    switch (gap.code) {
      case "no-folder":
      case "no-active-folder":
      case "folder-outside-task": {
        const folder = contract?.projectFolder;
        if (folder)
          return {
            ...base,
            message: `${lead} Attach ${folder} to ${agent.name}.`,
            fix: {
              kind: "attach-folder",
              label: `Attach ${folder} to ${agent.name}`,
              agentId: agent.id,
              path: folder,
            },
          };
        const profile = this.teamNeedsProject(agent);
        return {
          ...base,
          message: profile
            ? `${lead} Assign the team a project (its setup attaches the project folder to every role) or attach a folder to ${agent.name}.`
            : `${lead} Attach a folder to ${agent.name}.`,
          fix: {
            kind: "choose-project-folder",
            label: "Choose project folder",
            agentId: agent.id,
          },
        };
      }
      case "folder-read-only":
        return {
          ...base,
          message: `${lead} Give ${agent.name} write access to the project folder.`,
          fix: {
            kind: "grant-write-access",
            label: `Give ${agent.name} write access`,
            agentId: agent.id,
            ...(contract?.projectFolder
              ? { path: contract.projectFolder }
              : {}),
          },
        };
      case "grant-missing": {
        const tool =
          capability === "shell"
            ? "shell"
            : capability === "read"
              ? "read"
              : "write";
        return {
          ...base,
          message: `${lead} Grant ${agent.name} the "${tool}" tool or give the work to another agent.`,
          fix: {
            kind: "grant-tool",
            label: `Grant the "${tool}" tool to ${agent.name}`,
            agentId: agent.id,
            tool,
          },
        };
      }
      case "adapter-unsupported":
        return {
          ...base,
          message: `${lead} Use a Claude or Codex agent for this work.`,
          fix: {
            kind: "change-runtime",
            label: `Use a Claude or Codex agent instead of ${agent.name}`,
            agentId: agent.id,
          },
        };
      case "shell-withheld":
        return {
          ...base,
          message: `${lead}`,
          fix: {
            kind: "change-assignment-mode",
            label: "Use a team assignment",
            agentId: agent.id,
          },
        };
      case "sandbox-unavailable":
        return {
          ...base,
          message: `${lead}`,
          fix: {
            kind: "fix-sandbox",
            label: `Fix the sandbox or remove the shell tool from ${agent.name}`,
            agentId: agent.id,
          },
        };
      case "folder-restricted":
        return {
          ...base,
          message: `${lead} Remove the access rules from ${agent.name}'s folder or give it an unrestricted one.`,
          fix: {
            kind: "remove-access-rules",
            label: `Remove the access rules on ${agent.name}`,
            agentId: agent.id,
          },
        };
      default:
        return { ...base, message: lead, fix: null };
    }
  }

  /** Evaluate an actual (or prospective) launch plan against what the role must be able to do. */
  evaluatePlan(
    agent: Agent,
    plan: PlanFacts,
    options: {
      task?: TaskTraits;
      contract?: ContractLike | null;
      host?: HostFacts;
      runtime?: (environment: string) => Readiness | undefined;
      /**
       * A launch gate (scheduler, chat run, Start): a folder nobody asked the system about is not
       * assumed fine, it is "not checked yet". Previews leave it out of the judgment because their
       * answer would be a question they cannot ask (they are synchronous).
       */
      strictFolders?: boolean;
    } = {},
  ): ReadinessDecision {
    const host: HostFacts = { ...this.host(), ...options.host };
    const effective = effectiveCapabilities(plan, host);
    const contract = this.contractOf(options);
    const roleClass = roleClassOf(this.service, agent);
    const { required, basis } = requiredFor({
      contract,
      roleClass,
      tools: plan.tools,
      adapter: effective.adapter,
    });
    const issues: ReadinessIssue[] = [];
    for (const capability of required) {
      const gap = effective.gaps[capability];
      if (!effective.available[capability] && gap)
        issues.push(
          this.describeGap(agent, capability, gap, contract, options.task?.id),
        );
    }
    // What the system really lets this launch do in its folders: the last probe answer. A grant
    // that the operating system overrules is not a capability; a refused folder blocks the launch
    // the same way a missing grant does. At a launch gate a folder that was never asked about is
    // not assumed fine either.
    const folderAccess: NonNullable<ReadinessDecision["folderAccess"]> = [];
    for (const target of this.folderTargets(plan, required)) {
      const answer = host.folderAccess?.(target.path, target.write);
      if (!answer) {
        if (options.strictFolders && host.folderAccess)
          issues.push(this.describeUnasked(agent, target, options.task?.id));
        continue;
      }
      folderAccess.push({
        path: answer.path,
        write: answer.write,
        ok: answer.ok,
        checkedAt: answer.checkedAt,
        ...(answer.ok
          ? answer.warning
            ? { warning: answer.warning.message }
            : {}
          : { code: answer.code }),
      });
      if (!answer.ok)
        issues.push(
          this.describeFolderFailure(
            agent,
            target.write,
            answer,
            options.task?.id,
          ),
        );
    }
    // Authentication and installation: reported where the answer is informational (setup, notices,
    // task readiness). The launch itself keeps its own `runtime_unavailable` path, which requeues
    // the work by itself once the runtime is ready (src/readiness.ts).
    const runtime = options.runtime?.(agent.environment);
    if (runtime?.state === "unavailable")
      issues.push({
        code: "runtime-unavailable",
        capability: null,
        agentId: agent.id,
        agentName: agent.name,
        ...(options.task?.id ? { taskId: options.task.id } : {}),
        message: `${agent.name}: ${runtime.message}`,
        fix: /sign(ed)?[ -]?(in|out)|log ?in|authenticat/i.test(runtime.message)
          ? {
              kind: "sign-in",
              label: `Sign in to ${agent.environment}`,
              agentId: agent.id,
            }
          : {
              kind: "change-runtime",
              label: `Open Settings to select ${agent.environment}`,
              agentId: agent.id,
            },
      });
    // One issue per cause: write and shell both missing for the same reason read as one.
    const seen = new Set<string>();
    const distinct = issues.filter((issue) => {
      const key = `${issue.code}:${issue.fix?.kind}:${issue.fix?.path ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ready: distinct.length === 0,
      agentId: agent.id,
      agentName: agent.name,
      ...(options.task?.id ? { taskId: options.task.id } : {}),
      basis,
      roleClass,
      required,
      effective: {
        available: effective.available,
        toolNames: effective.toolNames,
        folders: effective.folders,
        taskRoot: effective.taskRoot,
        sandbox: effective.sandbox,
        adapter: effective.adapter,
      },
      ...(folderAccess.length ? { folderAccess } : {}),
      issues: distinct,
      message: distinct.length
        ? distinct.map((i) => i.message).join(" ")
        : null,
    };
  }

  /** The contract a decision is judged against: the caller's, else the task's effective one. */
  private contractOf(options: {
    task?: TaskTraits;
    contract?: ContractLike | null;
  }) {
    return options.contract !== undefined
      ? options.contract
      : options.task?.id
        ? this.service.contracts.effective({
            id: options.task.id,
            parentTaskId: options.task.parentTaskId,
            workflowId: options.task.workflowId,
          })
        : null;
  }

  /**
   * The folders a launch needs the system to open, with the access each needs: the task's own
   * folders (the declared task paths, else the active folder), written when the role must write
   * and the folder is attached for writing, otherwise read.
   */
  folderTargets(plan: PlanFacts, required: Capability[]) {
    if (!plan.cwd || !required.length) return [];
    const roots = providerRootsOf(plan);
    const own = plan.taskScoped
      ? roots
      : roots.filter((root) => root.path === plan.cwd);
    const targets = (own.length ? own : [{ path: plan.cwd, access: "read" }])
      .map((root) => ({
        path: root.path,
        write: required.includes("write") && root.access === "write",
      }))
      .filter(
        (target, index, all) =>
          all.findIndex((other) => other.path === target.path) === index,
      );
    return targets;
  }

  /** The issue a refused folder becomes: the probe's own words, and the one repair that fits. */
  private describeFolderFailure(
    agent: Agent,
    write: boolean,
    answer: Extract<FolderProbeResult, { ok: false }>,
    taskId?: string,
  ): ReadinessIssue {
    const capability: Capability = write ? "write" : "read";
    // An answer that has not come yet is a wait, not a refusal: no repair, only the explanation.
    if (answer.code === "folder-probe-pending")
      return {
        code: answer.code,
        capability,
        agentId: agent.id,
        agentName: agent.name,
        ...(taskId ? { taskId } : {}),
        message: `${answer.message} ${answer.fix}`,
        fix: null,
      };
    // macOS names the cause and the repair only for a permission refusal in a protected place.
    const system =
      answer.code === "folder-denied" &&
      !!answer.protectedFolder &&
      ["EPERM", "EACCES", "ETIMEDOUT"].includes(answer.errno);
    return {
      code: answer.code,
      capability,
      agentId: agent.id,
      agentName: agent.name,
      ...(taskId ? { taskId } : {}),
      message: `${agent.name} cannot ${VERB[capability]}: ${answer.message} ${answer.fix}`,
      fix: system
        ? {
            kind: "allow-folder-access",
            label: `Allow AgentTeam to access ${answer.path}, then check again`,
            agentId: agent.id,
            path: answer.path,
          }
        : // A platform that cannot run the check has no repair a different folder would give.
          answer.code === "probe-unavailable"
          ? null
          : {
              kind: "choose-project-folder",
              label: "Choose another project folder",
              agentId: agent.id,
              path: answer.path,
            },
    };
  }

  /** The question a launch gate leaves open: nobody asked the system about this folder. */
  private describeUnasked(
    agent: Agent,
    target: { path: string; write: boolean },
    taskId?: string,
  ): ReadinessIssue {
    return {
      code: "folder-probe-pending",
      capability: target.write ? "write" : "read",
      agentId: agent.id,
      agentName: agent.name,
      ...(taskId ? { taskId } : {}),
      message: `AgentTeam has not asked the system whether ${agent.name} can use ${target.path} yet; nothing starts before it has.`,
      fix: null,
    };
  }

  /** The attached folder a task's own folder lives in, when it is a folder inside one (not the attachment itself). */
  private attachedRoot(agent: Agent, path: string) {
    return agent.workspaces
      .filter(
        (w) => contains(w.path, path) && resolve(w.path) !== resolve(path),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]?.path;
  }
  /**
   * One folder a launch needs, asked about with the access the role needs. A task's own output
   * folder that is not made yet is judged by the attached folder it will be made in (and its
   * absence is not remembered as a refusal), so the first launch and a retry agree.
   */
  private async probeTarget(
    agent: Agent,
    target: { path: string; write: boolean },
    request: Omit<ProbeRequest, "write">,
  ) {
    const folders = this.service.folderAccess;
    const root = this.attachedRoot(agent, target.path);
    if (!root)
      return folders.probe(target.path, { ...request, write: target.write });
    const own = await folders.probe(target.path, {
      ...request,
      write: target.write,
      ignoreMissing: true,
    });
    if (own.ok || own.code !== "folder-missing") return own;
    return folders.probe(root, { ...request, write: target.write });
  }

  /**
   * Ask the system about the folders this launch will use, before anything starts, and return the
   * answers (and the host facts that carry exactly these answers, so the evaluation that follows
   * cannot read a different, later state). Scheduler, chat runs, Start, Recovery and project setup
   * call it (they are asynchronous); the preview paths only read what these calls left behind, so
   * a preview and the action it offers agree.
   */
  async probeLaunch(
    agent: Agent,
    plan: PlanFacts,
    options: FolderProbeOptions = {},
  ): Promise<ProbedFolders> {
    const host: HostFacts = { ...this.host(), ...options.host };
    const effective = effectiveCapabilities(plan, host);
    const { required } = requiredFor({
      contract: this.contractOf(options),
      roleClass: roleClassOf(this.service, agent),
      tools: plan.tools,
      adapter: effective.adapter,
    });
    const asked = await Promise.all(
      this.folderTargets(plan, required).map(async (target) => {
        const key = `${target.path}\u0000${target.write}`;
        const force =
          !!options.force && !(options.forced && options.forced.has(key));
        options.forced?.add(key);
        const result = await this.probeTarget(agent, target, {
          force,
          source: options.source,
          waitMs: options.waitMs,
          deadlineAt: options.deadlineAt,
        });
        return { target, result };
      }),
    );
    const fallback: FolderLookup =
      host.folderAccess ?? this.service.folderAccess.lookup;
    return {
      results: asked.map((entry) => entry.result),
      host: {
        ...host,
        folderAccess: (path, write) =>
          asked.find(
            (entry) =>
              entry.target.path === path && entry.target.write === write,
          )?.result ?? fallback(path, write),
      },
    };
  }
  /** `probeLaunch` for the plan saved configuration gives (no launch plan exists yet). */
  async probeProspective(
    agent: Agent,
    options: Omit<FolderProbeOptions, "task"> & {
      task?: Partial<TaskTraits>;
    } = {},
  ): Promise<ProbedFolders> {
    let plan: PlanFacts;
    try {
      plan = this.prospectivePlan(
        agent,
        agent.workspaces.length
          ? options.task
          : { ...options.task, resourcePaths: undefined },
        options.contract,
      );
    } catch {
      // A detached or changed folder is reported by the evaluator, not probed.
      return { results: [], host: { ...this.host(), ...options.host } };
    }
    return this.probeLaunch(agent, plan, {
      ...options,
      task: options.task as TaskTraits | undefined,
    });
  }
  /** `probeProspective` for a saved task (Recovery's Retry and Resume). */
  async probeTask(
    taskId: string,
    options: Omit<FolderProbeOptions, "task"> = {},
  ): Promise<ProbedFolders> {
    const task = this.store.get<Task>("task", taskId);
    const agent = this.store.get<Agent>("agent", task.agentId);
    return this.probeProspective(agent, { task, ...options });
  }
  /**
   * The folders a run looks at before it can be judged at all (resolving the launch plan, the
   * review baseline): the agent's active folder and every folder it may write. Inside a macOS
   * protected location even looking at a folder can wait for a prompt nobody has answered, and
   * the scheduler tick waits for the caller, so those folders (only those) are asked about first,
   * for reading, bounded: the answer is a result here, not a lookup that hangs.
   */
  async probeAttached(
    agent: Agent,
    options: Pick<FolderProbeOptions, "source" | "waitMs" | "deadlineAt"> = {},
  ) {
    const folders = this.service.folderAccess;
    const paths = [
      ...new Set(
        agent.workspaces
          .filter((w) => w.active || w.access === "write")
          .map((w) => w.path)
          .filter((path) => folders.mayPrompt(path)),
      ),
    ];
    return Promise.all(
      paths.map(async (path) => ({
        path,
        result: await folders.probe(path, { write: false, ...options }),
      })),
    );
  }
  /**
   * A run's output reports the system's refusal for a path under a folder it used: ask the system
   * about that folder now, with the access the role needs (read for a reviewer, write for a
   * writer), and keep the answer where readiness and Recovery read it. The run itself stays what
   * it was, with its evidence.
   */
  async noteDenial(
    agent: Agent,
    plan: PlanFacts,
    output: string,
    options: {
      task?: TaskTraits;
      contract?: ContractLike | null;
      source?: string;
      waitMs?: number;
    } = {},
  ) {
    const effective = effectiveCapabilities(plan, this.host());
    const { required } = requiredFor({
      contract: this.contractOf(options),
      roleClass: roleClassOf(this.service, agent),
      tools: plan.tools,
      adapter: effective.adapter,
    });
    let asked = 0;
    for (const target of this.folderTargets(plan, required)) {
      if (!reportsDeniedPath(output, target.path)) continue;
      asked++;
      await this.probeTarget(agent, target, {
        force: true,
        source: options.source ?? "post-run",
        waitMs: options.waitMs ?? 1000,
      });
    }
    return asked;
  }
  /**
   * A task's output folder could not be made (the system refused the `mkdir`, or the folder it
   * belongs in vanished): the same typed wait as any refused folder, worded by the probe, instead
   * of a task that stays queued without a word. Returns whether the task was blocked.
   */
  async blockForFolderError(
    task: Task,
    agent: Agent,
    error: unknown,
    options: { deadlineAt?: number } = {},
  ) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (error instanceof AppError || typeof code !== "string") return false;
    if (!/^E[A-Z0-9]+$/.test(code)) return false;
    const attempted = (error as NodeJS.ErrnoException).path;
    const declared = attempted ?? task.resourcePaths?.[0];
    const root = declared
      ? (agent.workspaces
          .filter((w) => contains(w.path, declared))
          .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? declared)
      : undefined;
    if (!root) return false;
    // The probe words the cause (and the macOS repair) when the folder it belongs in is refused;
    // when that folder passes, the refusal is the error's own and is recorded as such.
    const probed = await this.service.folderAccess.probe(root, {
      write: true,
      force: true,
      source: "prepare",
      deadlineAt: options.deadlineAt,
    });
    let failure: FolderProbeFailure;
    if (!probed.ok) failure = probed;
    else {
      failure = failureFromError(
        root,
        true,
        error,
        (error as NodeJS.ErrnoException).syscall ?? "mkdir",
        { platform: this.service.hostPlatform?.() },
      );
      this.service.folderAccess.noteFailure(failure, "prepare");
    }
    const issue = this.describeFolderFailure(agent, true, failure, task.id);
    this.blockTask(task, {
      ready: false,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task.id,
      basis: "grants",
      roleClass: roleClassOf(this.service, agent),
      required: ["write"],
      effective: null,
      issues: [issue],
      message: issue.message,
    });
    return true;
  }

  /** Evaluate from saved configuration (synchronous): delegation, resume, setup and previews. */
  evaluateProspective(
    agent: Agent,
    options: {
      task?: TaskTraits;
      contract?: ContractLike | null;
      host?: HostFacts;
      runtime?: (environment: string) => Readiness | undefined;
    } = {},
  ): ReadinessDecision {
    const roleClass = roleClassOf(this.service, agent);
    const failed = (issue: ReadinessIssue): ReadinessDecision => ({
      ready: false,
      agentId: agent.id,
      agentName: agent.name,
      ...(options.task?.id ? { taskId: options.task.id } : {}),
      basis: "grants",
      roleClass,
      required: requiredFor({
        contract:
          options.contract ??
          (options.task?.id
            ? this.service.contracts.effective(options.task as Task)
            : null),
        roleClass,
        tools: agent.tools,
        adapter:
          this.service.connection(agent.environment).transport === "acp"
            ? "acp"
            : (agent.environment as EffectiveCapabilities["adapter"]),
      }).required,
      effective: null,
      issues: [issue],
      message: issue.message,
    });
    if (options.task?.executionMode === "file-only") {
      const support = simpleTaskSupport(this.service, agent);
      if (!support.available)
        return failed({
          code: "adapter-unsupported",
          capability: null,
          agentId: agent.id,
          agentName: agent.name,
          ...(options.task?.id ? { taskId: options.task.id } : {}),
          message: `${agent.name}: ${support.reason}`,
          fix: {
            kind: "change-runtime",
            label: `Choose another agent for this assignment`,
            agentId: agent.id,
          },
        });
    }
    let plan: PlanFacts;
    try {
      // An agent with no folder at all has no task scope to check: the cause is "no folder".
      plan = this.prospectivePlan(
        agent,
        agent.workspaces.length
          ? options.task
          : { ...options.task, resourcePaths: undefined },
        options.contract,
      );
    } catch (error) {
      const issue = this.issueFromError(agent, error, options.task?.id);
      if (!issue) throw error;
      return failed(issue);
    }
    return this.evaluatePlan(agent, plan, options);
  }

  /**
   * One decision for an agent that takes part in several tasks: it is ready only when it is ready
   * for every one of them, with every distinct cause listed once.
   */
  mergeDecisions(
    agent: Agent,
    decisions: ReadinessDecision[],
  ): ReadinessDecision {
    const first = decisions[0];
    const seen = new Set<string>();
    const issues = decisions
      .flatMap((d) => d.issues)
      .filter((issue) => {
        const key = `${issue.code}:${issue.fix?.kind}:${issue.fix?.path ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const folderAccess = decisions
      .flatMap((d) => d.folderAccess ?? [])
      .filter(
        (answer, index, all) =>
          all.findIndex(
            (other) =>
              other.path === answer.path && other.write === answer.write,
          ) === index,
      );
    return {
      ...first,
      agentId: agent.id,
      agentName: agent.name,
      ready: issues.length === 0,
      required: uniq(decisions.flatMap((d) => d.required)),
      ...(folderAccess.length ? { folderAccess } : {}),
      issues,
      message: issues.length ? issues.map((i) => i.message).join(" ") : null,
    };
  }

  /** The host the provider processes run on, for the sandbox rule (the RunManager's platform). */
  host(): HostFacts {
    const platform = this.service.hostPlatform?.();
    return {
      ...(platform ? { platform } : {}),
      folderAccess: this.service.folderAccess.lookup,
    };
  }

  /** Runtime installation and sign-in as the app currently knows it (wired by the RunManager). */
  runtime = (environment: string) =>
    this.service.runtimeReadiness?.(environment);

  /** Persist the blocker and stop the task BEFORE it starts: no process, effect, lease, turn or attempt. */
  blockTask(task: Task, decision: ReadinessDecision) {
    const agent = this.store.get<Agent>("agent", task.agentId);
    const sandboxOnly =
      decision.issues.length > 0 &&
      decision.issues.every((issue) => issue.code === "sandbox-unavailable");
    // Only waiting for the system's answer to a folder question: not a refusal, and it resolves
    // by itself when the answer arrives (src/folder-access.ts).
    const pendingOnly =
      decision.issues.length > 0 &&
      decision.issues.every((issue) => issue.code === "folder-probe-pending");
    const message =
      decision.message ??
      `${agent.name} is missing a capability this work needs.`;
    // One transaction: the wait, the setup state, the event and the transition appear together.
    return this.store.transaction(() => {
      noteRuntimeWait(this.store, {
        kind: "task",
        targetId: task.id,
        environment: agent.environment,
        reason: sandboxOnly
          ? "sandbox-unavailable"
          : pendingOnly
            ? "folder-probe-pending"
            : "capability-missing",
        capability: sandboxOnly ? "sandboxed-shell" : "tools-and-folders",
        message,
        issues: decision.issues.slice(0, 6).map((issue) => ({
          ...issue,
          message: issue.message.slice(0, 600),
        })),
        attempt: this.service.recovery.state(task.id).attempt,
      });
      this.store.emit("task.setup_required", task.id, {
        agentId: agent.id,
        workflowId: task.workflowId,
        issues: decision.issues.map(
          ({ code, capability, message: m, fix }) => ({
            code,
            capability,
            message: m.slice(0, 300),
            fix,
          }),
        ),
      });
      this.service.setups.noteBlocked(task.workflowId, decision);
      return this.service.transitionTask(task.id, {
        status: "blocked",
        result: message.slice(0, 2000),
      });
    });
  }
  /** A launch-preparation error that is a setup cause blocks the task; anything else is retried next tick. */
  blockForLaunchError(task: Task, agent: Agent, error: unknown) {
    const issue = this.issueFromError(agent, error, task.id);
    if (!issue) return false;
    this.blockTask(task, {
      ready: false,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task.id,
      basis: "grants",
      roleClass: roleClassOf(this.service, agent),
      required: [],
      effective: null,
      issues: [issue],
      message: issue.message,
    });
    return true;
  }

  /**
   * The refusal for a delegation to a recipient that cannot do the work (invoke_teammate): the
   * setup state is recorded (once per worker) and the error names the repair. The caller throws it
   * before any task, invocation record or counter exists.
   */
  refusal(
    decision: ReadinessDecision,
    workflowId: string,
    context: "delegation" | "resume" = "delegation",
  ) {
    this.service.setups.noteBlocked(workflowId, decision);
    return new AppError(
      409,
      "capability_missing",
      context === "delegation"
        ? `${decision.message} Nothing was created and no teammate was started. Tell the user which setup step is missing; delegate this work again once it is done.`
        : `${decision.message} Nothing was started and no attempt was used; repeat the action once the setup is done.`,
    );
  }

  /**
   * Requeue blocked work whose setup is complete: capability waits whose requirements are now met
   * and work parked on an unverified required check that was since confirmed. Waits that still
   * fail stay put with their refreshed cause. Called from `ReadinessService.requeueReady` and the
   * project setup action, so a repair needs no separate retry.
   */
  requeueWaiting(only?: (task: Task) => boolean) {
    const requeued: string[] = [];
    for (const wait of this.store.list<RuntimeWait>("runtime-wait")) {
      if (
        wait.kind !== "task" ||
        (wait.reason !== "capability-missing" &&
          wait.reason !== "folder-probe-pending" &&
          wait.reason !== "check-unconfirmed")
      )
        continue;
      let task: Task | undefined;
      let agent: Agent | undefined;
      try {
        task = this.store.get<Task>("task", wait.targetId);
        agent = this.store.get<Agent>("agent", task.agentId);
      } catch {
        this.store.remove("runtime-wait", wait.id);
        continue;
      }
      if (
        task.status !== "blocked" ||
        this.service.recovery.state(task.id).attempt !== wait.attempt
      ) {
        this.store.remove("runtime-wait", wait.id);
        continue;
      }
      if (only && !only(task)) continue;
      if (wait.reason !== "check-unconfirmed") {
        const decision = this.evaluateProspective(agent, { task });
        if (!decision.ready) {
          // A question the system has answered since turns "waiting" into a plain refusal.
          const reason = decision.issues.every(
            (issue) => issue.code === "folder-probe-pending",
          )
            ? "folder-probe-pending"
            : "capability-missing";
          const refreshed = (decision.message ?? "").slice(0, 2000);
          if (
            (refreshed && refreshed !== wait.message) ||
            reason !== wait.reason
          )
            this.store.put("runtime-wait", {
              ...wait,
              reason,
              message: refreshed || wait.message,
              issues: decision.issues.slice(0, 6),
            });
          continue;
        }
      } else if (this.service.contracts.unresolved(task).length) continue;
      // The requeue refuses while the wait exists, so lift it first and restore it if the requeue
      // still fails: a blocked task never loses the explanation of why it is blocked.
      this.store.remove("runtime-wait", wait.id);
      try {
        this.service.recovery.requeue(task.id);
        this.store.emit("task.runtime_requeued", task.id, {
          agentId: task.agentId,
          environment: agent.environment,
          reason: wait.reason,
        });
        requeued.push(wait.id);
      } catch {
        // An uncertain effect, a pending approval or a changed setup keep it stopped (Recovery).
        this.store.put("runtime-wait", wait);
      }
    }
    this.service.setups.refreshOpen();
    return requeued;
  }

  /**
   * Who an agent can hand work to and whether each of them could do it: the data behind the chat
   * composer notice. Derived from the workers' own readiness, never from the planner's folders.
   */
  delegationReadiness(agentId: string) {
    const agent = this.store.get<Agent>("agent", agentId);
    const reachable = this.store
      .list<Agent>("agent")
      .filter(
        (other) =>
          other.id !== agent.id &&
          this.service.permitted(agent.id, other.id, "delegate"),
      );
    const workers = reachable.map((other) => {
      const decision = this.evaluateProspective(other, {
        runtime: this.runtime,
      });
      return {
        agentId: other.id,
        name: other.name,
        roleClass: decision.roleClass,
        ready: decision.ready,
        issues: decision.issues,
      };
    });
    const teamId = this.service.teamSpaces.teamOfAgent(agent);
    const profile = teamId ? teamProfile(this.store, teamId) : null;
    const hasProject =
      !!teamId &&
      this.service.teamSpaces
        .members(teamId)
        .workflows.some(
          (w) =>
            (w as { kind?: string }).kind !== "conversation" &&
            (w as { lifecycle?: { state?: string } }).lifecycle?.state !==
              "archived",
        );
    const blocked = workers.filter((worker) => !worker.ready);
    return {
      agentId: agent.id,
      workers,
      projectType: profile?.type ?? null,
      hasProject,
      notice:
        !reachable.length && !this.evaluateProspective(agent).ready
          ? {
              code: "agent-not-ready" as const,
              text: this.evaluateProspective(agent).message,
              action: this.evaluateProspective(agent).issues[0]?.fix ?? null,
            }
          : profile?.type === "pipeline" && !hasProject
            ? {
                code: "pipeline-needs-project" as const,
                text: "This team runs projects; chat does not start the pipeline.",
                action: {
                  kind: "choose-project-folder" as const,
                  label: "Assign a project",
                },
              }
            : blocked.length
              ? {
                  code: "workers-not-ready" as const,
                  text: `${blocked
                    .slice(0, 3)
                    .map((worker) => worker.name)
                    .join(
                      ", ",
                    )}${blocked.length > 3 ? ` and ${blocked.length - 3} more` : ""} cannot write or run code yet: ${blocked[0].issues[0]?.message ?? "setup is missing"}`,
                  action: blocked[0].issues[0]?.fix ?? {
                    kind: "choose-project-folder" as const,
                    label: "Choose project folder",
                  },
                }
              : null,
    };
  }
}
