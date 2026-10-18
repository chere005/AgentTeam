import { randomUUID } from "node:crypto";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { Store } from "./store.ts";
import { assert } from "./model.ts";
export type Approval = {
  id: string;
  agentId: string;
  request: RequestPermissionRequest;
  createdAt: string;
};
export class Approvals {
  store: Store;
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
  list() {
    return [...this.pending.values()].map((p) => p.approval);
  }
  request(
    agentId: string,
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) {
    return new Promise<RequestPermissionResponse>((resolve) => {
      const id = randomUUID(),
        approval = {
          id,
          agentId,
          request,
          createdAt: new Date().toISOString(),
        };
      const finish = (response: RequestPermissionResponse) => {
        this.pending.delete(id);
        signal.removeEventListener("abort", cancel);
        this.store.emit("approval.resolved", agentId, {
          id,
          outcome: response.outcome,
        });
        resolve(response);
      };
      const cancel = () => finish({ outcome: { outcome: "cancelled" } });
      this.pending.set(id, { approval, resolve: finish });
      signal.addEventListener("abort", cancel, { once: true });
      this.store.emit("approval.requested", agentId, { id });
      if (signal.aborted) cancel();
    });
  }
  respond(id: string, optionId: string | null) {
    const pending = this.pending.get(id);
    assert(
      pending,
      "approval_expired",
      "This approval is no longer pending",
      409,
    );
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
  cancelAgent(agentId: string) {
    for (const { approval, resolve } of [...this.pending.values()])
      if (approval.agentId === agentId)
        resolve({ outcome: { outcome: "cancelled" } });
  }
}
