import { useEffect, useState, useCallback, useRef } from "react";
import {
  Network,
  MessageSquare,
  ListTodo,
  FolderOpen,
  Library,
  Settings,
  Plus,
  PanelRight,
  PanelLeft,
  ArrowLeftRight,
  X,
  Activity,
  ChevronDown,
  Command,
  Search,
} from "lucide-react";
import {
  api,
  empty,
  saved,
  persist,
  type Snapshot,
  type TeamEvent,
  type Agent,
} from "./api";
import { Resources } from "./components/Resources";
import { TeamCanvas } from "./components/TeamCanvas";
import { AgentEditor } from "./components/AgentEditor";
import {
  Chat,
  Workflows,
  Skills,
  Workspace,
  Preferences,
  ActivityLog,
} from "./components/Panes";
export type Panel =
  | "chat"
  | "team"
  | "workflows"
  | "workspace"
  | "skills"
  | "settings"
  | "activity"
  | "resources";
const panels: { id: Panel; name: string; icon: typeof Network }[] = [
  { id: "chat", name: "Conversations", icon: MessageSquare },
  { id: "team", name: "Team canvas", icon: Network },
  { id: "workflows", name: "Workflows", icon: ListTodo },
  { id: "workspace", name: "Workspace", icon: FolderOpen },
  { id: "skills", name: "Skills library", icon: Library },
  { id: "resources", name: "Resources", icon: Network },
  { id: "activity", name: "Activity", icon: Activity },
  { id: "settings", name: "Settings", icon: Settings },
];
export default function App() {
  const [data, setData] = useState<Snapshot>(empty),
    [events, setEvents] = useState<TeamEvent[]>([]),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const [main, setMain] = useState<Panel>(() => saved("main", "chat")),
    [right, setRight] = useState<Panel>(() => saved("right", "workflows")),
    [showRight, setShowRight] = useState(() => saved("showRight", true)),
    [showLeft, setShowLeft] = useState(() => saved("showLeft", true)),
    [width, setWidth] = useState(() => saved("rightWidth", 380));
  const [selected, setSelected] = useState(""),
    [editor, setEditor] = useState<Agent | "new" | null>(null),
    [search, setSearch] = useState("");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const refresh = useCallback(async () => {
    try {
      const next = await api("/snapshot");
      setData(next);
      setSelected((id) =>
        next.agents.some((a: Agent) => a.id === id)
          ? id
          : (next.agents[0]?.id ?? ""),
      );
      setReady(true);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!window.agentteam) {
      setError(
        "Open AgentTeam in the desktop application. The browser preview has no local bridge.",
      );
      return;
    }
    void refresh();
    return window.agentteam.onEvent((e) => {
      setEvents((old) => [...old, e].slice(-300));
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void refresh(), 80);
    });
  }, [refresh]);
  useEffect(() => {
    persist("main", main);
    persist("right", right);
    persist("showRight", showRight);
    persist("showLeft", showLeft);
    persist("rightWidth", width);
  }, [main, right, showRight, showLeft, width]);
  const agent = data.agents.find((a) => a.id === selected);
  function pane(id: Panel, side: string) {
    const props = {
      data,
      selected,
      setSelected,
      act,
      events,
      edit: (a: Agent) => setEditor(a),
    };
    switch (id) {
      case "team":
        return (
          <TeamCanvas
            {...props}
            add={() => setEditor("new")}
            chat={(id) => {
              setSelected(id);
              side === "main" ? setMain("chat") : setRight("chat");
            }}
          />
        );
      case "chat":
        return <Chat {...props} />;
      case "workflows":
        return <Workflows {...props} />;
      case "workspace":
        return <Workspace {...props} />;
      case "skills":
        return <Skills {...props} />;
      case "settings":
        return <Preferences {...props} />;
      case "resources":
        return <Resources {...props} />;
      case "activity":
        return <ActivityLog events={events} data={data} />;
    }
  }
  function paneHeader(
    panel: Panel,
    setPanel: (p: Panel) => void,
    side: string,
  ) {
    return (
      <header className="pane-header">
        <select
          aria-label={side + " pane"}
          value={panel}
          onChange={(e) => setPanel(e.target.value as Panel)}
        >
          {panels.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="row">
          <span className="quiet">
            {side === "main" ? "Workspace" : "Side pane"}
          </span>
          {side === "right" && (
            <button
              className="icon"
              title="Hide right pane"
              onClick={() => setShowRight(false)}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>
    );
  }
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Network size={20} />
          </span>
          <b>AgentTeam</b>
          <span className="version">LOCAL WORKSPACE</span>
        </div>
        <div className="top-status">
          <span className={"dot " + (data.liveExecution ? "green" : "")} />
          {data.liveExecution ? "Execution enabled" : "Execution paused"}
          <span className="divider" />
          {data.activity.filter((a) => a.state === "processing").length} active
        </div>
        <div className="row">
          <button
            className="icon"
            aria-label="Toggle navigation"
            onClick={() => setShowLeft(!showLeft)}
          >
            <PanelLeft size={18} />
          </button>
          <button
            className="icon"
            title="Swap panes"
            onClick={() => {
              setMain(right);
              setRight(main);
              setShowRight(true);
            }}
          >
            <ArrowLeftRight size={17} />
          </button>
          <button
            className={"icon " + (showRight ? "active" : "")}
            aria-label="Toggle right pane"
            onClick={() => setShowRight(!showRight)}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>
      <div className="body">
        {showLeft && (
          <aside className="navigation">
            <div className="nav-section">WORKSPACE</div>
            <nav>
              {panels
                .filter((p) => p.id !== "settings")
                .map((p) => (
                  <button
                    key={p.id}
                    className={main === p.id ? "selected" : ""}
                    onClick={() => setMain(p.id)}
                  >
                    <p.icon size={18} />
                    {p.name}
                    {p.id === "workflows" && (
                      <span className="count">{data.workflows.length}</span>
                    )}
                  </button>
                ))}
            </nav>
            <div className="nav-section row between">
              YOUR TEAM
              <button
                className="icon"
                aria-label="Add agent"
                onClick={() => setEditor("new")}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="search">
              <Search size={14} />
              <input
                aria-label="Find agent"
                placeholder="Find agent…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="agent-list">
              {data.agents
                .filter((a) =>
                  a.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((a) => (
                  <button
                    className={selected === a.id ? "selected" : ""}
                    key={a.id}
                    onClick={() => {
                      setSelected(a.id);
                      setMain("chat");
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setEditor(a);
                    }}
                  >
                    <span className={"avatar " + a.environment}>
                      {a.name.slice(0, 1)}
                    </span>
                    <span className="agent-name">
                      {a.name}
                      <small>
                        {a.kind === "team-assistant"
                          ? "Team coordinator"
                          : a.environment}
                      </small>
                    </span>
                    <span
                      className={
                        "dot " +
                        (data.activity.find((x) => x.agentId === a.id)
                          ?.state === "processing"
                          ? "green pulse"
                          : "")
                      }
                    />
                  </button>
                ))}
            </div>
            <button className="add-agent" onClick={() => setEditor("new")}>
              <Plus size={16} />
              New agent
            </button>
            <div className="nav-bottom">
              <button onClick={() => setMain("settings")}>
                <Settings size={17} />
                Settings
              </button>
              <small>Private on this computer</small>
            </div>
          </aside>
        )}
        <main className="main-pane">
          {paneHeader(main, setMain, "main")}
          {ready ? (
            pane(main, "main")
          ) : (
            <div className="empty">
              <Command size={36} />
              <h2>Connecting to your workspace</h2>
              <p>Loading agents and skills…</p>
            </div>
          )}
        </main>
        {showRight && (
          <>
            <div
              className="resize"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const start = e.clientX,
                  w = width;
                const el = e.currentTarget;
                const move = (event: PointerEvent) =>
                  setWidth(
                    Math.max(300, Math.min(650, w + start - event.clientX)),
                  );
                const end = () => {
                  el.removeEventListener("pointermove", move);
                  el.removeEventListener("pointerup", end);
                };
                el.addEventListener("pointermove", move);
                el.addEventListener("pointerup", end);
              }}
            />
            <aside className="right-pane" style={{ width }}>
              {paneHeader(right, setRight, "right")}
              {ready && pane(right, "right")}
            </aside>
          </>
        )}
      </div>
      <footer className="statusbar">
        <span>
          <span className="dot green" />
          {ready ? "Workspace connected" : "Connecting"}
        </span>
        <span>
          {data.agents.length} agents · {data.edges.length} connections
        </span>
        <span>
          {agent?.name ?? "No agent selected"}
          {agent ? " / " + agent.environment : ""}
        </span>
      </footer>
      {error && (
        <div className="toast" role="alert">
          <div>
            <b>Something needs attention</b>
            <p>{error.replace(/^Error: /, "")}</p>
          </div>
          <button
            className="icon"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {editor && (
        <AgentEditor
          agent={editor === "new" ? undefined : editor}
          data={data}
          close={() => setEditor(null)}
          save={async (input) => {
            await api(
              editor === "new" ? "/agents" : "/agents/" + editor.id,
              editor === "new" ? "POST" : "PUT",
              input,
            );
            await refresh();
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}
