import { createHash } from "node:crypto";
import { z } from "zod";
import type { TeamService } from "./service.ts";
import { errorKindOf } from "./provider-errors.ts";
import { assert, type Message, type Task } from "./model.ts";
import type { ApprovalRecord } from "./approvals.ts";

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
  /** True when startRun would replay this attempt's recorded provider output instead of running it. */
  willReplayRun(task: Task) {
    const s = this.state(task.id);
    return (
      this.ledger.find(`provider-run:${task.id}:${s.attempt}`)?.state ===
      "completed"
    );
  }
  startRun(task: Task, mutating: boolean) {
    const s = this.state(task.id);
    const { effect, action } = this.ledger.begin({
      taskId: task.id,
      key: `provider-run:${task.id}:${s.attempt}`,
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
      const key = `tool:${task.id}:${s.attempt}:${callId}`;
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
      for (const lease of this.store.list<{ id: string }>("lease"))
        this.service.resources.release(lease.id);
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
    if (task.status === "blocked" && !this.ledger.uncertainFor(task.id).length)
      this.service.transitionTask(task.id, { status: "interrupted" });
  }
  // ---- explicit actions -------------------------------------------------------------------
  /** Resume an interrupted task, or retry a failed/blocked one, from its last checkpoint. */
  requeue(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    assert(
      ["interrupted", "blocked", "failed"].includes(task.status),
      "not_resumable",
      `A ${task.status} task has nothing to resume`,
    );
    const s = this.state(taskId);
    const last = this.latest(taskId);
    this.store.transaction(() => {
      s.resume = {
        fromCheckpointId: last?.id ?? null,
        sessionId: s.providerSessionId,
      };
      this.saveState(s);
    });
    try {
      return this.service.transitionTask(taskId, { status: "queued" });
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
    const uncertain = this.ledger.uncertainFor(task.id);
    if (uncertain.length)
      return {
        allowed: false,
        reason: `Decide on uncertain effect: ${uncertain[0].description}`,
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
  describe(task: Task) {
    const s = this.state(task.id);
    const effects = this.ledger.list(task.id);
    const uncertainEffects = effects.filter((e) => e.state === "uncertain");
    const pendingApprovals = this.service.approvals.pendingFor(task.id);
    const completed = effects
      .filter((e) => e.state === "completed")
      .map((e) => e.description);
    const next: string[] = [];
    for (const a of pendingApprovals)
      next.push(
        `Answer pending approval: ${(a.request.toolCall as { title?: string } | undefined)?.title ?? "tool action"}`,
      );
    for (const e of uncertainEffects)
      next.push(
        `Decide on uncertain effect "${e.description}": retry, mark applied, or abandon`,
      );
    if (!pendingApprovals.length && !uncertainEffects.length) {
      const run = this.ledger.find(`provider-run:${task.id}:${s.attempt}`);
      if (
        task.status === "failed" ||
        task.status === "interrupted" ||
        task.status === "blocked"
      ) {
        if (run?.state === "completed")
          next.push(
            "Finalize from the saved provider output (no provider call)",
          );
        else if (task.status === "failed")
          next.push(
            s.providerSessionId
              ? `Start attempt ${s.attempt + 1}, resuming provider session ${s.providerSessionId}`
              : `Start attempt ${s.attempt + 1} from the beginning`,
          );
        else if (s.providerSessionId)
          next.push(
            `Resume provider session ${s.providerSessionId} (attempt ${s.attempt})`,
          );
        else next.push(`Re-run attempt ${s.attempt} from the beginning`);
        if (task.requiresValidation && !this.service.validation.gate(task).open)
          next.push("Wait for required validation to pass before executing");
        const blockers = task.dependsOn.filter(
          (d) => this.store.get<Task>("task", d).status !== "completed",
        );
        if (blockers.length) next.push("Wait for unfinished dependencies");
      }
    }
    for (const t of this.store.list<Task>("task"))
      if (t.dependsOn.includes(task.id) && t.status === "queued")
        next.push(`Then unblocks: ${t.title}`);
    return { next, completed, uncertainEffects, pendingApprovals };
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
