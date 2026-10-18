import { useEffect, useState } from "react";
import { api } from "../api";
import { sparklinePoints } from "../instruction-length";

type Run = {
  seq: number;
  at: string;
  label: string;
  kind: "task" | "conversation";
  total: number;
  role: number;
  instructions: number;
  skills: number;
  knowledge: number;
  skillsLoaded: number;
  skillsListed: number;
};
type Cost = {
  runs: Run[];
  summary: { count: number; latest: number; average: number; max: number };
  note: string;
};

/**
 * Approximate instruction-context cost of an agent's recent runs (from `run.context` events):
 * a small inline sparkline plus a short list with the split between role, instructions, skills
 * and knowledge. No chart library.
 */
export function ContextCost({ agentId }: { agentId: string }) {
  const [cost, setCost] = useState<Cost | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api(`/agents/${agentId}/context-cost?limit=30`)
      .then((c) => live && (setCost(c), setError("")))
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [agentId]);
  if (error) return <p className="hint bad-text">{error}</p>;
  if (!cost) return null;
  const recent = [...cost.runs].reverse().slice(0, 8);
  return (
    <section className="context-cost" data-testid="context-cost">
      <h3>Context cost per run</h3>
      {!cost.runs.length ? (
        <p className="hint" data-testid="context-cost-empty">
          No runs recorded yet. Each run records the approximate size of the
          instructions it received.
        </p>
      ) : (
        <>
          <p>
            <svg
              role="img"
              aria-label={`Context cost of the last ${cost.runs.length} run(s), latest ~${cost.summary.latest} tokens`}
              width="160"
              height="28"
              viewBox="0 0 160 28"
              className="sparkline"
            >
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                points={sparklinePoints(
                  cost.runs.map((r) => r.total),
                  160,
                  26,
                )}
              />
            </svg>{" "}
            <small data-testid="context-cost-summary">
              latest ~{cost.summary.latest.toLocaleString()} · average ~
              {cost.summary.average.toLocaleString()} · max ~
              {cost.summary.max.toLocaleString()} tokens over{" "}
              {cost.summary.count} run(s)
            </small>
          </p>
          <ul className="cap-list" data-testid="context-cost-runs">
            {recent.map((r) => (
              <li key={r.seq}>
                <b>{r.label}</b>{" "}
                <small>~{r.total.toLocaleString()} tokens</small>{" "}
                <small className="quiet">
                  role {r.role} · instructions {r.instructions} · skills{" "}
                  {r.skills} ({r.skillsLoaded} loaded, {r.skillsListed} listed)
                  · knowledge {r.knowledge} · {new Date(r.at).toLocaleString()}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
      <small className="quiet">{cost.note}</small>
    </section>
  );
}
