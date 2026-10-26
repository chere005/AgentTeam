// The typed recovery decision (reliable-execution plan item 6).
//
// What Recovery shows for an interrupted, blocked or failed task and what its action then does
// come from ONE computation (`RecoveryService.decide`): the preview text (`describe()` / `next`),
// the retry gate and the action (`requeue`, `continueDelegation`) all read this object, so the page
// cannot promise "no provider call" for a button that makes one. It names the attempt the action
// works on and whether a provider invocation will happen, judged against the state the action will
// actually execute (a retry of a failed task starts the NEXT attempt under a new ledger key; a
// delegation continuation gets a new run key within the same attempt).
import type { ReadinessIssue, SetupAction } from "./launch-readiness.ts";

export const RECOVERY_KINDS = [
  /** A required capability, tool, folder or check is missing: repair it; the task then continues by itself. */
  "setup-repair",
  /** A failed task starts the next attempt: a new provider call under a new ledger key. */
  "new-attempt",
  /** An interrupted run continues in the same attempt: a provider call (a resumed session when it can be). */
  "resume-run",
  /** A parent whose delegated work is done gets a continuation turn in the same attempt. */
  "delegation-continuation",
  /** The provider already answered this attempt: finalize the saved output, no provider call. */
  "completion-only-replay",
  /** A mutating effect may or may not have happened: the user decides before anything runs. */
  "uncertain-effect-resolution",
] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export type RecoveryDecision = {
  kind: RecoveryKind;
  taskId: string;
  /** Whether the action can execute now; when not, `blocker` is the error the action raises. */
  allowed: boolean;
  blocker: { code: string; message: string } | null;
  /** The backend action that carries the decision out. */
  action:
    | "requeue"
    | "continue-delegation"
    | "decide-effect"
    | "repair-setup"
    | "wait";
  /** The attempt this works on, the attempt number current afterwards and the cap. */
  attempt: { current: number; after: number; max: number };
  consumesAttempt: boolean;
  /** Delegation continuations only (limit 3 per attempt). */
  continuation: { current: number; after: number; max: number } | null;
  /** True exactly when executing the action makes a provider invocation. */
  providerCall: boolean;
  /** The ledger key the next run uses and whether the ledger replays it instead of calling the provider. */
  run: { key: string; replay: boolean } | null;
  /** "resume" only when the provider session can actually be resumed (task-scoped runs start fresh). */
  session: "none" | "fresh" | "resume";
  resumesSessionId: string | null;
  /** One sentence for the button's tooltip; it matches what the action does. */
  summary: string;
  /** What `describe().next` lists (approvals and uncertain effects first). */
  steps: string[];
  /** Setup repair: the typed causes and the one repair to offer first. */
  setup: {
    reason: string;
    message: string;
    issues: ReadinessIssue[];
    action: SetupAction | null;
    /** What happens by itself once the repair is done. */
    then: Pick<RecoveryDecision, "kind" | "providerCall" | "summary"> | null;
  } | null;
  /** Uncertain effects: each choice and whether it leads to a provider call. */
  outcomes:
    | {
        decision: "retry" | "completed" | "abandon";
        label: string;
        providerCall: boolean;
      }[]
    | null;
  /** Cancelling this task: the delegated work the existing cascade cancels with it. */
  cancel: {
    allowed: boolean;
    cascades: { taskId: string; title: string; status: string }[];
  };
};
