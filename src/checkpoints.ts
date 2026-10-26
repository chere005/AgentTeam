import { createHash } from "node:crypto";
import { z } from "zod";
import type { TeamService } from "./service.ts";
import { errorKindOf } from "./provider-errors.ts";
import { assert, type Agent, type Message, type Task } from "./model.ts";
import type { ApprovalRecord } from "./approvals.ts";
import { isCapabilityWait, type RuntimeWait } from "./runtime-waits.ts";
import type { RecoveryDecision } from "./recovery-decision.ts";

/**
 * Engine-agnostic durable execution: immutable checkpoints, an effect ledger and recovery.
 * See docs/durable-execution.md. Nothing here depends on XState or LangGraph; either could drive
 * transitions on top, because all durable facts live in three plain entities:
 *  - `checkpoint`   append-only (SQLite triggers forbid update/delete) boundary snapshots
 *  - `effect`       idempotency-keyed ledger of external effects (attempted/completed/uncertain/failed)
 *  - `task-recovery` mutable per-task cursor: attempt number, provider session, retry policy
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cap = (s: string | undefined, n = 100_000) => (s ?? "").slice(0, n);
const MUTATING_TOOL_KINDS = new Set(["edit", "delete", "move", "execute"]);
const MAX_TOOL_CHECKPOINTS = 300;
/** Provider failures that prove the provider refused before acting, so no effect can have happened. */
const PRE_EFFECT_KINDS = new Set([
  "authentication",
  "quota",
  "model-unavailable",
]);

export const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(50).default(5),
    backoffMs: z.number().int().min(0).max(3_600_000).default(5000),
    backoffFactor: z.number().min(1).max(10).default(2),
    maxBackoffMs: z.number().int().min(0).max(86_400_000).default(300_000),
    /** Failed tasks requeue themselves after the backoff (never when an effect is uncertain). */
    auto: z.boolean().default(false),
  })
  .strict();
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export const DEFAULT_RETRY_POLICY: RetryPolicy = retryPolicySchema.parse({});
/** Delay before retry number `failures` (1-based): exponential, never above `maxBackoffMs`. */
export function backoffDelay(policy: RetryPolicy, failures: number) {
  const raw =
    policy.backoffMs * policy.backoffFactor ** Math.max(0, failures - 1);
  return Math.min(policy.maxBackoffMs, Math.round(raw));
}

export type Boundary =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.interrupted"
  | "task.blocked"
  | "task.requeued"
  | "provider.session"
  | "tool"
  | "approval.requested"
  | "approval.resolved"
  | "effect";
export type Checkpoint = {
  id: string;
  taskId: string;
  workflowId: string;
  seq: number;
  attempt: number;
  boundary: Boundary;
  nextStep: string;
  data: Record<string, unknown>;
  createdAt: string;
};
export type EffectState = "attempted" | "completed" | "uncertain" | "failed";
export type Effect = {
  id: string;
  taskId: string;
  /** Idempotency key: the same key never executes its mutation twice without a decision. */
  key: string;
  kind: string;
  description: string;
  mutating: boolean;
  state: EffectState;
  attempts: number;
  result?: string;
  error?: string;
  ref?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  history: { at: string; state: EffectState; note: string }[];
  decision?: { decision: string; note: string; at: string };
};
export type TaskRecovery = {
  id: string;
  attempt: number;
  resumes: number;
  providerSessionId: string | null;
  /** Session id the next provider run should resume (set by an explicit resume/retry). */
  useSession: string | null;
  resume?: { fromCheckpointId: string | null; sessionId: string | null };
  policy: RetryPolicy;
  notBefore: string | null;
  interruptReason?: string;
  toolCheckpoints: number;
  /** Separate provider effect keys for bounded continuations after delegated work. */
  continuation?: number;
};
const decisionSchema = z
  .object({
    decision: z.enum(["retry", "completed", "abandon"]),
    note: z.string().max(2000).default(""),
    result: z.string().max(100_000).optional(),
  })
  .strict();

