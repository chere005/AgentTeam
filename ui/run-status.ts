/**
 * The one run-status vocabulary and mapping for every work view (canvas cards, chat, projects,
 * inspector, recovery, project header). Pure; tested in test/run-status.test.ts.
 *
 *   queued       waiting its turn (dependencies, a free slot, a locked folder, delegated work)
 *   running      a provider turn is in progress
 *   waiting for you   only the user can move it: paused project, human control, interrupted run to resume
 *   blocked      cannot proceed until something else changes (failed dependency, gate, uncertain effect)
 *   failed       finished unsuccessfully (including a "completed" result that does not satisfy its task)
 *   done         finished successfully
 * plus `idle` (nothing to do), `cancelled` and `superseded` (replaced by verified work).
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting-you"
  | "blocked"
  | "failed"
  | "done"
  | "idle"
  | "cancelled"
  | "superseded";

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "queued",
  running: "running",
  "waiting-you": "waiting for you",
  blocked: "blocked",
  failed: "failed",
  done: "done",
  idle: "idle",
  cancelled: "cancelled",
  superseded: "superseded",
};
export const runStatusLabel = (s: RunStatus) => RUN_STATUS_LABEL[s];

/** Queued-task wait reasons (TeamService.taskState) that only the user can resolve. */
const USER_WAITS = new Set(["workflow-paused", "human-control"]);
/** Queued-task wait reasons that mean progress needs something else to change first. */
const BLOCKED_WAITS = new Set([
  "dependency-failed",
  "validation-required",
  "review-required",
  "global-filesystem-block",
]);

/** Pick the most significant wait code (user-actionable, then blocking, then any). */
export function primaryWaitReason(codes: readonly string[]): string | null {
  return (
    codes.find((c) => USER_WAITS.has(c)) ??
    codes.find((c) => BLOCKED_WAITS.has(c)) ??
    codes[0] ??
    null
  );
}

export type TaskLike = {
  status: string;
  waitReason?: string | null;
  supersededBy?: string | null;
  /** The result does not satisfy the task even though it was marked completed. */
  problem?: boolean;
  /** The task waits for delegated child work (not a failure). */
  delegationWaiting?: boolean;
};

export function taskRunStatus(t: TaskLike): RunStatus {
  if (t.supersededBy) return "superseded";
  if (t.problem) return "failed";
  switch (t.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "interrupted":
      return "waiting-you";
    case "blocked":
      return t.delegationWaiting ? "queued" : "blocked";
    case "queued": {
      const w = t.waitReason ?? "";
      if (USER_WAITS.has(w)) return "waiting-you";
      if (BLOCKED_WAITS.has(w)) return "blocked";
      return "queued";
    }
    default:
      return "queued";
  }
}

/** Agent activity state from `TeamService.activity` (+ whether it has failed tasks). */
export function agentRunStatus(state: string, failed = false): RunStatus {
  if (failed) return "failed";
  switch (state) {
    case "processing":
      return "running";
    case "human-control":
    case "interrupted":
      return "waiting-you";
    case "blocked":
      return "blocked";
    case "waiting":
      return "queued";
    default:
      return "idle";
  }
}

/** Project (workflow) rollup from `TeamService.workflowStatus`. */
export function projectRunStatus(status: string): RunStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "paused":
    case "needs-attention":
      return "waiting-you";
    case "queued":
      return "queued";
    default:
      return "idle";
  }
}
