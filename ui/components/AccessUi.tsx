import { useEffect, useState } from "react";
import { Plus, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { api } from "../api";
import type { AccessRule, RuledWorkspace } from "../access-view";
import "./cooperation.css";

export const EXTERNAL_TEXT =
  "AgentTeam locks are cooperative and cover only work AgentTeam launches (tasks, chat runs, Git actions). External editors, interactive CLI sessions and native apps are outside this enforcement and can write to leased paths at any time.";

/** Always-visible label: what AgentTeam can and cannot enforce. */
export function ExternalNotice({ holder }: { holder?: string }) {
  const outside = holder === "cli" || holder === "native";
  return (
    <p
      className={"external-notice" + (outside ? " active" : "")}
      data-testid="external-notice"
    >
      <ShieldAlert size={14} />
      <span>
        {outside && (
          <b>
            {holder === "cli"
              ? "Interactive CLI session"
              : "Native app session"}{" "}
            is outside lock enforcement.{" "}
          </b>
        )}
        {EXTERNAL_TEXT}
      </span>
    </p>
  );
}

/** Add/remove file and folder rules (and exclusions) for one attached folder. */
export function RulesEditor({
  ws,
  onChange,
}: {
  ws: RuledWorkspace;
  onChange: (next: { rules: AccessRule[]; explicitOnly: boolean }) => void;
}) {
  const rules = ws.rules ?? [];
  const [path, setPath] = useState("");
  const [access, setAccess] = useState<AccessRule["access"]>("none");
  const set = (r: AccessRule[], explicitOnly = !!ws.explicitOnly) =>
    onChange({ rules: r, explicitOnly });
  return (
    <details className="rules-editor" open={rules.length > 0}>
      <summary>
        Files, exclusions and inherited rules
        {rules.length ? ` (${rules.length})` : ""}
      </summary>
      <p className="hint">
        Paths are relative to this folder. An exclusion always wins; otherwise
        the most specific rule applies, then the folder access above.
      </p>
      <label className="inline">
        <input
          type="checkbox"
          aria-label={"Only listed paths for " + ws.path}
          checked={!!ws.explicitOnly}
          onChange={(e) => set(rules, e.target.checked)}
        />
        Grant only the listed files and folders (not the whole folder)
      </label>
      {rules.map((r, i) => (
        <div className="rule-row" key={r.path + i}>
          <code>{r.path}</code>
          <select
            aria-label={"Rule for " + r.path}
            value={r.access}
            onChange={(e) =>
              set(
                rules.map((x, j) =>
                  j === i
                    ? { ...x, access: e.target.value as AccessRule["access"] }
                    : x,
                ),
              )
            }
          >
            <option value="none">Excluded</option>
            <option value="read">Read only</option>
            <option value="write">Read & write</option>
          </select>
          <button
            className="icon"
            aria-label={"Remove rule " + r.path}
            onClick={() => set(rules.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="rule-row">
        <input
          aria-label="New rule path"
          placeholder="src/generated or notes.md"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <select
          aria-label="New rule access"
          value={access}
          onChange={(e) => setAccess(e.target.value as AccessRule["access"])}
        >
          <option value="none">Excluded</option>
          <option value="read">Read only</option>
          <option value="write">Read & write</option>
        </select>
        <button
          type="button"
          disabled={!path.trim()}
          onClick={() => {
            set([
              ...rules.filter((r) => r.path !== path.trim()),
              { path: path.trim(), access },
            ]);
            setPath("");
          }}
        >
          <Plus size={13} />
          Add rule
        </button>
      </div>
    </details>
  );
}

type Report = {
  workspace: string;
  access: string;
  explicitOnly: boolean;
  restricted: boolean;
  active: boolean;
  allowed: { path: string; access: string; reason: string }[];
  denied: { path: string; reason: string }[];
  notes: string[];
};
export type AccessView = {
  workspaces: Report[];
  lock: {
    default: string;
    holds: { id: string; scope: string; paths: string[]; draining: unknown }[];
  };
  external: { outsideLocks: boolean; holder: string; notice: string };
};

/** Exact allowed/denied paths and the reason for each, for one agent (cards, details, Workspace). */
export function EffectiveAccess({
  agentId,
  events,
  folder,
}: {
  agentId: string;
  events?: unknown;
  folder?: string;
}) {
  const [view, setView] = useState<AccessView | null>(null);
  useEffect(() => {
    let live = true;
    api("/agents/" + agentId + "/access")
      .then((v) => live && setView(v as AccessView))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [agentId, events]);
  if (!view) return null;
  const shown = view.workspaces.filter(
    (w) => !folder || w.workspace === folder,
  );
  return (
    <section className="effective-access" data-testid="effective-access">
      <h3>
        <ShieldCheck size={15} /> Effective access
      </h3>
      {shown.map((w) => (
        <div className="effective-folder" key={w.workspace}>
          <code className="full-path">{w.workspace}</code>
          <div className="effective-lists">
            <ul aria-label="Allowed paths">
              {w.allowed.map((a) => (
                <li key={"a" + a.path} className={"ok " + a.access}>
                  <b>{a.access === "write" ? "Read & write" : "Read only"}</b>{" "}
                  <code>{a.path}</code>
                  <small>{a.reason}</small>
                </li>
              ))}
              {!w.allowed.length && <li className="none">Nothing allowed</li>}
            </ul>
            <ul aria-label="Denied paths">
              {w.denied.map((d) => (
                <li key={"d" + d.path} className="no">
                  <b>Denied</b> <code>{d.path}</code>
                  <small>{d.reason}</small>
                </li>
              ))}
            </ul>
          </div>
          {w.notes.map((n) => (
            <p className="hint" key={n}>
              {n}
            </p>
          ))}
        </div>
      ))}
      <p className="hint">{view.lock.default}</p>
      {view.lock.holds.map((h) => (
        <p className="hint" key={h.id}>
          Holding a {h.scope === "declared" ? "task-declared" : "whole-folder"}{" "}
          lease on {h.paths.join(", ")}
          {h.draining ? " (draining after a restart)" : ""}
        </p>
      ))}
      <ExternalNotice holder={view.external.holder} />
    </section>
  );
}

type Review = {
  note: string;
  reserves: { scope: string; paths: string[] };
  priority: number;
  wouldWait: boolean;
  holders: {
    leaseId: string;
    agent: string;
    overlaps: { mine: string; theirs: string }[];
  }[];
  queueDepth: number;
  workspaces: Report[];
  external: { holder: string };
};
/** Task-launch review: what the task would reserve, whether it would wait, and the effective access. */
export function LaunchReview({
  agentId,
  workflowId,
  resourcePaths,
}: {
  agentId: string;
  workflowId?: string;
  resourcePaths: string[];
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const key = resourcePaths.join("\n");
  useEffect(() => {
    let live = true;
    api("/resources/launch-review", "POST", {
      agentId,
      workflowId: workflowId ?? null,
      ...(resourcePaths.length ? { resourcePaths } : {}),
    })
      .then((r) => {
        if (!live) return;
        setReview(r as Review);
        setError("");
      })
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [agentId, workflowId, key]);
  return (
    <div className="launch-review" data-testid="launch-review">
      <b>Launch review</b>
      {error && <p className="error">{error}</p>}
      {review && (
        <>
          <p>
            {review.note}
            <br />
            <small>
              Reserves:{" "}
              {review.reserves.paths.map((p) => (
                <code key={p}>{p}</code>
              ))}
              {!review.reserves.paths.length && "nothing (no attached folders)"}
            </small>
          </p>
          <p>
            {review.wouldWait
              ? "Would wait for: " +
                review.holders
                  .map(
                    (h) =>
                      h.agent +
                      " (" +
                      h.overlaps
                        .map((o) =>
                          o.mine === o.theirs
                            ? o.mine
                            : o.mine + " ~ " + o.theirs,
                        )
                        .join(", ") +
                      ")",
                  )
                  .join("; ")
              : "No current holder overlaps these paths."}{" "}
            {review.queueDepth} request{review.queueDepth === 1 ? "" : "s"} are
            queued.
          </p>
          {review.workspaces.map((w) => (
            <p className="hint" key={w.workspace}>
              <code>{w.workspace}</code>:{" "}
              {w.allowed.map((a) => `${a.access} ${a.path}`).join(", ") ||
                "nothing allowed"}
              {w.denied.filter((d) => d.path !== ".git").length
                ? "; denied " +
                  w.denied
                    .filter((d) => d.path !== ".git")
                    .map((d) => d.path)
                    .join(", ")
                : ""}
            </p>
          ))}
          <ExternalNotice holder={review.external.holder} />
        </>
      )}
    </div>
  );
}