export class EffectLedger {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  private id(key: string) {
    return "e-" + sha(key).slice(0, 32);
  }
  find(key: string): Effect | undefined {
    try {
      return this.store.get<Effect>("effect", this.id(key));
    } catch {
      return undefined;
    }
  }
  list(taskId?: string): Effect[] {
    const all = this.store.list<Effect>("effect");
    return taskId ? all.filter((e) => e.taskId === taskId) : all;
  }
  private save(effect: Effect, state: EffectState, note: string) {
    effect.state = state;
    effect.updatedAt = new Date().toISOString();
    effect.history.push({ at: effect.updatedAt, state, note });
    this.store.put("effect", effect);
    this.store.emit("effect.recorded", effect.taskId, {
      effectId: effect.id,
      key: effect.key,
      state,
    });
    return effect;
  }
  /**
   * Starts an effect. `replay` returns the recorded outcome of an already completed effect so the
   * caller skips it; an in-flight or uncertain effect refuses; a failed one (known not applied, or
   * the user decided to retry) may run again.
   */
  begin(input: {
    taskId: string;
    key: string;
    kind: string;
    description: string;
    mutating: boolean;
    ref?: Record<string, string>;
  }): { effect: Effect; action: "run" | "replay" } {
    return this.store.transaction(() => {
      const existing = this.find(input.key);
      if (!existing) {
        const now = new Date().toISOString();
        const effect = this.save(
          {
            id: this.id(input.key),
            taskId: input.taskId,
            key: input.key,
            kind: input.kind,
            description: input.description,
            mutating: input.mutating,
            state: "attempted",
            attempts: 1,
            ref: input.ref,
            createdAt: now,
            updatedAt: now,
            history: [],
          },
          "attempted",
          "attempt 1",
        );
        return { effect, action: "run" as const };
      }
      if (existing.state === "completed")
        return { effect: existing, action: "replay" as const };
      assert(
        existing.state !== "uncertain",
        "effect_uncertain",
        `Outcome of "${existing.description}" is uncertain; decide whether it was applied before retrying`,
      );
      assert(
        existing.state !== "attempted",
        "effect_in_flight",
        `"${existing.description}" is already in progress`,
      );
      existing.attempts++;
      return {
        effect: this.save(
          existing,
          "attempted",
          `attempt ${existing.attempts}`,
        ),
        action: "run" as const,
      };
    });
  }
  complete(id: string, result?: string) {
    return this.store.transaction(() => {
      const e = this.store.get<Effect>("effect", id);
      if (e.state === "completed") return e;
      if (result !== undefined) e.result = cap(result);
      return this.save(e, "completed", "completed");
    });
  }
  /** Known not applied (e.g. refused before acting): safe to run again. */
  fail(id: string, error: string) {
    return this.store.transaction(() => {
      const e = this.store.get<Effect>("effect", id);
      if (e.state === "completed") return e;
      e.error = cap(error, 2000);
      return this.save(e, "failed", cap(error, 200));
    });
  }
  /** Outcome unknown (crash, kill, error after the mutation could have started). */
  markUncertain(id: string, reason: string) {
    return this.store.transaction(() => {
      const e = this.store.get<Effect>("effect", id);
      if (e.state === "completed" || e.state === "failed") return e;
      e.error = cap(reason, 2000);
      return this.save(e, "uncertain", cap(reason, 200));
    });
  }
  /** Startup: effects still `attempted` lost their process. Mutations become uncertain, others retryable. */
  settleInterrupted() {
    return this.store.transaction(() => {
      let uncertain = 0;
      for (const e of this.list())
        if (e.state === "attempted") {
          if (e.mutating) {
            this.markUncertain(
              e.id,
              "Backend restarted while the effect was in flight",
            );
            uncertain++;
          } else
            this.fail(e.id, "Interrupted by restart; effect is not a mutation");
        }
      return uncertain;
    });
  }
  uncertainFor(taskId: string) {
    return this.list(taskId).filter((e) => e.state === "uncertain");
  }
  /** Explicit user decision about an uncertain effect. */
  decide(effectId: string, input: unknown) {
    const data = decisionSchema.parse(input);
    const effect = this.store.get<Effect>("effect", effectId);
    assert(
      effect.state === "uncertain",
      "effect_not_uncertain",
      "Only uncertain effects need a decision",
    );
    if (data.decision === "completed" && effect.kind === "provider-run")
      assert(
        data.result?.trim(),
        "result_required",
        "Provide the result the provider run produced",
        400,
      );
    const out = this.store.transaction(() => {
      const e = this.store.get<Effect>("effect", effectId);
      e.decision = {
        decision: data.decision,
        note: data.note,
        at: new Date().toISOString(),
      };
      if (data.decision === "completed") {
        if (data.result) e.result = cap(data.result);
        this.save(
          e,
          "completed",
          "user: applied" + (data.note ? " - " + data.note : ""),
        );
      } else
        this.save(
          e,
          "failed",
          data.decision === "retry"
            ? "user: not applied, retry allowed"
            : "user: abandoned",
        );
      if (
        data.decision === "retry" &&
        e.kind === "chat-run" &&
        e.ref?.messageId
      )
        this.requeueMessage(e.ref.messageId);
      this.store.emit("effect.decided", e.taskId, {
        effectId,
        decision: data.decision,
      });
      return e;
    });
    this.service.recovery.afterDecision(out, data.decision);
    return out;
  }
  private requeueMessage(messageId: string) {
    const message = this.store.get<Message>("message", messageId);
    if (message.status !== "failed") return;
    const session = this.store.get<{ id: string; agentId: string }>(
      "session",
      message.sessionId,
    );
    message.status = "queued";
    this.store.put("message", message);
    this.store.put("run-request", {
      id: session.id,
      agentId: session.agentId,
      queuedAt: new Date().toISOString(),
    });
    this.store.emit("session.run_queued", session.id, {
      agentId: session.agentId,
    });
  }
}

