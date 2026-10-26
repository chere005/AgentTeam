/**
 * Explains an agent's max-concurrency limit: which running children currently occupy it and why
 * further invocations wait. Mirrors TeamService.capacity()/taskState(): only tasks invoked by the
 * agent count, and a queued task reports "invocation-limit" while the limit is full.
 */
export type DelegationBlocker = {
  taskId: string;
  title: string;
  agentId: string;
  agentName: string;
  status: string;
  /** Bounded diagnostic task data; it is never an instruction to an agent. */
  reason: string;
};
export type InvocationTask = {
  id: string;
  title: string;
  agentId: string;
  invokedBy?: string;
  parentTaskId?: string;
  dependsOn?: string[];
  result?: string;
  delegation?: {
    state: "waiting" | "blocked" | "continuing";
    childIds: string[];
    message: string;
    blockers?: DelegationBlocker[];
  };
  runtimeBlocker?: { code: string; message: string };
  dependencyBlockers?: {
    taskId: string;
    title: string;
    agentId: string;
    agentName: string;
    status: string;
    reason: string;
  }[];
  status: string;
};
export type InvocationBlocker = {
  id: string;
  title: string;
  agentName: string;
  status: string;
  cause: string;
};
const failedStatuses = new Set([
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
]);
export function sandboxUnavailable(result: string | undefined): boolean {
  return /sandbox[-_ ]unavailable|sandbox (?:is )?required but unavailable|sandbox required[^\n]{0,80}unavailable/i.test(
    result ?? "",
  );
}
/** Render the cause without repeating a provider's suggestion to remove sandbox enforcement. */
export function invocationFailureCause(task: InvocationTask): string {
  if (task.runtimeBlocker?.code === "sandbox_unavailable")
    return "sandbox unavailable";
  if (sandboxUnavailable(task.result)) return "sandbox unavailable";
  if (task.delegation?.state === "blocked") return task.delegation.message;
  if (task.runtimeBlocker?.message) return task.runtimeBlocker.message;
  return (task.result?.split("\n").find((line) => line.trim()) ?? task.status)
    .replace(/\s+/g, " ")
    .slice(0, 240);
}
/** Includes the original failed prerequisite when intermediate queued dependencies also wait. */
export function failedInvocationDependencies(
  task: InvocationTask,
  tasks: InvocationTask[],
  agentNames: Record<string, string>,
): InvocationBlocker[] {
  const reportedFailures = task.dependencyBlockers?.filter((blocker) =>
    failedStatuses.has(blocker.status),
  );
  if (reportedFailures?.length)
    return reportedFailures.map((blocker) => ({
      id: blocker.taskId,
      title: blocker.title,
      agentName: blocker.agentName,
      status: blocker.status,
      cause: sandboxUnavailable(blocker.reason)
        ? "sandbox unavailable"
        : blocker.reason,
    }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>([task.id]);
  const blockers: InvocationBlocker[] = [];
  const visit = (ids: string[]) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const dependency = byId.get(id);
      if (!dependency || dependency.status === "completed") continue;
      if (failedStatuses.has(dependency.status))
        blockers.push({
          id,
          title: dependency.title,
          agentName: agentNames[dependency.agentId] ?? dependency.agentId,
          status: dependency.status,
          cause: invocationFailureCause(dependency),
        });
      else visit(dependency.dependsOn ?? []);
    }
  };
  visit(task.dependsOn ?? []);
  return blockers;
}
export function invocationTaskState(
  task: InvocationTask,
  tasks: InvocationTask[],
  agentNames: Record<string, string>,
): { status: string; label: string; detail: string | null; recovery: boolean } {
  if (task.delegation && task.delegation.state !== "continuing")
    return {
      status: "blocked",
      label:
        task.delegation.state === "blocked"
          ? "Needs attention"
          : "Waiting for delegated work",
      detail: task.delegation.message,
      recovery: task.delegation.state === "blocked",
    };
  const children = tasks.filter((child) => child.parentTaskId === task.id);
  const pending = children.filter((child) => child.status !== "completed");
  if (["blocked", "completed"].includes(task.status) && pending.length) {
    const failed = pending.filter((child) => failedStatuses.has(child.status));
    return {
      status: "blocked",
      label: failed.length ? "Needs attention" : "Waiting for delegated work",
      detail: failed.length
        ? failed
            .map(
              (child) =>
                `${agentNames[child.agentId] ?? child.agentId}: ${invocationFailureCause(child)}`,
            )
            .join("; ")
        : `${pending.length} required assignment${pending.length === 1 ? " is" : "s are"} still unfinished.`,
      recovery: failed.length > 0,
    };
  }
  const blockers =
    task.status === "queued"
      ? failedInvocationDependencies(task, tasks, agentNames)
      : [];
  if (blockers.length)
    return {
      status: "blocked",
      label: "Blocked by failed prerequisite",
      detail: blockers
        .map((b) => `${b.agentName} · ${b.title}: ${b.cause}`)
        .join("; "),
      recovery: true,
    };
  if (
    ["failed", "blocked"].includes(task.status) &&
    (task.runtimeBlocker?.code === "sandbox_unavailable" ||
      sandboxUnavailable(task.result))
  )
    return {
      status: "blocked",
      label: "Blocked: sandbox unavailable",
      detail:
        task.runtimeBlocker?.message ??
        "The required sandbox is unavailable. Choose a runtime with supported sandboxing (on Windows, a configured WSL2 runtime), or remove an unnecessary shell grant for file-only work. Retry after fixing the configuration.",
      recovery: true,
    };
  return {
    status: task.status,
    label: task.status,
    detail: null,
    recovery: ["failed", "interrupted", "blocked"].includes(task.status),
  };
}
export type InvocationSummary = {
  limit: number | null;
  running: { id: string; title: string; agentName: string }[];
  waiting: {
    id: string;
    title: string;
    agentName: string;
    reason: string;
    detail?: string;
  }[];
  full: boolean;
  explanation: string;
};
export const waitReasonText: Record<string, string> = {
  "invocation-limit":
    "the invoking agent is at its concurrent invocation limit",
  dependencies: "it depends on unfinished tasks",
  "dependency-failed": "a prerequisite failed and needs recovery",
  "delegation-pending": "required delegated work is unfinished",
  "sandbox-unavailable": "the required sandbox is unavailable",
  "resource-busy": "shared files or folders are in use",
  "human-control": "the agent is under human control",
  "workflow-paused": "its workflow is paused",
  "validation-required": "a required validation has not passed",
  "review-required": "a required review has not been approved",
};
export function invocationSummary(
  agentId: string,
  limit: number | null,
  tasks: InvocationTask[],
  agentNames: Record<string, string>,
  waitReasons: Record<string, string | null> = {},
): InvocationSummary {
  const mine = tasks.filter((t) => t.invokedBy === agentId);
  const name = (t: InvocationTask) => agentNames[t.agentId] ?? t.agentId;
  const running = mine
    .filter((t) => t.status === "running")
    .map((t) => ({ id: t.id, title: t.title, agentName: name(t) }));
  const full = limit !== null && running.length >= limit;
  const waiting = mine
    .filter((t) => t.status === "queued")
    .map((t) => {
      const blockers = failedInvocationDependencies(t, tasks, agentNames);
      return {
        id: t.id,
        title: t.title,
        agentName: name(t),
        reason: blockers.length
          ? "dependency-failed"
          : (waitReasons[t.id] ?? (full ? "invocation-limit" : "scheduling")),
        ...(blockers.length
          ? {
              detail: blockers
                .map((b) => `${b.agentName} · ${b.title}: ${b.cause}`)
                .join("; "),
            }
          : {}),
      };
    });
  const explanation =
    limit === null
      ? `No limit: all ${running.length} running children run in parallel.`
      : full
        ? waiting.length
          ? `${running.length} of ${limit} slots are in use by the running children below, so ${waiting.length} more invocation${waiting.length === 1 ? " waits" : "s wait"} until one finishes.`
          : `${running.length} of ${limit} slots are in use; the next invocation will wait until one finishes.`
        : `${running.length} of ${limit} slots in use.`;
  return { limit, running, waiting, full, explanation };
}
