import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  useStore,
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  type NodeProps,
  type EdgeProps,
  type Node,
  type ReactFlowInstance,
  EdgeLabelRenderer,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Layers,
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
  Maximize,
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
import { teamKey, MAIN_TEAM_ID } from "../team-view";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  fitOrgLayout,
  orgLayout,
  resolveParents,
  type Size,
} from "../org-layout";
import {
  FIT_PADDING,
  MIN_FIT_ZOOM,
  fitStep,
  fitViewport,
  sameViewport,
  type FitState,
  type FitTrigger,
  type Viewport,
} from "../canvas-fit";
import { useTheme } from "../theme";
import { clearArrange, peekArrange } from "../arrange-request";
import { accessLabel, accessTitle } from "../access-view";
import { agentDisplayName, agentSelectorLabel } from "../agent-identity";
import { AgentAvatar } from "./AgentAvatar";
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
  /** Open the team library (example teams, saved teams, packs). */
  openTeams?: () => void;
  /** Open the projects view (a card's "View blockers"). */
  openBlockers?: (agentId: string) => void;
};
/** Below this React Flow zoom, cards switch to the large-type glance layout. */
const FAR_ZOOM = 0.6;
/** Beyond this many agents per-card animation is turned off to keep large graphs responsive. */
const CALM_AGENTS = 40;
/** Short role line for a card: the role preset or the first words of the role text. */
function roleLabel(a: Agent) {
  const type = (a as any).roleType as string | undefined;
  if (type && type !== "custom") return type[0].toUpperCase() + type.slice(1);
  const role = (a.role ?? "").trim();
  return role.length > 42 ? role.slice(0, 40).trimEnd() + "…" : role;
}
function Card({ data }: NodeProps) {
  const a = data.agent as Agent,
    activity = data.activity as any;
  const displayName = agentDisplayName(a);
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
      data-card-mode={data.simple ? "simple" : "detailed"}
      style={
        far
          ? ({
              // Constant on-screen text size down to the lowest fit zoom (ui/canvas-fit.ts).
              "--inv": Math.min(1 / MIN_FIT_ZOOM, 1 / Math.max(zoom, 0.01)),
            } as React.CSSProperties)
          : undefined
      }
      aria-label={`${agentSelectorLabel(a)}, ${state}${failed ? ", has failed tasks" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      {far && (
        <div className="card-glance" data-testid="card-glance">
          <b title={a.name}>{displayName}</b>
          <span className="glance-line" title={a.environment + " · " + a.model}>
            {a.kind === "team-assistant"
              ? "Coordinator"
              : roleLabel(a) || a.model}{" "}
            · {a.environment}
            {(state !== "idle" || failed || resume) && (
              <>
                {" "}
                <span
                  className={"badge " + (state === "processing" ? "green" : "")}
                >
                  {state}
                  {failed ? " · failed" : resume ? " · resume" : ""}
                </span>
              </>
            )}
          </span>
        </div>
      )}
      <div className="row">
        <AgentAvatar
          name={a.name}
          nickname={a.nickname}
          avatar={a.avatar}
          environment={a.environment}
          className={`avatar ${a.environment}`}
        />
        <div className="grow">
          <b title={a.name}>{displayName}</b>
          <small className="card-role">
            {a.kind === "team-assistant"
              ? "Team coordinator"
              : roleLabel(a) || "No role yet"}
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
        <span className="card-model" title={a.environment + " · " + a.model}>
          {a.environment} · {a.model}
        </span>
        <span
          className={
            "badge " + (activity?.state === "processing" ? "green" : "")
          }
        >
          {activity?.state ?? "idle"}
        </span>
      </div>
      <div
        className="card-details"
        aria-hidden={!!data.simple}
        inert={data.simple ? true : undefined}
      >
        <div className="card-details-inner">
          <p>{a.role || "Add a role and instructions"}</p>
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
          <span className="card-invoked">
            {activity?.capacity.running ?? 0} / {limit} invoked
          </span>
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
              Setup
            </button>
          </div>
        </div>
      </div>
      {(failed || resume) && (
        <button
          className="failure nodrag"
          title="Open the tasks that need a decision"
          onClick={(e) => {
            e.stopPropagation();
            (data.blockers as Function | undefined)?.(a.id);
          }}
        >
          {failed
            ? `${activity.failedTaskIds.length} failed task(s)`
            : `${activity.interruptedTaskIds.length} interrupted task(s) to resume`}{" "}
          · View blockers
        </button>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
/**
 * Org-chart tree edges (parent → child) are orthogonal step connectors; other communication
 * links are lighter and dashed. The kind label ("Tasks", "Review", ...) shows only while the edge
 * is hovered or selected (it is always in the edge's accessible name and the connection dialog).
 */
function FlowEdge(props: EdgeProps) {
  const tree = !!props.data?.tree;
  const [path, labelX, labelY] = tree
    ? getSmoothStepPath({
        ...props,
        borderRadius: 6,
        // One bus just under the parent, also for the lower lines of a compact (wrapped) row,
        // so the branches drop through the gaps between cards instead of crossing them.
        ...(props.targetY - props.sourceY > 160
          ? { centerY: props.sourceY + 45 }
          : {}),
      })
    : getBezierPath(props);
  const pulse = props.data?.pulse as any;
  const busy = !!props.data?.busy;
  const shown = !!props.selected || !!props.data?.hovered;
  // Captions keep a readable on-screen size when zoomed out (like the far-zoom card text).
  const zoom = useStore((st) => st.transform[2]),
    inv = Math.min(1 / MIN_FIT_ZOOM, Math.max(1, 1 / Math.max(zoom, 0.01)));
  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={props.markerEnd}
        markerStart={props.markerStart}
        className={
          (tree ? "edge-tree" : "edge-link") +
          (busy ? " edge-busy" : "") +
          (shown ? " edge-shown" : "")
        }
        style={{
          ...props.style,
          stroke: pulse
            ? "var(--edge-pulse)"
            : busy
              ? "var(--edge-busy)"
              : shown
                ? "var(--edge-hover)"
                : tree
                  ? "var(--edge-tree)"
                  : "var(--edge-link)",
          strokeWidth: pulse ? 2.5 : busy ? 2 : tree ? 1.5 : 1.25,
          strokeDasharray: tree || pulse || busy ? undefined : "5 4",
        }}
      />
      <EdgeLabelRenderer>
        <div
          className={"edge-caption nodrag nopan" + (shown ? " shown" : "")}
          data-testid="edge-caption"
          aria-hidden={!shown}
          style={{
            transform: `translate(${labelX}px,${labelY}px) translate(-50%, -50%) scale(${inv})`,
          }}
        >
          {props.label}
        </div>
      </EdgeLabelRenderer>
      {pulse && (
        <circle
          className="flow-particle"
          r="4"
          fill={
            pulse.kind === "failure"
              ? "var(--edge-pulse-failure)"
              : "var(--edge-pulse)"
          }
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
  // Groups and the viewport are remembered per team (Main keeps the legacy keys); the App
  // remounts the canvas (key = team id) when the active team changes.
  const teamId = p.data.activeTeamId ?? MAIN_TEAM_ID,
    teamName = p.data.teamView?.team.name ?? "this team",
    crossTeam = p.data.teamView?.crossTeam ?? [],
    otherAgents = (p.data.teamView?.otherAgents ?? []).filter(
      (a) => a.kind !== "team-assistant",
    ),
    teamNames = new Map(
      (p.data.teamView?.teams ?? []).map((t) => [t.id, t.name]),
    );
  const groupsKey = teamKey("groups", teamId),
    viewportKey = teamKey("viewport", teamId),
    arrangedKey = teamKey("arranged", teamId);
  const allAgents = p.data.teamView?.allAgents ?? p.data.agents;
  const agentName = (id: string) =>
    allAgents.find((a) => a.id === id)?.name ?? "Unknown agent";
  const [simple, setSimple] = useState(() => saved("simpleCards", true)),
    [nodes, setNodes] = useState<Node[]>([]),
    [connection, setConnection] = useState<{
      from: string;
      to: string;
      kind: Edge["kind"];
      bidirectional: boolean;
      enabled: boolean;
      id?: string;
      /** Explicit link to an agent of another team (sent as crossTeam: true). */
      crossTeam?: boolean;
    } | null>(null),
    [now, setNow] = useState(Date.now()),
    [savingTeam, setSavingTeam] = useState(false),
    [groups, setGroups] = useState<Group[]>(() =>
      sanitizeGroups(
        saved(groupsKey, []),
        p.data.agents.map((a) => a.id),
      ),
    ),
    [flow, setFlow] = useState<ReactFlowInstance | null>(null),
    [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
      null,
    ),
    [showGroups, setShowGroups] = useState(false);
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
  const openCrossTeam = (edgeId: string) => {
    const link = crossTeam.find((x) => x.edge.id === edgeId);
    if (link) setConnection({ ...link.edge, crossTeam: true });
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Restored once: a viewport the user panned/zoomed to by hand wins over fitting, so the canvas
  // reopens where it was left. Otherwise (and for viewports stored before `manual` existed) the
  // canvas fits the team (ui/canvas-fit.ts).
  const [viewport] = useState(() => {
    const v = saved<(Viewport & { manual?: boolean }) | null>(
      viewportKey,
      null,
    );
    return v &&
      v.manual === true &&
      [v.x, v.y, v.zoom].every(
        (n) => typeof n === "number" && Number.isFinite(n),
      ) &&
      // Persisted canvases below the readable fit floor make a reopened team look empty.
      v.zoom >= MIN_FIT_ZOOM &&
      v.zoom <= 2
      ? { x: v.x, y: v.y, zoom: v.zoom }
      : null;
  });
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLDivElement>(null),
    fitState = useRef<FitState>({ manual: !!viewport, hint: false }),
    lastFit = useRef<Viewport | null>(null),
    gesture = useRef(false),
    [fitHint, setFitHint] = useState(false),
    [hoverEdge, setHoverEdge] = useState<string | null>(null);
  /** Fit the visible cards into the canvas (padding, readable minimum zoom). */
  function applyFit(duration = 200) {
    const el = canvasRef.current;
    if (!flow || !el || !el.clientWidth || !el.clientHeight) return;
    const visible = flow.getNodes().filter((n) => !n.hidden);
    if (!visible.length) return;
    const v = fitViewport(flow.getNodesBounds(visible), {
      width: el.clientWidth,
      height: el.clientHeight,
    });
    lastFit.current = v;
    void flow.setViewport(v, { duration });
  }
  function fitTrigger(t: FitTrigger, duration?: number) {
    const r = fitStep(fitState.current, t);
    fitState.current = r.state;
    setFitHint(r.state.hint);
    // An explicit fit forgets the hand-placed viewport (the next launch fits again).
    if (t === "explicit")
      try {
        localStorage.removeItem("agentteam." + viewportKey);
      } catch {
        /* storage unavailable */
      }
    if (r.fit && t === "resize" && reflowRef.current()) return;
    if (r.fit) applyFit(duration);
  }
  const fitRef = useRef(fitTrigger);
  fitRef.current = fitTrigger;
  const reflowRef = useRef<() => boolean>(() => false);
  const positions = saved<Record<string, { x: number; y: number }>>(
    "positions",
    {},
  );
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const skipModeFit = useRef(false);
  const modeArrangeTimer = useRef<number | null>(null);
  const arrangeRef = useRef<
    (subset?: string[], fit?: boolean, cardMode?: boolean) => void
  >(() => {});
  useEffect(
    () => () => {
      if (modeArrangeTimer.current)
        window.clearTimeout(modeArrangeTimer.current);
    },
    [],
  );
  const assistantIds = p.data.agents
    .filter((a) => a.kind === "team-assistant")
    .map((a) => a.id);
  const memberIds = p.data.agents
    .filter((a) => a.kind !== "team-assistant")
    .map((a) => a.id);
  const cardSize = (cardMode = simple): Size => ({
    width: CARD_WIDTH,
    height: cardMode ? CARD_HEIGHT.compact : CARD_HEIGHT.detailed,
  });
  /**
   * Measured card sizes (React Flow), so rows fit compact and detailed cards alike. Below
   * FAR_ZOOM the cards show the smaller glance layout, so measurements taken then would be too
   * small once zoomed in again: the nominal sizes are used instead.
   */
  const measuredSizes = (ns: Node[], cardMode = simple) => {
    const measured = Object.fromEntries(
      ns
        .filter(
          (n) =>
            n.type === "agent" &&
            n.measured?.width &&
            (flow?.getZoom() ?? 1) >= FAR_ZOOM,
        )
        .map((n) => [
          n.id,
          { width: n.measured!.width!, height: n.measured!.height! },
        ]),
    );
    return cardMode === simple ? (measured as Record<string, Size>) : {};
  };
  /** The whole team's org layout for the current canvas width (compact when too wide). */
  const bestLayout = (cardMode = simple) => {
    const el = canvasRef.current;
    const maxWidth = el?.clientWidth
      ? (el.clientWidth - 2 * FIT_PADDING) / MIN_FIT_ZOOM
      : 0;
    return fitOrgLayout(
      orgInput(p.data.agents),
      orgEdges(),
      {
        sizes: measuredSizes(nodesRef.current, cardMode),
        defaultSize: cardSize(cardMode),
        origin: { x: 0, y: 0 },
        aside: assistantIds,
      },
      maxWidth,
    ).positions;
  };
  /**
   * After a canvas resize: an arrangement made automatically (Arrange, insert) whose cards were
   * not moved since is re-flowed for the new width (compact or regular). Returns whether it did.
   */
  const reflowArranged = () => {
    const last = saved<Record<string, { x: number; y: number }> | null>(
      arrangedKey,
      null,
    );
    if (!last) return false;
    const agentNodes = nodesRef.current.filter((n) => n.type === "agent");
    const same = (a: { x: number; y: number }, b?: { x: number; y: number }) =>
      !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
    if (
      agentNodes.length !== Object.keys(last).length ||
      !agentNodes.every((n) => same(n.position, last[n.id]))
    )
      return false;
    const next = bestLayout();
    if (agentNodes.every((n) => same(n.position, next[n.id]))) return false;
    arrange();
    return true;
  };
  reflowRef.current = reflowArranged;
  const orgInput = (agents: Agent[]) =>
    agents.map((a) => ({ id: a.id, parentId: a.parentId }));
  const orgEdges = () =>
    p.data.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind }));
  /**
   * Arrange as a top-down org chart (ui/org-layout.ts) from agent.parentId (delegation edges only
   * for agents without a parent); the Team Assistant goes top-left, outside the tree. With
   * `subset`, only those agents are arranged, as their own tree to the right of the others (an
   * insert into an existing team keeps everyone else where the user put them). Then re-fit.
   */
  function arrange(subset?: string[], fit = true, cardMode = simple) {
    const only = subset ? new Set(subset) : null;
    const agents = only
      ? p.data.agents.filter((a) => only.has(a.id))
      : p.data.agents;
    let origin = { x: 0, y: 0 };
    if (only) {
      const others = nodesRef.current.filter(
        (n) =>
          n.type === "agent" && !only.has(n.id) && !assistantIds.includes(n.id),
      );
      if (others.length)
        origin = {
          x:
            Math.max(
              ...others.map(
                (n) => n.position.x + (n.measured?.width ?? CARD_WIDTH),
              ),
            ) + 120,
          y: Math.min(...others.map((n) => n.position.y)),
        };
    }
    // A whole-team arrangement reflows wide leaf rows into lines (compact layout) when the
    // regular org chart would not fit the canvas at the lowest readable zoom.
    const result = only
      ? fitOrgLayout(
          orgInput(agents),
          orgEdges(),
          {
            sizes: measuredSizes(nodesRef.current, cardMode),
            defaultSize: cardSize(cardMode),
            origin,
            aside: [],
          },
          0,
        ).positions
      : bestLayout(cardMode);
    persist("positions", { ...saved("positions", {}), ...result });
    // Remembered so a later canvas resize may re-flow this automatic arrangement (never a
    // hand-placed one).
    if (!only) persist(arrangedKey, result);
    setNodes((old) =>
      old.map((n) => (result[n.id] ? { ...n, position: result[n.id] } : n)),
    );
    if (fit) setTimeout(() => fitRef.current("explicit"), 80);
  }
  arrangeRef.current = arrange;
  // Automatic arrangement, once the cards have been measured: a pending request from an insert
  // (team, template, pack, example team) for this team, or a team none of whose agents has a
  // stored position yet (a new team). Manual drag positions are never touched otherwise.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!flow) return;
    const agentNodes = nodes.filter((n) => n.type === "agent" && !n.hidden);
    if (!agentNodes.length) return;
    if (!agentNodes.every((n) => n.measured?.width && n.measured?.height))
      return;
    const request = peekArrange(teamId);
    if (request) {
      const present = new Set(p.data.agents.map((a) => a.id));
      if (!request.agentIds.every((id) => present.has(id))) return;
      clearArrange();
      autoChecked.current = true;
      const all = memberIds.every((id) => request.agentIds.includes(id));
      arrange(all ? undefined : request.agentIds);
      return;
    }
    if (autoChecked.current) return;
    autoChecked.current = true;
    const stored = saved<Record<string, unknown>>("positions", {});
    if (memberIds.length && !memberIds.some((id) => stored[id]))
      arrange(undefined, !saved(viewportKey, null));
  }, [flow, nodes]);
  // Fit once the visible cards are measured, and again when the set of visible cards (or the card
  // style) changes, unless the user has moved the view by hand (then the "Fit" hint shows).
  const fitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!flow) return;
    const shown = nodes.filter((n) => !n.hidden);
    if (!shown.length || !shown.every((n) => n.measured?.width)) return;
    const key = shown.map((n) => n.id).join(",") + (simple ? "" : ":detailed");
    if (fitKey.current === key) return;
    const first = fitKey.current === null;
    fitKey.current = key;
    if (skipModeFit.current) {
      skipModeFit.current = false;
      return;
    }
    if (first && fitState.current.manual) return; // restored viewport: leave it
    fitRef.current("nodes", first ? 0 : 200);
  }, [flow, nodes, simple]);
  // Canvas size changes (side panel opened/closed or resized, window resized): debounced re-fit.
  useEffect(() => {
    const el = canvasRef.current;
    if (!flow || !el) return;
    let size = { w: el.clientWidth, h: el.clientHeight },
      timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (Math.abs(w - size.w) < 2 && Math.abs(h - size.h) < 2) return;
      size = { w, h };
      clearTimeout(timer);
      timer = setTimeout(() => fitRef.current("resize"), 150);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [flow]);
  useEffect(() => {
    // An insert finishing while this canvas is open re-runs the check above.
    const again = () => setNodes((ns) => [...ns]);
    window.addEventListener("agentteam:arrange-request", again);
    return () => window.removeEventListener("agentteam:arrange-request", again);
  }, []);
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
    persist(groupsKey, groups);
  }, [groups]);
  const hidden = useMemo(() => hiddenAgents(groups), [groups]);
  useEffect(() => {
    setNodes((old) => {
      const pos = (id: string) => old.find((n) => n.id === id)?.position;
      // An agent without a position (added after the team was arranged) is placed where the org
      // layout puts it relative to its parent's current position; nothing else moves.
      const fresh = p.data.agents.filter((a) => !pos(a.id) && !positions[a.id]);
      const tree = fresh.length
        ? orgLayout(orgInput(p.data.agents), orgEdges(), {
            sizes: measuredSizes(old),
            defaultSize: cardSize(),
            aside: assistantIds,
          })
        : null;
      const placed = (a: Agent) => {
        const at = tree!.positions[a.id];
        const parent = tree!.parent[a.id];
        const anchor = parent ? (pos(parent) ?? positions[parent]) : undefined;
        return anchor && parent
          ? {
              x: anchor.x + at.x - tree!.positions[parent].x,
              y: anchor.y + at.y - tree!.positions[parent].y,
            }
          : at;
      };
      const lonely = !p.data.agents.some((a) => a.kind !== "team-assistant");
      const agentNodes: Node[] = p.data.agents.map((a) => ({
        id: a.id,
        type: "agent",
        hidden: hidden.has(a.id) || (lonely && a.kind === "team-assistant"),
        selected: hidden.has(a.id)
          ? false
          : old.find((n) => n.id === a.id)?.selected,
        position: pos(a.id) ?? positions[a.id] ?? placed(a),
        data: {
          agent: a,
          activity: p.data.activity.find((x) => x.agentId === a.id),
          simple,
          selected: a.id === p.selected,
          edit: p.edit,
          chat: p.chat,
          blockers: p.openBlockers,
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
  // Org-chart parents (as Arrange lays them out): an edge parent → child is a tree edge.
  const parents = useMemo(
    () => resolveParents(orgInput(p.data.agents), orgEdges()),
    [p.data.agents, p.data.edges],
  );
  const arrowColor = theme === "light" ? "#8a97a8" : "#5d6d82";
  const edges = useMemo(
    () =>
      visibleEdges(p.data.edges, groups).map((e) => {
        const tree =
          !e.grouped && e.source === e.from && e.target === e.to
            ? parents[e.to] === e.from
            : false;
        const kindLabel = {
          delegate: "Tasks",
          consult: "Advice",
          review: "Review",
          notify: "Updates",
        }[e.kind as Edge["kind"]];
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
          label: kindLabel,
          ariaLabel: `${agentName(e.from)} to ${agentName(e.to)}: ${kindLabel ?? e.kind}`,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: arrowColor,
            width: 14,
            height: 14,
          },
          markerStart:
            (e as any).bidirectional && !e.grouped
              ? {
                  type: MarkerType.ArrowClosed,
                  color: arrowColor,
                  width: 14,
                  height: 14,
                }
              : undefined,
          data: {
            tree,
            hovered: hoverEdge === e.id,
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
    [
      p.data.edges,
      p.data.activity,
      p.events,
      now,
      groups,
      parents,
      hoverEdge,
      arrowColor,
    ],
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
    // Walking the hierarchy moves the view on purpose: no automatic re-fit afterwards.
    fitTrigger("user-move");
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
  // The Team Assistant is global; an otherwise empty team shows the getting-started card instead.
  const members = p.data.agents.filter((a) => a.kind !== "team-assistant");
  const groupBar = showGroups || groups.length > 0;
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
        <button className="primary" aria-label="New agent" onClick={p.add}>
          <Plus size={15} />
          Agent
        </button>
        <button
          title="Arrange as an org chart: leads on top, reports centered below (replaces manual positions)"
          onClick={() => arrange()}
        >
          <GitBranch size={15} />
          Arrange
        </button>
        <button
          aria-pressed={!simple}
          title="Show more on each card: folders, invocations, priority and quick actions"
          onClick={() => {
            const nextMode = !simple;
            const arranged = saved<Record<
              string,
              { x: number; y: number }
            > | null>(arrangedKey, null);
            const current = nodesRef.current.filter(
              (node) => node.type === "agent",
            );
            const isAutoArranged =
              !!arranged &&
              current.length === Object.keys(arranged).length &&
              current.every(
                (node) =>
                  Math.abs(
                    node.position.x - (arranged[node.id]?.x ?? Infinity),
                  ) < 1 &&
                  Math.abs(
                    node.position.y - (arranged[node.id]?.y ?? Infinity),
                  ) < 1,
              );
            skipModeFit.current = isAutoArranged;
            setSimple(nextMode);
            persist("simpleCards", nextMode);
            if (modeArrangeTimer.current)
              window.clearTimeout(modeArrangeTimer.current);
            if (isAutoArranged) {
              modeArrangeTimer.current = window.setTimeout(() => {
                modeArrangeTimer.current = null;
                arrangeRef.current(undefined, false, nextMode);
                window.setTimeout(() => fitRef.current("nodes", 180), 100);
              }, 220);
            }
          }}
        >
          {simple ? "Detailed cards" : "Simple cards"}
        </button>
        <button
          aria-pressed={groupBar}
          title="Group agents and walk the hierarchy (parent, child, sibling)"
          onClick={() => setShowGroups(!groupBar)}
        >
          <Layers size={15} />
          Groups
        </button>
        {selectedAgentIds.length > 0 && (
          <button
            title="Save the selected agents (Ctrl/Cmd-click or Shift-drag to select more) as a reusable team"
            onClick={() => setSavingTeam(true)}
          >
            <Users size={15} />
            Save as team
          </button>
        )}
      </div>
      {groupBar && (
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
      )}
      {crossTeam.length > 0 && (
        <div
          className="cross-team-strip"
          role="group"
          aria-label="Cross-team links"
          data-testid="cross-team-links"
        >
          <span className="cross-team-badge">CROSS-TEAM</span>
          {crossTeam.map((x) => (
            <button
              key={x.edge.id}
              title="Communication link to an agent of another team; enforced like every other connection"
              onClick={() => openCrossTeam(x.edge.id)}
            >
              {agentName(x.edge.from)} → {agentName(x.edge.to)} (
              {x.outsideTeamName})
            </button>
          ))}
        </div>
      )}
      <div
        className="canvas"
        ref={canvasRef}
        aria-label={`Team canvas: ${teamName}`}
        data-testid="team-canvas"
        data-fit={fitHint ? "hint" : "auto"}
      >
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
          onEdgeMouseEnter={(_, edge) => setHoverEdge(edge.id)}
          onEdgeMouseLeave={(_, edge) =>
            setHoverEdge((h) => (h === edge.id ? null : h))
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
          onMoveStart={(e) => {
            gesture.current = !!e;
          }}
          // A wheel/drag that interrupts a running fit animation continues that gesture (no new
          // start event), so user input is also recognised here.
          onMove={(e) => {
            if (!e) return;
            gesture.current = true;
            // Manual at once: a debounced re-fit must not undo a pan/zoom still in progress.
            if (!fitState.current.manual) fitTrigger("user-move");
          }}
          onMoveEnd={(e, v) => {
            // A pan/zoom by hand (not a click on the pane, not our own fit) stops auto-fitting.
            if ((e || gesture.current) && !sameViewport(lastFit.current, v))
              fitTrigger("user-move");
            gesture.current = false;
            if (fitState.current.manual)
              persist(viewportKey, { ...v, manual: true });
          }}
          {...(viewport ? { defaultViewport: viewport } : {})}
          minZoom={0.15}
          maxZoom={2}
          colorMode={theme}
        >
          <Background
            gap={24}
            size={1}
            bgColor={theme === "light" ? "#eee8dd" : "#1b1217"}
            color={theme === "light" ? "#e8d9c8" : "#402632"}
          />
          <Controls
            showInteractive={false}
            showFitView={false}
            onZoomIn={() => fitTrigger("user-move")}
            onZoomOut={() => fitTrigger("user-move")}
          >
            <ControlButton
              onClick={() => fitTrigger("explicit")}
              title="Fit the team to the view"
              aria-label="Fit view"
            >
              <Maximize size={12} />
            </ControlButton>
          </Controls>
          {members.length > 12 && (
            <MiniMap
              nodeColor={theme === "light" ? "#e8dece" : "#36222d"}
              maskColor={theme === "light" ? "#eee8dd66" : "#1b1217bb"}
              pannable
            />
          )}
        </ReactFlow>
        {fitHint && (
          <button
            className="fit-hint"
            data-testid="fit-hint"
            title="The canvas changed size; fit the team to the view again"
            onClick={() => fitTrigger("explicit")}
          >
            <Maximize size={13} />
            Fit
          </button>
        )}
        {!members.length && (
          <div className="canvas-empty" data-testid="canvas-empty">
            <h2>No agents in {teamName} yet</h2>
            <p>
              Start with one agent and give it folders and skills, or insert a
              ready-made example team you can adjust.
            </p>
            <div className="row center">
              <button className="primary" onClick={p.add}>
                <Plus size={15} />
                Add an agent
              </button>
              {p.openTeams && (
                <button onClick={p.openTeams}>
                  <Users size={15} />
                  Insert an example team
                </button>
              )}
            </div>
            <ol className="canvas-steps">
              <li>Add an agent and pick its model.</li>
              <li>Select it to add folders it may read or edit, and skills.</li>
              <li>Drag between cards to let agents hand off work.</li>
            </ol>
          </div>
        )}
        {members.length > 0 && !p.data.edges.length && (
          <p className="canvas-tip" role="note">
            Tip: drag from the dot under a card to another card to connect them.
            Select a card to set it up.
          </p>
        )}
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
          groups={groups.map((g) => ({ name: g.name, agentIds: g.agentIds }))}
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
              {connection.crossTeam && (
                <p className="hint" data-testid="cross-team-note">
                  <span className="cross-team-badge">CROSS-TEAM</span> This link
                  connects agents of different teams. It is enforced exactly
                  like any other connection (permissions, locks, limits and
                  gates stay global).
                </p>
              )}
              {connection.crossTeam && !connection.id && (
                <label>
                  Agent in another team
                  <select
                    aria-label="Agent in another team"
                    value={connection.to}
                    onChange={(e) =>
                      setConnection({ ...connection, to: e.target.value })
                    }
                  >
                    <option value="">Choose an agent…</option>
                    {otherAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {agentSelectorLabel(a)} (
                        {teamNames.get(a.teamId ?? "") ?? "Main team"})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="connection-pair">
                <span>{agentName(connection.from)}</span>
                {connection.bidirectional ? (
                  <ArrowLeftRight size={20} />
                ) : (
                  <ArrowRight size={20} />
                )}
                <span>{connection.to ? agentName(connection.to) : "…"}</span>
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
                  <span>Only {agentName(connection.from)}</span>
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
                  disabled={!connection.to}
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
                  {connection.id
                    ? "Save connection"
                    : connection.crossTeam
                      ? "Create cross-team link"
                      : "Connect agents"}
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
              ...(otherAgents.length
                ? [
                    [
                      "Link to an agent in another team…",
                      () =>
                        setConnection({
                          from: menu.id,
                          to: "",
                          kind: "delegate",
                          bidirectional: false,
                          enabled: true,
                          crossTeam: true,
                        }),
                    ],
                  ]
                : []),
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
