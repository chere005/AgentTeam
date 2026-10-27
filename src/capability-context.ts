// One side-effect-free, task-aware assembler of what a run can do (reliable-execution plan item 2).
// The same facts feed three outputs, so they cannot disagree:
//  (a) the generated line in the model's instructions ("Tools in this run: ... Reachable
//      teammates: ..."), appended by `TeamService.launchPlan` and shown by the instructions preview;
//  (b) the effective-instructions preview for an agent, optionally for a task;
//  (c) a redacted launch manifest recorded beside the `task.settings` event.
// Nothing here starts a process, writes an entity or reads a file; the manifest carries no token,
// environment variable, prompt or file content.
import type { Agent, Task } from "./model.ts";
import {
  effectiveCapabilities,
  capabilityScopeHash,
  type EffectiveCapabilities,
  type HostFacts,
  type PlanFacts,
} from "./launch-capability.ts";
import { contractHash } from "./execution-contract.ts";
import type { ReadinessDecision, ReadinessIssue } from "./launch-readiness.ts";
import type { TeamService } from "./service.ts";

/** A short, plain reason a teammate cannot do file or shell work yet. */
function shortReason(issue: ReadinessIssue) {
  switch (issue.code) {
    case "no-folder":
      return "no folder attached";
    case "no-active-folder":
      return "no active folder";
    case "folder-read-only":
      return "its folder is read-only";
    case "grant-missing":
      return "tool not granted";
    case "adapter-unsupported":
      return "its runtime has no file or shell tools";
    case "shell-withheld":
      return "shell withheld in this assignment";
    case "sandbox-unavailable":
      return "required sandbox unavailable";
    case "folder-restricted":
      return "folder uses access rules the provider cannot enforce";
    default:
      return issue.code.replace(/-/g, " ");
  }
}

export type TeammateView = {
  agentId: string;
  name: string;
  ready: boolean;
  /** Why it cannot do file or shell work yet (absent when it can). */
  reason: string | null;
};

export type CapabilityContext = {
  effective: EffectiveCapabilities;
  teammates: TeammateView[];
  /** The generated instruction line. */
  line: string;
};

/** Teammates the agent can delegate to and whether each could do work that writes or runs code. */
export function reachableTeammates(
  service: TeamService,
  agent: Agent,
): TeammateView[] {
  return service.store
    .list<Agent>("agent")
    .filter(
      (other) =>
        other.id !== agent.id &&
        other.kind !== "team-assistant" &&
        service.permitted(agent.id, other.id, "delegate"),
    )
    .map((other) => {
      const decision = service.launchReadiness.evaluateProspective(other);
      return {
        agentId: other.id,
        name: other.name,
        ready: decision.ready,
        reason: decision.issues[0] ? shortReason(decision.issues[0]) : null,
      };
    });
}

/**
 * Assemble the capability context of one launch from its plan facts (the real `LaunchPlan`, or a
 * prospective plan for a preview). Leaf workers are told "Reachable teammates: none": they are
 * never told they can delegate when they cannot.
 */
export function capabilityContext(
  service: TeamService,
  agent: Agent,
  plan: PlanFacts,
  host: HostFacts = service.launchReadiness.host(),
  taskId?: string,
): CapabilityContext {
  const effective = effectiveCapabilities(plan, host);
  const teammates = service.executionProjects.isReview(taskId)
    ? []
    : reachableTeammates(service, agent);
  const tools = effective.toolNames.length
    ? effective.toolNames.join(", ")
    : `none (${effective.gaps.read?.message ?? "no file tools are exposed"})`;
  const folders = effective.folders.length
    ? effective.folders.map((f) => `${f.path} (${f.access})`).join("; ")
    : "none";
  const shell = effective.available.shell
    ? "yes (sandboxed)"
    : `no (${effective.gaps.shell?.message ?? "not available"})`;
  const mates = teammates.length
    ? teammates
        .map((t) => (t.ready ? t.name : `${t.name} (not ready: ${t.reason})`))
        .join(", ")
    : "none";
  return {
    effective,
    teammates,
    line: `Tools in this run: ${tools}. Folders: ${folders}. Shell: ${shell}. Reachable teammates: ${mates}.`,
  };
}

/** The redacted record of what a launch was given (names and paths, never secrets or content). */
export function launchManifest(
  service: TeamService,
  input: {
    agent: Agent;
    task: Pick<Task, "id" | "parentTaskId" | "workflowId" | "executionMode">;
    plan: PlanFacts;
    decision: ReadinessDecision;
    host?: HostFacts;
    adapterVersion?: string | null;
    teammateTools: boolean;
  },
) {
  const effective = effectiveCapabilities(
    input.plan,
    input.host ?? service.launchReadiness.host(),
  );
  const contract = service.contracts.effective(input.task);
  return {
    version: 1 as const,
    scopeHash: capabilityScopeHash(
      input.plan,
      input.host ?? service.launchReadiness.host(),
    ),
    taskId: input.task.id,
    agentId: input.agent.id,
    adapter: {
      id: effective.adapter,
      transport: effective.transport,
      environment: input.agent.environment,
      version: input.adapterVersion ?? null,
    },
    model: input.agent.model,
    effort: input.agent.effort,
    executionMode: input.task.executionMode ?? "standard",
    taskRoot: effective.taskRoot,
    allowedRoots: effective.folders,
    toolNames: [
      ...effective.toolNames,
      ...(input.teammateTools
        ? [
            ...(!service.executionProjects.isReview(input.task.id) &&
            reachableTeammates(service, input.agent).length
              ? ["mcp__agentteam__invoke_teammate"]
              : []),
            "mcp__agentteam__teammate_result",
          ]
        : []),
    ],
    sandbox: effective.sandbox,
    readiness: {
      ready: input.decision.ready,
      basis: input.decision.basis,
      required: input.decision.required,
      issues: input.decision.issues.map(({ code, capability }) => ({
        code,
        capability,
      })),
    },
    contract: contract
      ? {
          id: contract.id,
          workKind: contract.workKind,
          hash: contractHash(contract),
        }
      : null,
  };
}
export type LaunchManifest = ReturnType<typeof launchManifest>;
