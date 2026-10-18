import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Agent, type Snapshot, type TeamEvent } from "../api";
import "./inspector.css";

/** Encodes every character the desktop IPC path filter rejects (".", "_") as well as reserved ones. */
const enc = (v: string) =>
  encodeURIComponent(v).replace(/\./g, "%2E").replace(/_/g, "%5F");
const qs = (params: Record<string, string | undefined>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${enc(v!)}`);
  return parts.length ? "?" + parts.join("&") : "";
};

type Entry = {
  seq: number;
  at: string;
  type: string;
  category: string;
  severity: "debug" | "info" | "warn" | "error";
  summary: string;
  correlationId: string;
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  workflowId: string | null;
  files: string[];
  conversation: { sessionId: string; agentId: string } | null;
  data: unknown;
};
type Reason = {
  code: string;
  blocking: boolean;
  title: string;
  detail: string;
  taskId?: string;
};
type Explanation = {
  subject: { kind: string; id: string; name: string };
  status: string;
  waiting: boolean;
  headline: string;
  reasons: Reason[];
};
export type TransferView = {
  taskId: string;
  edgeId: string | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  state: "pending" | "returned" | "failed";
  durationMs: number | null;
  request: { at: string; title: string; text: string } | null;
  response: { at: string; kind: string; text: string } | null;
  rule: {
    edge: {
      id: string;
      kind: string;
      bidirectional: boolean;
      enabled: boolean;
    } | null;
    matchedRules: { ruleId: string; priority: number; scope: string }[];
    note: string;
  };
};

type Props = {
  data: Snapshot;
  events: TeamEvent[];
  openChat: (agentId: string) => void;
};
const TABS = [
  ["timeline", "Timeline"],
  ["waiting", "Why waiting"],
  ["transfers", "Transfers"],
  ["preview", "Preview"],
  ["playground", "Playground"],
  ["export", "Export"],
] as const;
type Tab = (typeof TABS)[number][0];

/** Run inspector: correlated timeline, wait explainer, transfers, previews, playground and export. */
export function Inspector(p: Props) {
  const [tab, setTab] = useState<Tab>("timeline");
  return (
    <div className="scroll section insp" data-testid="inspector">
      <span className="eyebrow">RUN INSPECTOR</span>
      <h2>See what the team did and why</h2>
      <div className="insp-tabs" role="tablist">
        {TABS.map(([id, name]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "primary" : ""}
            onClick={() => setTab(id)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "timeline" && <Timeline {...p} />}
      {tab === "waiting" && <Waiting {...p} />}
      {tab === "transfers" && <Transfers {...p} />}
      {tab === "preview" && <Preview {...p} />}
      {tab === "playground" && <Playground {...p} />}
      {tab === "export" && <Export />}
    </div>
  );
}

function useLoad<T>(path: string, deps: unknown[], initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      setValue(await api(path));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { value, error, busy, reload: load };
}

// ---- timeline -----------------------------------------------------------------------------
function Timeline(p: Props) {
  const [f, setF] = useState({
    agentId: "",
    workflowId: "",
    taskId: "",
    minSeverity: "info",
    type: "",
    q: "",
    file: "",
    correlationId: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((o) => ({ ...o, [k]: v }));
  const tasks = p.data.workflows.flatMap((w) => w.tasks);
  const path =
    "/inspector/timeline" +
    qs({
      ...f,
      minSeverity: f.minSeverity === "debug" ? "" : f.minSeverity,
      limit: "400",
    });
  // Live events nudge a reload so the timeline follows the run.
  const { value, error, reload } = useLoad<{
    entries: Entry[];
    total: number;
    truncated: boolean;
    correlations: { id: string; count: number }[];
  }>(path, [p.events.length], {
    entries: [],
    total: 0,
    truncated: false,
    correlations: [],
  });
  const [open, setOpen] = useState<number | null>(null);
  const rows = [...value.entries].reverse();
  return (
    <section aria-label="Timeline" data-testid="timeline">
      <div className="insp-filters">
        <label>
          Agent
          <select
            value={f.agentId}
            onChange={(e) => set("agentId", e.target.value)}
          >
            <option value="">All</option>
            {p.data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workflow
          <select
            value={f.workflowId}
            onChange={(e) => set("workflowId", e.target.value)}
          >
            <option value="">All</option>
            {p.data.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task
          <select
            value={f.taskId}
            onChange={(e) => set("taskId", e.target.value)}
          >
            <option value="">All</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity
          <select
            value={f.minSeverity}
            onChange={(e) => set("minSeverity", e.target.value)}
          >
            <option value="debug">Everything (debug+)</option>
            <option value="info">Info and above</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors only</option>
          </select>
        </label>
        <label>
          Event type
          <input
            placeholder="task.  lock  tool"
            value={f.type}
            onChange={(e) => set("type", e.target.value)}
          />
        </label>
        <label>
          Search
          <input value={f.q} onChange={(e) => set("q", e.target.value)} />
        </label>
        <label>
          File
          <input
            placeholder="path fragment"
            value={f.file}
            onChange={(e) => set("file", e.target.value)}
          />
        </label>
        <button onClick={() => void reload()}>Refresh</button>
      </div>
      {f.correlationId && (
        <p className="insp-chip-row">
          Correlation <code>{f.correlationId}</code>
          <button onClick={() => set("correlationId", "")}>Clear</button>
        </p>
      )}
      {error && (
        <p role="alert" className="insp-error">
          {error}
        </p>
      )}
      <p className="quiet" data-testid="timeline-count">
        {value.total} event{value.total === 1 ? "" : "s"}
        {value.truncated
          ? ` (showing the latest ${value.entries.length})`
          : ""}{" "}
        · {value.correlations.length} correlation group
        {value.correlations.length === 1 ? "" : "s"}
      </p>
      {!rows.length && <p className="quiet">No events match these filters.</p>}
      <ol className="insp-list">
        {rows.map((e) => (
          <li
            key={e.seq}
            className={"insp-entry sev-" + e.severity}
            data-testid="timeline-entry"
          >
            <button
              className="insp-entry-head"
              aria-expanded={open === e.seq}
              onClick={() => setOpen(open === e.seq ? null : e.seq)}
            >
              <span className={"dot sev-" + e.severity} title={e.severity} />
              <span className="insp-time">
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <span className="badge">{e.category}</span>
              <span className="insp-summary">{e.summary}</span>
              {e.agentName && <span className="quiet">{e.agentName}</span>}
            </button>
            <div className="insp-links">
              <button
                title="Show only this task run / conversation"
                onClick={() => set("correlationId", e.correlationId)}
              >
                {e.correlationId.slice(0, 13)}
              </button>
              {e.files.map((file) => (
                <button
                  key={file}
                  className="insp-file"
                  title="Filter by this file"
                  onClick={() => set("file", file)}
                >
                  {file.split("/").slice(-2).join("/")}
                </button>
              ))}
              {e.conversation && (
                <button onClick={() => p.openChat(e.conversation!.agentId)}>
                  Open conversation
                </button>
              )}
            </div>
            {open === e.seq && <pre>{JSON.stringify(e.data, null, 2)}</pre>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- waiting -------------------------------------------------------------------------------
export function ReasonList({ explanation }: { explanation: Explanation }) {
  return (
    <div className="insp-explain" data-testid="explanation">
      <b data-testid="explanation-headline">{explanation.headline}</b>
      <ul>
        {explanation.reasons.map((r, i) => (
          <li
            key={i}
            data-testid={"reason-" + r.code}
            className={r.blocking ? "blocking" : ""}
          >
            <span className={"badge " + (r.blocking ? "red" : "")}>
              {r.blocking ? "blocks" : "info"}
            </span>{" "}
            <b>{r.title}</b>
            <p>{r.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
function Waiting(p: Props) {
  const list = useLoad<
    {
      taskId: string;
      title: string;
      status: string;
      headline: string;
      codes: string[];
    }[]
  >("/inspector/waiting", [p.events.length], []);
  const [target, setTarget] = useState<{
    kind: "tasks" | "agents";
    id: string;
  } | null>(null);
  const [agentId, setAgentId] = useState("");
  const path = target
    ? `/inspector/${target.kind}/${enc(target.id)}/waiting`
    : "";
  const [exp, setExp] = useState<Explanation | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target) return;
    let live = true;
    api(path)
      .then((v) => live && (setExp(v), setError("")))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [path, p.events.length, target]);
  return (
    <section aria-label="Why is this waiting" data-testid="waiting">
      <div className="insp-filters">
        <label>
          Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Choose an agent…</option>
            {p.data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!agentId}
          onClick={() => setTarget({ kind: "agents", id: agentId })}
        >
          Why is this agent waiting?
        </button>
      </div>
      <h3>Queued, interrupted and blocked tasks</h3>
      {!list.value.length && <p className="quiet">Nothing is waiting.</p>}
      <ul className="insp-plain">
        {list.value.map((t) => (
          <li key={t.taskId} data-testid="waiting-task">
            <div className="row between">
              <span>
                {t.title} <span className="badge">{t.status}</span>
              </span>
              <button
                onClick={() => setTarget({ kind: "tasks", id: t.taskId })}
              >
                Why is this waiting?
              </button>
            </div>
            <small className="quiet">{t.headline}</small>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="insp-error">
          {error}
        </p>
      )}
      {exp && target && <ReasonList explanation={exp} />}
    </section>
  );
}

// ---- transfers -----------------------------------------------------------------------------
export function TransferDetail({
  t,
  agents,
}: {
  t: TransferView;
  agents: Agent[];
}) {
  const name = (id: string | null) =>
    agents.find((a) => a.id === id)?.name ?? id ?? "?";
  return (
    <article className="insp-transfer" data-testid="transfer-detail">
      <div className="row between">
        <b>
          {name(t.fromAgentId)} → {name(t.toAgentId)}
        </b>
        <span className={"badge " + (t.state === "failed" ? "red" : "")}>
          {t.state}
        </span>
      </div>
      <dl>
        <dt>Request</dt>
        <dd data-testid="transfer-request">
          <b>{t.request?.title}</b>
          <pre>{t.request?.text || "(no instructions)"}</pre>
        </dd>
        <dt>Response</dt>
        <dd data-testid="transfer-response">
          {t.response ? (
            <pre>{t.response.text || "(empty)"}</pre>
          ) : (
            "Still waiting for the response."
          )}
        </dd>
        <dt>Duration</dt>
        <dd data-testid="transfer-duration">
          {t.durationMs === null
            ? "not finished"
            : `${(t.durationMs / 1000).toFixed(2)} s`}
        </dd>
        <dt>Originating rule</dt>
        <dd data-testid="transfer-rule">
          {t.rule.edge
            ? `Delegation edge (${t.rule.edge.kind}${t.rule.edge.bidirectional ? ", both ways" : ""}${t.rule.edge.enabled ? "" : ", disabled"})`
            : "No edge recorded"}
          {t.rule.matchedRules.length > 0 &&
            ` · routing rule(s) at priority ${t.rule.matchedRules.map((r) => r.priority).join(", ")}`}
          <small className="quiet"> {t.rule.note}</small>
        </dd>
      </dl>
    </article>
  );
}
/** Transfers for one edge (or all), used by the Inspector tab and the canvas connection dialog. */
export function EdgeTransfers({
  edgeId,
  agents,
}: {
  edgeId?: string;
  agents: Agent[];
}) {
  const { value, error } = useLoad<TransferView[]>(
    "/inspector/transfers" + qs({ edgeId }),
    [],
    [],
  );
  const [sel, setSel] = useState<string | null>(null);
  const shown = [...value].reverse();
  const current = shown.find((t) => t.taskId === sel) ?? shown[0];
  return (
    <div data-testid="transfers">
      {error && (
        <p role="alert" className="insp-error">
          {error}
        </p>
      )}
      {!shown.length && (
        <p className="quiet">No transfers have crossed this connection yet.</p>
      )}
      <div className="insp-transfer-list">
        {shown.map((t) => (
          <button
            key={t.taskId}
            className={current?.taskId === t.taskId ? "primary" : ""}
            onClick={() => setSel(t.taskId)}
            data-testid="transfer-row"
          >
            {t.request?.title ?? t.taskId.slice(0, 8)} · {t.state}
          </button>
        ))}
      </div>
      {current && <TransferDetail t={current} agents={agents} />}
    </div>
  );
}
function Transfers(p: Props) {
  return (
    <section aria-label="Transfers">
      <p className="quiet">
        Every delegation crossing a canvas connection: what was asked, what came
        back, how long it took and what authorised it. Open a connection on the
        canvas to see only its transfers.
      </p>
      <EdgeTransfers agents={p.data.agents} />
    </section>
  );
}

// ---- preview -------------------------------------------------------------------------------
type Decision = {
  kind: string;
  allowed: boolean;
  enforcement: string;
  subject: string;
  reason: string;
};
function Preview(p: Props) {
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState("delegate");
  const [paths, setPaths] = useState("");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  async function run() {
    setError("");
    try {
      const lines = paths
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const m = l.match(/^(read|write)\s+(.+)$/i);
          return {
            access: (m ? m[1].toLowerCase() : "read") as string,
            path: m ? m[2] : l,
          };
        });
      setResult(
        await api("/inspector/preview", "POST", {
          route: {
            text: text || "(no text)",
            kind,
            ...(from ? { fromAgentId: from } : {}),
            ...(target ? { targetId: target } : {}),
          },
          access: { paths: lines },
        }),
      );
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const name = (id: string) =>
    p.data.agents.find((a) => a.id === id)?.name ?? id;
  return (
    <section aria-label="Routing and access preview" data-testid="preview">
      <p className="quiet">
        Nothing runs here: this shows who would receive the request and what
        that agent may touch.
      </p>
      <div className="insp-form">
        <label>
          Request text
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label>
          From
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">You (intake)</option>
            {p.data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Explicit recipient
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Let routing rules decide</option>
            {p.data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Connection kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {["delegate", "consult", "review", "notify"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Paths to check (one per line, optional “read|write /path”)
          <textarea value={paths} onChange={(e) => setPaths(e.target.value)} />
        </label>
        <button className="primary" onClick={() => void run()}>
          Preview
        </button>
      </div>
      {error && (
        <p role="alert" className="insp-error">
          {error}
        </p>
      )}
      {result && (
        <div data-testid="preview-result">
          <h3>Routing</h3>
          <p data-testid="preview-routing">
            <span
              className={
                "badge " +
                (result.routing.status === "selected" ? "green" : "red")
              }
            >
              {result.routing.status}
            </span>{" "}
            {result.routing.agentId ? name(result.routing.agentId) + " — " : ""}
            {result.routing.reason}
          </p>
          {(result.routing.matches ?? []).length > 0 && (
            <ul className="insp-plain">
              {result.routing.matches.map((m: any) => (
                <li key={m.ruleId}>
                  {name(m.agentId)} via {m.scope} rule, priority {m.priority}
                </li>
              ))}
            </ul>
          )}
          {result.access && (
            <>
              <h3>
                Access{" "}
                <span
                  className={
                    "badge " + (result.access.allowed ? "green" : "red")
                  }
                >
                  {result.access.allowed
                    ? "all clear"
                    : "something would be refused or wait"}
                </span>
              </h3>
              <ul className="insp-plain" data-testid="access-decisions">
                {result.access.decisions.map((d: Decision, i: number) => (
                  <li key={i}>
                    <span className={"badge " + (d.allowed ? "green" : "red")}>
                      {d.allowed ? "allow" : "deny"}
                    </span>{" "}
                    <b>{d.kind}</b> · {d.subject}
                    <p>
                      {d.reason}{" "}
                      <small className="quiet">
                        ({d.enforcement === "backend" ? "enforced" : "advisory"}
                        )
                      </small>
                    </p>
                  </li>
                ))}
              </ul>
              <small className="quiet">{result.access.note}</small>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---- playground ----------------------------------------------------------------------------
type RunSummary = {
  id: string;
  exampleName: string;
  label: string;
  startedAt: string;
  durationMs: number;
  workflowStatus: string;
  stalled: boolean;
  expectations: { passed: boolean };
};
function Playground(p: Props) {
  const examples = useLoad<any[]>("/inspector/examples", [], []);
  const runs = useLoad<RunSummary[]>("/inspector/runs", [], []);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [overrides, setOverrides] = useState("");
  const [error, setError] = useState("");
  const [last, setLast] = useState<any>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [diff, setDiff] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const template = useMemo(() => {
    const [a, b] = p.data.agents.filter((x) => x.kind !== "team-assistant");
    const name = a?.name ?? "Agent";
    return JSON.stringify(
      {
        name: "Example task",
        description: "What this evaluation checks",
        files: { "input.txt": "controlled input" },
        tasks: [
          {
            key: "main",
            title: "Summarise input.txt",
            agent: name,
            instructions: "Read input.txt and summarise it.",
          },
          ...(b
            ? [
                {
                  key: "review",
                  title: "Review the summary",
                  agent: b.name,
                  dependsOn: ["main"],
                },
              ]
            : []),
        ],
        fixture: { [name]: { text: "Summary: controlled input" } },
        expected: {
          workflowStatus: "completed",
          tasks: { main: { status: "completed", resultIncludes: ["Summary"] } },
        },
      },
      null,
      2,
    );
  }, [p.data.agents]);
  async function guard(label: string, fn: () => Promise<void>) {
    setError("");
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  const runExample = (id: string) =>
    guard("run", async () => {
      const body: any = { label: "run " + new Date().toLocaleTimeString() };
      if (overrides.trim()) body.overrides = JSON.parse(overrides);
      setLast(await api(`/inspector/examples/${enc(id)}/run`, "POST", body));
      await runs.reload();
    });
  return (
    <section aria-label="Playground" data-testid="playground">
      <p className="quiet" data-testid="playground-notice">
        Runs use a copy of your team in a throw-away folder with{" "}
        <b>scripted fixture output only</b>. No live provider is started and
        your folders, leases and conversations are untouched.
      </p>
      <h3>Saved examples</h3>
      {!examples.value.length && (
        <p className="quiet">No examples yet. Save one below.</p>
      )}
      <ul className="insp-plain">
        {examples.value.map((ex) => (
          <li key={ex.id} data-testid="example">
            <div className="row between">
              <span>
                <b>{ex.name}</b>{" "}
                <small className="quiet">{ex.tasks.length} task(s)</small>
              </span>
              <span className="row">
                <button
                  disabled={!!busy}
                  onClick={() => void runExample(ex.id)}
                >
                  {busy === "run" ? "Running…" : "Run (fixture)"}
                </button>
                <button
                  onClick={() => {
                    setDraft(JSON.stringify(stripMeta(ex), null, 2));
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() =>
                    void guard("del", async () => {
                      await api("/inspector/examples/" + enc(ex.id), "DELETE");
                      await examples.reload();
                    })
                  }
                >
                  Delete
                </button>
              </span>
            </div>
            {ex.description && (
              <small className="quiet">{ex.description}</small>
            )}
          </li>
        ))}
      </ul>
      <label>
        Optional overrides for the next run (JSON, e.g. change a model or prompt
        without touching the live agent)
        <textarea
          aria-label="Run overrides"
          placeholder='{"agents":{"Planner":{"model":"other-model"}}}'
          value={overrides}
          onChange={(e) => setOverrides(e.target.value)}
        />
      </label>
      <details open={editing}>
        <summary
          onClick={(e) => {
            e.preventDefault();
            if (!editing && !draft) setDraft(template);
            setEditing(!editing);
          }}
        >
          Create or edit an example
        </summary>
        <textarea
          aria-label="Example definition"
          className="insp-json"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="row">
          <button
            className="primary"
            disabled={!draft.trim()}
            onClick={() =>
              void guard("save", async () => {
                const input = JSON.parse(draft);
                const existing = examples.value.find(
                  (x) => x.name === input.name,
                );
                await api(
                  existing
                    ? "/inspector/examples/" + enc(existing.id)
                    : "/inspector/examples",
                  existing ? "PUT" : "POST",
                  input,
                );
                setDraft("");
                setEditing(false);
                await examples.reload();
              })
            }
          >
            Save example
          </button>
          <button
            disabled={!draft.trim() || !!busy}
            onClick={() =>
              void guard("run", async () => {
                const body: any = {
                  example: JSON.parse(draft),
                  label: "draft",
                };
                if (overrides.trim()) body.overrides = JSON.parse(overrides);
                setLast(await api("/inspector/playground/run", "POST", body));
                await runs.reload();
              })
            }
          >
            Run without saving
          </button>
        </div>
      </details>
      {error && (
        <p role="alert" className="insp-error">
          {error}
        </p>
      )}
      {last && <RunView run={last} />}
      <h3>Runs</h3>
      {!runs.value.length && <p className="quiet">No runs yet.</p>}
      <ul className="insp-plain">
        {[...runs.value].reverse().map((r) => (
          <li key={r.id} data-testid="run-row">
            <label className="row">
              <input
                type="checkbox"
                aria-label={"Compare " + (r.label || r.exampleName)}
                checked={pick.includes(r.id)}
                onChange={(e) =>
                  setPick((old) =>
                    e.target.checked
                      ? [...old, r.id].slice(-2)
                      : old.filter((x) => x !== r.id),
                  )
                }
              />
              <span>
                {r.exampleName}{" "}
                {r.label && <small className="quiet">· {r.label}</small>}{" "}
                <span
                  className={
                    "badge " + (r.expectations.passed ? "green" : "red")
                  }
                >
                  {r.expectations.passed
                    ? "expectations met"
                    : "expectations missed"}
                </span>{" "}
                <span className="badge">{r.workflowStatus}</span>
                {r.stalled && <span className="badge red">stalled</span>}
              </span>
            </label>
            <button
              onClick={() =>
                void guard("view", async () =>
                  setLast(await api("/inspector/runs/" + enc(r.id))),
                )
              }
            >
              View
            </button>
          </li>
        ))}
      </ul>
      <button
        disabled={pick.length !== 2}
        onClick={() =>
          void guard("compare", async () =>
            setDiff(
              await api("/inspector/compare", "POST", {
                a: pick[0],
                b: pick[1],
              }),
            ),
          )
        }
      >
        Compare selected runs
      </button>
      {diff && <DiffView diff={diff} />}
    </section>
  );
}
const stripMeta = (ex: any) => {
  const { id, createdAt, updatedAt, ...rest } = ex;
  void id;
  void createdAt;
  void updatedAt;
  return rest;
};
function RunView({ run }: { run: any }) {
  return (
    <article className="insp-run" data-testid="run-result">
      <div className="row between">
        <b>
          {run.exampleName} · {run.workflowStatus}
          {run.stalled ? " (stalled)" : ""}
        </b>
        <span
          className={"badge " + (run.expectations.passed ? "green" : "red")}
          data-testid="run-expectations"
        >
          {run.expectations.passed ? "expectations met" : "expectations missed"}
        </span>
      </div>
      <ul className="insp-plain">
        {run.outcomes.map((o: any) => (
          <li key={o.key} data-testid="run-outcome">
            <span className="badge">{o.status}</span> <b>{o.title}</b>{" "}
            <small className="quiet">({o.agent})</small>
            <pre>{o.result || o.waiting || "(no result)"}</pre>
          </li>
        ))}
      </ul>
      {run.expectations.checks.length > 0 && (
        <ul className="insp-plain">
          {run.expectations.checks.map((c: any, i: number) => (
            <li key={i}>
              <span className={"badge " + (c.passed ? "green" : "red")}>
                {c.passed ? "ok" : "miss"}
              </span>{" "}
              {c.name} <small className="quiet">{c.detail}</small>
            </li>
          ))}
        </ul>
      )}
      <small className="quiet">
        {run.timeline.length} timeline entries · {run.turns} agent turn(s) ·{" "}
        {run.durationMs} ms · mode: {run.mode}
      </small>
    </article>
  );
}
function DiffView({ diff }: { diff: any }) {
  return (
    <article className="insp-run" data-testid="run-diff">
      <b data-testid="diff-summary">{diff.summary}</b>
      <h4>Configuration</h4>
      {!diff.config.changed && <p className="quiet">Identical.</p>}
      {diff.config.agents.map((a: any) => (
        <div key={a.name}>
          <b>{a.name}</b>{" "}
          {a.state !== "kept" && <span className="badge">{a.state}</span>}
          <ul className="insp-plain">
            {a.changes.map((c: any) => (
              <li key={c.field}>
                {c.field}: <code>{JSON.stringify(c.before)}</code> →{" "}
                <code>{JSON.stringify(c.after)}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {[...diff.config.edges.added, ...diff.config.rules.added].length > 0 && (
        <p>Connections/rules added.</p>
      )}
      <h4>Outcomes</h4>
      <ul className="insp-plain">
        {diff.outcomes.tasks.map((o: any) => (
          <li key={o.key}>
            <b>{o.key}</b>: {o.a?.status} → {o.b?.status}
            {o.resultChanged && <span className="badge">result changed</span>}
            {o.resultChanged && (
              <div className="insp-sidebyside">
                <pre>{o.a?.result}</pre>
                <pre>{o.b?.result}</pre>
              </div>
            )}
          </li>
        ))}
      </ul>
      <h4>Timeline</h4>
      <ul className="insp-plain">
        {diff.timeline.ops
          .filter((o: any) => o.op !== "same")
          .map((o: any, i: number) => (
            <li key={i} className={"diff-" + o.op}>
              {o.op === "added" ? "+" : "−"} {o.sig.replaceAll("|", " · ")}
            </li>
          ))}
      </ul>
    </article>
  );
}

// ---- export --------------------------------------------------------------------------------
function Export() {
  const [format, setFormat] = useState<"zip" | "json">("zip");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setError("");
    try {
      const bundle = await api("/inspector/bundle", "POST", { format });
      setResult(bundle);
      const bytes =
        bundle.encoding === "base64"
          ? Uint8Array.from(atob(bundle.data), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(bundle.data);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: bundle.contentType }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = bundle.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Diagnostic export" data-testid="export">
      <p>
        Exports configuration shape, statuses, limits, locks and the event
        timeline for support or debugging. Credentials, tokens, API keys, auth
        headers, environment secrets, agent instructions, raw tool input and
        file contents are never included; secret-looking values are replaced
        with <code>[REDACTED]</code>.
      </p>
      <div className="row">
        <label>
          Format
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as "zip" | "json")}
          >
            <option value="zip">ZIP (one file per area)</option>
            <option value="json">Single JSON file</option>
          </select>
        </label>
        <button className="primary" disabled={busy} onClick={() => void run()}>
          {busy ? "Preparing…" : "Export redacted bundle"}
        </button>
      </div>
      {error && (
        <p role="alert" className="insp-error">
          {error}
        </p>
      )}
      {result && (
        <div data-testid="export-result">
          <p>
            <b data-testid="export-name">{result.filename}</b> · {result.bytes}{" "}
            bytes
          </p>
          <p className="quiet">
            Contents: {result.files.join(", ")}. Redacted:{" "}
            {result.redaction.literalsRemoved} secret value(s),{" "}
            {result.redaction.patternsRemoved} credential pattern(s),{" "}
            {result.redaction.keysRemoved} secret-named field(s);{" "}
            {result.redaction.truncated} long text(s) shortened.
          </p>
        </div>
      )}
    </section>
  );
}
