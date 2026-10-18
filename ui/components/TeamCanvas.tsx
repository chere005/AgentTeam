import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  BaseEdge,
  getBezierPath,
  type NodeProps,
  type EdgeProps,
  type Node,
  EdgeLabelRenderer,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Plus,
  Settings2,
  MessageSquare,
  GitBranch,
  ArrowRight,
  ArrowLeftRight,
  Briefcase,
  Lightbulb,
  ShieldCheck,
  Bell,
  X,
  Trash2,
} from "lucide-react";
import {
  api,
  saved,
  persist,
  type Agent,
  type Snapshot,
  type TeamEvent,
  type Edge,
} from "../api";
type Props = {
  data: Snapshot;
  selected: string;
  setSelected: (id: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  events: TeamEvent[];
  edit: (a: Agent) => void;
  add: () => void;
  chat: (id: string) => void;
};
function Card({ data }: NodeProps) {
  const a = data.agent as Agent,
    activity = data.activity as any;
  return (
    <div className={"agent-card " + (data.selected ? "chosen" : "")}>
      <Handle type="target" position={Position.Top} />
      <div className="row">
        <span className={"avatar " + a.environment}>{a.name[0]}</span>
        <div className="grow">
          <b>{a.name}</b>
          <small>
            {a.kind === "team-assistant"
              ? "Team coordinator"
              : a.environment + " · " + a.model}
          </small>
        </div>
        <span
          className={
            "state-orbit " +
            (activity?.state === "processing" ? "processing" : "")
          }
        />
      </div>
      <div className="card-basics">
        <span
          className={
            "badge " + (activity?.state === "processing" ? "green" : "")
          }
        >
          {activity?.state ?? "idle"}
        </span>
        <span>
          {activity?.capacity.running ?? 0} /{" "}
          {a.maxConcurrentInvocations ?? "∞"} invoked
        </span>
      </div>
      <div
        className="card-access"
        title={
          a.workspaces
            .map(
              (w) =>
                w.path +
                " — " +
                (w.access === "write" ? "read & write" : "read only"),
            )
            .join("\n") || "No attached folders"
        }
      >
        {a.workspaces.length ? (
          a.workspaces.map((w) => (
            <span key={w.path}>
              {w.access === "write" ? "RW" : "RO"} ·{" "}
              {w.path.split(/[\\/]/).pop()}
              {w.active ? " · active" : ""}
            </span>
          ))
        ) : (
          <span>No attached folders</span>
        )}
      </div>
      {!data.simple && (
        <>
          <p>{a.role || "Add a role and instructions"}</p>
          <div className="card-meta">
            <span>{a.skills.length} skills</span>
            <span>{a.effort ?? "Auto"} effort</span>
            <span>{a.workspaces.length} folders</span>
          </div>
          <div className="card-actions nodrag">
            <button
              onClick={() => {
                (data.chat as Function)(a.id);
              }}
            >
              <MessageSquare size={13} />
              Chat
            </button>
            <button
              onClick={() => {
                (data.edit as Function)(a);
              }}
            >
              <Settings2 size={13} />
              Configure
            </button>
          </div>
        </>
      )}
      {activity?.failedTaskIds.length > 0 && (
        <div className="failure">
          {activity.failedTaskIds.length} failed task(s)
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
function FlowEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath(props);
  const pulse = props.data?.pulse as any;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        style={{
          stroke: pulse ? "#77d5ba" : "#465267",
          strokeWidth: pulse ? 2.5 : 1.5,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="edge-caption nodrag nopan"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
        >
          {props.label}
        </div>
      </EdgeLabelRenderer>
      {pulse && (
        <circle
          className="flow-particle"
          r="4"
          fill={pulse.kind === "failure" ? "#f18c8c" : "#8ceacb"}
        >
          <animateMotion
            key={pulse.seq}
            dur="1.4s"
            repeatCount="2"
            path={path}
            keyPoints={pulse.reverse ? "1;0" : "0;1"}
            keyTimes="0;1"
            calcMode="linear"
          />
        </circle>
      )}
    </>
  );
}
const nodeTypes = { agent: Card },
  edgeTypes = { flow: FlowEdge };
export function TeamCanvas(p: Props) {
  const [simple, setSimple] = useState(() => saved("simpleCards", true)),
    [nodes, setNodes] = useState<Node[]>([]),
    [connection, setConnection] = useState<{
      from: string;
      to: string;
      kind: Edge["kind"];
      bidirectional: boolean;
      enabled: boolean;
      id?: string;
    } | null>(null),
    [now, setNow] = useState(Date.now()),
    [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
      null,
    );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const positions = saved<Record<string, { x: number; y: number }>>(
    "positions",
    {},
  );
  function layout() {
    const byLevel = new Map<number, number>();
    const result: Record<string, { x: number; y: number }> = {};
    for (const a of p.data.agents) {
      let depth = 0,
        parent = a.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        depth++;
        parent = p.data.agents.find((a) => a.id === parent)?.parentId ?? null;
      }
      const index = byLevel.get(depth) ?? 0;
      byLevel.set(depth, index + 1);
      result[a.id] = { x: index * 310, y: depth * (simple ? 180 : 300) };
    }
    persist("positions", result);
    setNodes((old) => old.map((n) => ({ ...n, position: result[n.id] })));
  }
  useEffect(() => {
    setNodes((old) =>
      p.data.agents.map((a, i) => ({
        id: a.id,
        type: "agent",
        position: old.find((n) => n.id === a.id)?.position ??
          positions[a.id] ?? { x: (i % 3) * 310, y: Math.floor(i / 3) * 270 },
        data: {
          agent: a,
          activity: p.data.activity.find((x) => x.agentId === a.id),
          simple,
          selected: a.id === p.selected,
          edit: p.edit,
          chat: p.chat,
        },
      })),
    );
  }, [p.data, p.selected, simple]);
  const edges = useMemo(
    () =>
      p.data.edges.map((e) => {
        const event = [...p.events]
          .reverse()
          .find(
            (x) =>
              x.type === "flow.transferred" &&
              x.data.edgeId === e.id &&
              now - Date.parse(x.createdAt) < 3000,
          );
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: "flow",
          label: {
            delegate: "Tasks",
            consult: "Advice",
            review: "Review",
            notify: "Updates",
          }[e.kind],
          markerEnd: { type: MarkerType.ArrowClosed, color: "#6c829a" },
          markerStart: e.bidirectional
            ? { type: MarkerType.ArrowClosed, color: "#6c829a" }
            : undefined,
          data: {
            pulse: event
              ? {
                  ...event.data,
                  seq: event.seq,
                  reverse: event.data.fromAgentId !== e.from,
                }
              : null,
          },
          style: { opacity: e.enabled ? 1 : 0.35 },
        };
      }),
    [p.data.edges, p.events, now],
  );
  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <button className="primary" onClick={p.add}>
          <Plus size={15} />
          Agent
        </button>
        <button
          onClick={() => {
            setSimple(!simple);
            persist("simpleCards", !simple);
          }}
        >
          {simple ? "Detailed cards" : "Simple cards"}
        </button>
        <button title="Arrange team hierarchy" onClick={layout}>
          <GitBranch size={15} />
          Arrange
        </button>
        <div className="grow" />
        <span className="connection-hint">
          Connect two agents to choose how they work together
        </span>
      </div>
      <div className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes) =>
            setNodes((ns) => applyNodeChanges(changes, ns))
          }
          onNodeDragStop={(_, node) => {
            persist("positions", {
              ...saved("positions", {}),
              [node.id]: node.position,
            });
          }}
          onConnect={(c) =>
            setConnection({
              from: c.source!,
              to: c.target!,
              kind: "delegate",
              bidirectional: false,
              enabled: true,
            })
          }
          onEdgeClick={(_, edge) => {
            const existing = p.data.edges.find((e) => e.id === edge.id);
            if (existing) setConnection({ ...existing });
          }}
          onNodeClick={(_, n) => p.setSelected(n.id)}
          onNodeDoubleClick={(_, n) =>
            p.edit(p.data.agents.find((a) => a.id === n.id)!)
          }
          onNodeContextMenu={(e, n) => {
            e.preventDefault();
            setMenu({ id: n.id, x: e.clientX, y: e.clientY });
          }}
          onPaneClick={() => setMenu(null)}
          onEdgesDelete={(edges) =>
            void p.act(async () => {
              for (const e of edges) await api("/edges/" + e.id, "DELETE");
            })
          }
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          minZoom={0.15}
          maxZoom={2}
          colorMode="dark"
        >
          <Background gap={22} size={1} color="#30394a" />
          <Controls />
          <MiniMap nodeColor="#344c51" maskColor="#10141cbb" />
        </ReactFlow>
        {!p.data.agents.length && (
          <div className="canvas-empty">
            <h2>Build your team</h2>
            <p>Add agents, then draw connections between their handles.</p>
            <button className="primary" onClick={p.add}>
              Create first agent
            </button>
          </div>
        )}
      </div>
      <div className="canvas-help">
        Drag handles to connect · Double-click to configure · Right-click to
        open · Select a connection and Delete to remove
      </div>
      {connection && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConnection(null);
          }}
        >
          <section
            className="modal connection-editor"
            role="dialog"
            aria-modal="true"
            aria-label="Connection settings"
          >
            <header>
              <div>
                <span className="eyebrow">WORKING TOGETHER</span>
                <h2>
                  {connection.id ? "Edit connection" : "Connect your agents"}
                </h2>
              </div>
              <button
                className="icon"
                aria-label="Close connection settings"
                onClick={() => setConnection(null)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="modal-content">
              <div className="connection-pair">
                <span>
                  {p.data.agents.find((a) => a.id === connection.from)?.name}
                </span>
                {connection.bidirectional ? (
                  <ArrowLeftRight size={20} />
                ) : (
                  <ArrowRight size={20} />
                )}
                <span>
                  {p.data.agents.find((a) => a.id === connection.to)?.name}
                </span>
              </div>
              <h3>What can they do together?</h3>
              <div
                className="connection-options"
                role="radiogroup"
                aria-label="Relationship"
              >
                {(
                  [
                    {
                      id: "delegate",
                      title: "Assign tasks",
                      description:
                        "Hand off work and receive the completed result.",
                      icon: Briefcase,
                    },
                    {
                      id: "consult",
                      title: "Ask for advice",
                      description:
                        "Get an opinion while keeping ownership of the task.",
                      icon: Lightbulb,
                    },
                    {
                      id: "review",
                      title: "Request a review",
                      description:
                        "Ask the other agent to check work and flag issues.",
                      icon: ShieldCheck,
                    },
                    {
                      id: "notify",
                      title: "Send updates",
                      description:
                        "Share progress or information without assigning work.",
                      icon: Bell,
                    },
                  ] as const
                ).map((option) => (
                  <button
                    role="radio"
                    aria-checked={connection.kind === option.id}
                    className={connection.kind === option.id ? "selected" : ""}
                    key={option.id}
                    onClick={() =>
                      setConnection({ ...connection, kind: option.id })
                    }
                  >
                    <option.icon size={21} />
                    <span>
                      <b>{option.title}</b>
                      <small>{option.description}</small>
                    </span>
                    <span className="choice-circle" />
                  </button>
                ))}
              </div>
              <h3>Who can start the conversation?</h3>
              <div className="direction-options">
                <button
                  className={!connection.bidirectional ? "selected" : ""}
                  onClick={() =>
                    setConnection({ ...connection, bidirectional: false })
                  }
                >
                  <ArrowRight size={17} />
                  <span>
                    Only{" "}
                    {p.data.agents.find((a) => a.id === connection.from)?.name}
                  </span>
                </button>
                <button
                  className={connection.bidirectional ? "selected" : ""}
                  onClick={() =>
                    setConnection({ ...connection, bidirectional: true })
                  }
                >
                  <ArrowLeftRight size={17} />
                  <span>Either agent</span>
                </button>
              </div>
              <p className="hint">
                Replies can always return to the sender. This controls who can
                initiate new work.
              </p>
              <button
                className="text-button"
                onClick={() =>
                  setConnection({
                    ...connection,
                    from: connection.to,
                    to: connection.from,
                  })
                }
              >
                <ArrowLeftRight size={14} />
                Reverse direction
              </button>
            </div>
            <footer>
              {connection.id ? (
                <button
                  className="danger"
                  onClick={() =>
                    void p.act(async () => {
                      await api("/edges/" + connection.id, "DELETE");
                      setConnection(null);
                    })
                  }
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              ) : (
                <span />
              )}
              <div className="row">
                <button onClick={() => setConnection(null)}>Cancel</button>
                <button
                  className="primary"
                  onClick={() =>
                    void p.act(async () => {
                      const { id, ...input } = connection;
                      await api(
                        id ? "/edges/" + id : "/edges",
                        id ? "PUT" : "POST",
                        input,
                      );
                      setConnection(null);
                    })
                  }
                >
                  {connection.id ? "Save connection" : "Connect agents"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
      {menu && (
        <>
          <div className="menu-dismiss" onClick={() => setMenu(null)} />
          <div
            className="context-menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 230),
              top: Math.min(menu.y, window.innerHeight - 260),
            }}
          >
            {[
              ["Chat in AgentTeam", () => p.chat(menu.id)],
              [
                "Configure agent",
                () => p.edit(p.data.agents.find((a) => a.id === menu.id)!),
              ],
              [
                "Open native app",
                () =>
                  void p.act(async () => {
                    const r = await window.agentteam.openAgent(
                      menu.id,
                      "native",
                    );
                    window.alert(r.message);
                  }),
              ],
              [
                "CLI / resume instructions",
                () =>
                  void p.act(async () => {
                    const r = await window.agentteam.openAgent(menu.id, "cli");
                    window.prompt(
                      r.message + "\nDirectory: " + r.cwd,
                      r.command,
                    );
                  }),
              ],
              [
                "Take control / Return",
                () =>
                  void p.act(() =>
                    api("/agents/" + menu.id + "/control", "POST", {
                      owner:
                        p.data.agents.find((a) => a.id === menu.id)?.control ===
                        "human"
                          ? "team"
                          : "human",
                    }),
                  ),
              ],
            ].map(([label, fn]) => (
              <button
                key={String(label)}
                onClick={() => {
                  (fn as Function)();
                  setMenu(null);
                }}
              >
                {String(label)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
