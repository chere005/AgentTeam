type Request = (
  path: string,
  method: "POST",
  body: { workspace: string },
) => Promise<unknown>;

type Subscription = {
  users: number;
  pending: Promise<void>;
  renewal?: ReturnType<typeof setInterval>;
};

/** The backend has one lease per agent/folder, shared by Files, Git and Diff. */
export class WorkspaceWatchSubscriptions {
  private subscriptions = new Map<string, Subscription>();
  private request: Request;

  constructor(request: Request) {
    this.request = request;
  }

  subscribe(agentId: string, workspace: string) {
    const key = JSON.stringify([agentId, workspace]);
    let subscription = this.subscriptions.get(key);
    if (!subscription) {
      subscription = { users: 0, pending: Promise.resolve() };
      this.subscriptions.set(key, subscription);
    }
    const entry = subscription;
    const send = (action: "start" | "stop") => {
      // A previous view's slow stop must finish before its replacement starts the same lease.
      entry.pending = entry.pending.then(async () => {
        try {
          await this.request(`/agents/${agentId}/watch/${action}`, "POST", {
            workspace,
          });
        } catch {
          // Refresh remains available if watching cannot be established.
        }
      });
      return entry.pending;
    };
    if (entry.users++ === 0) {
      void send("start");
      entry.renewal = setInterval(() => void send("start"), 30_000);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.users > 0) return;
      clearInterval(entry.renewal);
      const stopped = send("stop");
      void stopped.then(() => {
        if (!entry.users && entry.pending === stopped)
          this.subscriptions.delete(key);
      });
    };
  }
}
