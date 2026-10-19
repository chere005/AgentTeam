import { useCallback, useEffect, useState } from "react";
import { api, type TeamEvent } from "../api";
import {
  ProposalDiff,
  requestProposal,
  type Detail,
  type Proposal,
} from "./AssistantPanel";
import "./assistant.css";

type Extracted = {
  proposals: Proposal[];
  rejected: { block: number; error: string }[];
};
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Extraction runs once per message (the backend extract is idempotent per block and only stores
 * data). Kept across re-renders and remounts so scrolling or switching agents never re-posts.
 */
const extracted = new Map<string, Promise<Extracted>>();
function extractOnce(messageId: string) {
  let p = extracted.get(messageId);
  if (!p) {
    p = api("/assistant/proposals/extract", "POST", { messageId });
    extracted.set(messageId, p);
    p.catch(() => extracted.delete(messageId));
  }
  return p;
}

/** Message the user sends back so the assistant can correct an invalid proposal. */
export const fixRequest = (error: string) =>
  `The proposal in your last reply was rejected by AgentTeam's validation:\n${error}\nPlease reply with a corrected agentteam-proposal block.`;

/**
 * "Proposed changes" under a Team Assistant reply: the backend-validated proposal with its diff,
 * significance and status. Nothing is applied by the reply; Approve & apply is the user-only
 * approve + apply route (stale/expired handling unchanged).
 */
export function ProposalCards({
  messageId,
  events,
  send,
  openChanges,
}: {
  messageId: string;
  events: TeamEvent[];
  send: (text: string) => Promise<void>;
  openChanges?: () => void;
}) {
  const [result, setResult] = useState<Extracted | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    extractOnce(messageId)
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError(err(e)));
    return () => {
      alive = false;
    };
  }, [messageId]);
  // Only proposal and agent/edge/workflow changes can change a proposal's status or diff.
  let version = 0;
  for (const e of events)
    if (/^(assistant|agent|edge|rule|workflow)\./.test(e.type)) version = e.seq;
  if (error)
    return (
      <div role="alert" className="limit-error">
        Could not read the proposal: {error}
      </div>
    );
  if (!result) return null;
  return (
    <>
      {result.proposals.map((p) => (
        <ProposalCard
          key={p.id}
          id={p.id}
          version={version}
          openChanges={openChanges}
        />
      ))}
      {result.rejected.map((r) => (
        <section
          key={r.block}
          className="proposal-card invalid"
          data-testid="proposal-invalid"
          aria-label="Invalid proposal"
        >
          <div className="proposal-card-head">
            <span className="eyebrow">PROPOSED CHANGES</span>
            <span className="badge limit-stopped">invalid</span>
          </div>
          <p>AgentTeam could not use this proposal. Nothing was changed.</p>
          <pre className="proposal-error" data-testid="proposal-error">
            {r.error}
          </pre>
          <div className="row">
            <button
              className="primary"
              onClick={() => void send(fixRequest(r.error))}
            >
              Ask the assistant to fix this
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

function ProposalCard({
  id,
  version,
  openChanges,
}: {
  id: string;
  version: number;
  openChanges?: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setDetail(await api("/assistant/proposals/" + id));
    } catch (e) {
      setError(err(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load, version]);
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
    await load();
  };
  if (!detail)
    return error ? (
      <div role="alert" className="limit-error">
        {error}
      </div>
    ) : null;
  const p = detail.proposal;
  const open = p.status === "pending" || p.status === "approved";
  const approveAndApply = () =>
    run(async () => {
      if (detail.needsApproval)
        await api(`/assistant/proposals/${id}/approve`, "POST", {});
      await api(`/assistant/proposals/${id}/apply`, "POST", { confirm: true });
    });
  return (
    <section
      className={"proposal-card " + p.status}
      data-testid="proposal-card"
      aria-label={"Proposed changes: " + p.title}
    >
      <div className="proposal-card-head">
        <span className="eyebrow">PROPOSED CHANGES</span>
        <span className="badge" data-testid="proposal-status">
          {p.status}
        </span>
        {p.significant && open && (
          <span className="badge limit-stopped">needs your approval</span>
        )}
      </div>
      <h4>{p.title}</h4>
      {p.rationale && <p className="hint">{p.rationale}</p>}
      {p.reasons.length > 0 && open && (
        <ul className="reasons" data-testid="proposal-reasons">
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {p.status !== "applied" && <ProposalDiff diff={detail.diff} />}
      {p.status === "applied" && (
        <ul className="proposal-applied" data-testid="proposal-applied">
          {(p.summary?.length
            ? p.summary
            : detail.diff.map((d) => d.done ?? d.label)
          ).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {p.statusReason && p.status !== "rejected" && (
        <div role="status" className="limit-error">
          {p.statusReason}
        </div>
      )}
      {error && (
        <div role="alert" className="limit-error">
          {error}
        </div>
      )}
      <div className="row">
        {open && (
          <button
            className="primary"
            disabled={busy || (!detail.canApply && !detail.needsApproval)}
            title={
              detail.needsApproval
                ? "Approves the significant changes listed above, then applies them through the same validation as the forms"
                : "Applies through the same validation as the forms"
            }
            onClick={() => void approveAndApply()}
          >
            Approve &amp; apply
          </button>
        )}
        {open && (
          <button
            disabled={busy}
            onClick={() =>
              void run(() =>
                api(`/assistant/proposals/${id}/reject`, "POST", {}),
              )
            }
          >
            Reject
          </button>
        )}
        {openChanges && (
          <button
            className="link"
            onClick={() => {
              requestProposal(id);
              openChanges();
            }}
          >
            Open in Assistant changes
          </button>
        )}
      </div>
    </section>
  );
}
