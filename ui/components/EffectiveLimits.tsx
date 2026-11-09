import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import {
  formatLimitRow,
  type EffectiveLimits as Effective,
  type LimitRow,
  type LimitSource,
} from "../../src/effective-limits";
import type { FeatureId } from "../features";
import "./limits.css";

const SOURCE_LABEL: Record<LimitSource, string> = {
  project: "Project",
  agent: "Agent",
  team: "Team",
  provider: "Provider",
};

/** Where each source is edited. Agent limits live in the agent editor's Advanced section. */
function editTarget(
  row: LimitRow,
  openFeature?: (id: FeatureId) => void,
): { label: string; run: () => void } | null {
  switch (row.edit.target) {
    case "project":
      return openFeature
        ? { label: "Edit in Usage & limits", run: () => openFeature("usage") }
        : null;
    case "agent":
      return {
        label: "Edit in agent Advanced",
        run: () => {
          const el = document.querySelector<HTMLDetailsElement>(
            '[data-testid="agent-advanced"]',
          );
          if (el) {
            el.open = true;
            el.scrollIntoView({ block: "nearest" });
          }
        },
      };
    case "provider":
      return openFeature
        ? { label: "Runtime settings", run: () => openFeature("settings") }
        : null;
    default:
      return null;
  }
}

/** The one compact "Limits" block: effective limits for a run and which one binds. */
export function EffectiveLimits({
  workflowId,
  agentId,
  openFeature,
}: {
  workflowId?: string;
  agentId?: string;
  openFeature?: (id: FeatureId) => void;
}) {
  const [view, setView] = useState<Effective | null>(null);
  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (workflowId) qs.set("workflowId", workflowId);
    if (agentId) qs.set("agentId", agentId);
    try {
      setView(await api("/limits/effective?" + qs.toString()));
    } catch {
      /* entity removed */
    }
  }, [workflowId, agentId]);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent((e) => {
      if (/^(workflow|task|agent|session)\./.test(e.type)) void load();
    });
  }, [load]);
  if (!view) return null;
  // Per-task shape limits are noise unless set; keep the block short.
  const rows = view.rows.filter(
    (r) =>
      r.state !== "unlimited" &&
      !(r.scope === "task" && r.key.endsWith("depth") && r.max === 4),
  );
  const sources = [...new Set(rows.map((r) => r.source))];
  const binding = view.rows.find((r) => r.binding);
  return (
    <section
      className="effective-limits"
      data-testid="effective-limits"
      aria-label="Limits"
    >
      <h4>
        Limits
        {binding && (
          <span
            className={
              "badge" + (binding.state === "reached" ? " limit-stopped" : "")
            }
            data-testid="binding-limit"
          >
            binding: {binding.label}
          </span>
        )}
      </h4>
      {view.trip && (
        <p className="limit-trip" role="alert">
          Stopped by limit: {view.trip.reason}
        </p>
      )}
      {!rows.length && <p className="hint">No limits set.</p>}
      {sources.map((source) => {
        const group = rows.filter((r) => r.source === source);
        const edit = editTarget(group[0], openFeature);
        return (
          <div className="effective-limits-group" key={source}>
            <div className="effective-limits-source">
              <b>{SOURCE_LABEL[source]}</b>
              {edit && (
                <button
                  type="button"
                  className="text-button"
                  onClick={edit.run}
                >
                  {edit.label}
                </button>
              )}
            </div>
            <ul>
              {group.map((r) => (
                <li
                  key={r.key}
                  data-testid={"limit-" + r.key}
                  data-state={r.state}
                  className={r.binding ? "binding" : undefined}
                >
                  <span>{r.label}</span>
                  <span>
                    {formatLimitRow(r)}
                    {r.binding && " (binds)"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
