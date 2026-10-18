import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import "./limits.css";

type LimitKey =
  | "maxRuntimeSeconds"
  | "maxAgentTurns"
  | "maxHandoffs"
  | "maxRetries"
  | "maxSpawnedAgents"
  | "maxTokens"
  | "maxChildrenPerTask"
  | "maxDelegationDepth";
type LimitsView = {
  limits: Record<LimitKey, number | null>;
  trip: null | { kind: string; reason: string; at: string };
  counters: {
    agentTurns: number;
    handoffs: number;
    retries: number;
    spawnedAgents: number;
    runtimeSeconds: number;
  };
  usage: {
    state: "unavailable" | "partial" | "reported";
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheTokens: number | null;
    turnsWithoutUsage: number;
    cost: { state: string; note: string };
  };
  history: { type: string; at: string }[];
};
const FIELDS: {
  key: LimitKey;
  label: string;
  counter?: keyof LimitsView["counters"];
}[] = [
  {
    key: "maxRuntimeSeconds",
    label: "Max runtime (s)",
    counter: "runtimeSeconds",
  },
  { key: "maxAgentTurns", label: "Max agent turns", counter: "agentTurns" },
  { key: "maxHandoffs", label: "Max handoffs", counter: "handoffs" },
  { key: "maxRetries", label: "Max retries", counter: "retries" },
  {
    key: "maxSpawnedAgents",
    label: "Max spawned agents",
    counter: "spawnedAgents",
  },
  { key: "maxTokens", label: "Token budget (reported)" },
  { key: "maxChildrenPerTask", label: "Max children per task" },
  { key: "maxDelegationDepth", label: "Max delegation depth" },
];
const text = (v: number | null) => (v === null ? "" : String(v));

/** Per-workflow stopping limits: editor, consumption and the exact reason a workflow stopped. */
export function WorkflowLimits({
  workflowId,
  act,
}: {
  workflowId: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<LimitsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setView(await api("/workflows/" + workflowId + "/limits"));
    } catch {
      /* workflow removed */
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent((e) => {
      if (e.type.startsWith("workflow.") || e.type.startsWith("task."))
        void load();
    });
  }, [load]);
  if (!view) return null;
  const form =
    draft ??
    Object.fromEntries(FIELDS.map((f) => [f.key, text(view.limits[f.key])]));
  const body = () => {
    const out: Record<string, number | null> = {};
    for (const f of FIELDS) {
      const raw = (form[f.key] ?? "").trim();
      if (!raw) {
        if (f.key !== "maxDelegationDepth") out[f.key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`${f.label} must be a whole number of at least 1`);
      out[f.key] = n;
    }
    return out;
  };
  const submit = async (resume: boolean) => {
    setError("");
    try {
      const limits = body();
      await api(
        "/workflows/" + workflowId + "/limits" + (resume ? "/resume" : ""),
        resume ? "POST" : "PUT",
        resume ? { limits } : limits,
      );
      await act(async () => undefined); // refresh the shared snapshot (workflow paused state)
      setDraft(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const u = view.usage;
  return (
    <details className="limits-panel" aria-label="Workflow limits">
      <summary>
        Limits
        {view.trip ? (
          <span className="badge limit-stopped">stopped: {view.trip.kind}</span>
        ) : null}
      </summary>
      {view.trip && (
        <p className="limit-trip" data-testid="limit-trip" role="alert">
          Stopped by limit: {view.trip.reason}
        </p>
      )}
      <div className="limit-grid">
        {FIELDS.map((f) => (
          <label key={f.key}>
            <span>
              {f.label}
              {f.counter && (
                <small data-testid={"used-" + f.key}>
                  {" "}
                  used {view.counters[f.counter]}
                </small>
              )}
              {f.key === "maxTokens" && (
                <small data-testid="used-maxTokens">
                  {" "}
                  {u.totalTokens === null
                    ? "usage unavailable"
                    : `used ${u.totalTokens}`}
                </small>
              )}
            </span>
            <input
              inputMode="numeric"
              placeholder={f.key === "maxDelegationDepth" ? "4" : "unlimited"}
              value={form[f.key] ?? ""}
              onChange={(e) => setDraft({ ...form, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <p className="hint" data-testid="usage-note">
        Token usage: {u.state}
        {u.turnsWithoutUsage > 0 &&
          ` (${u.turnsWithoutUsage} turns reported none)`}
        {u.totalTokens !== null &&
          `, ${u.inputTokens} in / ${u.outputTokens} out`}
        . Cost: {u.cost.state}. {u.cost.note}
      </p>
      {error && (
        <p className="limit-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button onClick={() => void submit(false)}>Save limits</button>
        {view.trip && (
          <button className="primary" onClick={() => void submit(true)}>
            Extend and resume
          </button>
        )}
      </div>
    </details>
  );
}
