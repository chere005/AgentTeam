import { randomUUID } from "node:crypto";
import type { TeamService } from "./service.ts";
import {
  assert,
  type Agent,
  type Message,
  type Task,
  type Workflow,
} from "./model.ts";
import { untrusted, UNTRUSTED_NOTICE } from "./shared-common.ts";
import { Redactor } from "./redact.ts";
import {
  invocationFailureCause,
  type DelegationBlocker,
} from "./invocation-view.ts";

const KIND = "delegation-wait";
const MAX_CONTINUATIONS = 3;
type DelegationWait = {
  id: string;
  attempt: number;
  state: "waiting" | "continuing";
  childIds: string[];
  result: string;
  cwd: string;
  sessionId?: string;
};

/** A provider turn can finish while its delegated work is still outstanding. The parent
 * waits without a process or lease, then gets a bounded continuation in the normal queue.
 * The saved provider output and each continuation retain separate effect-ledger keys. */
export class DelegatedWork {
  private service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  private record(id: string) {
    return this.store.list<DelegationWait>(KIND).find((r) => r.id === id);
  }
  children(task: Task) {
    return this.store
      .list<Task>("task")
      .filter(
        (child) =>
          child.parentTaskId === task.id &&
          child.workflowId === task.workflowId,
      );
  }
  pending(task: Task) {
    return this.children(task).filter(
      (child) =>
        !this.service.permitted(task.agentId, child.agentId, "delegate") ||
        !this.service.taskDependencySatisfied(child.id) ||
        !this.service.orchestration.gate(child).open,
    );
  }
  /** Report the actual failing leaf without making a waiting manager look like an execution failure. */
  private blockers(task: Task): DelegationBlocker[] {
    const found: DelegationBlocker[] = [];
    const visited = new Set<string>([task.id]);
    const redactor = new Redactor({ maxString: 500 });
    let scanned = 0;
    const add = (child: Task, reason: string) => {
      const agent = this.store.get<Agent>("agent", child.agentId);
      const clean = (value: string, max: number) =>
        redactor
          .string(value)
          .replace(/[\s\x00-\x1f]+/g, " ")
          .trim()
          .slice(0, max);
      found.push({
        taskId: child.id,
        title: clean(child.title, 160),
        agentId: child.agentId,
        agentName: clean(agent.nickname || agent.name, 100),
        status: this.service.taskOutcome(child),
        reason: clean(reason, 400),
      });
    };
    const visit = (parent: Task, depth: number) => {
      for (const child of this.pending(parent)) {
        if (found.length >= 8 || ++scanned > 128) return;
        if (
          !this.service.permitted(parent.agentId, child.agentId, "delegate")
        ) {
          // Do not expose descendant results across a revoked communication edge.
          add(
            child,
            "Delegation connection was revoked. Restore it before continuing.",
          );
          continue;
        }
        if (visited.has(child.id) || depth >= 8) {
          add(
            child,
            "Delegated work needs review: its task chain is cyclic or exceeds the status inspection limit.",
          );
          continue;
        }
        visited.add(child.id);
        const outcome = this.service.taskOutcome(child);
        const wait = this.record(child.id);
        if (
          child.status === "blocked" &&
          wait?.state === "waiting" &&
          !this.service.recovery.ledger.uncertainFor(child.id).length
        ) {
          if (
            (this.service.recovery.state(child.id).continuation ?? 0) >=
            MAX_CONTINUATIONS
          )
            add(
              child,
              "Automatic continuation limit reached. Review this task in Recovery.",
            );
          else visit(child, depth + 1);
          continue;
        }
        if (
          ["failed", "cancelled", "blocked", "interrupted"].includes(outcome)
        ) {
          const checks = this.service.limits.meta(child.id).checks;
          const cause =
            checks && !checks.passed
              ? this.service.limits.failedChecksText(checks)
              : this.service.recovery.state(child.id).interruptReason ||
                invocationFailureCause({
                  ...child,
                  result: redactor.string(child.result ?? ""),
                });
          add(child, cause);
        }
      }
    };
    visit(task, 0);
    return found;
  }
  view(id: string) {
    const record = this.record(id);
    if (!record) return undefined;
    const task = this.store.get<Task>("task", id);
    const pending = this.pending(task);
    const revoked = pending.some(
      (child) =>
        !this.service.permitted(task.agentId, child.agentId, "delegate"),
    );
    const blockers = this.blockers(task);
    const failed = revoked || blockers.length > 0;
    const capped =
      (this.service.recovery.state(id).continuation ?? 0) >= MAX_CONTINUATIONS;
    return {
      state:
        record.state === "continuing"
          ? ("continuing" as const)
          : failed || capped
            ? ("blocked" as const)
            : ("waiting" as const),
      childIds: pending.map((child) => child.id),
      blockers,
      message:
        record.state === "continuing"
          ? "Reviewing completed delegated work."
          : capped
            ? "Automatic continuation limit reached. Review the delegated work in Recovery."
            : revoked
              ? "Delegated work needs attention. Communication permission was revoked; restore the delegation connection before continuing."
              : failed
                ? "Delegated work needs attention. " +
                  blockers
                    .slice(0, 3)
                    .map((blocker) => `${blocker.agentName}: ${blocker.reason}`)
                    .join("; ") +
                  (blockers.length > 3
                    ? `; ${blockers.length - 3} more task blockers.`
                    : "")
                : "Waiting for delegated work and required reviews to finish.",
    };
  }
  /** Refresh artifact evidence immediately before a parent can use its children's results. */
  async verifyChildren(task: Task) {
    for (const child of this.children(task)) {
      if (child.status !== "completed" || !child.completionChecks?.length)
        continue;
      const agent = this.store.get<Agent>("agent", child.agentId);
      const cwd =
        this.service.limits.meta(child.id).checks?.cwd ??
        child.resourcePaths?.[0] ??
        agent.workspaces.find((w) => w.active)?.path ??
        agent.workspaces[0]?.path ??
        process.cwd();
      await this.service.limits.evaluate(child, child.result ?? "", cwd);
    }
  }
  defer(task: Task, result: string, cwd: string, sessionId?: string) {
    if (!this.pending(task).length) return false;
    this.store.transaction(() => {
      const previous = this.record(task.id);
      this.store.put(KIND, {
        id: task.id,
        attempt: this.service.recovery.state(task.id).attempt,
        state: "waiting",
        childIds: this.children(task).map((child) => child.id),
        result: result.slice(0, 100_000),
        cwd,
        ...(sessionId || previous?.sessionId
          ? { sessionId: sessionId ?? previous?.sessionId }
          : {}),
      } satisfies DelegationWait);
      this.service.transitionTask(task.id, {
        status: "blocked",
        result: result.slice(0, 100_000),
      });
      this.store.emit("task.delegation_wait", task.id, this.view(task.id));
    });
    return true;
  }
  assertCanQueue(task: Task) {
    const record = this.record(task.id);
    if (!record || record.state === "continuing") return;
    assert(
      !this.pending(task).length,
      "delegated_work_pending",
      "Resolve the delegated tasks and their required reviews before resuming the parent.",
    );
    assert(
      false,
      "delegation_resume_required",
      "Resume this parent through Recovery so its completed provider turn is not replayed.",
    );
  }
  markContinuing(id: string) {
    const record = this.record(id);
    assert(
      record,
      "delegation_wait_missing",
      "The parent has no saved delegated work to continue.",
    );
    this.store.put(KIND, { ...record, state: "continuing" });
  }
  async sweep() {
    for (const record of this.store.list<DelegationWait>(KIND)) {
      if (record.state !== "waiting") continue;
      const task = this.store.get<Task>("task", record.id);
      if (task.status !== "blocked") continue;
      if (this.store.get<Workflow>("workflow", task.workflowId).paused)
        continue;
      if (this.store.get<Agent>("agent", task.agentId).control !== "team")
        continue;
      if (this.service.recovery.state(task.id).attempt !== record.attempt)
        continue;
      if (
        (this.service.recovery.state(task.id).continuation ?? 0) >=
        MAX_CONTINUATIONS
      )
        continue;
      // Refresh previously failed artifact evidence after repair, once execution/reviews finish.
      if (
        this.children(task).some(
          (child) =>
            (child.status !== "completed" &&
              this.service.taskOutcome(child) !== "superseded") ||
            !this.service.orchestration.gate(child).open,
        )
      )
        continue;
      await this.verifyChildren(task);
      if (this.pending(task).length) continue;
      try {
        this.store.transaction(() => {
          this.service.recovery.continueDelegation(task.id);
          this.store.emit("task.delegation_ready", task.id);
        });
      } catch {
        // Recovery, human control, uncertain effects and limits keep the parent stopped.
      }
    }
  }
  continuationNote(task: Task) {
    const record = this.record(task.id);
    if (!record || record.state !== "continuing") return "";
    assert(
      !this.pending(task).length,
      "delegated_work_pending",
      "Delegated results are no longer available or their acceptance checks have not passed.",
    );
    return (
      "\n\nDelegated work has finished. This is a continuation of the same assignment. " +
      "Review the results below and produce the final deliverable. Do not repeat completed " +
      "delegations or claim success without passing the completion checks. " +
      UNTRUSTED_NOTICE +
      "\n" +
      untrusted(
        "delegated-results",
        { "parent-task": task.id },
        JSON.stringify(
          this.children(task).map((child) => ({
            taskId: child.id,
            title: child.title,
            status: this.service.taskOutcome(child),
            result: (child.result ?? "").slice(0, 10_000),
          })),
        ).slice(0, 50_000),
      )
    );
  }
  onTransition(task: Task) {
    const record = this.record(task.id);
    if (!record) return;
    const failedContinuation =
      task.status === "failed" && record.state === "continuing";
    if (
      !["completed", "cancelled"].includes(task.status) &&
      !failedContinuation
    )
      return;
    if (
      record.sessionId &&
      (task.status === "completed" || failedContinuation)
    ) {
      this.store.put<Message>("message", {
        id: randomUUID(),
        sessionId: record.sessionId,
        role: "assistant",
        text: failedContinuation
          ? "Delegated work needs attention.\n\n" +
            (task.result ?? "The final acceptance checks did not pass.")
          : (task.result ?? "Delegated work completed."),
        status: "delivered",
        createdAt: new Date().toISOString(),
      });
      this.store.emit(
        failedContinuation
          ? "session.delegation_failed"
          : "session.delegation_completed",
        record.sessionId,
        {
          taskId: task.id,
        },
      );
    }
    if (!failedContinuation) this.store.remove(KIND, task.id);
  }
}
