import { useCallback, useEffect, useState } from "react";
import { api, type Snapshot, type TeamEvent } from "../api";
import "./assistant.css";

type DiffField = { path: string; before: unknown; after: unknown };
type DiffEntry = {
  index: number;
  action: string;
  label: string;
  significant: boolean;
  reasons: string[];
  fields: DiffField[];
};
type Proposal = {
  id: string;
  title: string;
  rationale: string;
  status: string;
  statusReason?: string;
  significant: boolean;
  reasons: string[];
  source: { type: "user" | "assistant" };
  createdAt: string;
  expiresAt: string;
  /** "kind:id" of every pre-existing entity the proposal touches (team filter). */
  base?: Record<string, string | null>;
};
type Detail = {
  proposal: Proposal;
  diff: DiffEntry[];
  stale: string[];
  canApply: boolean;
  needsApproval: boolean;
};
type Audit = {
  id: string;
  at: string;
  actor: { type: string };
  proposedBy: { type: string };
  action: string;
  summary: string;
};
type Coord = {
  workflowId: string;
  name: string;
  goal: string;
  currentGoal: string;
  stopWhen: string;
  status: string;
  paused: boolean;
  trip: { kind: string; reason: string } | null;
  hasStopCondition: boolean;
  tasks: Record<string, number>;
  stopping: {
    key: string;
    limit: number | null;
    used: number | null;
    tripped: boolean;
  }[];
};
const show = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v ?? null);
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Team of a proposal: null when it touches only the active team or global/new entities. */
function otherTeamOf(p: Proposal, data: Snapshot): string | null {
  const index = data.teamView?.index;
  if (!index) return null;
  for (const key of Object.keys(p.base ?? {})) {
    const team = index.get(key.slice(key.indexOf(":") + 1));
    if (team && team !== data.activeTeamId) return team;
  }
  return null;
}

