/**
 * Work that failed ONLY because its provider runtime was missing or signed out
 * (`runtime_unavailable` or `sandbox_unavailable`, before any provider process started). The scheduler records one
 * `runtime-wait` entity per failed task or chat request; `src/readiness.ts` re-queues it once that
 * runtime is ready again (tasks through `recovery.requeue`, the same path as Retry, so the failed
 * attempt's checkpoint and handoff note stay as they are; chats by re-queuing the still-queued
 * user messages) and removes the record either way.
 */
import type { Store } from "./store.ts";
import type { ReadinessIssue } from "./launch-readiness.ts";

export type RuntimeWait = {
  /** `task:<taskId>` or `chat:<sessionId>`. */
  id: string;
  kind: "task" | "chat";
  targetId: string;
  environment: string;
  /**
   * Missing on legacy records, which describe a missing/signed-out runtime. `capability-missing`:
   * the role cannot do the work its contract needs (no writable folder, tool not granted, adapter
   * unsupported); `check-unconfirmed`: a required check is still unverified (src/execution-contract.ts).
   */
  reason?:
    | "runtime-unavailable"
    | "sandbox-unavailable"
    | "capability-missing"
    | "check-unconfirmed"
    | "assignment-preparation";
  /** Capability waits are recorded only for a known pre-process refusal, never provider output. */
  capability?:
    | "sandboxed-shell"
    | "tools-and-folders"
    | "required-check"
    | "prepared-project";
  /** Actionable blocker displayed while a capability wait persists. */
  message?: string;
  /** Typed causes with one repair each (capability-missing), bounded and free of secrets. */
  issues?: ReadinessIssue[];
  /** Recovery attempt that failed (tasks): a later attempt means someone already retried it. */
  attempt?: number;
  at: string;
};
export const RUNTIME_WAIT = "runtime-wait";
/** Waits that stop a task before any provider effect and persist until the cause is repaired. */
export const CAPABILITY_WAIT_REASONS = [
  "sandbox-unavailable",
  "capability-missing",
  "check-unconfirmed",
  "assignment-preparation",
] as const;
export const isCapabilityWait = (wait: Pick<RuntimeWait, "reason">) =>
  CAPABILITY_WAIT_REASONS.includes(
    wait.reason as (typeof CAPABILITY_WAIT_REASONS)[number],
  );
/** The `taskState().runtimeBlocker.code` for a wait. */
export const blockerCode = (wait: Pick<RuntimeWait, "reason">) =>
  wait.reason === "assignment-preparation"
    ? ("assignment_preparation" as const)
    : wait.reason === "capability-missing"
      ? ("capability_missing" as const)
      : wait.reason === "check-unconfirmed"
        ? ("check_unconfirmed" as const)
        : ("sandbox_unavailable" as const);
/** A wait older than this is dropped instead of re-queued (the user has likely moved on). */
export const RUNTIME_WAIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function noteRuntimeWait(
  store: Store,
  wait: Omit<RuntimeWait, "id" | "at">,
) {
  try {
    store.put(RUNTIME_WAIT, {
      ...wait,
      id: `${wait.kind}:${wait.targetId}`,
      at: new Date().toISOString(),
    } satisfies RuntimeWait);
  } catch {
    /* best effort: without the record the work stays failed and Retry still works */
  }
}
