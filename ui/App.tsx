import { PendingApprovals } from "./components/Connections";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  Network,
  Settings,
  X,
  Command,
  Search,
  Briefcase,
  BellDot,
  MessageSquare,
  PanelRightOpen,
  PanelRightClose,
  Pause,
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
import { Capabilities } from "./components/Capabilities";
import { AssistantPanel } from "./components/AssistantPanel";
import { WorkflowGraphs } from "./components/WorkflowGraphs";
import { TeamLibrary } from "./components/Teams";
import { TeamCanvas } from "./components/TeamCanvas";
import { AgentPanel, NewAgentDialog } from "./components/AgentPanel";
import { CommandMenu, type PaletteAction } from "./components/CommandMenu";
import {
  Chat,
  Workflows,
  Workspace,
  Preferences,
  ActivityLog,
  AgentAccess,
  ProjectPanels,
} from "./components/Panes";
import { InboxPane, useInbox } from "./components/Inbox";
import { LayoutSettings } from "./components/LayoutMenu";
import { ThemeSettings } from "./components/ThemeSettings";
import { useUnsavedGuard } from "./components/UnsavedGuard";
import { TeamSwitcher, TeamNotice } from "./components/TeamSwitcher";
import { openAssignProject } from "./components/Projects";
import { TeamSettings } from "./components/TeamSettings";
import { filterSnapshot, itemTeam, teamIndex, teamKey } from "./team-view";
import { DialogFocusManager, ShortcutHelp } from "./components/A11y";
import { focusables } from "./components/A11y";
import { clampWidth, type PaneLayout } from "./workspace";
import {
  CANVAS,
  closeTab,
  openTab,
  sanitizeTabs,
  tabName,
  type FeatureId,
  type TabId,
  type TabState,
} from "./features";
import type { InboxItem } from "./inbox";

type Placement = "replace" | "beside";
/** Stored open tabs of a team (first run and new teams: Canvas only). */
const loadTabs = (teamId: string) =>
  sanitizeTabs(saved(teamKey("tabs", teamId), null));

