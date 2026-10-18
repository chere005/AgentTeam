import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, assert, type Task, type Workflow } from "./model.ts";
import {
  DEFAULT_LIMITS,
  limitsPatchSchema,
  limitsSchema,
  type CompletionCheck,
  type Limits,
} from "./limits-schema.ts";
import type { TeamService } from "./service.ts";
import { canonical } from "./shared-common.ts";
export type { Limits, CompletionCheck } from "./limits-schema.ts";

/** JSON objects a reply offers: the whole reply, each fenced block, and the outermost {...} span. */
export function jsonObjectCandidates(text: string): Record<string, unknown>[] {
  const candidates = [text.trim()];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g))
    candidates.push(m[1].trim());
  const a = text.indexOf("{"),
    b = text.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  const out: Record<string, unknown>[] = [];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v))
        out.push(v as Record<string, unknown>);
    } catch {}
  }
  return out;
}
const fieldPresent = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    (typeof v === "string" && !v.trim()) ||
    (Array.isArray(v) && !v.length)
  );
/**
 * The distinct objects in a reply that carry every required field (non-empty). The output-fields
 * completion check and the required-review verdict both use this, so they always agree: exactly one
 * qualifying object satisfies a contract; none or several (ambiguous) do not.
 */
export function contractObjects(text: string, fields: string[]) {
  const seen = new Map<string, Record<string, unknown>>();
  for (const o of jsonObjectCandidates(text))
    if (fields.every((f) => fieldPresent(o[f]))) seen.set(canonical(o), o);
  return [...seen.values()];
}

export type TripKind =
  | "runtime"
  | "turns"
  | "handoffs"
  | "retries"
  | "spawned"
  | "tokens"
  | "depth"
  | "loop";
