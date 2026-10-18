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
  useStore,
  BaseEdge,
  getBezierPath,
  type NodeProps,
  type EdgeProps,
  type Node,
  type ReactFlowInstance,
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
  Users,
} from "lucide-react";
import { SaveTeamDialog } from "./Teams";
import { EdgeTransfers } from "./Inspector";
import { GroupBar, GroupNode } from "./TeamGroups";
import { priorityName } from "./PrioritySelect";
import {
  createGroup,
  groupCentre,
  groupNodeId,
  hiddenAgents,
  relatives,
  sanitizeGroups,
  setAllCollapsed,
  stepSibling,
  summarizeGroup,
  toggleGroup,
  ungroup,
  visibleEdges,
  type Group,
} from "../groups";
import "./canvas-cards.css";
import { accessLabel, accessTitle } from "../access-view";
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
  /** Open the saved-teams pane to insert a team onto the canvas. */
  openTeams?: () => void;
  /** Open the executable workflow graphs pane (separate from this communication graph). */
  openGraphs?: () => void;
};
/** Below this React Flow zoom, cards switch to the large-type glance layout. */
const FAR_ZOOM = 0.6;
/** Beyond this many agents per-card animation is turned off to keep large graphs responsive. */
const CALM_AGENTS = 40;
function Card({ data }: NodeProps) {
  const a = data.agent as Agent,
    activity = data.activity as any;
  const zoom = useStore((s) => s.transform[2]),
    far = zoom < FAR_ZOOM,
    state: string = activity?.state ?? "idle",
    failed = (activity?.failedTaskIds?.length ?? 0) > 0,
    resume = (activity?.interruptedTaskIds?.length ?? 0) > 0,
    limit = a.maxConcurrentInvocations ?? "∞";
  return (
    <div
      className={
        "agent-card " +
        (data.selected ? "chosen " : "") +
        (far ? "far " : "") +
        (state === "processing" ? "busy " : "") +
        (failed ? "has-failure " : "") +
        (resume ? "has-resume " : "")
      }
      style={
        far
          ? ({
              "--inv": Math.min(1.8, 1 / Math.max(zoom, 0.01)),
            } as React.CSSProperties)
          : undefined
      }
      aria-label={`${a.name}, ${state}${failed ? ", has failed tasks" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      {far && (
        <div className="card-glance" data-testid="card-glance">
          <b title={a.name}>{a.name}</b>
          <span className="glance-line">
            {(a as any).roleType && (a as any).roleType !== "custom"
              ? (a as any).roleType + " · "
              : ""}
            {a.environment} · {a.model}
          </span>
          <span className="glance-line">
            <span
              className={"badge " + (state === "processing" ? "green" : "")}
            >
              {state}
              {failed ? " · failed" : resume ? " · resume" : ""}
            </span>{" "}
            {priorityName(a.schedulingPriority)} ·{" "}
            {activity?.capacity.running ?? 0}/{limit}
          </span>
        </div>
      )}
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
          {activity?.capacity.running ?? 0} / {limit} invoked
        </span>
        {!!data.simple && <span>{priorityName(a.schedulingPriority)}</span>}
      </div>
      <div
        className="card-access"
        title={
          a.workspaces.map((w) => accessTitle(w)).join("\n") ||
          "No attached folders"
        }
      >
        {a.workspaces.length ? (
          a.workspaces.map((w) => (
            <span key={w.path}>
              {accessLabel(w)} · {w.path.split(/[\\/]/).pop()}
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
          <dl className="card-config" aria-label={`${a.name} configuration`}>
            <div>
              <dt>Priority</dt>
              <dd>{priorityName(a.schedulingPriority)}</dd>
            </div>
            <div>
              <dt>Effort</dt>
              <dd>{a.effort ?? "Auto"}</dd>
            </div>
            <div>
              <dt>Invoked</dt>
              <dd>
                {activity?.capacity.running ?? 0}/{limit}
              </dd>
            </div>
            <div>
              <dt>Skills</dt>
              <dd>{a.skills.length}</dd>
            </div>
            <div>
              <dt>Folders</dt>
              <dd>{a.workspaces.length}</dd>
            </div>
            <div>
              <dt>Control</dt>
              <dd>{a.control}</dd>
            </div>
          </dl>
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
      {activity?.interruptedTaskIds?.length > 0 && (
        <div className="failure">
          {activity.interruptedTaskIds.length} interrupted task(s) to resume
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
function FlowEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath(props);
  const pulse = props.data?.pulse as any;
  const busy = !!props.data?.busy;
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        className={busy ? "edge-busy" : undefined}
        style={{
          stroke: pulse ? "#77d5ba" : busy ? "#5fb89f" : "#465267",
          strokeWidth: pulse ? 2.5 : busy ? 2 : 1.5,
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
          style={{ pointerEvents: "all", cursor: "pointer" }}
          onClick={() =>
            // Run inspector: open this connection's request/response/duration/rule details.
            window.dispatchEvent(
              new CustomEvent("agentteam:inspect-edge", { detail: props.id }),
            )
          }
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
const nodeTypes = { agent: Card, group: GroupNode },
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
    [savingTeam, setSavingTeam] = useState(false),
    [groups, setGroups] = useState<Group[]>(() =>
      sanitizeGroups(
        saved("groups", []),
        p.data.agents.map((a) => a.id),
      ),
    ),
    [flow, setFlow] = useState<ReactFlowInstance | null>(null),
    [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
      null,
    );
  useEffect(() => {
    const open = (e: Event) => {
      const existing = p.data.edges.find(
        (x) => x.id === (e as CustomEvent<string>).detail,
      );
      if (existing) setConnection({ ...existing });
    };
    window.addEventListener("agentteam:inspect-edge", open);
    return () => window.removeEventListener("agentteam:inspect-edge", open);
  }, [p.data.edges]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Restored once: a saved viewport wins over fitView so the canvas reopens where it was left.
  const [viewport] = useState(() => {
    const v = saved<{ x: number; y: number; zoom: number } | null>(
      "viewport",
      null,
    );
    return v &&
      [v.x, v.y, v.zoom].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      ) &&
      v.zoom >= 0.15 &&
      v.zoom <= 2
      ? v
      : null;
  });
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
  // Prune groups when agents are deleted, and persist every change.
  const agentIdKey = p.data.agents.map((a) => a.id).join(",");
  useEffect(() => {
    if (!p.data.agents.length) return;
    setGroups((g) => {
      const next = sanitizeGroups(
        g,
        p.data.agents.map((a) => a.id),
      );
      return JSON.stringify(next) === JSON.stringify(g) ? g : next;
    });
  }, [agentIdKey]);
  useEffect(() => {
    persist("groups", groups);
  }, [groups]);
  const hidden = useMemo(() => hiddenAgents(groups), [groups]);
  useEffect(() => {
    setNodes((old) => {
      const pos = (id: string) => old.find((n) => n.id === id)?.position;
      const agentNodes: Node[] = p.data.agents.map((a, i) => ({
        id: a.id,
        type: "agent",
        hidden: hidden.has(a.id),
        selected: hidden.has(a.id)
          ? false
          : old.find((n) => n.id === a.id)?.selected,
        position: pos(a.id) ??
          positions[a.id] ?? { x: (i % 3) * 310, y: Math.floor(i / 3) * 270 },
        data: {
          agent: a,
          activity: p.data.activity.find((x) => x.agentId === a.id),
          simple,
          selected: a.id === p.selected,
          edit: p.edit,
          chat: p.chat,
        },
      }));
      const known = Object.fromEntries(
        agentNodes.map((n) => [n.id, n.position]),
      );
      const groupNodes: Node[] = groups
        .filter((g) => g.collapsed)
        .map((g) => ({
          id: groupNodeId(g),
          type: "group",
          selected: old.find((n) => n.id === groupNodeId(g))?.selected,
          position: pos(groupNodeId(g)) ?? groupCentre(g, known),
          data: {
            group: g,
            summary: summarizeGroup(g, p.data.activity),
            expand: () => setGroups((all) => toggleGroup(all, g.id, false)),
          },
        }));
      return [...agentNodes, ...groupNodes];
    });
  }, [p.data, p.selected, simple, groups]);
  const edges = useMemo(
    () =>
      visibleEdges(p.data.edges, groups).map((e) => {
        const event = e.grouped
          ? undefined
          : [...p.events]
              .reverse()
              .find(
                (x) =>
                  x.type === "flow.transferred" &&
                  x.data.edgeId === e.id &&
                  now - Date.parse(x.createdAt) < 3000,
              );
        const sourceBusy =
          p.data.activity.find((x) => x.agentId === e.from)?.state ===
          "processing";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "flow",
          label: {
            delegate: "Tasks",
            consult: "Advice",
            review: "Review",
            notify: "Updates",
          }[e.kind as Edge["kind"]],
          markerEnd: { type: MarkerType.ArrowClosed, color: "#6c829a" },
          markerStart:
            (e as any).bidirectional && !e.grouped
              ? { type: MarkerType.ArrowClosed, color: "#6c829a" }
              : undefined,
          data: {
            busy: e.enabled && sourceBusy && e.kind === "delegate",
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
    [p.data.edges, p.data.activity, p.events, now, groups],
  );
  const selectedAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const n of nodes) {
      if (!n.selected) continue;
      if (n.type === "group") {
        const g = groups.find((x) => groupNodeId(x) === n.id);
        g?.agentIds.forEach((id) => ids.add(id));
      } else if (!n.hidden) ids.add(n.id);
    }
    return [...ids];
  }, [nodes, groups]);
  const rel = relatives(p.data.agents, p.selected);
  function goto(id: string | null) {
    if (!id) return;
    p.setSelected(id);
    // Reveal the target if a collapsed group is hiding it.
    setGroups((all) => {
      const g = all.find((x) => x.collapsed && x.agentIds.includes(id));
      return g ? toggleGroup(all, g.id, false) : all;
    });
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setTimeout(
      () =>
        flow?.fitView({
          nodes: [{ id }],
          duration: 250,
          maxZoom: 1,
          padding: 0.6,
        }),
      60,
    );
  }
  const calm = p.data.agents.length > CALM_AGENTS;
  return (
    <div
      className={"canvas-wrap" + (calm ? " calm" : "")}
      onKeyDown={(e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        const t = e.target as HTMLElement;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        const next =
          e.key === "ArrowUp"
            ? rel.parent
            : e.key === "ArrowDown"
              ? rel.children[0]
              : e.key === "ArrowRight"
                ? stepSibling(p.data.agents, p.selected, 1)
                : e.key === "ArrowLeft"
                  ? stepSibling(p.data.agents, p.selected, -1)
                  : undefined;
        if (next !== undefined) {
          e.preventDefault();
          goto(next);
        }
      }}
    >
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
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
        <button
          title="Select agents (Ctrl/Cmd-click or Shift-drag), then save them as a reusable team"
          disabled={!selectedAgentIds.length}
          onClick={() => setSavingTeam(true)}
        >
          <Users size={15} />
          Save as team
        </button>
        {p.openTeams && (
          <button
            title="Insert a saved team onto the canvas"
            onClick={p.openTeams}
          >
            <Users size={15} />
            Insert team
          </button>
        )}
        {p.openGraphs && (
          <button
            title="Executable workflow graphs: steps, conditions, commands, human input"
            onClick={p.openGraphs}
          >
            Workflow graphs
          </button>
        )}
        <div className="grow" />
        <span className="connection-hint">
          Connect two agents to choose how they work together
        </span>
      </div>
      <GroupBar
        groups={groups}
        selectionCount={selectedAgentIds.length}
        create={(name) =>
          setGroups((all) =>
            createGroup(
              all,
              name,
              selectedAgentIds,
              "g" + Date.now().toString(36),
            ),
          )
        }
        toggle={(id) => setGroups((all) => toggleGroup(all, id))}
        setAll={(c) => setGroups((all) => setAllCollapsed(all, c))}
        selectMembers={(id) => {
          const g = groups.find((x) => x.id === id);
          if (!g) return;
          if (g.collapsed) setGroups((all) => toggleGroup(all, id, false));
          setNodes((ns) =>
            ns.map((n) => ({ ...n, selected: g.agentIds.includes(n.id) })),
          );
        }}
        remove={(id) => setGroups((all) => ungroup(all, id))}
        nav={{
          parent: rel.parent ? () => goto(rel.parent) : null,
          child: rel.children[0] ? () => goto(rel.children[0]) : null,
          sibling: rel.siblings[0]
            ? () => goto(stepSibling(p.data.agents, p.selected, 1))
            : null,
        }}
      />
      <div className="canvas" aria-label="Team canvas">
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
          onNodeClick={(_, n) => {
            if (n.type === "agent") p.setSelected(n.id);
          }}
          onNodeDoubleClick={(_, n) => {
            if (n.type === "group")
              setGroups((all) =>
                toggleGroup(all, n.id.slice("group:".length), false),
              );
            else p.edit(p.data.agents.find((a) => a.id === n.id)!);
          }}
          onNodeContextMenu={(e, n) => {
            e.preventDefault();
            if (n.type !== "agent") return;
            setMenu({ id: n.id, x: e.clientX, y: e.clientY });
          }}
          onPaneClick={() => setMenu(null)}
          onEdgesDelete={(edges) =>
            void p.act(async () => {
              for (const e of edges) await api("/edges/" + e.id, "DELETE");
            })
          }
          deleteKeyCode={["Backspace", "Delete"]}
          onInit={setFlow}
          onMoveEnd={(_, v) => persist("viewport", v)}
          {...(viewport ? { defaultViewport: viewport } : { fitView: true })}
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
      {savingTeam && (
        <SaveTeamDialog
          agentIds={selectedAgentIds.filter(
            (id) =>
              p.data.agents.find((a) => a.id === id)?.kind !== "team-assistant",
          )}
          names={selectedAgentIds
            .filter(
              (id) =>
                p.data.agents.find((a) => a.id === id)?.kind !==
                "team-assistant",
            )
            .map((id) => p.data.agents.find((a) => a.id === id)?.name ?? id)}
          omittedAssistant={selectedAgentIds.some(
            (id) =>
              p.data.agents.find((a) => a.id === id)?.kind === "team-assistant",
          )}
          positions={Object.fromEntries(
            nodes
              .filter((n) => n.type === "agent")
              .map((n) => [n.id, n.position]),
          )}
          close={() => setSavingTeam(false)}
        />
      )}
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
              {connection.id && (
                <details className="edge-transfers" open>
                  <summary>Transfers on this connection</summary>
                  <EdgeTransfers
                    edgeId={connection.id}
                    agents={p.data.agents}
                  />
                </details>
              )}
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