export default function App() {
  const [data, setData] = useState<Snapshot>(empty),
    [events, setEvents] = useState<TeamEvent[]>([]),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const [showRight, setShowRight] = useState(
      () => saved<boolean>("side.show", true) !== false,
    ),
    [width, setWidth] = useState(() =>
      clampWidth(saved<number>("side.width", 440)),
    ),
    [placement, setPlacement] = useState<Placement>(() =>
      saved<string>("agentPanel.placement", "replace") === "beside"
        ? "beside"
        : "replace",
    ),
    [panelOpen, setPanelOpen] = useState(
      () => saved<boolean>("agentPanel.open", false) === true,
    ),
    [help, setHelp] = useState(false),
    [palette, setPalette] = useState(false),
    [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(() => saved("selected", ""));
  // Actions that close the agent panel or replace its agent ask first when it has unsaved edits.
  const { guard, dialog: unsavedDialog } = useUnsavedGuard();
  // One team at a time: every view gets the active team's slice of the (unfiltered) snapshot.
  const view = useMemo(() => filterSnapshot(data, data.activeTeamId), [data]);
  const teamId = view.activeTeamId,
    team = view.teamView.team;
  // Open feature tabs, remembered per team; loaded when the active team changes.
  const [tabs, setTabsState] = useState<TabState>(() => loadTabs(teamId));
  const tabsTeam = useRef(teamId);
  if (tabsTeam.current !== teamId) {
    tabsTeam.current = teamId;
    const next = loadTabs(teamId);
    if (JSON.stringify(next) !== JSON.stringify(tabs)) setTabsState(next);
  }
  const setTabs = (fn: (t: TabState) => TabState) =>
    setTabsState((old) => {
      const next = fn(old);
      persist(teamKey("tabs", tabsTeam.current), next);
      return next;
    });
  const [notice, setNotice] = useState("");
  const shownTeam = useRef<string | null>(null),
    switching = useRef<string | null>(null);
  const allInbox = useInbox(data);
  // Inbox: the active team's items (and global ones); other teams' items are listed separately
  // and opening one switches the team first.
  const inbox = useMemo(() => {
    const index = teamIndex(data);
    const tagged = allInbox.items.map((item) => ({
      item,
      team: itemTeam(index, item),
    }));
    return {
      items: tagged
        .filter((x) => x.team === null || x.team === teamId)
        .map((x) => x.item),
      others: tagged
        .filter((x) => x.team !== null && x.team !== teamId)
        .map((x) => ({
          ...x.item,
          teamId: x.team!,
          teamName:
            data.teams.find((t) => t.id === x.team)?.name ?? "another team",
        })),
      dismiss: allInbox.dismiss,
    };
  }, [allInbox, data, teamId]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const refresh = useCallback(async () => {
    try {
      const next: Snapshot = await api("/snapshot");
      // The active team changed without the switcher (a sample, template or pack created its own
      // team, or the team was deleted): say so visibly.
      const nextTeam = filterSnapshot(next, next.activeTeamId).teamView.team;
      if (
        shownTeam.current !== null &&
        shownTeam.current !== nextTeam.id &&
        switching.current !== nextTeam.id
      )
        setNotice(`Now showing team “${nextTeam.name}”.`);
      shownTeam.current = nextTeam.id;
      switching.current = null;
      setData(next);
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
  // Keep the selection inside the active team.
  useEffect(() => {
    if (!ready) return;
    setSelected((id) =>
      view.agents.some((a) => a.id === id) ? id : (view.agents[0]?.id ?? ""),
    );
  }, [view, ready]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 12_000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    persist("selected", selected);
    persist("side.show", showRight);
    persist("side.width", width);
    persist("agentPanel.placement", placement);
    persist("agentPanel.open", panelOpen);
  }, [showRight, width, selected, placement, panelOpen]);

  // A different team: its agents differ, so the agent panel closes (the chat stays).
  const panelTeam = useRef(teamId);
  useEffect(() => {
    if (panelTeam.current === teamId) return;
    panelTeam.current = teamId;
    setPanelOpen(false);
  }, [teamId]);
  const openFeature = (id: TabId) => setTabs((t) => openTab(t, id));
  // Saved layouts never include Settings itself (layouts are applied from there).
  const current: PaneLayout = {
    tabs: tabs.tabs.filter((t) => t !== "settings"),
    active: tabs.active === "settings" ? CANVAS : tabs.active,
    showRight,
    rightWidth: width,
  };
  const applyLayout = (l: PaneLayout) => {
    // Applied from Settings: keep that tab open (last) so the layout list stays reachable.
    setTabs((t) => ({
      tabs: t.tabs.includes("settings")
        ? [...l.tabs.filter((x) => x !== "settings"), "settings"]
        : l.tabs,
      active: l.active,
    }));
    setShowRight(l.showRight);
    setWidth(l.rightWidth);
  };
  /** Explicit "open conversation" action: shows the conversation in the side panel. */
  const openConversation = (id: string) =>
    guard(() => {
      setSelected(id);
      setShowRight(true);
      if (placement === "replace") setPanelOpen(false);
    });
  /** Selecting an agent (canvas, palette, "Set up"): opens its setup panel. */
  const openAgentPanel = (id: string) => {
    const open = () => {
      setSelected(id);
      setPanelOpen(true);
      if (placement === "replace") setShowRight(true);
    };
    if (id === selected) open();
    else guard(open);
  };
  /** Team management from the switcher: errors go to the toast and keep the form open. */
  const teamAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  /** Make `id` the active team (persisted by the backend); never pauses or cancels any work. */
  const switchTeam = (id: string, why?: string) => {
    if (id === teamId) return;
    guard(() => doSwitchTeam(id, why));
  };
  const doSwitchTeam = (id: string, why?: string) => {
    const name = data.teams.find((t) => t.id === id)?.name ?? "team";
    switching.current = id;
    shownTeam.current = id;
    setData((d) => ({ ...d, activeTeamId: id }));
    setNotice(why ?? `Switched to team “${name}”.`);
    // Each team remembers its own open tabs (loaded when the active team changes).
    void act(() => api("/team-spaces/active", "PUT", { teamId: id }));
  };
  const openInbox = (
    item: InboxItem & { teamId?: string; teamName?: string },
  ) => {
    const target: TabId =
      item.target === "workspace"
        ? "review"
        : item.target === "workflows"
          ? "projects"
          : CANVAS;
    if (item.teamId && item.teamId !== teamId) {
      // Open the target in the other team's own tabs, then switch to it.
      persist(
        teamKey("tabs", item.teamId),
        openTab(loadTabs(item.teamId), target),
      );
      switchTeam(
        item.teamId,
        `Switched to team “${item.teamName}” to show: ${item.title}`,
      );
    } else if (item.target !== "chat") openFeature(target);
    if (item.agentId) setSelected(item.agentId);
    if (item.target === "chat") {
      if (item.agentId) openConversation(item.agentId);
      else setShowRight(true);
    }
  };
  const openConnection = (edgeId: string) => {
    openFeature(CANVAS);
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent("agentteam:inspect-edge", { detail: edgeId }),
        ),
      60,
    );
  };
  const assignProject = () => {
    openFeature("projects");
    openAssignProject();
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
        const regions = [
          ".topbar",
          ".main-pane",
          ".agent-column",
          ".right-pane",
        ]
          .map((q) => document.querySelector<HTMLElement>(q))
          .filter((x): x is HTMLElement => !!x);
        const at = regions.findIndex((r) => r.contains(document.activeElement));
        const next =
          regions[
            (at + (e.shiftKey ? -1 : 1) + regions.length) % regions.length
          ];
        (focusables(next)[0] ?? next).focus();
      } else if (mod && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        guard(() => setShowRight((v) => !v));
      } else if (
        mod &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setPalette(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        document
          .querySelector<HTMLButtonElement>('[data-testid="team-switcher"]')
          ?.click();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setTabs((s) => openTab(s, "inbox"));
      } else if (e.key === "Escape" && !editing && !mod) {
        // Esc closes the agent panel (focus goes back to the canvas region).
        if (
          document.querySelector(".agent-panel") &&
          !document.querySelector(".team-popup, .context-menu")
        ) {
          e.preventDefault();
          guard(() => {
            setPanelOpen(false);
            document.querySelector<HTMLElement>(".main-pane")?.focus();
          });
        }
      } else if (e.key === "?" && !editing && !mod) {
        e.preventDefault();
        setHelp(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const agent = view.agents.find((a) => a.id === selected);
  const members = view.agents.filter((a) => a.kind !== "team-assistant");
  const props = {
    data: view,
    selected,
    setSelected: (id: string) =>
      id === selected ? undefined : guard(() => setSelected(id)),
    act,
    events,
    edit: (a: Agent) => openAgentPanel(a.id),
    openChat: openConversation,
    openFeature: (id: FeatureId) => openFeature(id),
  };
  function featureView(id: TabId) {
    switch (id) {
      case CANVAS:
        return (
          <TeamCanvas
            key={teamId}
            {...props}
            setSelected={openAgentPanel}
            add={() => setCreating(true)}
            openTeams={() => openFeature("library")}
            openBlockers={(agentId) => {
              const a = view.activity.find((x) => x.agentId === agentId);
              setSelected(agentId);
              openFeature(a?.failedTaskIds.length ? "projects" : "recovery");
            }}
            chat={openConversation}
          />
        );
      case "projects":
        return <Workflows {...props} />;
      case "team-settings":
        return <TeamSettings key={teamId} {...props} />;
      case "files":
      case "git":
      case "review":
      case "preview":
        return <Workspace {...props} view={id} />;
      case "settings":
        return (
          <Preferences
            {...props}
            workspace={
              <>
                <ThemeSettings />
                <section className="settings-card">
                  <h3>Agent panel</h3>
                  <p>
                    Selecting an agent opens its setup panel. Show it in place
                    of the chat, or as its own column beside the chat.
                  </p>
                  <select
                    aria-label="Agent panel placement"
                    value={placement}
                    onChange={(e) => setPlacement(e.target.value as Placement)}
                  >
                    <option value="replace">In place of the chat</option>
                    <option value="beside">Beside the chat</option>
                  </select>
                </section>
                <LayoutSettings
                  key={teamId}
                  teamId={teamId}
                  current={current}
                  apply={applyLayout}
                />
              </>
            }
          />
        );
      case "access":
        return (
          <div className="scroll">
            <AgentAccess {...props} />
            <Resources {...props} />
          </div>
        );
      case "library":
        return (
          <TeamLibrary
            events={events}
            act={act}
            agentIds={view.agents.map((a) => a.id)}
            team={{ id: team.id, name: team.name }}
            goCanvas={() => {
              openFeature(CANVAS);
              void refresh();
            }}
          />
        );
      case "inbox":
        return (
          <InboxPane
            items={inbox.items}
            others={inbox.others}
            teamName={team.name}
            dismiss={inbox.dismiss}
            open={openInbox}
          />
        );
      case "capabilities":
        return <Capabilities {...props} />;
      case "inspector":
        return (
          <Inspector data={view} events={events} openChat={props.openChat} />
        );
      case "assistant":
        return <AssistantPanel data={view} events={events} />;
      case "graphs":
        return (
          <WorkflowGraphs
            data={view}
            events={events}
            act={act}
            goCanvas={() => openFeature(CANVAS)}
          />
        );
      case "limits":
      case "recovery":
      case "shared":
        return <ProjectPanels {...props} kind={id} />;
      case "activity":
        return <ActivityLog events={events} data={view} />;
    }
  }
  const actions: PaletteAction[] = [
    {
      id: "new-agent",
      name: "New agent",
      description: "Create an agent in this team.",
      keywords: "add create",
      run: () => setCreating(true),
    },
    {
      id: "example",
      name: "Insert an example team",
      description: "Pipeline, Wolfram-validated or product feature team.",
      keywords: "template saved starter",
      run: () => openFeature("library"),
    },
    {
      id: "assign",
      name: "Assign project",
      description: `Give ${team.name} a goal and a workspace.`,
      keywords: "project work",
      run: assignProject,
    },
    {
      id: "canvas",
      name: "Canvas",
      description: "Back to the team graph.",
      keywords: "team graph home",
      run: () => openFeature(CANVAS),
    },
    {
      id: "chat",
      name: "Show chat",
      description: "Open the conversation with the selected agent.",
      keywords: "conversation message talk",
      run: () =>
        guard(() => {
          setShowRight(true);
          if (placement === "replace") setPanelOpen(false);
        }),
    },
    {
      id: "toggle-side",
      name: showRight ? "Hide side panel" : "Show side panel",
      description: "Chat and agent setup on the right (Ctrl/Cmd+\\).",
      keywords: "panel right",
      run: () => guard(() => setShowRight((v) => !v)),
    },
    {
      id: "switch-team",
      name: "Switch team",
      description: "Pick another team or create one (Ctrl/Cmd+Shift+T).",
      keywords: "team new rename delete",
      run: () =>
        setTimeout(
          () =>
            document
              .querySelector<HTMLButtonElement>('[data-testid="team-switcher"]')
              ?.click(),
          0,
        ),
    },
    {
      id: "layouts",
      name: "Layouts",
      description: "Saved sets of tabs (in Settings).",
      keywords: "layout presets workspace",
      run: () => openFeature("settings"),
    },
    {
      id: "shortcuts",
      name: "Keyboard shortcuts",
      description: "Every shortcut in one list (?).",
      keywords: "keys help",
      run: () => setHelp(true),
    },
  ];
  const side = placement === "replace" && panelOpen && agent ? "agent" : "chat";
  const agentPanel = agent && (
    <AgentPanel
      key={agent.id}
      agent={agent}
      data={view}
      events={events}
      act={act}
      placement={placement}
      setPlacement={(p) =>
        guard(() => {
          setPlacement(p);
          setShowRight(true);
        })
      }
      close={() => guard(() => setPanelOpen(false))}
      openChat={openConversation}
      openFeature={(id) => openFeature(id)}
      openConnection={openConnection}
    />
  );
  return (
    <div className="app">
      <a className="skip-link" href="#main-pane">
        Skip to main content
      </a>
      <DialogFocusManager />
      <header className="topbar">
        <div className="brand" aria-label="AgentTeam">
          <span className="brand-mark" aria-hidden="true">
            <Network size={17} />
          </span>
          <b>AgentTeam</b>
        </div>
        {ready && (
          <TeamSwitcher
            teams={data.teams}
            active={team}
            switchTo={(id) => switchTeam(id)}
            create={(name) =>
              teamAction(async () => {
                const created = await api("/team-spaces", "POST", {
                  name,
                });
                switching.current = created.id;
                await api("/team-spaces/active", "PUT", {
                  teamId: created.id,
                });
                setNotice(`Created team “${created.name}”; it is now active.`);
              })
            }
            rename={(id, name) =>
              teamAction(() => api("/team-spaces/" + id, "PUT", { name }))
            }
            assignProject={assignProject}
            openSettings={() => openFeature("team-settings")}
            remove={(id, options) =>
              teamAction(async () => {
                const r = await api("/team-spaces/" + id, "DELETE", options);
                switching.current = r.moveTo;
                const dest =
                  data.teams.find((t) => t.id === r.moveTo)?.name ?? "Main";
                setNotice(
                  `Deleted team “${team.name}”. ${r.agents === "delete" ? "Its agents were deleted" : "Its agents were moved"}; its projects moved to “${dest}”.`,
                );
              })
            }
          />
        )}
        {ready && members.length > 0 && (
          <button
            className="topbar-assign"
            title={`Give ${team.name} a project: a goal and a workspace for its agents`}
            onClick={assignProject}
          >
            <Briefcase size={15} />
            Assign project
          </button>
        )}
        <div className="grow" />
        {ready && !data.liveExecution && (
          <button
            className="topbar-chip"
            title="New runs are held. Resume in Settings."
            onClick={() => openFeature("settings")}
          >
            <Pause size={13} />
            Execution paused
          </button>
        )}
        {(inbox.items.length > 0 || inbox.others.length > 0) && (
          <button
            className={
              "topbar-attention" + (inbox.items.length ? "" : " elsewhere")
            }
            aria-label={`Attention inbox, ${inbox.items.length} item${inbox.items.length === 1 ? "" : "s"}${inbox.others.length ? `, ${inbox.others.length} in other teams` : ""}`}
            title="Things waiting for you (Ctrl/Cmd+Shift+I)"
            onClick={() => openFeature("inbox")}
          >
            <BellDot size={15} />
            {inbox.items.length > 0 && (
              <span data-testid="inbox-badge">{inbox.items.length}</span>
            )}
            <span className="topbar-attention-text">
              {inbox.items.length ? "need you" : "in other teams"}
            </span>
          </button>
        )}
        <button
          className="topbar-more"
          aria-label="More"
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
          title="All views and actions (Ctrl/Cmd+K)"
          onClick={() => setPalette(true)}
        >
          <Search size={15} />
          More
          <kbd>{/Mac/i.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <button
          className="icon"
          aria-label="Settings"
          title="Settings"
          onClick={() => openFeature("settings")}
        >
          <Settings size={17} />
        </button>
        <span className="sr-only" aria-live="polite">
          {ready ? "Workspace connected" : "Connecting"}
        </span>
      </header>
      {notice && <TeamNotice text={notice} dismiss={() => setNotice("")} />}
      <div className="body">
        <main
          className="main-pane"
          id="main-pane"
          tabIndex={-1}
          aria-label="Main content"
          data-testid={ready ? "workspace-ready" : undefined}
        >
          {tabs.tabs.length > 0 && (
            <div className="view-tabs" role="tablist" aria-label="Open views">
              {[CANVAS as TabId, ...tabs.tabs].map((id) => (
                <div
                  key={id}
                  className={"view-tab" + (tabs.active === id ? " active" : "")}
                >
                  <button
                    role="tab"
                    id={"tab-" + id}
                    aria-selected={tabs.active === id}
                    aria-controls="view-panel"
                    onClick={() => openFeature(id)}
                  >
                    {tabName(id)}
                  </button>
                  {id !== CANVAS && (
                    <button
                      className="icon view-tab-close"
                      aria-label={`Close ${tabName(id)}`}
                      title="Close tab"
                      onClick={() => setTabs((t) => closeTab(t, id))}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div
            className="view-panel"
            id="view-panel"
            role={tabs.tabs.length ? "tabpanel" : undefined}
            aria-labelledby={
              tabs.tabs.length ? "tab-" + tabs.active : undefined
            }
          >
            {ready ? (
              featureView(tabs.active)
            ) : (
              <div className="empty">
                <Command size={36} />
                <h2>Connecting to your workspace</h2>
                <p>Loading agents and skills…</p>
              </div>
            )}
          </div>
          {!showRight && (
            <button
              className="side-reopen"
              aria-label="Show side panel"
              title="Show chat (Ctrl/Cmd+\)"
              onClick={() => setShowRight(true)}
            >
              <PanelRightOpen size={16} />
            </button>
          )}
        </main>
        {ready && placement === "beside" && panelOpen && agent && (
          <aside className="agent-column" aria-label="Agent setup">
            {agentPanel}
          </aside>
        )}
        {showRight && (
          <>
            <div
              className="resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize side panel"
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
              aria-label="Side panel"
            >
              <header className="side-head">
                <div
                  className="side-tabs"
                  role="tablist"
                  aria-label="Side panel"
                >
                  <button
                    role="tab"
                    aria-selected={side === "chat"}
                    onClick={() => {
                      if (placement === "replace")
                        guard(() => setPanelOpen(false));
                    }}
                  >
                    <MessageSquare size={14} />
                    Chat
                  </button>
                  {placement === "replace" && agent && (
                    <button
                      role="tab"
                      aria-selected={side === "agent"}
                      onClick={() => setPanelOpen(true)}
                    >
                      Agent setup
                    </button>
                  )}
                </div>
                <button
                  className="icon"
                  aria-label="Hide side panel"
                  title="Hide (Ctrl/Cmd+\)"
                  onClick={() => guard(() => setShowRight(false))}
                >
                  <PanelRightClose size={16} />
                </button>
              </header>
              {ready && (side === "agent" ? agentPanel : <Chat {...props} />)}
            </aside>
          </>
        )}
      </div>
      <PendingApprovals
        agents={data.agents}
        openInbox={() => openFeature("inbox")}
      />
      {palette && (
        <CommandMenu
          open={(id) => openFeature(id)}
          openTabs={tabs.tabs}
          agents={view.agents.map((a) => ({
            id: a.id,
            name: a.name,
            detail:
              a.kind === "team-assistant"
                ? "Team coordinator"
                : `${a.environment} · ${a.model}${a.role ? " · " + a.role : ""}`,
          }))}
          actions={actions}
          selectAgent={openAgentPanel}
          close={() => setPalette(false)}
        />
      )}
      {help && <ShortcutHelp close={() => setHelp(false)} />}
      {unsavedDialog}
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
      {creating && (
        <NewAgentDialog
          data={view}
          close={() => setCreating(false)}
          create={async (input) => {
            // A new agent joins the active team, then its setup panel opens.
            const created = await api("/agents", "POST", { ...input, teamId });
            await refresh();
            setCreating(false);
            if (created?.id) openAgentPanel(created.id);
          }}
        />
      )}
    </div>
  );
}