export type Trip = {
  kind: TripKind;
  reason: string;
  value: number;
  max: number | null;
  at: string;
  taskId?: string;
};
export type LimitState = {
  id: string;
  workflowId: string;
  limits: Limits;
  counters: {
    turns: number;
    handoffs: number;
    retries: number;
    spawned: number;
    runtimeMs: number;
    clockStartedAt: string | null;
    tokens: {
      input: number;
      output: number;
      cache: number;
      reportingTurns: number;
    };
  };
  trip: Trip | null;
  history: (
    | { type: "trip"; at: string; trip: Trip }
    | {
        type: "resume";
        at: string;
        before: Limits;
        after: Limits;
        requeued: string[];
      }
    | { type: "limits"; at: string; before: Limits; after: Limits }
  )[];
};
export type CheckResult = {
  check: CompletionCheck;
  passed: boolean;
  detail: string;
};
export type CheckEvidence = {
  passed: boolean;
  resultHash: string;
  at: string;
  results: CheckResult[];
};
type TaskMeta = {
  id: string;
  partialResult?: string;
  stoppedByLimit?: string;
  cancelRequested?: string;
  checks?: CheckEvidence;
  checkHistory?: CheckEvidence[];
};
const LIVE = ["queued", "running"];
/** Unfinished work that still counts toward delegation chains and child caps (resumable states). */
const PENDING = [...LIVE, "interrupted", "blocked"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const COUNT_KINDS: Record<
  string,
  { counter: keyof LimitState["counters"]; limit: keyof Limits }
> = {
  turns: { counter: "turns", limit: "maxAgentTurns" },
  handoffs: { counter: "handoffs", limit: "maxHandoffs" },
  retries: { counter: "retries", limit: "maxRetries" },
  spawned: { counter: "spawned", limit: "maxSpawnedAgents" },
};
const LABEL: Record<string, string> = {
  turns: "agent turns",
  handoffs: "handoffs",
  retries: "retries",
  spawned: "spawned agent invocations",
};

/**
 * Per-workflow stopping conditions, delegation bounds and completion checks.
 * All state is persisted as `workflow-limits` / `task-meta` entities; trips pause the
 * workflow, record the exact reason and never discard task results.
 */
export class LimitsService {
  service: TeamService;
  /** Set by the scheduler: aborts a running task's provider process. Returns false when none is active. */
  abortTask: (taskId: string) => boolean = () => false;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  state(workflowId: string): LimitState {
    try {
      return this.store.get<LimitState>("workflow-limits", workflowId);
    } catch {
      return {
        id: workflowId,
        workflowId,
        limits: { ...DEFAULT_LIMITS },
        counters: {
          turns: 0,
          handoffs: 0,
          retries: 0,
          spawned: 0,
          runtimeMs: 0,
          clockStartedAt: null,
          tokens: { input: 0, output: 0, cache: 0, reportingTurns: 0 },
        },
        trip: null,
        history: [],
      };
    }
  }
  private save(state: LimitState) {
    this.store.put("workflow-limits", state);
  }
  meta(taskId: string): TaskMeta {
    try {
      return this.store.get<TaskMeta>("task-meta", taskId);
    } catch {
      return { id: taskId };
    }
  }
  private saveMeta(meta: TaskMeta) {
    this.store.put("task-meta", meta);
  }
  runtimeMs(state: LimitState, now = Date.now()) {
    return (
      state.counters.runtimeMs +
      (state.counters.clockStartedAt
        ? Math.max(0, now - Date.parse(state.counters.clockStartedAt))
        : 0)
    );
  }
  tokensUsed(state: LimitState) {
    return state.counters.tokens.input + state.counters.tokens.output;
  }
  // ---- configuration -------------------------------------------------------------------
  setLimits(workflowId: string, input: unknown) {
    this.store.get<Workflow>("workflow", workflowId);
    const patch = limitsPatchSchema.parse(input);
    return this.store.transaction(() => {
      const state = this.state(workflowId);
      const before = state.limits;
      state.limits = limitsSchema.parse({ ...before, ...patch });
      state.history.push({
        type: "limits",
        at: new Date().toISOString(),
        before,
        after: state.limits,
      });
      this.save(state);
      this.store.emit("workflow.limits_updated", workflowId);
      this.sweep(workflowId);
      return this.status(workflowId);
    });
  }
  /** Extends limits and resumes a tripped workflow; refuses while the tripped limit is still exceeded. */
  resume(
    workflowId: string,
    input: { limits?: unknown; requeueStopped?: boolean } = {},
  ) {
    this.store.get<Workflow>("workflow", workflowId);
    const patch = limitsPatchSchema.parse(input.limits ?? {});
    return this.store.transaction(() => {
      const state = this.state(workflowId);
      assert(
        state.trip,
        "not_tripped",
        "This workflow has no tripped limit to resume from; use pause/resume instead",
      );
      const before = state.limits;
      const after = limitsSchema.parse({ ...before, ...patch });
      const trial = { ...state, limits: after };
      const exceeded = this.headroomProblem(trial, state.trip);
      assert(
        !exceeded,
        "limit_still_exceeded",
        `${exceeded} Raise the limit (extension) before resuming.`,
      );
      state.limits = after;
      state.trip = null;
      state.counters.clockStartedAt = null;
      const requeued: string[] = [];
      if (input.requeueStopped !== false)
        for (const t of this.store.list<Task>("task"))
          if (
            t.workflowId === workflowId &&
            t.status === "failed" &&
            this.meta(t.id).stoppedByLimit &&
            // An aborted mutating run is uncertain (or attempts are exhausted): the task stays
            // failed for an explicit decision in the recovery panel instead of failing the resume.
            this.service.recovery.retryGate(t).allowed
          ) {
            this.service.transitionTask(t.id, { status: "queued" });
            requeued.push(t.id);
          }
      state.history.push({
        type: "resume",
        at: new Date().toISOString(),
        before,
        after,
        requeued,
      });
      this.save(state);
      this.service.pauseWorkflow(workflowId, false);
      this.store.emit("workflow.limit_resumed", workflowId, { requeued });
      return this.status(workflowId);
    });
  }
  private headroomProblem(state: LimitState, trip: Trip): string | null {
    const l = state.limits;
    switch (trip.kind) {
      case "runtime":
        return l.maxRuntimeSeconds !== null &&
          this.runtimeMs(state) >= l.maxRuntimeSeconds * 1000
          ? `Runtime ${Math.round(this.runtimeMs(state) / 1000)}s already reaches the ${l.maxRuntimeSeconds}s limit.`
          : null;
      case "tokens":
        return l.maxTokens !== null && this.tokensUsed(state) >= l.maxTokens
          ? `Reported tokens ${this.tokensUsed(state)} already reach the ${l.maxTokens} budget.`
          : null;
      case "depth":
        return null;
      case "loop":
        return null;
      default: {
        const k = COUNT_KINDS[trip.kind];
        const max = l[k.limit] as number | null;
        const value = state.counters[k.counter] as number;
        return max !== null && value >= max
          ? `${value} ${LABEL[trip.kind]} already reach the limit of ${max}.`
          : null;
      }
    }
  }
  // ---- tripping --------------------------------------------------------------------------
  trip(
    workflowId: string,
    kind: TripKind,
    reason: string,
    value: number,
    max: number | null,
    opts: { abortRunning?: boolean; taskId?: string } = {},
  ): Trip {
    const aborts: string[] = [];
    const trip = this.store.transaction(() => {
      const state = this.state(workflowId);
      if (state.trip) return state.trip; // first reason wins; it stays the recorded reason
      const t: Trip = {
        kind,
        reason,
        value,
        max,
        at: new Date().toISOString(),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      };
      state.trip = t;
      state.history.push({ type: "trip", at: t.at, trip: t });
      if (state.counters.clockStartedAt) {
        state.counters.runtimeMs = this.runtimeMs(state);
        state.counters.clockStartedAt = null;
      }
      this.save(state);
      const wf = this.store.get<Workflow>("workflow", workflowId);
      wf.paused = true;
      this.store.put("workflow", wf);
      this.store.emit("workflow.paused", workflowId, { limit: kind, reason });
      this.store.emit("workflow.limit_tripped", workflowId, { ...t });
      if (opts.abortRunning)
        for (const task of this.store.list<Task>("task"))
          if (task.workflowId === workflowId && task.status === "running") {
            const meta = this.meta(task.id);
            meta.stoppedByLimit = reason;
            this.saveMeta(meta);
            aborts.push(task.id);
          }
      return t;
    });
    for (const id of aborts) this.abortTask(id);
    return trip;
  }
  private blocked(trip: Trip): never {
    throw new AppError(
      409,
      "limit_exceeded",
      `Workflow stopped by limit (${trip.kind}): ${trip.reason} Extend the limit and resume to continue.`,
    );
  }
  /** Periodic/lazy sweep: manages the runtime clock and trips runtime or token budgets. */
  sweep(onlyWorkflowId?: string) {
    const now = Date.now();
    for (const state of this.store.list<LimitState>("workflow-limits")) {
      if (onlyWorkflowId && state.workflowId !== onlyWorkflowId) continue;
      let wf: Workflow;
      try {
        wf = this.store.get<Workflow>("workflow", state.workflowId);
      } catch {
        continue;
      }
      const tasks = this.store
        .list<Task>("task")
        .filter((t) => t.workflowId === state.workflowId);
      const active = tasks.some((t) => LIVE.includes(t.status));
      const wantClock =
        !wf.paused && !state.trip && active && state.counters.turns > 0;
      if (state.counters.clockStartedAt && !wantClock) {
        state.counters.runtimeMs = this.runtimeMs(state, now);
        state.counters.clockStartedAt = null;
        this.save(state);
      } else if (!state.counters.clockStartedAt && wantClock) {
        state.counters.clockStartedAt = new Date(now).toISOString();
        this.save(state);
      }
      if (state.trip) continue;
      const l = state.limits;
      if (l.maxRuntimeSeconds !== null) {
        const ms = this.runtimeMs(state, now);
        if (ms >= l.maxRuntimeSeconds * 1000)
          this.trip(
            state.workflowId,
            "runtime",
            `Maximum runtime of ${l.maxRuntimeSeconds}s reached (${Math.round(ms / 1000)}s elapsed while active).`,
            Math.round(ms / 1000),
            l.maxRuntimeSeconds,
            { abortRunning: true },
          );
      }
      if (l.maxTokens !== null && this.tokensUsed(state) >= l.maxTokens)
        this.trip(
          state.workflowId,
          "tokens",
          `Reported token budget of ${l.maxTokens} reached (${this.tokensUsed(state)} used; only provider-reported usage is counted).`,
          this.tokensUsed(state),
          l.maxTokens,
          { abortRunning: true },
        );
    }
  }
  // ---- task start / retry / create hooks ---------------------------------------------------
  /** Called before a task enters `running`. Throws (after recording a trip) when a limit blocks the turn. */
  enforceStart(task: Task) {
    this.sweep(task.workflowId);
    const state = this.state(task.workflowId);
    if (state.trip) this.blocked(state.trip);
    const l = state.limits;
    if (l.maxAgentTurns !== null && state.counters.turns + 1 > l.maxAgentTurns)
      this.blocked(
        this.trip(
          task.workflowId,
          "turns",
          `Maximum of ${l.maxAgentTurns} agent turns reached.`,
          state.counters.turns,
          l.maxAgentTurns,
          { taskId: task.id },
        ),
      );
    if (task.parentTaskId && l.maxChildrenPerTask !== null) {
      const running = this.store
        .list<Task>("task")
        .filter(
          (t) =>
            t.parentTaskId === task.parentTaskId &&
            t.status === "running" &&
            t.id !== task.id,
        ).length;
      assert(
        running < l.maxChildrenPerTask,
        "children_limit",
        `Parent task already has ${running} running children (cap ${l.maxChildrenPerTask})`,
      );
    }
  }
  recordTurn(task: Task) {
    const state = this.state(task.workflowId);
    state.counters.turns++;
    if (!state.counters.clockStartedAt)
      state.counters.clockStartedAt = new Date().toISOString();
    this.save(state);
  }
  beforeRetry(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    if (task.status !== "failed" || this.meta(taskId).stoppedByLimit) return;
    const state = this.state(task.workflowId);
    const max = state.limits.maxRetries;
    if (max !== null && state.counters.retries + 1 > max)
      this.blocked(
        this.trip(
          task.workflowId,
          "retries",
          `Maximum of ${max} retries reached.`,
          state.counters.retries,
          max,
          { taskId },
        ),
      );
  }
  recordRetry(task: Task) {
    const meta = this.meta(task.id);
    if (meta.stoppedByLimit) {
      delete meta.stoppedByLimit;
      delete meta.cancelRequested;
      this.saveMeta(meta);
      return;
    }
    const state = this.state(task.workflowId);
    state.counters.retries++;
    this.save(state);
  }
  /** Ancestor chain, nearest parent first. */
  ancestors(task: Pick<Task, "parentTaskId">): Task[] {
    const chain: Task[] = [];
    const seen = new Set<string>();
    let id = task.parentTaskId;
    while (id && !seen.has(id)) {
      seen.add(id);
      let t: Task;
      try {
        t = this.store.get<Task>("task", id);
      } catch {
        break;
      }
      chain.push(t);
      id = t.parentTaskId;
    }
    return chain;
  }
  /**
   * Validates a teammate invocation/handoff before the task row exists: resolves the parent task,
   * enforces recursion depth, loop detection, handoff/spawn totals and the per-parent children cap.
   * Returns the resolved parent id (explicit or inferred from the invoker's single running task).
   */
  beforeCreate(data: {
    workflowId: string;
    agentId: string;
    invokedBy?: string;
    parentTaskId?: string;
    title: string;
  }): { parentTaskId?: string; depth: number } {
    if (!data.invokedBy) {
      assert(
        !data.parentTaskId,
        "invalid_parent",
        "parentTaskId requires invokedBy",
        400,
      );
      return { depth: 0 };
    }
    const state = this.state(data.workflowId);
    if (state.trip) this.blocked(state.trip);
    const all = this.store
      .list<Task>("task")
      .filter((t) => t.workflowId === data.workflowId);
    let parent: Task | undefined;
    if (data.parentTaskId) {
      parent = this.store.get<Task>("task", data.parentTaskId);
      assert(
        parent.workflowId === data.workflowId &&
          parent.agentId === data.invokedBy,
        "invalid_parent",
        "Parent task must belong to this workflow and be run by the invoking agent",
        400,
      );
      assert(
        LIVE.includes(parent.status),
        "parent_finished",
        "A finished parent task cannot spawn more work",
      );
    } else {
      const running = all.filter(
        (t) => t.agentId === data.invokedBy && t.status === "running",
      );
      if (running.length === 1) parent = running[0];
    }
    const chain = parent ? [parent, ...this.ancestors(parent)] : [];
    const depth = chain.filter((t) => t.invokedBy).length + 1;
    const l = state.limits;
    const tripAndThrow = (
      kind: TripKind,
      reason: string,
      value: number,
      max: number | null,
      code: string,
    ): never => {
      this.trip(data.workflowId, kind, reason, value, max);
      throw new AppError(409, code, reason);
    };
    const name = (id: string) =>
      this.store.get<{ name: string }>("agent", id).name;
    if (data.agentId === data.invokedBy)
      tripAndThrow(
        "loop",
        `Delegation loop: ${name(data.agentId)} cannot invoke itself.`,
        depth,
        null,
        "delegation_loop",
      );
    const loopAt = chain.find((t) => t.agentId === data.agentId);
    if (loopAt)
      tripAndThrow(
        "loop",
        `Delegation loop: ${name(data.agentId)} is already in this call chain (${[
          ...chain,
        ]
          .reverse()
          .map((t) => name(t.agentId))
          .join(" -> ")} -> ${name(data.agentId)}).`,
        depth,
        null,
        "delegation_loop",
      );
    // Cycle among live delegations even when parent links are unknown (e.g. queued ping-pong).
    const edges = new Map<string, Set<string>>();
    for (const t of all)
      if (t.invokedBy && PENDING.includes(t.status))
        (
          edges.get(t.invokedBy) ??
          edges.set(t.invokedBy, new Set()).get(t.invokedBy)!
        ).add(t.agentId);
    const seen = new Set<string>();
    const stack = [data.agentId];
    while (stack.length) {
      const a = stack.pop()!;
      if (a === data.invokedBy)
        tripAndThrow(
          "loop",
          `Delegation loop: ${name(data.invokedBy)} would invoke ${name(data.agentId)} while ${name(data.agentId)} already depends on a live delegation back to ${name(data.invokedBy)}.`,
          depth,
          null,
          "delegation_loop",
        );
      if (seen.has(a)) continue;
      seen.add(a);
      for (const next of edges.get(a) ?? []) stack.push(next);
    }
    if (depth > l.maxDelegationDepth)
      tripAndThrow(
        "depth",
        `Maximum delegation depth of ${l.maxDelegationDepth} exceeded (this invocation would be depth ${depth}).`,
        depth,
        l.maxDelegationDepth,
        "depth_limit",
      );
    if (l.maxHandoffs !== null && state.counters.handoffs + 1 > l.maxHandoffs)
      tripAndThrow(
        "handoffs",
        `Maximum of ${l.maxHandoffs} handoffs reached.`,
        state.counters.handoffs,
        l.maxHandoffs,
        "limit_exceeded",
      );
    if (
      l.maxSpawnedAgents !== null &&
      state.counters.spawned + 1 > l.maxSpawnedAgents
    )
      tripAndThrow(
        "spawned",
        `Maximum of ${l.maxSpawnedAgents} spawned agent invocations reached.`,
        state.counters.spawned,
        l.maxSpawnedAgents,
        "limit_exceeded",
      );
    if (parent && l.maxChildrenPerTask !== null) {
      const live = all.filter(
        (t) => t.parentTaskId === parent!.id && PENDING.includes(t.status),
      ).length;
      assert(
        live < l.maxChildrenPerTask,
        "children_limit",
        `Parent task already has ${live} live children (cap ${l.maxChildrenPerTask})`,
      );
    }
    return { parentTaskId: parent?.id, depth };
  }
  recordCreate(task: Task) {
    if (!task.invokedBy) return;
    const state = this.state(task.workflowId);
    state.counters.handoffs++;
    state.counters.spawned++;
    this.save(state);
  }
  /** Runs inside the status-transition transaction after the new state is stored. */
  onTransition(task: Task) {
    if (!["completed", "failed", "cancelled"].includes(task.status)) return;
    if (task.invokedBy && task.status !== "cancelled") {
      const state = this.state(task.workflowId);
      state.counters.handoffs++; // result/failure handed back to the invoker
      this.save(state);
    }
    if (task.parentTaskId)
      this.store.emit("delegation.returned", task.id, {
        parentTaskId: task.parentTaskId,
        childTaskId: task.id,
        workflowId: task.workflowId,
        outcome: task.status,
        partialResult: this.meta(task.id).partialResult ?? null,
      });
    if (task.status !== "cancelled") return;
    for (const child of this.store.list<Task>("task")) {
      if (child.parentTaskId !== task.id) continue;
      const reason = `Cancelled because ancestor task ${task.id} was cancelled.`;
      if (["queued", "interrupted", "blocked"].includes(child.status))
        this.service.transitionTask(child.id, {
          status: "cancelled",
          result: reason,
        });
      else if (child.status === "running") {
        const meta = this.meta(child.id);
        meta.cancelRequested = reason;
        this.saveMeta(meta);
        if (!this.abortTask(child.id))
          this.service.transitionTask(child.id, {
            status: "cancelled",
            result: reason,
          });
      }
    }
  }
  // ---- results of aborted/failed provider runs -------------------------------------------------
  /** Decides the terminal state of a task whose provider run ended abnormally and preserves partial text. */
  finishAbnormal(
    task: Task,
    aborted: boolean,
    message: string,
    partial: string,
  ): { status: "failed" | "cancelled"; result: string } {
    const meta = this.meta(task.id);
    if (partial.trim()) meta.partialResult = partial.slice(0, 100_000);
    this.saveMeta(meta);
    if (meta.stoppedByLimit)
      return {
        status: "failed",
        result: `Stopped by workflow limit: ${meta.stoppedByLimit}`,
      };
    if (aborted)
      return { status: "cancelled", result: meta.cancelRequested ?? message };
    return { status: "failed", result: message };
  }
  // ---- usage -----------------------------------------------------------------------------
  recordUsage(task: Task, data: unknown) {
    const u = (data ?? {}) as Record<string, unknown>;
    const num = (k: string) =>
      typeof u[k] === "number" && u[k] >= 0 ? (u[k] as number) : 0;
    const input = num("input_tokens"),
      output = num("output_tokens");
    if (!input && !output) return;
    const cache =
      num("cached_input_tokens") +
      num("cache_creation_input_tokens") +
      num("cache_read_input_tokens");
    const state = this.state(task.workflowId);
    state.counters.tokens.input += input;
    state.counters.tokens.output += output;
    state.counters.tokens.cache += cache;
    state.counters.tokens.reportingTurns++;
    this.save(state);
    this.sweep(task.workflowId);
  }
  // ---- completion checks --------------------------------------------------------------------
  setChecks(taskId: string, checks: CompletionCheck[]) {
    return this.store.transaction(() => {
      const task = this.store.get<Task>("task", taskId);
      assert(
        ["queued", "failed", "interrupted", "blocked"].includes(task.status),
        "task_started",
        "Completion checks can only change while a task is not running or finished",
      );
      task.completionChecks = checks;
      this.store.put("task", task);
      this.store.emit("task.updated", taskId, { agentId: task.agentId });
      return task;
    });
  }
  async evaluate(
    task: Task,
    result: string,
    cwd: string,
  ): Promise<CheckEvidence | null> {
    const checks = task.completionChecks ?? [];
    if (!checks.length) return null;
    const results: CheckResult[] = [];
    for (const check of checks)
      results.push(await this.runCheck(task, check, result, cwd));
    const evidence: CheckEvidence = {
      passed: results.every((r) => r.passed),
      resultHash: sha(result),
      at: new Date().toISOString(),
      results,
    };
    const meta = this.meta(task.id);
    meta.checks = evidence;
    meta.checkHistory = [...(meta.checkHistory ?? []), evidence].slice(-20);
    this.saveMeta(meta);
    this.store.emit("task.checks", task.id, {
      passed: evidence.passed,
      results: results.map((r) => ({
        type: r.check.type,
        passed: r.passed,
        detail: r.detail,
      })),
    });
    return evidence;
  }
  /** Hard gate used by transitionTask: returned text alone is never success when checks are declared. */
  assertCompletion(task: Task, result: string | undefined) {
    if (!task.completionChecks?.length) return;
    const ev = this.meta(task.id).checks;
    assert(
      ev?.passed && ev.resultHash === sha(result ?? ""),
      "completion_checks_failed",
      "Completion checks have not passed for this result" +
        (ev && !ev.passed
          ? ": " +
            ev.results
              .filter((r) => !r.passed)
              .map((r) => r.detail)
              .join("; ")
          : ""),
    );
  }
  failedChecksText(ev: CheckEvidence) {
    return (
      "Completion checks failed: " +
      ev.results
        .filter((r) => !r.passed)
        .map((r) => r.detail)
        .join("; ")
    );
  }
  private async runCheck(
    task: Task,
    check: CompletionCheck,
    result: string,
    cwd: string,
  ): Promise<CheckResult> {
    const done = (passed: boolean, detail: string) => ({
      check,
      passed,
      detail,
    });
    try {
      if (check.type === "output-fields") {
        const complete = contractObjects(result, check.fields);
        if (complete.length === 1)
          return done(true, "Required output fields present");
        if (complete.length > 1)
          return done(
            false,
            `Output is ambiguous: ${complete.length} different JSON objects carry the required field(s) ${check.fields.join(", ")}; return exactly one`,
          );
        let best: string[] = check.fields;
        for (const obj of jsonObjectCandidates(result)) {
          const missing = check.fields.filter((f) => !fieldPresent(obj[f]));
          if (missing.length < best.length) best = missing;
        }
        return done(
          false,
          `Output is missing required JSON field(s): ${best.join(", ")}`,
        );
      }
      if (check.type === "output-matches")
        return new RegExp(check.pattern, check.flags).test(result)
          ? done(true, "Output matches the required pattern")
          : done(
              false,
              `Output does not match /${check.pattern}/${check.flags}`,
            );
      if (check.type === "artifact-exists") {
        if (isAbsolute(check.path) || check.path.split(/[\\/]/).includes(".."))
          return done(
            false,
            `Artifact path ${check.path} must be relative and inside the workspace`,
          );
        const base = await realpath(cwd);
        const target = await realpath(resolve(base, check.path));
        const rel = relative(base, target);
        if (
          rel.startsWith("..") ||
          isAbsolute(rel) ||
          rel.split(sep).includes(".git")
        )
          return done(
            false,
            `Artifact ${check.path} resolves outside the workspace`,
          );
        return (await stat(target)).isFile()
          ? done(true, `Artifact ${check.path} exists`)
          : done(false, `Artifact ${check.path} is not a file`);
      }
      if (!task.requiresValidation)
        return done(
          false,
          "validation-gate check needs a task that requires validation",
        );
      const gate = this.service.validation.gate(task);
      return gate.open
        ? done(true, "Validation gate passed for the current inputs")
        : done(false, `Validation gate is closed (${gate.reason})`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      return done(
        false,
        check.type === "artifact-exists" && code === "ENOENT"
          ? `Artifact ${(check as { path: string }).path} does not exist`
          : `Check ${check.type} could not be evaluated: ${e instanceof Error ? e.message : "error"}`,
      );
    }
  }
  // ---- status ---------------------------------------------------------------------------
  status(workflowId: string) {
    this.store.get<Workflow>("workflow", workflowId);
    const state = this.state(workflowId);
    const t = state.counters.tokens;
    const tasks = this.store
      .list<Task>("task")
      .filter((x) => x.workflowId === workflowId);
    const silent = Math.max(0, state.counters.turns - t.reportingTurns);
    const runtimeSeconds = Math.round(this.runtimeMs(state) / 1000);
    const l = state.limits;
    return {
      workflowId,
      limits: l,
      trip: state.trip,
      counters: {
        agentTurns: state.counters.turns,
        handoffs: state.counters.handoffs,
        retries: state.counters.retries,
        spawnedAgents: state.counters.spawned,
        runtimeSeconds,
      },
      usage: {
        state:
          t.reportingTurns === 0
            ? "unavailable"
            : silent
              ? "partial"
              : "reported",
        inputTokens: t.reportingTurns ? t.input : null,
        outputTokens: t.reportingTurns ? t.output : null,
        cacheTokens: t.reportingTurns ? t.cache : null,
        totalTokens: t.reportingTurns ? t.input + t.output : null,
        reportingTurns: t.reportingTurns,
        turnsWithoutUsage: silent,
        note: "Token counts are only what providers report; cache tokens are listed separately and are not counted toward the budget. Wolfram runs and some adapters report none.",
        cost: {
          state: "unavailable",
          note: "No monetary cost is estimated. Subscription-quota usage is opaque, and API pricing varies by account; tokens are not converted to dollars.",
        },
      },
      history: state.history,
      tasks: tasks.map((x) => {
        const meta = this.meta(x.id);
        return {
          taskId: x.id,
          parentTaskId: x.parentTaskId ?? null,
          invokedBy: x.invokedBy ?? null,
          depth: x.invokedBy
            ? this.ancestors(x).filter((a) => a.invokedBy).length + 1
            : 0,
          childTaskIds: tasks
            .filter((c) => c.parentTaskId === x.id)
            .map((c) => c.id),
          status: x.status,
          partialResult: meta.partialResult ?? null,
          stoppedByLimit: meta.stoppedByLimit ?? null,
          completionChecks: x.completionChecks ?? [],
          checkEvidence: meta.checks ?? null,
        };
      }),
    };
  }
}
