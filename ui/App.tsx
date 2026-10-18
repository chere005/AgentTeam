import { PendingApprovals } from "./components/Connections";
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
  Inbox as InboxIcon,
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
import { Inspector } from "./components/Inspector";
import { TeamLibrary } from "./components/Teams";
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
import { InboxPane, useInbox } from "./components/Inbox";
import { LayoutMenu } from "./components/LayoutMenu";
import { DialogFocusManager, ShortcutHelp } from "./components/A11y";
import { focusables } from "./components/A11y";
import { clampWidth, sanitizeLayout, type PaneLayout } from "./workspace";
import type { InboxItem } from "./inbox";
export type Panel =
  | "chat"
  | "team"
  | "workflows"
  | "workspace"
  | "skills"
  | "settings"
  | "activity"
  | "resources"
  | "teams"
  | "inbox"
  | "inspector";
const panels: { id: Panel; name: string; icon: typeof Network }[] = [
  { id: "chat", name: "Conversations", icon: MessageSquare },
  { id: "team", name: "Team canvas", icon: Network },
  { id: "workflows", name: "Workflows", icon: ListTodo },
  { id: "workspace", name: "Workspace", icon: FolderOpen },
  { id: "skills", name: "Skills library", icon: Library },
  { id: "resources", name: "Resources", icon: Network },
  { id: "teams", name: "Saved teams", icon: Library },
  { id: "inbox", name: "Attention inbox", icon: InboxIcon },
  { id: "inspector", name: "Run inspector", icon: Search },
  { id: "activity", name: "Activity", icon: Activity },
  { id: "settings", name: "Settings", icon: Settings },
];
export default function App() {
  const [data, setData] = useState<Snapshot>(empty),
    [events, setEvents] = useState<TeamEvent[]>([]),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  // One sanitised read of stored pane state; invalid or missing values fall back to the defaults
  // (Canvas in the middle, Conversation on the right).
  const [initial] = useState(() =>
    sanitizeLayout(
      saved<number>("layoutVersion", 0) === 2
        ? {
            main: saved("main", "team"),
            right: saved("right", "chat"),
            showLeft: saved("showLeft", true),
            showRight: saved("showRight", true),
            rightWidth: saved("rightWidth", 440),
          }
        : {},
    ),
  );
  const [main, setMain] = useState<Panel>(initial.main),
    [right, setRight] = useState<Panel>(initial.right),
    [showRight, setShowRight] = useState(initial.showRight),
    [showLeft, setShowLeft] = useState(initial.showLeft),
    [width, setWidth] = useState(initial.rightWidth),
    [help, setHelp] = useState(false),
    // Set when a saved layout deliberately chose a non-Conversation right pane (e.g. Monitoring → Inbox):
    // selecting an agent then keeps that pane; only an explicit "open conversation" action switches it.
    [rightPinned, setRightPinned] = useState(
      () =>
        saved<boolean>("rightPinned", false) === true &&
        initial.right !== "chat",
    );
  const [selected, setSelected] = useState(() => saved("selected", "")),
    [editor, setEditor] = useState<Agent | "new" | null>(null),
    [search, setSearch] = useState("");
  const inbox = useInbox(data);
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
    persist("layoutVersion", 2);
    persist("selected", selected);
    persist("main", main);
    persist("right", right);
    persist("showRight", showRight);
    persist("showLeft", showLeft);
    persist("rightWidth", width);
    persist("rightPinned", rightPinned);
  }, [main, right, showRight, showLeft, width, selected, rightPinned]);
  useEffect(() => {
    if (right === "chat") setRightPinned(false);
  }, [right]);
  const current: PaneLayout = {
    main,
    right,
    showLeft,
    showRight,
    rightWidth: width,
  };
  const applyLayout = (l: PaneLayout) => {
    setMain(l.main);
    setRight(l.right);
    setShowLeft(l.showLeft);
    setShowRight(l.showRight);
    setWidth(l.rightWidth);
    setRightPinned(l.right !== "chat");
  };
  /** Explicit "open conversation" action: always shows the Conversation pane on the right. */
  const openConversation = (id: string) => {
    setSelected(id);
    if (main === "chat") return; // the conversation is already the main pane
    setRightPinned(false);
    setRight("chat");
    setShowRight(true);
  };
  /** Plain selection (agent list): follows the conversation unless a layout pinned the right pane. */
  const selectAgent = (id: string) => {
    setSelected(id);
    if (main !== "chat" && !rightPinned) {
      setRight("chat");
      setShowRight(true);
    }
  };
  const openInbox = (item: InboxItem) => {
    if (item.agentId) setSelected(item.agentId);
    if (item.target === "chat") {
      setRightPinned(false);
      setRight("chat");
      setShowRight(true);
    } else if (item.target === "team") setMain("team");
    else setMain(item.target);
    if (right === item.target || (item.target === "chat" && right === "chat"))
      setShowRight(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const editing =
        !!t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "F6") {
        e.preventDefault();
        const regions = [".navigation", ".main-pane", ".right-pane"]
          .map((q) => document.querySelector<HTMLElement>(q))
          .filter((x): x is HTMLElement => !!x);
        const at = regions.findIndex((r) => r.contains(document.activeElement));
        const next =
          regions[
            (at + (e.shiftKey ? -1 : 1) + regions.length) % regions.length
          ];
        (focusables(next)[0] ?? next).focus();
      } else if (
        mod &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "b"
      ) {
        e.preventDefault();
        setShowLeft((v) => !v);
      } else if (mod && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        setShowRight((v) => !v);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowLeft(true);
        setTimeout(
          () =>
            document.querySelector<HTMLInputElement>("#agent-find")?.focus(),
          0,
        );
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setEditor("new");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setRight("inbox");
        setShowRight(true);
      } else if (e.key === "?" && !editing && !mod) {
        e.preventDefault();
        setHelp(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const agent = data.agents.find((a) => a.id === selected);
  function pane(id: Panel, side: string) {
    const props = {
      data,
      selected,
      setSelected,
      act,
      events,
      edit: (a: Agent) => setEditor(a),
      openChat: openConversation,
    };
    switch (id) {
      case "team":
        return (
          <TeamCanvas
            {...props}
            add={() => setEditor("new")}
            openTeams={() => setMain("teams")}
            chat={openConversation}
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
      case "teams":
        return (
          <TeamLibrary
            events={events}
            act={act}
            agentIds={data.agents.map((a) => a.id)}
            goCanvas={() => {
              setMain("team");
              void refresh();
            }}
          />
        );
      case "inbox":
        return (
          <InboxPane
            items={inbox.items}
            dismiss={inbox.dismiss}
            open={openInbox}
          />
        );
      case "inspector":
        return (
          <Inspector data={data} events={events} openChat={props.openChat} />
        );
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
              aria-label="Hide right pane"
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
      <a className="skip-link" href="#main-pane">
        Skip to main content
      </a>
      <DialogFocusManager />
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
          <LayoutMenu current={current} apply={applyLayout} />
          <button
            className="icon topbar-inbox"
            aria-label={`Attention inbox, ${inbox.items.length} item${inbox.items.length === 1 ? "" : "s"}`}
            title="Attention inbox (Ctrl/Cmd+Shift+I)"
            onClick={() => {
              setRight("inbox");
              setShowRight(true);
            }}
          >
            <InboxIcon size={17} />
            {inbox.items.length > 0 && (
              <span
                className="nav-badge"
                data-testid="inbox-badge"
                aria-hidden="true"
              >
                {inbox.items.length}
              </span>
            )}
          </button>
          <button
            className="icon"
            aria-label="Toggle navigation"
            aria-expanded={showLeft}
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
            aria-expanded={showRight}
            onClick={() => setShowRight(!showRight)}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </header>
      <div className="body">
        {showLeft && (
          <aside className="navigation" aria-label="Workspace navigation">
            <div className="nav-section">WORKSPACE</div>
            <nav aria-label="Panes">
              {panels
                .filter((p) => p.id !== "settings")
                .map((p) => (
                  <button
                    key={p.id}
                    className={main === p.id ? "selected" : ""}
                    aria-current={main === p.id ? "page" : undefined}
                    onClick={() => setMain(p.id)}
                  >
                    <p.icon size={18} />
                    {p.name}
                    {p.id === "workflows" && (
                      <span className="count">{data.workflows.length}</span>
                    )}
                    {p.id === "inbox" && inbox.items.length > 0 && (
                      <span className="nav-badge">{inbox.items.length}</span>
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
                id="agent-find"
                aria-label="Find agent"
                placeholder="Find agent…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="agent-list" role="group" aria-label="Agents">
              {data.agents
                .filter((a) =>
                  a.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((a) => (
                  <button
                    className={selected === a.id ? "selected" : ""}
                    aria-pressed={selected === a.id}
                    key={a.id}
                    onClick={() => selectAgent(a.id)}
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
        <main
          className="main-pane"
          id="main-pane"
          tabIndex={-1}
          aria-label="Main content"
        >
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
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize right pane"
              aria-valuemin={300}
              aria-valuemax={650}
              aria-valuenow={width}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  setWidth((w) =>
                    clampWidth(w + (e.key === "ArrowLeft" ? 20 : -20)),
                  );
                }
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const start = e.clientX,
                  w = width;
                const el = e.currentTarget;
                const move = (event: PointerEvent) =>
                  setWidth(clampWidth(w + start - event.clientX));
                const end = () => {
                  el.removeEventListener("pointermove", move);
                  el.removeEventListener("pointerup", end);
                };
                el.addEventListener("pointermove", move);
                el.addEventListener("pointerup", end);
              }}
            />
            <aside
              className="right-pane"
              style={{ width }}
              aria-label="Side pane"
            >
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
      <PendingApprovals agents={data.agents} />
      {help && <ShortcutHelp close={() => setHelp(false)} />}
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