function Proposals({ events, data }: { events: TeamEvent[]; data: Snapshot }) {
  const [all, setList] = useState<Proposal[]>([]);
  // The Team Assistant is global; its proposals are shown in the team they change.
  const list = all.filter((p) => !otherTeamOf(p, data));
  const elsewhere = all.length - list.length;
  const [sel, setSel] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState("");
  const [json, setJson] = useState("");
  const last = events.length ? events[events.length - 1].seq : 0;
  const load = useCallback(async () => {
    try {
      setList(await api("/assistant/proposals"));
      setAudit(await api("/assistant/audit"));
      if (sel) setDetail(await api("/assistant/proposals/" + sel));
    } catch (e) {
      setError(err(e));
    }
  }, [sel]);
  useEffect(() => {
    void load();
  }, [load, last]);
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(err(e));
    }
    await load();
  };
  const post = (id: string, action: string, body: object = {}) =>
    run(() => api(`/assistant/proposals/${id}/${action}`, "POST", body));
  const readLatest = () =>
    run(async () => {
      const snap: Snapshot = await api("/snapshot");
      const assistant = snap.agents.find((a) => a.kind === "team-assistant");
      const session = snap.sessions.find((s) => s.agentId === assistant?.id);
      if (!session)
        throw new Error("The Team Assistant has no conversation yet");
      const messages: { id: string; role: string }[] = await api(
        `/sessions/${session.id}/messages`,
      );
      const reply = [...messages].reverse().find((m) => m.role === "assistant");
      if (!reply) throw new Error("The Team Assistant has not replied yet");
      const out = await api("/assistant/proposals/extract", "POST", {
        messageId: reply.id,
      });
      if (!out.proposals.length)
        throw new Error(
          out.rejected[0]?.error ??
            "No agentteam-proposal block in the latest reply",
        );
      if (out.rejected.length)
        setError(
          out.rejected.length +
            " proposal block(s) were rejected: " +
            out.rejected[0].error,
        );
      setSel(out.proposals[0].id);
    });
  return (
    <section className="assist-section" aria-label="Proposed changes">
      <h3>Proposed changes</h3>
      <p className="hint">
        The assistant can only propose. Nothing changes until you apply a
        proposal here, and significant changes need an explicit approval first.
      </p>
      <div className="row">
        <button onClick={() => void readLatest()}>
          Read proposals from the assistant’s latest reply
        </button>
      </div>
      {error && (
        <div role="alert" className="limit-error">
          {error}
        </div>
      )}
      {elsewhere > 0 && (
        <p className="hint" data-testid="proposals-elsewhere">
          {elsewhere} proposal(s) change other teams; switch to that team to
          review them.
        </p>
      )}
      <ul className="proposal-list" data-testid="proposal-list">
        {list.map((p) => (
          <li key={p.id}>
            <button
              className={"proposal-row" + (p.id === sel ? " active" : "")}
              onClick={() => setSel(p.id)}
            >
              <b>{p.title}</b>
              <span className="badge">{p.status}</span>
              <span className="badge">{p.source.type}</span>
              {p.significant && (
                <span className="badge limit-stopped">significant</span>
              )}
            </button>
          </li>
        ))}
        {!list.length && <li className="hint">No proposals yet.</li>}
      </ul>
      {detail && detail.proposal.id === sel && (
        <div className="proposal-detail" data-testid="proposal-detail">
          <h4>{detail.proposal.title}</h4>
          {detail.proposal.rationale && <p>{detail.proposal.rationale}</p>}
          <p className="hint">
            Proposed by {detail.proposal.source.type} · expires{" "}
            {new Date(detail.proposal.expiresAt).toLocaleTimeString()}
          </p>
          {detail.proposal.statusReason && (
            <div
              role="status"
              className="limit-error"
              data-testid="proposal-reason"
            >
              {detail.proposal.statusReason}
            </div>
          )}
          {detail.proposal.reasons.length > 0 && (
            <ul className="reasons" data-testid="proposal-reasons">
              {detail.proposal.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="diff" data-testid="proposal-diff">
            {detail.diff.map((d) => (
              <div key={d.index} className={"diff-op " + d.action}>
                <b>
                  {d.index + 1}. {d.label}
                </b>
                {d.significant && (
                  <span className="badge limit-stopped">significant</span>
                )}
                <table>
                  <tbody>
                    {d.fields.map((f) => (
                      <tr key={f.path}>
                        <th scope="row">{f.path}</th>
                        <td className="before">
                          {d.action === "create" ? "" : show(f.before)}
                        </td>
                        <td className="after">{show(f.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <div className="row">
            {detail.needsApproval && (
              <button
                data-testid="approve"
                onClick={() => void post(detail.proposal.id, "approve")}
              >
                Approve significant changes
              </button>
            )}
            <button
              data-testid="apply"
              className="primary"
              disabled={!detail.canApply}
              title={
                detail.needsApproval
                  ? "Approve the significant changes first"
                  : detail.canApply
                    ? "Apply through the same validation as the forms"
                    : "This proposal can no longer be applied"
              }
              onClick={() =>
                void post(detail.proposal.id, "apply", { confirm: true })
              }
            >
              Apply
            </button>
            <button
              disabled={
                !["pending", "approved"].includes(detail.proposal.status)
              }
              onClick={() => void post(detail.proposal.id, "reject")}
            >
              Reject
            </button>
          </div>
        </div>
      )}
      <details className="audit">
        <summary>Change log ({audit.length})</summary>
        <ul data-testid="audit-log">
          {[...audit].reverse().map((a) => (
            <li key={a.id}>
              <time>{new Date(a.at).toLocaleTimeString()}</time>{" "}
              <b>{a.actor.type}</b> {a.action}: {a.summary}{" "}
              <small>(proposed by {a.proposedBy.type})</small>
            </li>
          ))}
        </ul>
      </details>
      <details className="new-proposal">
        <summary>Write a proposal by hand (JSON)</summary>
        <textarea
          aria-label="Proposal JSON"
          rows={6}
          value={json}
          placeholder='{"title":"…","ops":[{"op":"agent.update","id":"…","changes":{"role":"…"}}]}'
          onChange={(e) => setJson(e.target.value)}
        />
        <button
          onClick={() =>
            void run(async () => {
              const made = await api(
                "/assistant/proposals",
                "POST",
                JSON.parse(json),
              );
              setSel(made.id);
              setJson("");
            })
          }
        >
          Create proposal
        </button>
      </details>
    </section>
  );
}

function CoordinationCard({ c, reload }: { c: Coord; reload: () => void }) {
  const [goal, setGoal] = useState(c.currentGoal);
  const [stop, setStop] = useState(c.stopWhen);
  const [error, setError] = useState("");
  useEffect(() => {
    setGoal(c.currentGoal);
    setStop(c.stopWhen);
  }, [c.currentGoal, c.stopWhen]);
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(err(e));
    }
    reload();
  };
  return (
    <div className="coord-card" data-testid="coord-card">
      <div className="row between">
        <b>{c.name}</b>
        <span className="row">
          <span
            className={
              "badge " +
              (c.status === "stopped-by-limit" ? "limit-stopped" : "")
            }
            data-testid="coord-status"
          >
            {c.status}
          </span>
          {c.paused ? (
            <button
              onClick={() =>
                void run(() =>
                  api(`/coordination/${c.workflowId}/resume`, "POST"),
                )
              }
            >
              Resume
            </button>
          ) : (
            <button
              onClick={() =>
                void run(() =>
                  api(`/coordination/${c.workflowId}/pause`, "POST"),
                )
              }
            >
              Pause
            </button>
          )}
        </span>
      </div>
      {c.trip && (
        <div className="limit-trip" role="status">
          Stopped by limit: {c.trip.reason} Raise the limit and resume from the
          workflow’s limits panel.
        </div>
      )}
      <label>
        Current goal
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={500}
        />
      </label>
      <label>
        Stop when (note for you and the assistant; not enforced)
        <input
          value={stop}
          onChange={(e) => setStop(e.target.value)}
          maxLength={1000}
        />
      </label>
      <button
        disabled={goal === c.currentGoal && stop === c.stopWhen}
        onClick={() =>
          void run(() =>
            api(`/coordination/${c.workflowId}`, "PUT", {
              currentGoal: goal,
              stopWhen: stop,
            }),
          )
        }
      >
        Save goal
      </button>
      <p className="hint">
        Created for: {c.goal} · {c.tasks.running} running · {c.tasks.queued}{" "}
        queued · {c.tasks.needsAttention} need attention
      </p>
      <ul className="stopping" data-testid="stopping">
        {c.stopping
          .filter((s) => s.limit !== null)
          .map((s) => (
            <li key={s.key} className={s.tripped ? "tripped" : ""}>
              {s.key}: {s.used ?? "n/a"} / {s.limit}
            </li>
          ))}
        {!c.hasStopCondition && (
          <li className="hint">
            No enforced stopping condition: this workflow runs until its tasks
            finish. Set limits in Workflows.
          </li>
        )}
      </ul>
      {error && (
        <div role="alert" className="limit-error">
          {error}
        </div>
      )}
    </div>
  );
}

function Coordination({
  events,
  data,
}: {
  events: TeamEvent[];
  data: Snapshot;
}) {
  const [all, setRows] = useState<Coord[]>([]);
  const rows = all.filter((c) =>
    data.workflows.some((w) => w.id === c.workflowId),
  );
  const last = events.length ? events[events.length - 1].seq : 0;
  const load = useCallback(async () => {
    try {
      setRows(await api("/coordination"));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, last]);
  return (
    <section className="assist-section" aria-label="Background coordination">
      <h3>Background coordination</h3>
      {!rows.length && (
        <p className="hint">
          No workflows in {data.teamView?.team.name ?? "this team"}.
        </p>
      )}
      {rows.map((c) => (
        <CoordinationCard key={c.workflowId} c={c} reload={() => void load()} />
      ))}
    </section>
  );
}

function Inspection() {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    api("/assistant/context")
      .then((r) => setText(r.text))
      .catch((e) => setText(err(e)));
  }, [open]);
  return (
    <details
      className="assist-section"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>What the assistant can inspect (read-only, bounded)</summary>
      <p className="hint">
        Sent to the assistant as untrusted data: workflow states, queues,
        leases, failures and available skills/tools. It contains no task results
        or credentials.
      </p>
      <pre data-testid="assistant-context">{text}</pre>
    </details>
  );
}

export function AssistantPanel({
  events,
  data,
}: {
  data: Snapshot;
  events: TeamEvent[];
}) {
  return (
    <div className="assistant-panel scroll section">
      <Proposals events={events} data={data} />
      <Coordination events={events} data={data} />
      <Inspection />
    </div>
  );
}
