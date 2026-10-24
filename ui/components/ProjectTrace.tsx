import { useEffect, useMemo, useState } from "react";
import { Info, MessageSquare, X } from "lucide-react";
import { api, type Agent, type Snapshot, type TeamEvent } from "../api";
import "./project-trace.css";

type TraceEvent = {
  seq: number;
  at: string;
  type: string;
  category: string;
  severity: "debug" | "info" | "warn" | "error";
  summary: string;
  correlationId: string;
  agentId: string | null;
  agentName: string | null;
  agentIds: string[];
  taskId: string | null;
  workflowId: string | null;
  files: string[];
  conversation: { sessionId: string; agentId: string } | null;
  data: unknown;
};
type QuickTarget =
  | { kind: "event"; event: TraceEvent }
  | { kind: "agent"; agent: Agent; events: TraceEvent[] };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const eventColor = (e: TraceEvent) =>
  e.severity === "error"
    ? "#ef7777"
    : e.severity === "warn"
      ? "#e7bd5c"
      : e.category === "transfer" || e.category === "message"
        ? "#8cdbbd"
        : "#78a9e8";

export function ProjectTrace({
  data,
  events,
  openChat,
  initialWorkflowId = "",
}: {
  data: Snapshot;
  events: TeamEvent[];
  openChat: (id: string) => void;
  initialWorkflowId?: string;
}) {
  const [workflowId, setWorkflowId] = useState(initialWorkflowId);
  const [entries, setEntries] = useState<TraceEvent[]>([]);
  const [error, setError] = useState("");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [quick, setQuick] = useState<QuickTarget | null>(null);
  const workflow = data.workflows.find((w) => w.id === workflowId);
  useEffect(() => setWorkflowId(initialWorkflowId), [initialWorkflowId]);
  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams({
      teamId: data.activeTeamId,
      minSeverity: "debug",
      limit: "1000",
    });
    if (workflowId) query.set("workflowId", workflowId);
    api(`/inspector/timeline?${query}`)
      .then((result: { entries: TraceEvent[] }) => {
        if (!alive) return;
        const chronological = result.entries
          .slice()
          .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
        setEntries(chronological);
        setSelectedSeq((current) =>
          current && chronological.some((e) => e.seq === current)
            ? current
            : (chronological.at(-1)?.seq ?? null),
        );
        setError("");
      })
      .catch(
        (e) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [data.activeTeamId, workflowId, events.length]);
  useEffect(() => {
    if (!quick) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuick(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quick]);
  const currentIndex = entries.findIndex((entry) => entry.seq === selectedSeq);
  const selectedEvent =
    currentIndex < 0 ? entries.at(-1) : entries[currentIndex];
  const visibleEvents =
    currentIndex < 0 ? entries : entries.slice(0, currentIndex + 1);
  const agents = data.teamView?.allAgents ?? data.agents;
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const graph = useMemo(() => {
    const participating = new Set<string>();
    const edgeCounts = new Map<
      string,
      { from: string; to: string; count: number; latest: TraceEvent }
    >();
    for (const event of visibleEvents) {
      const ids = event.agentIds.filter((id) => agentsById.has(id));
      ids.forEach((id) => participating.add(id));
      const d = record(event.data);
      const from = typeof d.fromAgentId === "string" ? d.fromAgentId : ids[0];
      const to = typeof d.toAgentId === "string" ? d.toAgentId : ids[1];
      if (
        from &&
        to &&
        from !== to &&
        agentsById.has(from) &&
        agentsById.has(to)
      ) {
        const key = `${from}>${to}`;
        const existing = edgeCounts.get(key);
        edgeCounts.set(key, {
          from,
          to,
          count: (existing?.count ?? 0) + 1,
          latest: event,
        });
      }
    }
    if (workflow)
      workflow.tasks.forEach((task) => participating.add(task.agentId));
    const nodes = [...participating]
      .map((id) => agentsById.get(id))
      .filter((agent): agent is Agent => !!agent);
    const positions = new Map(
      nodes.map((agent, index) => {
        const angle =
          (Math.PI * 2 * index) / Math.max(nodes.length, 1) - Math.PI / 2;
        return [
          agent.id,
          {
            x: 500 + Math.cos(angle) * (nodes.length < 3 ? 210 : 330),
            y: 245 + Math.sin(angle) * 155,
          },
        ];
      }),
    );
    return { nodes, edges: [...edgeCounts.values()], positions };
  }, [visibleEvents, workflow, agents]);
  const shownWorkflowName = workflow?.name ?? "All team activity";
  return (
    <div className="project-trace" data-testid="project-trace">
      <header className="project-trace-head">
        <div>
          <span className="eyebrow">PROJECT TRACE</span>
          <h2>{shownWorkflowName}</h2>
          <p>
            Follow who talked to whom, what happened, and which files were
            produced.
          </p>
        </div>
        <label>
          Project
          <select
            aria-label="Project"
            value={workflowId}
            onChange={(event) => setWorkflowId(event.target.value)}
          >
            <option value="">All team activity</option>
            {data.workflows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error && (
        <p className="trace-error" role="alert">
          Could not load this project trace: {error}
        </p>
      )}
      <section className="trace-graph-area" aria-label="Communication graph">
        <div className="trace-graph-caption">
          <b>Communication graph</b>
          <span>
            {selectedEvent
              ? `Through ${new Date(selectedEvent.at).toLocaleTimeString()}`
              : "Select a project event below"}
          </span>
        </div>
        {selectedEvent && graph.nodes.length ? (
          <svg
            className="trace-graph"
            viewBox="0 0 1000 490"
            role="img"
            aria-label="Agents and their recorded handoffs"
          >
            <defs>
              <marker
                id="trace-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="#718197" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const from = graph.positions.get(edge.from)!;
              const to = graph.positions.get(edge.to)!;
              const mx = (from.x + to.x) / 2;
              const my = (from.y + to.y) / 2;
              return (
                <g key={`${edge.from}>${edge.to}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke="#718197"
                    strokeWidth={Math.min(5, 1.5 + edge.count)}
                    markerEnd="url(#trace-arrow)"
                  />
                  <text x={mx} y={my - 7} className="trace-edge-label">
                    {edge.count} event{edge.count === 1 ? "" : "s"}
                  </text>
                  <foreignObject x={mx - 13} y={my + 1} width="28" height="28">
                    <button
                      className="trace-info edge-info"
                      title={`Quick Look: ${edge.latest.summary}`}
                      aria-label={`Quick Look: ${edge.latest.summary}`}
                      onClick={() =>
                        setQuick({ kind: "event", event: edge.latest })
                      }
                    >
                      <Info size={14} />
                    </button>
                  </foreignObject>
                </g>
              );
            })}
            {graph.nodes.map((agent) => {
              const at = graph.positions.get(agent.id)!;
              const related = visibleEvents.filter((event) =>
                event.agentIds.includes(agent.id),
              );
              return (
                <g
                  key={agent.id}
                  className="trace-node"
                  onClick={() =>
                    setQuick({ kind: "agent", agent, events: related })
                  }
                >
                  <rect
                    x={at.x - 95}
                    y={at.y - 35}
                    width="190"
                    height="70"
                    rx="12"
                  />
                  <text
                    x={at.x}
                    y={at.y - 2}
                    textAnchor="middle"
                    className="trace-node-name"
                  >
                    {agent.name.slice(0, 23)}
                  </text>
                  <text
                    x={at.x}
                    y={at.y + 17}
                    textAnchor="middle"
                    className="trace-node-detail"
                  >
                    {agent.role || agent.environment} · {related.length} event
                    {related.length === 1 ? "" : "s"}
                  </text>
                  <foreignObject
                    x={at.x + 62}
                    y={at.y - 53}
                    width="28"
                    height="28"
                  >
                    <button
                      className="trace-info"
                      title={`Quick Look: ${agent.name}`}
                      aria-label={`Quick Look: ${agent.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setQuick({ kind: "agent", agent, events: related });
                      }}
                    >
                      <Info size={14} />
                    </button>
                  </foreignObject>
                </g>
              );
            })}
            {!graph.edges.length && (
              <text
                x="500"
                y="455"
                textAnchor="middle"
                className="trace-empty-label"
              >
                No agent-to-agent handoffs recorded before this point.
              </text>
            )}
          </svg>
        ) : (
          <div className="trace-graph-empty">
            {entries.length
              ? "No agent activity is linked to this project yet."
              : "Project events will appear here as work runs."}
          </div>
        )}
      </section>
      <section className="trace-timeline" aria-label="Project timeline">
        <div className="trace-timeline-top">
          <div>
            <b>Timeline</b>
            <span>
              {entries.length} event{entries.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="quiet">
            Select an event to move through the project
          </span>
        </div>
        {entries.length ? (
          <div className="trace-timeline-scroll">
            <ol>
              {entries.map((event) => (
                <li
                  key={event.seq}
                  className={event.seq === selectedSeq ? "selected" : ""}
                >
                  <button
                    className="trace-event-select"
                    onClick={() => setSelectedSeq(event.seq)}
                    title={`${new Date(event.at).toLocaleString()} · ${event.summary}`}
                    aria-current={
                      event.seq === selectedSeq ? "step" : undefined
                    }
                  >
                    <span
                      className="trace-event-dot"
                      style={{ background: eventColor(event) }}
                    />
                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                    <span>{event.summary}</span>
                  </button>
                  <button
                    className="trace-info trace-event-info"
                    title="Quick Look summary"
                    aria-label={`Quick Look: ${event.summary}`}
                    onClick={() => setQuick({ kind: "event", event })}
                  >
                    <Info size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="trace-timeline-empty">
            Assign a project or run a task to start its timeline.
          </p>
        )}
      </section>
      {quick && (
        <div
          className="trace-quicklook-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setQuick(null)
          }
        >
          <section
            className="trace-quicklook"
            role="dialog"
            aria-modal="true"
            aria-label="Quick Look summary"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">QUICK LOOK · SUMMARY</span>
                <h3>
                  {quick.kind === "event"
                    ? quick.event.summary
                    : quick.agent.name}
                </h3>
              </div>
              <button
                className="icon"
                aria-label="Close Quick Look"
                onClick={() => setQuick(null)}
              >
                <X size={17} />
              </button>
            </header>
            {quick.kind === "event" ? (
              <div className="trace-quicklook-body">
                <p>
                  <b>{quick.event.category}</b> ·{" "}
                  {new Date(quick.event.at).toLocaleString()}
                </p>
                <p>{quick.event.summary}</p>
                <p className="trace-markdown-summary">
                  **{quick.event.summary}**
                  <br />
                  {quick.event.type} · {quick.event.correlationId}
                </p>
                {!!quick.event.files.length && (
                  <div>
                    <b>Files and assets</b>
                    <ul>
                      {quick.event.files.map((file) => (
                        <li key={file}>
                          <code>{file}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {quick.event.conversation && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setQuick(null);
                      openChat(quick.event.conversation!.agentId);
                    }}
                  >
                    <MessageSquare size={14} /> Open agent conversation
                  </button>
                )}
                <details>
                  <summary>Event details</summary>
                  <pre>{JSON.stringify(quick.event.data, null, 2)}</pre>
                </details>
              </div>
            ) : (
              <div className="trace-quicklook-body">
                <p>{quick.agent.role || `${quick.agent.environment} agent`}</p>
                <p>
                  {quick.events.length} event
                  {quick.events.length === 1 ? "" : "s"} in this project trace.
                </p>
                <ul>
                  {quick.events
                    .slice(-8)
                    .reverse()
                    .map((event) => (
                      <li key={event.seq}>
                        {event.summary}{" "}
                        <small>{new Date(event.at).toLocaleTimeString()}</small>
                      </li>
                    ))}
                </ul>
                <button
                  className="secondary"
                  onClick={() => {
                    setQuick(null);
                    openChat(quick.agent.id);
                  }}
                >
                  <MessageSquare size={14} /> Open agent conversation
                </button>
              </div>
            )}
            <footer>Press Esc or click outside to close.</footer>
          </section>
        </div>
      )}
    </div>
  );
}