export class RecoveryService {
  service: TeamService;
  ledger: EffectLedger;
  constructor(service: TeamService) {
    this.service = service;
    this.ledger = new EffectLedger(service);
    // Checkpoints are immutable evidence, like validation records.
    this.store.db.exec(`
      CREATE TRIGGER IF NOT EXISTS checkpoint_no_update BEFORE UPDATE ON entities
        WHEN OLD.kind='checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoints are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS checkpoint_no_delete BEFORE DELETE ON entities
        WHEN OLD.kind='checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoints are immutable'); END;
      CREATE INDEX IF NOT EXISTS checkpoint_task ON entities(json_extract(data,'$.taskId')) WHERE kind='checkpoint';`);
    service.approvals.observer = (kind, approval) =>
      this.onApproval(kind, approval);
  }
  private get store() {
    return this.service.store;
  }
  // ---- per-task cursor -------------------------------------------------------------------
  state(taskId: string): TaskRecovery {
    try {
      return this.store.get<TaskRecovery>("task-recovery", taskId);
    } catch {
      return {
        id: taskId,
        attempt: 1,
        resumes: 0,
        providerSessionId: null,
        useSession: null,
        policy: { ...DEFAULT_RETRY_POLICY },
        notBefore: null,
        toolCheckpoints: 0,
      };
    }
  }
  private saveState(state: TaskRecovery) {
    this.store.put("task-recovery", state);
  }
  setPolicy(taskId: string, input: unknown) {
    const task = this.store.get<Task>("task", taskId);
    const policy = retryPolicySchema.parse(input);
    return this.store.transaction(() => {
      const state = this.state(task.id);
      state.policy = policy;
      this.saveState(state);
      this.store.emit("task.retry_policy", task.id, { agentId: task.agentId });
      return state;
    });
  }
  // ---- checkpoints -----------------------------------------------------------------------
  checkpoints(taskId: string): Checkpoint[] {
    return this.store.db
      .prepare(
        "SELECT data FROM entities WHERE kind='checkpoint' AND json_extract(data,'$.taskId')=? ORDER BY rowid",
      )
      .all(taskId)
      .map((r) => JSON.parse(String(r.data)));
  }
  latest(taskId: string): Checkpoint | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM entities WHERE kind='checkpoint' AND json_extract(data,'$.taskId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(taskId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  checkpoint(
    task: Task,
    boundary: Boundary,
    nextStep: string,
    data: Record<string, unknown> = {},
  ): Checkpoint {
    const row = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM entities WHERE kind='checkpoint' AND json_extract(data,'$.taskId')=?",
      )
      .get(task.id);
    const seq = Number(row?.n ?? 0) + 1;
    const cp: Checkpoint = {
      id: `${task.id}:${seq}`,
      taskId: task.id,
      workflowId: task.workflowId,
      seq,
      attempt: this.state(task.id).attempt,
      boundary,
      nextStep,
      // Shared workflow state versions at this boundary: lets recovery restore state (src/shared-state.ts).
      data: { ...data, state: this.service.shared.snapshot(task.workflowId) },
      createdAt: new Date().toISOString(),
    };
    this.store.put("checkpoint", cp);
    this.store.emit("checkpoint.saved", task.id, {
      checkpointId: cp.id,
      boundary,
    });
    return cp;
  }
  private dependencies(task: Task) {
    return task.dependsOn.map((id) => {
      const d = this.store.get<Task>("task", id);
      return { id, status: d.status, resultHash: sha(d.result ?? "") };
    });
  }
  // ---- transitions (called by TeamService.transitionTask) ---------------------------------
  /** Runs before a transition; throws when recovery policy forbids it. */
  beforeTransition(task: Task, to: Task["status"]) {
    if (to === "running") this.assertNoUncertain(task);
    if (to !== "queued") return;
    this.assertNoUncertain(task);
    const runtimeBlocker = this.runtimeBlocker(task);
    assert(
      !runtimeBlocker,
      "runtime_capability_blocked",
      runtimeBlocker?.message ??
        "The required sandbox is still unavailable. Fix the setup before resuming; this task resumes automatically when it is ready.",
    );
    if (task.status === "failed") {
      const s = this.state(task.id);
      assert(
        s.attempt < s.policy.maxAttempts,
        "retry_exhausted",
        `Attempt limit reached (${s.attempt}/${s.policy.maxAttempts}); raise the task's retry policy to try again`,
      );
    }
    if (task.status === "interrupted" || task.status === "blocked")
      assert(
        !this.service.approvals.pendingFor(task.id).length,
        "approval_pending",
        "Answer the pending approval before resuming this task",
      );
  }
  private assertNoUncertain(task: Task) {
    const u = this.ledger.uncertainFor(task.id);
    assert(
      !u.length,
      "effect_uncertain",
      `Outcome of "${u[0]?.description}" is uncertain; record a decision before this task can run again`,
    );
  }
  private runtimeBlocker(task: Task) {
    if (task.status !== "blocked") return undefined;
    return this.store
      .list<RuntimeWait>("runtime-wait")
      .find(
        (wait) =>
          wait.kind === "task" &&
          wait.targetId === task.id &&
          isCapabilityWait(wait) &&
          wait.attempt === this.state(task.id).attempt,
      );
  }
  /** Runs inside the transition's transaction, after the task row changed. */
  onTransition(task: Task, from: Task["status"]) {
    const s = this.state(task.id);
    const base = { from };
    switch (task.status) {
      case "running": {
        s.useSession = s.resume?.sessionId ?? null;
        const resumed = s.resume ?? null;
        if (resumed) s.resumes++;
        s.resume = undefined;
        s.toolCheckpoints = 0;
        s.notBefore = null;
        delete s.interruptReason;
        this.saveState(s);
        this.checkpoint(
          task,
          "task.started",
          "Provider executes this attempt",
          {
            ...base,
            resumedFrom: resumed,
            dependencies: this.dependencies(task),
            lease:
              this.store
                .list<{ id: string; paths: string[] }>("lease")
                .find((l) => l.id === task.id)?.paths ?? null,
          },
        );
        return;
      }
      case "completed":
      case "failed":
      case "cancelled": {
        if (task.status !== "failed") this.service.approvals.expireFor(task.id);
        if (task.status === "failed") {
          s.notBefore = new Date(
            Date.now() + backoffDelay(s.policy, s.attempt),
          ).toISOString();
        }
        s.useSession = null;
        this.saveState(s);
        this.checkpoint(
          task,
          `task.${task.status}` as Boundary,
          task.status === "failed"
            ? this.retryGate(task).reason
            : "Nothing further runs for this task",
          {
            ...base,
            resultHash: sha(task.result ?? ""),
            result: cap(task.result),
          },
        );
        return;
      }
      case "interrupted":
      case "blocked": {
        const d = this.describe(task);
        this.checkpoint(
          task,
          `task.${task.status}` as Boundary,
          d.next[0] ?? "",
          {
            ...base,
            reason: s.interruptReason ?? null,
            next: d.next,
            completedEffects: d.completed,
            pendingApprovals: d.pendingApprovals.map((a) => a.id),
            uncertainEffects: d.uncertainEffects.map((e) => e.id),
            providerSessionId: s.providerSessionId,
            dependencies: this.dependencies(task),
          },
        );
        return;
      }
      case "queued": {
        if (from === "failed") {
          s.attempt++;
          s.continuation = 0;
          s.toolCheckpoints = 0;
        }
        this.saveState(s);
        this.checkpoint(
          task,
          "task.requeued",
          this.describe(task).next[0] ?? "",
          {
            ...base,
            attempt: s.attempt,
            resume: s.resume ?? null,
          },
        );
      }
    }
  }
  // ---- provider run boundaries (used by the scheduler) ------------------------------------
  /** The ledger key of a provider run; `at` names the state an action will execute (default: now). */
  private runKey(task: Task, at?: { attempt: number; continuation?: number }) {
    const s = this.state(task.id);
    const attempt = at?.attempt ?? s.attempt;
    const continuation = at ? at.continuation : s.continuation;
    return (
      `provider-run:${task.id}:${attempt}` +
      (continuation ? `:continuation:${continuation}` : "")
    );
  }
  /**
   * True when startRun would replay the recorded provider output instead of running it. Judge the
   * state the action will execute (`at`): a retry of a failed task is the next attempt, a
   * delegation continuation the next continuation of the same attempt.
   */
  willReplayRun(task: Task, at?: { attempt: number; continuation?: number }) {
    return this.ledger.find(this.runKey(task, at))?.state === "completed";
  }
  startRun(task: Task, mutating: boolean) {
    const s = this.state(task.id);
    const { effect, action } = this.ledger.begin({
      taskId: task.id,
      key: this.runKey(task),
      kind: "provider-run",
      description: `Provider run for "${task.title}" (attempt ${s.attempt})`,
      mutating,
    });
    return {
      effectId: effect.id,
      replay: action === "replay" ? (effect.result ?? "") : null,
      sessionId: s.useSession,
    };
  }
  finishRun(task: Task, effectId: string, result: string) {
    this.ledger.complete(effectId, result);
    const s = this.state(task.id);
    s.useSession = null;
    this.saveState(s);
    this.checkpoint(
      task,
      "effect",
      "Provider output saved; completion checks and transition run next",
      { effectId, kind: "provider-run", resultHash: sha(result) },
    );
  }
  /** A mutating effect that failed after it may have started is uncertain; a refusal is not. */
  failEffect(effectId: string, error: unknown) {
    const kind = errorKindOf(error);
    const message = error instanceof Error ? error.message : "Execution failed";
    const effect = this.store.get<Effect>("effect", effectId);
    if (effect.mutating && !(kind && PRE_EFFECT_KINDS.has(kind)))
      this.ledger.markUncertain(effectId, message);
    else this.ledger.fail(effectId, message);
  }
  failRun(task: Task, effectId: string, error: unknown) {
    this.failEffect(effectId, error);
    const s = this.state(task.id);
    s.useSession = null;
    this.saveState(s);
  }
  /** Records provider session ids and tool boundaries; mutating tool calls enter the ledger. */
  observe(task: Task, event: { type: string; data: unknown }) {
    const s = this.state(task.id);
    if (event.type === "session") {
      const id = String(event.data);
      if (s.providerSessionId !== id) {
        s.providerSessionId = id;
        this.saveState(s);
        this.checkpoint(task, "provider.session", "Provider continues", {
          providerSessionId: id,
        });
      }
      return;
    }
    if (event.type !== "tool") return;
    const u = (event.data ?? {}) as Record<string, unknown>;
    const callId = typeof u.toolCallId === "string" ? u.toolCallId : null;
    const kind = typeof u.kind === "string" ? u.kind : "other";
    const status = typeof u.status === "string" ? u.status : "pending";
    const title = typeof u.title === "string" ? u.title : kind;
    if (callId && MUTATING_TOOL_KINDS.has(kind)) {
      const key =
        `tool:${task.id}:${s.attempt}:` +
        (s.continuation ? `continuation:${s.continuation}:` : "") +
        callId;
      let effect = this.ledger.find(key);
      if (!effect)
        effect = this.ledger.begin({
          taskId: task.id,
          key,
          kind: "tool:" + kind,
          description: cap(title, 200),
          mutating: true,
        }).effect;
      if (status === "completed") this.ledger.complete(effect.id);
      else if (status === "failed")
        this.ledger.fail(effect.id, "tool reported failure");
    }
    const terminal = status === "completed" || status === "failed";
    if (terminal && s.toolCheckpoints < MAX_TOOL_CHECKPOINTS) {
      s.toolCheckpoints++;
      this.saveState(s);
      this.checkpoint(task, "tool", "Provider continues", {
        toolCallId: callId,
        kind,
        status,
        title: cap(title, 200),
      });
    }
  }
  /** Context for a resumed or retried run so the agent does not repeat applied mutations. */
  continuationNote(task: Task) {
    const s = this.state(task.id);
    const applied = this.ledger
      .list(task.id)
      .filter(
        (e) =>
          e.mutating && e.state === "completed" && e.kind !== "provider-run",
      );
    if (s.attempt === 1 && !s.resumes && !applied.length) return "";
    const lines = [
      `Recovery note (data): this task is on attempt ${s.attempt}${s.resumes ? ` after ${s.resumes} resume(s)` : ""}. Earlier work may be partially complete.`,
    ];
    if (applied.length)
      lines.push(
        "External effects already applied (do not repeat them):",
        ...applied.map((e) => "- " + e.description),
      );
    return "\n" + lines.join("\n");
  }
  private onApproval(kind: "requested" | "resolved", approval: ApprovalRecord) {
    if (!approval.taskId) return;
    let task: Task;
    try {
      task = this.store.get<Task>("task", approval.taskId);
    } catch {
      return;
    }
    const title =
      (approval.request.toolCall as { title?: string } | undefined)?.title ??
      "tool action";
    this.checkpoint(
      task,
      kind === "requested" ? "approval.requested" : "approval.resolved",
      kind === "requested"
        ? `Waiting for your answer: ${title}`
        : "Provider continues with the recorded answer",
      {
        approvalId: approval.id,
        title,
        outcome: approval.response?.outcome ?? null,
        afterRestart: approval.answeredAfterRestart ?? false,
      },
    );
  }
  // ---- recovery ---------------------------------------------------------------------------
  /**
   * Startup recovery (idempotent). Completed work stays completed; running tasks become
   * `interrupted` (resumable) or, when an external effect is uncertain, `blocked`.
   * Leases and slots of dead processes are released so ownership is never double-held.
   */
  recover() {
    return this.store.transaction(() => {
      this.ledger.settleInterrupted();
      this.service.approvals.restore();
      // Keep (as draining) leases whose backend/provider process may still run; free the rest.
      this.service.locks.reconcile();
      const recovered: string[] = [];
      for (const task of this.store.list<Task>("task")) {
        if (task.status !== "running") continue;
        const uncertain = this.ledger.uncertainFor(task.id);
        const s = this.state(task.id);
        s.interruptReason = uncertain.length
          ? "Backend restarted while an external effect was in flight; its outcome is uncertain."
          : "Backend restarted during execution.";
        this.saveState(s);
        this.service.transitionTask(task.id, {
          status: uncertain.length ? "blocked" : "interrupted",
        });
        recovered.push(task.id);
      }
      if (recovered.length)
        this.store.emit("tasks.recovered", "recovery", { taskIds: recovered });
      return recovered;
    });
  }
  /** After a user decision: unblock when nothing uncertain remains; abandon cancels the task. */
  afterDecision(effect: Effect, decision: string) {
    let task: Task;
    try {
      task = this.store.get<Task>("task", effect.taskId);
    } catch {
      return;
    }
    if (decision === "abandon") {
      if (["blocked", "interrupted", "failed"].includes(task.status))
        this.service.transitionTask(task.id, {
          status: "cancelled",
          result: `Abandoned after uncertain effect: ${effect.description}`,
        });
      return;
    }
    if (
      task.status === "blocked" &&
      !this.ledger.uncertainFor(task.id).length &&
      !["waiting", "blocked"].includes(
        this.service.delegations.view(task.id)?.state ?? "",
      )
    )
      this.service.transitionTask(task.id, { status: "interrupted" });
  }
  // ---- explicit actions -------------------------------------------------------------------
  /** Continue a finished provider turn after its required child results have arrived. */
  continueDelegation(taskId: string): Task {
    const task = this.store.get<Task>("task", taskId);
    assert(
      task.status === "blocked",
      "not_resumable",
      "The parent must be waiting for delegated work.",
    );
    assert(
      !this.service.delegations.pending(task).length,
      "delegated_work_pending",
      "Required delegated tasks and their reviews must succeed first.",
    );
    this.assertNoUncertain(task);
    return this.store.transaction(() => {
      const state = this.state(taskId);
      assert(
        (state.continuation ?? 0) < 3,
        "delegation_continuation_limit",
        "Automatic continuation limit reached. Review the delegated work before starting another assignment.",
      );
      state.continuation = (state.continuation ?? 0) + 1;
      this.saveState(state);
      this.service.delegations.markContinuing(taskId);
      return this.requeue(taskId);
    });
  }
  /** Resume an interrupted task, or retry a failed/blocked one, from its last checkpoint. */
  requeue(taskId: string): Task {
    return this.requeueWithDecision(taskId).task;
  }
  /**
   * The Recovery action. It carries out the typed decision the preview showed (`decide`): the
   * decision picks the path (a delegation continuation, or a requeue of the task itself), and the
   * transition gates enforce what the decision's blocker names.
   */
  requeueWithDecision(taskId: string): {
    task: Task;
    decision: RecoveryDecision;
  } {
    const task = this.store.get<Task>("task", taskId);
    assert(
      ["interrupted", "blocked", "failed"].includes(task.status),
      "not_resumable",
      `A ${task.status} task has nothing to resume`,
    );
    const decision = this.decide(task)!;
    if (decision.kind === "delegation-continuation")
      return { task: this.continueDelegation(taskId), decision };
    // A provider call needs the role to be able to do the work NOW: a folder detached or a grant
    // revoked since the task stopped is refused here with its real cause, before any attempt is
    // used (the scheduler repeats the check against the actual launch plan). Finalizing saved
    // output makes no provider call and needs no capability.
    if (decision.allowed && decision.providerCall) {
      const agent = this.store.get<Agent>("agent", task.agentId);
      const readiness = this.service.launchReadiness.evaluateProspective(
        agent,
        { task },
      );
      if (!readiness.ready)
        throw this.service.launchReadiness.refusal(
          readiness,
          task.workflowId,
          "resume",
        );
    }
    const s = this.state(taskId);
    const last = this.latest(taskId);
    this.store.transaction(() => {
      s.resume = {
        fromCheckpointId: last?.id ?? null,
        sessionId: decision.session === "resume" ? s.providerSessionId : null,
      };
      this.saveState(s);
    });
    try {
      return {
        task: this.service.transitionTask(taskId, { status: "queued" }),
        decision,
      };
    } catch (e) {
      const cleared = this.state(taskId);
      cleared.resume = undefined;
      this.saveState(cleared);
      throw e;
    }
  }
  /** Gate for a retry: attempts left and when the automatic backoff expires. */
  retryGate(task: Task) {
    const s = this.state(task.id);
    const left = s.policy.maxAttempts - s.attempt;
    const runtimeBlocker = this.runtimeBlocker(task);
    if (runtimeBlocker)
      return {
        allowed: false,
        blocker: "runtime-capability" as const,
        reason:
          runtimeBlocker.message ??
          "Fix the unavailable sandbox or choose a file-only simple task. This task resumes automatically when ready.",
        notBefore: null,
        attemptsLeft: Math.max(0, left),
      };
    const uncertain = this.ledger.uncertainFor(task.id);
    if (uncertain.length)
      return {
        allowed: false,
        reason: `Decide on uncertain effect: ${uncertain[0].description}`,
        notBefore: null,
        attemptsLeft: Math.max(0, left),
      };
    const delegation = this.service.delegations.view(task.id);
    if (
      delegation &&
      delegation.state !== "continuing" &&
      (this.service.delegations.pending(task).length ||
        (s.continuation ?? 0) >= 3)
    )
      return {
        allowed: false,
        reason: delegation.message,
        notBefore: null,
        attemptsLeft: Math.max(0, left),
      };
    // Resuming an interrupted/blocked task continues the current attempt; only retries consume one.
    if (task.status !== "failed")
      return {
        allowed: true,
        reason: `Resume continues attempt ${s.attempt} of ${s.policy.maxAttempts}`,
        notBefore: null,
        attemptsLeft: Math.max(0, left),
      };
    if (left <= 0)
      return {
        allowed: false,
        reason: `Attempt limit reached (${s.attempt}/${s.policy.maxAttempts})`,
        notBefore: null,
        attemptsLeft: 0,
      };
    return {
      allowed: true,
      reason: `Retry-from-checkpoint starts attempt ${s.attempt + 1} of ${s.policy.maxAttempts}`,
      notBefore: s.policy.auto ? s.notBefore : null,
      attemptsLeft: left,
    };
  }
  /** Scheduler tick: requeue failed tasks whose policy says auto-retry and whose backoff elapsed. */
  sweep(now = Date.now()) {
    for (const task of this.store.list<Task>("task")) {
      if (task.status !== "failed") continue;
      const s = this.state(task.id);
      if (!s.policy.auto || !s.notBefore || Date.parse(s.notBefore) > now)
        continue;
      if (this.service.limits.meta(task.id).stoppedByLimit) continue;
      if (!this.retryGate(task).allowed) continue;
      try {
        this.requeue(task.id);
      } catch {
        /* limits, pending decisions or exhausted attempts keep it failed */
      }
    }
  }
  // ---- views ------------------------------------------------------------------------------
  /**
   * The typed decision for a recoverable task, computed once. `describe()`, the retry gate and the
   * action all read it. It judges the state the action WILL execute: a failed task's retry is the
   * next attempt (new ledger key, so a provider call even when the failed attempt's output was
   * saved), an interrupted task continues its attempt (replaying saved output without a call only
   * when the ledger holds it), a delegating parent's continuation is a new run key in the same
   * attempt.
   */
  decide(task: Task): RecoveryDecision | null {
    if (!["failed", "interrupted", "blocked"].includes(task.status))
      return null;
    const s = this.state(task.id);
    const gate = this.retryGate(task);
    const uncertain = this.ledger.uncertainFor(task.id);
    const approvals = this.service.approvals.pendingFor(task.id);
    const runtimeBlocker = this.runtimeBlocker(task);
    const delegation = this.service.delegations.view(task.id);
    // Only a blocked parent continues its delegation; a failed or interrupted one is requeued.
    const delegating =
      task.status === "blocked" &&
      !!delegation &&
      delegation.state !== "continuing";
    const resumable = !!s.providerSessionId && !task.resourcePaths?.length;
    const max = s.policy.maxAttempts;
    // The cascade existing cancellation applies (src/limits.ts): live delegated descendants.
    const cascades: RecoveryDecision["cancel"]["cascades"] = [];
    const seen = new Set<string>([task.id]);
    const stack = [task.id];
    while (stack.length) {
      const parent = stack.pop()!;
      for (const child of this.store.list<Task>("task"))
        if (child.parentTaskId === parent && !seen.has(child.id)) {
          seen.add(child.id);
          if (
            ["queued", "interrupted", "blocked", "running"].includes(
              child.status,
            )
          ) {
            cascades.push({
              taskId: child.id,
              title: child.title,
              status: child.status,
            });
            stack.push(child.id);
          }
        }
    }
    const approvalSteps = approvals.map(
      (a) =>
        `Answer pending approval: ${(a.request.toolCall as { title?: string } | undefined)?.title ?? "tool action"}`,
    );
    const attempt = (after: number) => ({ current: s.attempt, after, max });
    const base = {
      taskId: task.id,
      cancel: { allowed: true, cascades },
      outcomes: null,
      setup: null,
    };
    const waits: string[] = [];
    if (task.requiresValidation && !this.service.validation.gate(task).open)
      waits.push("Wait for required validation to pass before executing");
    if (task.dependsOn.some((d) => !this.service.taskDependencySatisfied(d)))
      waits.push("Wait for unfinished dependencies");
    const approvalBlocker = approvals.length
      ? {
          code: "approval_pending",
          message: "Answer the pending approval before resuming this task",
        }
      : null;
    const open = gate.allowed && !approvals.length;

    if (uncertain.length)
      return {
        ...base,
        kind: "uncertain-effect-resolution",
        allowed: false,
        blocker: { code: "effect_uncertain", message: gate.reason },
        action: "decide-effect",
        attempt: attempt(s.attempt),
        consumesAttempt: false,
        continuation: null,
        providerCall: false,
        run: null,
        session: "none",
        resumesSessionId: null,
        summary: `It is unknown whether "${uncertain[0].description}" was applied; decide before anything runs. Nothing is replayed automatically.`,
        steps: [
          ...approvalSteps,
          ...uncertain.map(
            (e) =>
              `Decide on uncertain effect "${e.description}": retry, mark applied, or abandon`,
          ),
        ],
        outcomes: [
          {
            decision: "retry",
            label: "Not applied: allow retry",
            providerCall: true,
          },
          {
            decision: "completed",
            label: "Mark as applied",
            providerCall: false,
          },
          { decision: "abandon", label: "Abandon task", providerCall: false },
        ],
      };
    if (runtimeBlocker) {
      const then = this.afterRepair(task);
      const message =
        runtimeBlocker.message ??
        "Fix the required sandbox. The task resumes automatically once its setup is ready.";
      return {
        ...base,
        kind: "setup-repair",
        allowed: false,
        blocker: { code: "runtime_capability_blocked", message },
        action: "repair-setup",
        attempt: attempt(s.attempt),
        consumesAttempt: false,
        continuation: null,
        providerCall: false,
        run: null,
        session: "none",
        resumesSessionId: null,
        summary: `${message} Nothing runs and no attempt is used until the setup is repaired; the task then continues by itself.`,
        steps: [...approvalSteps, message],
        setup: {
          reason: runtimeBlocker.reason ?? "sandbox-unavailable",
          message,
          issues: runtimeBlocker.issues ?? [],
          action: runtimeBlocker.issues?.[0]?.fix ?? null,
          then: {
            kind: then.kind,
            providerCall: then.providerCall,
            summary: then.summary,
          },
        },
      };
    }
    if (delegating) {
      const continuation = s.continuation ?? 0;
      const at = { attempt: s.attempt, continuation: continuation + 1 };
      const replay = this.willReplayRun(task, at);
      const waiting = this.service.delegations.pending(task).length > 0;
      return {
        ...base,
        kind: "delegation-continuation",
        allowed: open,
        blocker:
          approvalBlocker ??
          (gate.allowed
            ? null
            : {
                code: waiting
                  ? "delegated_work_pending"
                  : "delegation_continuation_limit",
                message: gate.reason,
              }),
        action: gate.allowed ? "continue-delegation" : "wait",
        attempt: attempt(s.attempt),
        consumesAttempt: false,
        continuation: {
          current: continuation,
          after: continuation + 1,
          max: 3,
        },
        providerCall: !replay,
        run: { key: this.runKey(task, at), replay },
        session: "fresh",
        resumesSessionId: null,
        summary: gate.allowed
          ? `The delegated work is done: the parent gets a continuation turn in attempt ${s.attempt} (a new provider call, continuation ${continuation + 1} of 3).`
          : delegation!.message,
        steps: [...approvalSteps, delegation!.message],
      };
    }
    if (task.status === "failed") {
      const at = { attempt: s.attempt + 1 };
      const replay = this.willReplayRun(task, at);
      const saved = this.willReplayRun(task);
      return {
        ...base,
        kind: "new-attempt",
        allowed: open,
        blocker:
          approvalBlocker ??
          (gate.allowed
            ? null
            : { code: "retry_exhausted", message: gate.reason }),
        action: "requeue",
        attempt: attempt(s.attempt + 1),
        consumesAttempt: true,
        continuation: null,
        providerCall: !replay,
        run: { key: this.runKey(task, at), replay },
        session: resumable ? "resume" : "fresh",
        resumesSessionId: resumable ? s.providerSessionId : null,
        summary: `Start attempt ${s.attempt + 1} of ${max}: a new provider call${saved ? `; attempt ${s.attempt}'s saved output stays as evidence and is not finalized` : ""}.`,
        steps: approvalSteps.length
          ? approvalSteps
          : [
              resumable
                ? `Start attempt ${s.attempt + 1}, resuming provider session ${s.providerSessionId}`
                : `Start attempt ${s.attempt + 1} from the beginning`,
              ...waits,
            ],
      };
    }
    // interrupted, or blocked without a delegation, an uncertain effect or a setup blocker
    const key = this.runKey(task);
    if (this.willReplayRun(task))
      return {
        ...base,
        kind: "completion-only-replay",
        allowed: open,
        blocker: approvalBlocker,
        action: "requeue",
        attempt: attempt(s.attempt),
        consumesAttempt: false,
        continuation: null,
        providerCall: false,
        run: { key, replay: true },
        session: "none",
        resumesSessionId: null,
        summary: `Finalize attempt ${s.attempt} from the saved provider output (no provider call); completion checks run again.`,
        steps: approvalSteps.length
          ? approvalSteps
          : [
              "Finalize from the saved provider output (no provider call)",
              ...waits,
            ],
      };
    return {
      ...base,
      kind: "resume-run",
      allowed: open,
      blocker: approvalBlocker,
      action: "requeue",
      attempt: attempt(s.attempt),
      consumesAttempt: false,
      continuation: null,
      providerCall: true,
      run: { key, replay: false },
      session: resumable ? "resume" : "fresh",
      resumesSessionId: resumable ? s.providerSessionId : null,
      summary: resumable
        ? `Resume attempt ${s.attempt} in provider session ${s.providerSessionId}: a provider call, no attempt used.`
        : `Run attempt ${s.attempt} again from the beginning: a provider call, no attempt used.`,
      steps: approvalSteps.length
        ? approvalSteps
        : [
            resumable
              ? `Resume provider session ${s.providerSessionId} (attempt ${s.attempt})`
              : `Re-run attempt ${s.attempt} from the beginning`,
            ...waits,
          ],
    };
  }
  /** What a setup-blocked task does once its blocker is gone (the same attempt, nothing consumed). */
  private afterRepair(task: Task) {
    const s = this.state(task.id);
    const replay = this.willReplayRun(task);
    return {
      kind: replay
        ? ("completion-only-replay" as const)
        : ("resume-run" as const),
      providerCall: !replay,
      summary: replay
        ? `Finalize attempt ${s.attempt} from the saved provider output (no provider call).`
        : `Run attempt ${s.attempt}: a provider call, no attempt used.`,
    };
  }
  describe(task: Task) {
    const effects = this.ledger.list(task.id);
    const decision = this.decide(task);
    const next = [...(decision?.steps ?? [])];
    for (const t of this.store.list<Task>("task"))
      if (t.dependsOn.includes(task.id) && t.status === "queued")
        next.push(`Then unblocks: ${t.title}`);
    return {
      next,
      completed: effects
        .filter((e) => e.state === "completed")
        .map((e) => e.description),
      uncertainEffects: effects.filter((e) => e.state === "uncertain"),
      pendingApprovals: this.service.approvals.pendingFor(task.id),
      decision,
    };
  }
  view(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    const s = this.state(taskId);
    const d = this.describe(task);
    const last = this.latest(taskId);
    return {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        workflowId: task.workflowId,
        agentId: task.agentId,
        dependsOn: task.dependsOn,
      },
      attempt: s.attempt,
      resumes: s.resumes,
      policy: s.policy,
      providerSessionId: s.providerSessionId,
      reason: s.interruptReason ?? null,
      checkpoint: last
        ? {
            id: last.id,
            seq: last.seq,
            boundary: last.boundary,
            nextStep: last.nextStep,
            createdAt: last.createdAt,
          }
        : null,
      next: d.next,
      completedEffects: d.completed,
      uncertainEffects: d.uncertainEffects,
      pendingApprovals: d.pendingApprovals,
      retry: this.retryGate(task),
      /** The one typed decision the preview and the action share (null once nothing is left to recover). */
      decision: d.decision,
      /** For a parent stopped on delegated work: the failing leaf, so Recovery leads with it. */
      rootCause: this.rootCause(task),
    };
  }
  /** The failing leaf behind a delegating parent, as a setup problem or a failure. */
  private rootCause(task: Task) {
    const delegation = this.service.delegations.view(task.id);
    const leafId = delegation?.blockers?.[0]?.taskId;
    if (!leafId) return null;
    const leaf = this.store.get<Task>("task", leafId);
    const wait = this.runtimeBlocker(leaf);
    const agent = this.store.get<{ name: string }>("agent", leaf.agentId);
    return {
      taskId: leaf.id,
      title: leaf.title,
      agentName: agent.name,
      kind: wait ? ("setup" as const) : ("failure" as const),
      message: wait?.message ?? delegation!.blockers![0].reason,
      action: wait?.issues?.[0]?.fix ?? null,
    };
  }
  overview() {
    const tasks = this.store
      .list<Task>("task")
      .filter((t) => ["interrupted", "blocked", "failed"].includes(t.status));
    return {
      tasks: tasks.map((t) => this.view(t.id)),
      pendingApprovals: this.service.approvals.list(),
      uncertainEffects: this.ledger
        .list()
        .filter((e) => e.state === "uncertain"),
    };
  }
}
