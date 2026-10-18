import { createHash, randomUUID } from "node:crypto";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { Store } from "./store.ts";
import { assert } from "./model.ts";
export type Approval = {
  id: string;
  agentId: string;
  /** Task whose provider run raised the request; lets recovery attach it to a checkpoint. */
  taskId?: string;
  request: RequestPermissionRequest;
  createdAt: string;
  /** True once the provider process that asked is gone (restart); the answer is kept for the retried run. */
  orphaned?: boolean;
};
/** Persisted (`approval` entity) request, answer history and replay memo. */
export type ApprovalRecord = Approval & {
  fingerprint: string;
  status: "pending" | "resolved";
  response?: RequestPermissionResponse;
  resolvedAt?: string;
  answeredAfterRestart?: boolean;
  /** An after-restart answer was applied to the identical request raised by the resumed run. */
  consumed?: boolean;
};
/** Stable identity of what is being asked, independent of per-run tool call ids. */
export function approvalFingerprint(
  agentId: string,
  taskId: string | undefined,
  request: RequestPermissionRequest,
) {
  const call = (request.toolCall ?? {}) as Record<string, unknown>;
  return createHash("sha256")
    .update(
      JSON.stringify([
        agentId,
        taskId ?? null,
        call.title ?? null,
        call.kind ?? null,
        call.rawInput ?? null,
        call.locations ?? null,
        request.options.map((o) => o.optionId),
      ]),
    )
    .digest("hex");
}
export class Approvals {
  store: Store;
  /** Set by RecoveryService: records approval boundaries as task checkpoints. */
  observer?: (kind: "requested" | "resolved", approval: ApprovalRecord) => void;
  pending = new Map<
    string,
    {
      approval: Approval;
      resolve: (response: RequestPermissionResponse) => void;
    }
  >();
  constructor(store: Store) {
    this.store = store;
  }
  private records() {
    return this.store.list<ApprovalRecord>("approval");
  }
  /** Live approvals plus those restored after a restart (answerable, provider process gone). */
  list(): Approval[] {
    const live = [...this.pending.values()].map((p) => p.approval);
    const restored = this.records()
      .filter((r) => r.status === "pending" && !this.pending.has(r.id))
      .map(({ id, agentId, taskId, request, createdAt }) => ({
        id,
        agentId,
        taskId,
        request,
        createdAt,
        orphaned: true,
      }));
    return [...live, ...restored];
  }
  history(): ApprovalRecord[] {
    return this.records();
  }
  pendingFor(taskId: string) {
    return this.list().filter((a) => a.taskId === taskId);
  }
  /** Startup: persisted pending approvals have lost their provider process; keep them answerable. */
  restore() {
    for (const r of this.records())
      if (r.status === "pending" && !this.pending.has(r.id) && !r.orphaned)
        this.store.put("approval", { ...r, orphaned: true });
  }
  request(
    agentId: string,
    request: RequestPermissionRequest,
    signal: AbortSignal,
    taskId?: string,
  ) {
    const fingerprint = approvalFingerprint(agentId, taskId, request);
    // An answer given after a restart is applied once to the identical request of the resumed run.
    // Only task runs resume; a chat request without a task id never inherits another run's answer.
    const memo =
      taskId === undefined
        ? undefined
        : this.records().find(
            (r) =>
              r.taskId === taskId &&
              r.fingerprint === fingerprint &&
              r.answeredAfterRestart &&
              !r.consumed &&
              r.response,
          );
    if (memo) {
      this.store.put("approval", { ...memo, consumed: true });
      this.store.emit("approval.replayed", agentId, { id: memo.id });
      return Promise.resolve(memo.response!);
    }
    return new Promise<RequestPermissionResponse>((resolve) => {
      const id = randomUUID(),
        approval: Approval = {
          id,
          agentId,
          taskId,
          request,
          createdAt: new Date().toISOString(),
        };
      const record: ApprovalRecord = {
        ...approval,
        fingerprint,
        status: "pending",
      };
      const finish = (response: RequestPermissionResponse) => {
        this.pending.delete(id);
        signal.removeEventListener("abort", cancel);
        const resolved: ApprovalRecord = {
          ...record,
          status: "resolved",
          response,
          resolvedAt: new Date().toISOString(),
        };
        this.store.put("approval", resolved);
        this.store.emit("approval.resolved", agentId, {
          id,
          outcome: response.outcome,
        });
        this.observer?.("resolved", resolved);
        resolve(response);
      };
      const cancel = () => finish({ outcome: { outcome: "cancelled" } });
      this.pending.set(id, { approval, resolve: finish });
      signal.addEventListener("abort", cancel, { once: true });
      this.store.put("approval", record);
      this.store.emit("approval.requested", agentId, { id });
      this.observer?.("requested", record);
      if (signal.aborted) cancel();
    });
  }
  respond(id: string, optionId: string | null) {
    const pending = this.pending.get(id);
    if (!pending) return this.respondRestored(id, optionId);
    assert(
      optionId === null ||
        pending.approval.request.options.some((o) => o.optionId === optionId),
      "invalid_option",
      "Unknown approval option",
      400,
    );
    pending.resolve({
      outcome:
        optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
    });
    return { status: "resolved" };
  }
  /** Answers an approval whose provider process did not survive a restart; recorded for the resumed run. */
  private respondRestored(id: string, optionId: string | null) {
    let record: ApprovalRecord | undefined;
    try {
      record = this.store.get<ApprovalRecord>("approval", id);
    } catch {
      /* unknown id */
    }
    assert(
      record && record.status === "pending",
      "approval_expired",
      "This approval is no longer pending",
      409,
    );
    assert(
      optionId === null ||
        record.request.options.some((o) => o.optionId === optionId),
      "invalid_option",
      "Unknown approval option",
      400,
    );
    const response: RequestPermissionResponse = {
      outcome:
        optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
    };
    const resolved: ApprovalRecord = {
      ...record,
      orphaned: true,
      status: "resolved",
      response,
      resolvedAt: new Date().toISOString(),
      answeredAfterRestart: true,
    };
    this.store.transaction(() => {
      this.store.put("approval", resolved);
      this.store.emit("approval.resolved", record.agentId, {
        id,
        outcome: response.outcome,
        afterRestart: true,
      });
    });
    this.observer?.("resolved", resolved);
    return { status: "resolved" };
  }
  /**
   * A task that finished (completed/cancelled) will never resume, so its restored approvals
   * (provider process already gone) are closed instead of staying answerable forever.
   */
  expireFor(taskId: string) {
    for (const r of this.records())
      if (
        r.taskId === taskId &&
        r.status === "pending" &&
        !this.pending.has(r.id)
      ) {
        this.store.put("approval", {
          ...r,
          orphaned: true,
          status: "resolved",
          response: { outcome: { outcome: "cancelled" } },
          resolvedAt: new Date().toISOString(),
        });
        this.store.emit("approval.expired", r.agentId, { id: r.id, taskId });
      }
  }
  cancelAgent(agentId: string) {
    for (const { approval, resolve } of [...this.pending.values()])
      if (approval.agentId === agentId)
        resolve({ outcome: { outcome: "cancelled" } });
  }
}
