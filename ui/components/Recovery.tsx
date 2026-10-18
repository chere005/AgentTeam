import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import "./recovery.css";

type Effect = { id: string; description: string; kind: string };
type Approval = {
  id: string;
  orphaned?: boolean;
  request: {
    toolCall?: { title?: string };
    options: { optionId: string; name: string }[];
  };
};
type TaskRecovery = {
  task: { id: string; title: string; status: string; workflowId: string };
  attempt: number;
  resumes: number;
  policy: { maxAttempts: number; auto: boolean };
  providerSessionId: string | null;
  reason: string | null;
  checkpoint: {
    id: string;
    seq: number;
    boundary: string;
    nextStep: string;
    createdAt: string;
  } | null;
  next: string[];
  completedEffects: string[];
  uncertainEffects: Effect[];
  pendingApprovals: Approval[];
  retry: { allowed: boolean; reason: string; notBefore: string | null };
};
type Overview = { tasks: TaskRecovery[] };

/**
 * Resumable checkpoint per interrupted/blocked/failed task: what runs next, retry from the
 * checkpoint, uncertain external effects needing a decision, and approvals that survived a restart.
 */
export function WorkflowRecovery({
  workflowId,
  act,
}: {
  workflowId: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [items, setItems] = useState<TaskRecovery[]>([]);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const view: Overview = await api("/recovery");
      setItems(view.tasks.filter((t) => t.task.workflowId === workflowId));
    } catch {
      /* backend restarting */
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent((e) => {
      if (
        /^(task|approval|effect|checkpoint|tasks)[.]/.test(e.type) ||
        e.type.startsWith("workflow.")
      )
        void load();
    });
  }, [load]);
  if (!items.length) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await act(fn);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section
      className="recovery-panel"
      aria-label="Recovery"
      data-testid="recovery-panel"
    >
      <b>Recovery</b>
      {items.map((r) => (
        <article
          key={r.task.id}
          className="recovery-task"
          data-testid="recovery-task"
        >
          <div className="row between">
            <span>{r.task.title}</span>
            <span className={"badge recovery-" + r.task.status}>
              {r.task.status}
            </span>
          </div>
          {r.reason && <p className="quiet">{r.reason}</p>}
          {r.checkpoint && (
            <p className="quiet" data-testid="recovery-checkpoint">
              Checkpoint #{r.checkpoint.seq} · {r.checkpoint.boundary} · attempt{" "}
              {r.attempt} of {r.policy.maxAttempts}
              {r.providerSessionId
                ? ` · provider session ${r.providerSessionId}`
                : ""}
            </p>
          )}
          <div>
            <small>Runs next</small>
            <ol className="recovery-next" data-testid="recovery-next">
              {r.next.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ol>
          </div>
          {r.completedEffects.length > 0 && (
            <small data-testid="recovery-completed">
              Already completed, will not repeat:{" "}
              {r.completedEffects.join("; ")}
            </small>
          )}
          {r.pendingApprovals.map((a) => (
            <div
              key={a.id}
              className="recovery-box"
              data-testid="recovery-approval"
            >
              <span>
                Pending approval: {a.request.toolCall?.title ?? "tool action"}
                {a.orphaned ? " (kept across restart)" : ""}
              </span>
              <div className="row">
                {a.request.options.map((o) => (
                  <button
                    key={o.optionId}
                    onClick={() =>
                      void run(() =>
                        api("/approvals/" + a.id, "POST", {
                          optionId: o.optionId,
                        }),
                      )
                    }
                  >
                    {o.name}
                  </button>
                ))}
                <button
                  onClick={() =>
                    void run(() =>
                      api("/approvals/" + a.id, "POST", { optionId: null }),
                    )
                  }
                >
                  Cancel request
                </button>
              </div>
            </div>
          ))}
          {r.uncertainEffects.map((e) => (
            <div
              key={e.id}
              className="recovery-box"
              data-testid="recovery-effect"
            >
              <span>
                Uncertain: {e.description}. It may or may not have been applied.
              </span>
              {e.kind === "provider-run" && (
                <input
                  aria-label="Result if it was applied"
                  placeholder="Result, only if marking applied"
                  value={results[e.id] ?? ""}
                  onChange={(ev) =>
                    setResults({ ...results, [e.id]: ev.target.value })
                  }
                />
              )}
              <div className="row">
                {(
                  [
                    ["retry", "Not applied: allow retry"],
                    ["completed", "Mark as applied"],
                    ["abandon", "Abandon task"],
                  ] as const
                ).map(([decision, label]) => (
                  <button
                    key={decision}
                    onClick={() =>
                      void run(() =>
                        api("/effects/" + e.id + "/decision", "POST", {
                          decision,
                          ...(decision === "completed" && results[e.id]
                            ? { result: results[e.id] }
                            : {}),
                        }),
                      )
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="row">
            <button
              disabled={
                !r.retry.allowed ||
                r.pendingApprovals.length > 0 ||
                r.uncertainEffects.length > 0
              }
              title={r.retry.reason}
              onClick={() =>
                void run(() =>
                  api(
                    "/tasks/" +
                      r.task.id +
                      (r.task.status === "interrupted"
                        ? "/resume"
                        : "/retry-from-checkpoint"),
                    "POST",
                    {},
                  ),
                )
              }
            >
              {r.task.status === "failed"
                ? "Retry from checkpoint"
                : "Resume from checkpoint"}
            </button>
            {r.task.status !== "failed" && (
              <button
                onClick={() =>
                  void run(() =>
                    api("/tasks/" + r.task.id + "/status", "POST", {
                      status: "cancelled",
                    }),
                  )
                }
              >
                Cancel
              </button>
            )}
            <small className="quiet">{r.retry.reason}</small>
          </div>
        </article>
      ))}
      {error && (
        <p className="limit-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
