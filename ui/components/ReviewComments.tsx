import { useCallback, useEffect, useMemo, useState } from "react";
import { ConversationLink } from "./ConversationExtras";
import { api, type Agent } from "../api";

/** Which diff the review applies to: staged/unstaged, or a branch comparison. */
export type ReviewScope = {
  staged: boolean;
  base?: string;
  head?: string;
  mergeBase?: boolean;
};
type Comment = {
  id: string;
  path: string;
  side: "old" | "new";
  line: number;
  text: string;
  resolved: boolean;
  outdated: boolean;
  delivery: "queued" | "scheduled" | "sent";
  targetId: string;
};
type State = {
  comments: Comment[];
  reviewed: Record<string, boolean>;
  decision: {
    decision: "changes_requested" | "approved";
    note: string;
    stale: boolean;
  } | null;
  summary: {
    files: number;
    reviewedFiles: number;
    unresolved: number;
    resolved: number;
    outdated: number;
  };
};

export function ReviewComments({
  agentId,
  workspace,
  scope: reviewScope,
  path,
  agents,
  revision,
  onOpenConversation,
}: {
  agentId: string;
  workspace: string;
  scope: ReviewScope;
  path: string;
  agents: Agent[];
  revision: number;
  onOpenConversation?: (agentId: string) => void;
}) {
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [recipient, setRecipient] = useState(agentId),
    [busy, setBusy] = useState(false);
  const key = JSON.stringify(reviewScope);
  const scope = useMemo(
    () => ({ workspace, ...reviewScope }),
    [workspace, key],
  );
  const load = useCallback(async () => {
    try {
      setState(await api(`/agents/${agentId}/reviews/state`, "POST", scope));
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [agentId, scope]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  async function act(action: string, body: object) {
    setBusy(true);
    try {
      await api(`/agents/${agentId}/reviews/${action}`, "POST", {
        ...scope,
        ...body,
      });
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  if (!state)
    return error ? (
      <p role="alert" className="notice">
        {error}
      </p>
    ) : null;
  const s = state.summary;
  return (
    <section className="review-summary" aria-label="Review summary">
      <strong>Review summary</strong>
      <p className="hint">
        {s.reviewedFiles}/{s.files} files reviewed · {s.unresolved} unresolved ·{" "}
        {s.resolved} resolved · {s.outdated} outdated
      </p>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {path && path in state.reviewed && (
        <label>
          <input
            type="checkbox"
            checked={state.reviewed[path]}
            disabled={busy}
            onChange={(e) =>
              void act("reviewed", { path, reviewed: e.target.checked })
            }
          />{" "}
          Mark {path} as reviewed (resets if its diff changes)
        </label>
      )}
      <ul className="review-comment-list">
        {state.comments.map((c) => (
          <li key={c.id}>
            <code>
              {c.path} · {c.side} line {c.line}
            </code>{" "}
            {c.outdated && <em>(outdated)</em>}{" "}
            {c.resolved && <em>(resolved)</em>}
            <div>{c.text}</div>
            <small>
              To {name(c.targetId)} · {c.delivery}
            </small>{" "}
            <button
              disabled={busy}
              onClick={() =>
                void act("resolve", { id: c.id, resolved: !c.resolved })
              }
            >
              {c.resolved ? "Reopen" : "Resolve"}
            </button>
            {onOpenConversation && (
              <ConversationLink
                commentId={c.id}
                openChat={onOpenConversation}
                label="Open conversation"
              />
            )}
          </li>
        ))}
      </ul>
      {state.decision && (
        <p role="status">
          Decision:{" "}
          {state.decision.decision === "approved"
            ? "Approved"
            : "Changes requested"}
          {state.decision.stale && " (diff changed since; review again)"}.
          Nothing was committed or merged.
        </p>
      )}
      <label>
        Summary note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>
        Recipient for requested changes
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={busy}
        onClick={() =>
          void act("decide", {
            decision: "changes_requested",
            note,
            targetId: recipient,
          })
        }
      >
        Request changes
      </button>
      <button
        disabled={busy || s.unresolved > 0}
        title="Records approval only; never commits or merges"
        onClick={() => void act("decide", { decision: "approved", note })}
      >
        Approve review
      </button>
    </section>
  );
}
