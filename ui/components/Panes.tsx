import { WorktreeManager } from "./Worktrees";
import {
  RuleOptionsFields,
  RuleBadge,
  RoutingExplain,
  splitList,
} from "./RuleOptions";
import { DevServerPanel } from "./DevServer";
import { ChangesReview } from "./ChangesReview";
import {
  GateBadge,
  SampleSetup,
  TaskValidation,
  WorkflowGateSummary,
} from "./Validation";
import { PipelineHistory, PIPELINE_SAMPLE_ID } from "./Pipeline";
import { AssignProject, useAssignRequest } from "./Projects";
import { ProjectLifecycle } from "./ProjectLifecycle";
import { WorkflowRecovery } from "./Recovery";
import { WorkflowSharedState } from "./SharedState";
import { WorkflowStateEditor } from "./StateEditor";
import { TaskSettings } from "./TaskSettings";
import { RuleEditor } from "./RuleEditor";
import { HarnessSettings } from "./HarnessSettings";
import { FilesystemSettings } from "./FilesystemSettings";
import { GitWorkflowPanel } from "./GitWorkflow";
import { FilePreview, OpenWith } from "./FilePreview";
import { TextEditor } from "./TextEditor";
import { EditorSettings } from "./EditorSettings";
import {
  ConversationLink,
  ConversationSearch,
  LiveActivity,
  RunProgress,
  NewBelow,
  OwnershipBar,
  UnreadDivider,
  takeThenOpen,
  useChatScroll,
  useUnread,
} from "./ConversationExtras";
import {
  dividerIndex,
  hasProposalBlock,
  messageStatusLabel,
  processingMessageIds,
  sessionFailureMessage,
  splitProposalBlocks,
  unreadLabel,
} from "../conversation";
import { ProposalCards } from "./ProposalCard";
import { InvocationPanel } from "./InvocationPanel";
import { MessageMarkdown } from "./Markdown";
import { canLeaveFileEditor } from "../file-editor-guard";
import { useWorkspaceWatch } from "./useWorkspaceWatch";
import { EffectiveAccess, LaunchReview, ExternalNotice } from "./AccessUi";
import { accessLabel } from "../access-view";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Square,
  MessageSquare,
  FolderOpen,
  File,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  RefreshCw,
  Plus,
  Play,
  Pause,
  Check,
  Settings2,
  ExternalLink,
  GitBranch,
  Search,
  Clock,
  Network,
  MoreHorizontal,
} from "lucide-react";
import {
  api,
  agentInput,
  saved,
  persist,
  type Agent,
  type Snapshot,
  type TeamEvent,
} from "../api";
import { eventVisible } from "../team-view";
import { agentDisplayName, agentSelectorLabel } from "../agent-identity";
import { AgentAvatar } from "./AgentAvatar";
import { isProjectWorkflow } from "../project-kind";
import type { FeatureId } from "../features";
import { GitRenamePair } from "./GitRenamePair";
/** Comma-separated declared task paths from the task form. */
const declaredPaths = (text: string) =>
  text
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
const PI_DEMO_PROMPT =
  "Start a fresh demo in agentteam-demo/pi-300/; ignore earlier chat work and leave it untouched. Define 300 significant decimal digits of Pi (the leading 3 counts as digit one). Assign these files to the matching builders: cpp/pi.cpp, python/pi.py, and typescript/pi.ts. Have each builder create its subfolder, implement the program, and report how to run it. Then ask the Codex reviewer to check correctness and request focused fixes until it approves. Run the programs only if a command tool is available; report clearly if they were not run. Give me the files, review rounds, and final report.";
export type PaneProps = {
  data: Snapshot;
  selected: string;
  setSelected: (id: string) => void;
  currentProjectId?: string;
  setCurrentProject?: (id: string) => void;
  currentProject?: Snapshot["workflows"][number] | null;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  events: TeamEvent[];
  edit: (a: Agent) => void;
  /** Select an agent and show its conversation pane. */
  openChat?: (id: string) => void;
  /** Open (or focus) a feature tab. */
  openFeature?: (id: FeatureId) => void;
};
function AgentPicker(p: PaneProps & { unread?: Record<string, number> }) {
  const current = p.data.agents.find((agent) => agent.id === p.selected);
  return (
    <span className="agent-picker">
      {current && (
        <AgentAvatar
          name={current.name}
          nickname={current.nickname}
          avatar={current.avatar}
          environment={current.environment}
          className={`avatar small agent-picker-avatar ${current.environment}`}
        />
      )}
      <select
        aria-label="Agent"
        value={p.selected}
        onChange={(e) => p.setSelected(e.target.value)}
      >
        {p.data.agents.map((a) => (
          <option value={a.id} key={a.id}>
            {agentSelectorLabel(a)}
            {p.unread?.[a.id] ? ` (${unreadLabel(p.unread[a.id])} new)` : ""}
          </option>
        ))}
      </select>
    </span>
  );
}
export function Chat(p: PaneProps) {
  const [messages, setMessages] = useState<any[]>([]),
    [draft, setDraft] = useState(""),
    [mode, setMode] = useState("chat"),
    [cli, setCli] = useState<any>(null);
  const box = useRef<HTMLDivElement>(null),
    agent = p.data.agents.find((a) => a.id === p.selected),
    session = p.data.sessions.find((s) => s.agentId === p.selected);
  const displayName = agent ? agentDisplayName(agent) : "Agent";
  const [sending, setSending] = useState(false),
    [searching, setSearching] = useState(false),
    [options, setOptions] = useState(false),
    [clock, setClock] = useState(Date.now),
    [fallbackStartedAt, setFallbackStartedAt] = useState(Date.now),
    // Which agent the loaded messages belong to (scroll restore must not run on stale messages).
    [owner, setOwner] = useState("");
  const unread = useUnread(p.events, p.selected);
  const unreadAtOpen = unread.atOpen;
  const scroll = useChatScroll(
    p.selected,
    owner === p.selected ? messages.length : 0,
    box,
  );
  useEffect(() => {
    setFallbackStartedAt(Date.now());
    if (session?.state !== "running") return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.state]);
  // Synchronous guards: state updates are async, so a fast double Enter/click could otherwise
  // post the same message twice. `composing` tracks IME composition across browsers.
  const sendLock = useRef(false),
    composing = useRef(false),
    currentAgent = useRef(p.selected);
  currentAgent.current = p.selected;
  useEffect(() => {
    composing.current = false;
    setMessages([]);
    setDraft(saved("draft." + p.selected, ""));
    setCli(null);
    setMode("chat");
    setSearching(false);
  }, [p.selected]);
  // Every event refetches the list. A response is applied unless a NEWER request already
  // answered: discarding every in-flight response whenever another event arrives (the previous
  // behaviour) starved the list during a busy run, leaving a processing message labelled "queued".
  const fetchSeq = useRef(0),
    appliedSeq = useRef(0);
  useEffect(() => {
    if (!session) return;
    const seq = ++fetchSeq.current;
    const sid = session.id,
      agentId = p.selected;
    api("/sessions/" + sid + "/messages")
      .then((m) => {
        if (seq <= appliedSeq.current || currentAgent.current !== agentId)
          return;
        appliedSeq.current = seq;
        setMessages(m);
        setOwner(agentId);
      })
      .catch(() => {});
  }, [session?.id, p.events]);
  async function sendText(text: string, fromDraft: boolean) {
    if (!agent || !text.trim() || sendLock.current || composing.current) return;
    sendLock.current = true;
    setSending(true);
    try {
      await p.act(async () => {
        const s = await api("/agents/" + agent.id + "/session", "POST");
        await api("/sessions/" + s.id + "/messages", "POST", { text });
        // Clear only what was sent: keep anything typed meanwhile or in another agent's draft.
        if (fromDraft && saved("draft." + agent.id, "") === text)
          persist("draft." + agent.id, "");
        if (fromDraft && currentAgent.current === agent.id)
          setDraft((d) => (d === text ? "" : d));
        if (p.data.liveExecution)
          await api("/sessions/" + s.id + "/run", "POST");
      });
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  const send = () => sendText(draft, true);
  const processingIds = session
    ? processingMessageIds(p.events, session.id)
    : [];
  const failureMessage = session
    ? sessionFailureMessage(p.events, session.id)
    : null;
  const isAssistant = agent?.kind === "team-assistant";
  if (!agent)
    return (
      <div className="empty">
        <MessageSquare size={32} />
        <h2>No agents in {p.data.teamView?.team.name ?? "this team"}</h2>
        <p>
          Create an agent in this team, or switch teams in the top bar, to start
          a conversation.
        </p>
      </div>
    );
  return (
    <div className="chat pane-content">
      <div className="chat-toolbar">
        <div className="grow">
          <span className="eyebrow">TALKING TO</span>
          <AgentPicker {...p} unread={unread.counts} />
        </div>
        <div className="row">
          {p.data.teamView?.team.name.startsWith("Quickstart:") &&
            agent.name.startsWith("Manager") && (
              <button
                className="secondary pi-demo-shortcut"
                title="Fill in a fresh, multi-agent Pi demo prompt"
                onClick={() => {
                  setDraft(PI_DEMO_PROMPT);
                  persist("draft." + agent.id, PI_DEMO_PROMPT);
                }}
              >
                <Play size={14} /> Pi demo
              </button>
            )}
          <button
            className="icon"
            title="Search messages"
            aria-label="Search messages"
            aria-pressed={searching}
            onClick={() => setSearching((v) => !v)}
          >
            <Search size={17} />
          </button>
          <button
            className="icon"
            title="Agent setup"
            aria-label={`Set up ${agent.name}`}
            onClick={() => p.edit(agent)}
          >
            <Settings2 size={17} />
          </button>
          <button
            className="icon"
            title="Who drives this agent, CLI and native app"
            aria-label="Conversation options"
            aria-expanded={options}
            onClick={() => setOptions((v) => !v)}
          >
            <MoreHorizontal size={17} />
          </button>
        </div>
      </div>
      <OwnershipBar
        agent={agent}
        events={p.events}
        act={p.act}
        quiet={!options}
      />
      {searching && (
        <ConversationSearch agentId={agent.id} openChat={p.openChat} />
      )}
      {(options || mode === "cli") && (
        <div className="chat-mode">
          <div className="tabs">
            <button
              className={mode === "chat" ? "active" : ""}
              onClick={() => setMode("chat")}
            >
              Chat
            </button>
            <button
              className={mode === "cli" ? "active" : ""}
              onClick={() =>
                void p.act(async () => {
                  setCli(await takeThenOpen(agent.id, "cli"));
                  setMode("cli");
                })
              }
            >
              CLI
            </button>
            <button
              onClick={() =>
                void p.act(async () => {
                  const result = await takeThenOpen(agent.id, "native");
                  setCli(result);
                  setMode("cli");
                })
              }
            >
              Native app <ExternalLink size={12} />
            </button>
          </div>
          <span className="quiet">
            {agent.environment} · {agent.model} · {agent.effort ?? "auto"}
          </span>
        </div>
      )}
      <InvocationPanel
        agent={agent}
        limit={agent.maxConcurrentInvocations}
        data={p.data}
      />
      {mode === "cli" ? (
        <div className="scroll section">
          <h3>Continue in your agent’s interface</h3>
          <p>{cli?.message}</p>
          {cli?.cwd && (
            <>
              <label>
                Working directory<pre>{cli.cwd}</pre>
              </label>
              <label>
                Resume command<pre>{cli.command}</pre>
              </label>
              <button
                onClick={() => void navigator.clipboard.writeText(cli.command)}
              >
                Copy command
              </button>
              <p className="hint">
                CLI sessions run in your own terminal. Ownership was taken so
                the team scheduler and embedded chat leave this agent alone; use
                Return ownership above when you are done.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="messages scroll" ref={box} onScroll={scroll.onScroll}>
            {!messages.length && (
              <div className="welcome">
                <span className={"welcome-icon " + agent.environment}>
                  <Network size={32} />
                </span>
                <span className="eyebrow">
                  {agent.kind === "team-assistant"
                    ? "YOUR TEAM, IN SYNC"
                    : "AGENT CONVERSATION"}
                </span>
                <h1>
                  {agent.kind === "team-assistant"
                    ? "What are we building?"
                    : `Talk to ${displayName}`}
                </h1>
                <p>
                  {agent.kind === "team-assistant"
                    ? "Design your team, discuss a plan, and turn the work into clear steps. Your coordinator can see the agents, connections and workflows."
                    : agent.role ||
                      "Give this agent a task, ask a question, or explore an idea."}
                </p>
                <div className="suggestions">
                  {(p.data.teamView?.team.name.startsWith("Quickstart:") &&
                  agent.name.startsWith("Manager")
                    ? [PI_DEMO_PROMPT]
                    : agent.kind === "team-assistant"
                      ? [
                          "Help me design my team",
                          "Review the current workflow",
                          "Which skills should I add?",
                        ]
                      : ["Explain your responsibilities", "Plan the next task"]
                  ).map((text) => (
                    <button
                      key={text}
                      onClick={() => {
                        setDraft(text);
                        persist("draft." + agent.id, text);
                      }}
                    >
                      {text}
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <article
                className={"message " + m.role}
                key={m.id}
                data-message-id={m.id}
              >
                {i === dividerIndex(messages, unreadAtOpen) && (
                  <UnreadDivider n={unreadAtOpen} />
                )}
                <div className="message-label">
                  {m.role === "user" ? (
                    <span className="avatar small user">Y</span>
                  ) : (
                    <AgentAvatar
                      name={agent.name}
                      nickname={agent.nickname}
                      avatar={agent.avatar}
                      environment={agent.environment}
                      className={`avatar small ${agent.environment}`}
                    />
                  )}
                  <b>{m.role === "user" ? "You" : displayName}</b>
                  <time>
                    {new Date(m.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span className="badge" data-testid="message-status">
                    {messageStatusLabel(m, processingIds)}
                  </span>
                </div>
                {isAssistant &&
                m.role === "assistant" &&
                hasProposalBlock(m.text) ? (
                  <>
                    {splitProposalBlocks(m.text).map((part, j) =>
                      part.kind === "text" ? (
                        <div className="message-text" key={j}>
                          <MessageMarkdown text={part.text} collapsible />
                        </div>
                      ) : (
                        <details className="proposal-json" key={j}>
                          <summary>Show JSON</summary>
                          <pre>{part.json}</pre>
                        </details>
                      ),
                    )}
                    <ProposalCards
                      messageId={m.id}
                      events={p.events}
                      send={(text) => sendText(text, false)}
                      openChanges={
                        p.openFeature
                          ? () => p.openFeature!("assistant")
                          : undefined
                      }
                    />
                  </>
                ) : (
                  <div className="message-text">
                    <MessageMarkdown
                      text={m.text}
                      collapsible={m.role === "assistant"}
                    />
                  </div>
                )}
              </article>
            ))}
            {session && (
              <LiveActivity
                events={p.events}
                sessionId={session.id}
                name={displayName}
              />
            )}
            {failureMessage && (
              <div
                className="notice"
                role="alert"
                data-testid="session-failure"
              >
                {failureMessage}
              </div>
            )}
            <NewBelow n={scroll.below} jump={scroll.toBottom} />
          </div>
          <div className="composer-wrap">
            {session?.state === "running" && (
              <RunProgress
                name={displayName}
                startedAt={
                  session.startedAt ?? new Date(fallbackStartedAt).toISOString()
                }
                timeoutMs={session.timeoutMs}
                now={clock}
              />
            )}
            {!p.data.liveExecution && (
              <div className="notice">
                Execution is paused. Messages stay queued until you resume in
                Settings.
              </div>
            )}
            <div className="composer">
              <textarea
                aria-label="Message"
                placeholder={`Message ${displayName}…`}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  persist("draft." + agent.id, e.target.value);
                }}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => {
                  // Safari fires the confirming Enter keydown after compositionend.
                  setTimeout(() => (composing.current = false), 0);
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.repeat &&
                    !composing.current &&
                    !e.nativeEvent.isComposing &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="row between">
                <span className="hint">
                  Enter to send · Shift+Enter for a new line
                </span>
                {session?.state === "running" ? (
                  <button
                    className="send"
                    aria-label="Stop generation"
                    onClick={() =>
                      void p.act(() =>
                        api("/sessions/" + session.id + "/cancel", "POST"),
                      )
                    }
                  >
                    <Square size={16} />
                  </button>
                ) : (
                  <div className="row">
                    {session && messages.some((m) => m.status === "queued") && (
                      <button
                        disabled={!p.data.liveExecution}
                        onClick={() =>
                          void p.act(() =>
                            api("/sessions/" + session.id + "/run", "POST"),
                          )
                        }
                      >
                        Run queued
                      </button>
                    )}
                    <button
                      className="send"
                      aria-label="Send message"
                      disabled={!draft.trim() || sending}
                      onClick={() => void send()}
                    >
                      <ArrowUp size={19} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
export function Workflows(p: PaneProps) {
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [goal, setGoal] = useState(""),
    [criteria, setCriteria] = useState(""),
    [taskFor, setTaskFor] = useState(""),
    [title, setTitle] = useState(""),
    [taskAgent, setTaskAgent] = useState(""),
    [invoke, setInvoke] = useState(""),
    [deps, setDeps] = useState<string[]>([]),
    [needsValidation, setNeedsValidation] = useState(false),
    [taskPaths, setTaskPaths] = useState(""),
    [routeText, setRouteText] = useState(""),
    [route, setRoute] = useState<any>(null),
    [rule, setRule] = useState(false),
    [priority, setPriority] = useState(100),
    [scope, setScope] = useState("intake"),
    [ruleMode, setRuleMode] = useState("advisory"),
    [specialty, setSpecialty] = useState(""),
    [files, setFiles] = useState(""),
    [target, setTarget] = useState(""),
    [match, setMatch] = useState("");
  const [assigning, setAssigning] = useState(false);
  // Archived projects are hidden unless asked for (src/project-lifecycle.ts).
  const [showArchived, setShowArchived] = useState(false);
  const projectWorkflows = p.data.workflows.filter(isProjectWorkflow);
  const archived = projectWorkflows.filter(
    (w) =>
      (w as { lifecycle?: { state: string } }).lifecycle?.state === "archived",
  ).length;
  const shownWorkflows = showArchived
    ? projectWorkflows
    : projectWorkflows.filter(
        (w) =>
          (w as { lifecycle?: { state: string } }).lifecycle?.state !==
          "archived",
      );
  useAssignRequest(() => setAssigning(true));
  const selected = p.data.agents.find((a) => a.id === p.selected);
  const teamName = p.data.teamView?.team.name ?? "this team";
  return (
    <div className="scroll section">
      <div className="section-title">
        <div>
          <span className="eyebrow">TEAM WORK</span>
          <h2>Projects</h2>
        </div>
        <div className="row">
          <button
            className="primary"
            title={`Give ${teamName} a project: goal, workspace and tasks for its existing agents`}
            aria-expanded={assigning}
            onClick={() => setAssigning(!assigning)}
          >
            <Plus size={16} />
            Assign project
          </button>
          <button
            title="New blank project with one coordinator (no team setup, starts unpaused)"
            onClick={() => setCreating(!creating)}
          >
            Blank project
          </button>
        </div>
      </div>
      <p className="hint projects-hint">
        Projects group a goal, workspace and tasks for {teamName}. Follow each
        project here; agent conversations are in Chat.
      </p>
      {assigning && (
        <AssignProject
          teamId={p.data.activeTeamId ?? "main"}
          teamName={teamName}
          act={p.act}
          close={() => setAssigning(false)}
        />
      )}
      {creating && (
        <form
          className="form-card"
          onSubmit={(e) => {
            e.preventDefault();
            void p.act(async () => {
              await api("/workflows", "POST", {
                name,
                goal,
                ownerId: p.selected,
                completionCriteria: criteria,
                // New workflows belong to the active team.
                teamId: p.data.activeTeamId,
              });
              setCreating(false);
              setName("");
              setGoal("");
            });
          }}
        >
          <h3>Create blank project</h3>
          <label>
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Goal
            <textarea
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>
          <label>
            Done when
            <input
              required
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
            />
          </label>
          <label>
            Coordinator
            <AgentPicker {...p} />
          </label>
          <button className="primary" disabled={!p.selected}>
            Create project
          </button>
        </form>
      )}
      {!projectWorkflows.length && !creating && !assigning && (
        <div className="empty compact">
          <ListTodoIcon />
          <h3>No projects in {teamName}</h3>
          <p>
            Assign this team a project: a goal and a workspace for its agents.
            Other teams’ projects are listed when you switch to that team.
          </p>
          <button onClick={() => setAssigning(true)}>Assign project</button>
        </div>
      )}
      {archived > 0 && (
        <label className="inline show-archived">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived ({archived})
        </label>
      )}
      {shownWorkflows.map((w) => (
        <section className="workflow project-card" key={w.id}>
          <div className="row between project-heading">
            <div className="project-heading-copy">
              <h3>{w.name}</h3>
              <p>{w.goal}</p>
            </div>
            <div className="row">
              <span
                className={"badge " + (w.status === "running" ? "green" : "")}
              >
                {w.status === "needs-attention" ? "needs attention" : w.status}
              </span>
              {p.setCurrentProject && (
                <button
                  className="text-button"
                  aria-pressed={p.currentProjectId === w.id}
                  onClick={() => p.setCurrentProject!(w.id)}
                >
                  {p.currentProjectId === w.id
                    ? "Current project"
                    : "Make current"}
                </button>
              )}
            </div>
          </div>
          <ProjectLifecycle workflow={w} act={p.act} />
          <SampleSetup workflow={w} act={p.act} />
          <WorkflowGateSummary tasks={w.tasks} />
          <div className="project-progress-row">
            <div
              className="progress project-progress"
              role="progressbar"
              aria-label={`${w.name} task progress`}
              aria-valuemin={0}
              aria-valuemax={w.tasks.length}
              aria-valuenow={
                w.tasks.filter((t) => t.status === "completed").length
              }
            >
              <span
                style={{
                  width: `${w.tasks.length ? (100 * w.tasks.filter((t) => t.status === "completed").length) / w.tasks.length : 0}%`,
                }}
              />
            </div>
            <small>
              {w.tasks.filter((t) => t.status === "completed").length} of{" "}
              {w.tasks.length} tasks complete
            </small>
            <button
              className="icon"
              title={w.paused ? "Resume project" : "Pause project"}
              aria-label={w.paused ? "Resume project" : "Pause project"}
              onClick={() =>
                void p.act(() =>
                  api("/workflows/" + w.id + "/pause", "POST", {
                    paused: !w.paused,
                  }),
                )
              }
            >
              {w.paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
          </div>
          <details className="project-tasks">
            <summary>
              <b>Tasks</b>
              <span>
                {w.tasks.length} total ·{" "}
                {
                  w.tasks.filter(
                    (t) => t.status === "queued" || t.status === "running",
                  ).length
                }{" "}
                active ·{" "}
                {
                  w.tasks.filter((t) =>
                    ["failed", "blocked", "interrupted"].includes(t.status),
                  ).length
                }{" "}
                need attention
              </span>
            </summary>
            {w.tasks.map((t) => (
              <details className="task" key={t.id}>
                <summary>
                  <span className={"task-dot " + t.status} />
                  <span>
                    {t.title}
                    <small>
                      {p.data.agents.find((a) => a.id === t.agentId)?.name}
                    </small>
                  </span>
                  <GateBadge task={t} />
                  <span className="badge">{t.status}</span>
                </summary>
                <p>{t.instructions}</p>
                <small>Done when: {t.completionCriteria}</small>
                {t.dependsOn.length > 0 && (
                  <p className="hint">
                    Depends on{" "}
                    {t.dependsOn
                      .map((id) => w.tasks.find((x) => x.id === id)?.title)
                      .join(", ")}
                  </p>
                )}
                {t.result && <pre>{t.result}</pre>}
                {p.openChat && (
                  <ConversationLink
                    taskId={t.id}
                    openChat={p.openChat}
                    label="Open agent conversation"
                  />
                )}
                <TaskValidation
                  task={t}
                  liveExecution={p.data.liveExecution}
                  act={p.act}
                />
                <TaskSettings task={t} tasks={w.tasks} act={p.act} />
                <div className="row">
                  {t.status === "failed" && (
                    <button
                      onClick={() =>
                        void p.act(() =>
                          api("/tasks/" + t.id + "/status", "POST", {
                            status: "queued",
                          }),
                        )
                      }
                    >
                      Retry
                    </button>
                  )}
                  {["queued", "failed", "interrupted", "blocked"].includes(
                    t.status,
                  ) && (
                    <button
                      onClick={() =>
                        void p.act(() =>
                          api("/tasks/" + t.id + "/status", "POST", {
                            status: "cancelled",
                          }),
                        )
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {t.status === "running" && (
                    <button
                      onClick={() =>
                        void p.act(() =>
                          api("/tasks/" + t.id + "/cancel", "POST"),
                        )
                      }
                    >
                      Stop
                    </button>
                  )}
                </div>
              </details>
            ))}
          </details>
          <details className="project-more">
            <summary>Project settings & reports</summary>
            {w.setup?.sample === PIPELINE_SAMPLE_ID && (
              <PipelineHistory workflowId={w.id} act={p.act} />
            )}
            {p.openFeature && (
              <div className="row wrap project-links">
                <button
                  className="text-button"
                  onClick={() => p.openFeature!("usage")}
                >
                  Limits and usage
                </button>
                <button
                  className="text-button"
                  onClick={() => p.openFeature!("recovery")}
                >
                  Recovery
                </button>
                <button
                  className="text-button"
                  onClick={() => p.openFeature!("shared")}
                >
                  Shared state
                </button>
                <button
                  className="text-button"
                  onClick={() => p.openFeature!("graphs")}
                >
                  Step-by-step runs
                </button>
              </div>
            )}
          </details>
          <button
            className="text-button"
            onClick={() => {
              setTaskFor(taskFor === w.id ? "" : w.id);
              setTaskAgent(p.selected);
              setInvoke("");
              setDeps([]);
            }}
          >
            <Plus size={14} />
            Add task
          </button>
          {taskFor === w.id && (
            <form
              className="form-card"
              onSubmit={(e) => {
                e.preventDefault();
                void p.act(async () => {
                  await api("/tasks", "POST", {
                    workflowId: w.id,
                    agentId: taskAgent,
                    title,
                    instructions: title,
                    completionCriteria: criteria,
                    dependsOn: deps,
                    ...(needsValidation ? { requiresValidation: true } : {}),
                    ...(invoke ? { invokedBy: invoke } : {}),
                    ...(declaredPaths(taskPaths).length
                      ? { resourcePaths: declaredPaths(taskPaths) }
                      : {}),
                  });
                  setTaskPaths("");
                  setTaskFor("");
                  setTitle("");
                  setNeedsValidation(false);
                });
              }}
            >
              <label>
                Task
                <textarea
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                Assigned agent
                <select
                  value={taskAgent}
                  onChange={(e) => setTaskAgent(e.target.value)}
                >
                  {p.data.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {agentSelectorLabel(a)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Invoked by
                <select
                  value={invoke}
                  onChange={(e) => setInvoke(e.target.value)}
                >
                  <option value="">Direct user task</option>
                  {p.data.agents
                    .filter((a) => a.id !== taskAgent)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {agentSelectorLabel(a)}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Done when
                <input
                  required
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={needsValidation}
                  onChange={(e) => setNeedsValidation(e.target.checked)}
                />
                Requires Wolfram validation before it can run
              </label>
              {w.tasks.map((t) => (
                <label className="inline" key={t.id}>
                  <input
                    type="checkbox"
                    checked={deps.includes(t.id)}
                    onChange={(e) =>
                      setDeps(
                        e.target.checked
                          ? [...deps, t.id]
                          : deps.filter((id) => id !== t.id),
                      )
                    }
                  />
                  After {t.title}
                </label>
              ))}
              <label>
                Paths this task will touch (optional)
                <input
                  aria-label="Declared paths"
                  placeholder="Absolute paths, comma separated; empty locks every attached folder"
                  value={taskPaths}
                  onChange={(e) => setTaskPaths(e.target.value)}
                />
              </label>
              {taskAgent && (
                <LaunchReview
                  agentId={taskAgent}
                  workflowId={w.id}
                  resourcePaths={declaredPaths(taskPaths)}
                />
              )}
              <button className="primary">Queue task</button>
            </form>
          )}
        </section>
      ))}
      <div className="section-title">
        <h3>Routing rules</h3>
        <button onClick={() => setRule(!rule)}>
          <Plus size={14} />
          Rule
        </button>
      </div>
      {rule && (
        <form
          className="form-card"
          onSubmit={(e) => {
            e.preventDefault();
            void p.act(async () => {
              await api("/rules", "POST", {
                agentId: p.selected,
                scope,
                ...(scope === "action" ? { targetId: target } : {}),
                priority,
                match: {
                  textIncludes: match
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                  changedFilesAny: splitList(files),
                  catchAll: !match.trim() && !files.trim(),
                },
                mode: ruleMode,
                ...(specialty.trim() ? { specialty: specialty.trim() } : {}),
                kind: ruleMode === "mandatory" ? "review" : "delegate",
              });
              setRule(false);
            });
          }}
        >
          <label>
            Agent
            <AgentPicker {...p} />
          </label>
          <label>
            Rule type
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="intake">Bring matching work to me</option>
              <option value="action">When I need this, invoke…</option>
            </select>
          </label>
          {scope === "action" && (
            <label>
              Invoke
              <select
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Select agent</option>
                {p.data.agents
                  .filter((a) => a.id !== p.selected)
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {agentSelectorLabel(a)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Text contains (comma-separated)
            <input
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              placeholder="Empty matches all tasks"
            />
          </label>
          <RuleOptionsFields
            mode={ruleMode}
            setMode={setRuleMode}
            specialty={specialty}
            setSpecialty={setSpecialty}
            files={files}
            setFiles={setFiles}
          />
          <label>
            Priority (highest wins)
            <input
              type="number"
              min="0"
              max="10000"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </label>
          <button className="primary">Save rule</button>
        </form>
      )}
      {p.data.rules.map((r) => (
        <div className="rule" key={r.id}>
          <div>
            <b>{p.data.agents.find((a) => a.id === r.agentId)?.name}</b>
            <small>
              {r.scope === "action"
                ? "Invoke " +
                  p.data.agents.find((a) => a.id === r.targetId)?.name
                : "Receive tasks"}{" "}
              ·{" "}
              {r.match.catchAll
                ? "All tasks"
                : [
                    ...r.match.textIncludes,
                    ...(r.match.changedFilesAny ?? []),
                  ].join(", ")}{" "}
              · priority {r.priority}
            </small>
            <RuleBadge rule={r} />
          </div>
          <RuleEditor rule={r} agents={p.data.agents} act={p.act} />
          <button
            onClick={() => void p.act(() => api("/rules/" + r.id, "DELETE"))}
          >
            Remove
          </button>
        </div>
      ))}
      <details className="form-card">
        <summary>Test task routing</summary>
        <label>
          Task description
          <input
            value={routeText}
            onChange={(e) => setRouteText(e.target.value)}
          />
        </label>
        <button
          disabled={!routeText.trim()}
          onClick={() =>
            void p.act(async () =>
              setRoute(
                await api("/routing/preview", "POST", { text: routeText }),
              ),
            )
          }
        >
          Preview routing
        </button>
        {route && (
          <p>
            {route.status}:{" "}
            {p.data.agents.find((a) => a.id === route.agentId)?.name ??
              route.reason}
          </p>
        )}
        <RoutingExplain agents={p.data.agents} from={p.selected || undefined} />
      </details>
    </div>
  );
}
function ListTodoIcon() {
  return <Check size={30} />;
}
export type WorkspaceView = "files" | "git" | "review" | "preview";
const VIEW_TITLE: Record<WorkspaceView, string> = {
  files: "Files",
  git: "Git",
  review: "Diff",
  preview: "Preview",
};
/** Project files and Diff, plus Git and Preview as feature tabs for the selected workspace. */
export function Workspace(
  p: PaneProps & {
    view: WorkspaceView;
    openFileTarget?: {
      agentId: string;
      workspace: string;
      path: string;
    } | null;
    onFileTargetHandled?: () => void;
  },
) {
  const projectWorkspace = p.currentProject?.setup?.workspace;
  const projectAgentId =
    p.currentProject?.tasks
      .map((task) => p.data.agents.find((agent) => agent.id === task.agentId))
      .find((agent) =>
        agent?.workspaces.some(
          (workspace) => workspace.path === projectWorkspace,
        ),
      )?.id ??
    p.currentProject?.tasks[0]?.agentId ??
    p.currentProject?.ownerId;
  const preferredAgentId = projectAgentId ?? p.selected;
  const [workspaceAgentId, setWorkspaceAgentId] = useState(preferredAgentId);
  const pendingWorkspaceSelection = useRef<{
    agentId: string;
    path: string;
  } | null>(null);
  const [collapsedFolderAgents, setCollapsedFolderAgents] = useState<
    Set<string>
  >(() => new Set());
  const agent = p.data.agents.find((a) => a.id === workspaceAgentId),
    [root, setRoot] = useState(""),
    [path, setPath] = useState("."),
    [listing, setListing] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [git, setGit] = useState<any>(null),
    [commit, setCommit] = useState(""),
    [tick, setTick] = useState(0),
    [context, setContext] = useState<{
      path: string;
      x: number;
      y: number;
    } | null>(null);
  const tab = p.view;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => setWorkspaceAgentId(preferredAgentId), [preferredAgentId]);
  useEffect(() => {
    if (p.openFileTarget && p.openFileTarget.agentId !== workspaceAgentId)
      setWorkspaceAgentId(p.openFileTarget.agentId);
  }, [p.openFileTarget, workspaceAgentId]);
  useEffect(() => {
    const pending = pendingWorkspaceSelection.current;
    const selectedPath =
      pending && pending.agentId === agent?.id ? pending.path : null;
    if (selectedPath) pendingWorkspaceSelection.current = null;
    setRoot(
      selectedPath ??
        (projectWorkspace &&
        agent?.workspaces.some((w) => w.path === projectWorkspace)
          ? projectWorkspace
          : undefined) ??
        agent?.workspaces.find((w) => w.active)?.path ??
        agent?.workspaces[0]?.path ??
        "",
    );
    setPath(".");
    if (!previewRef.current?.isNew) setPreview(null);
    setGit(null);
    setListing(null);
  }, [
    workspaceAgentId,
    projectWorkspace,
    agent?.workspaces.map((w) => w.path).join("|"),
  ]);
  useEffect(() => {
    const target = p.openFileTarget;
    if (!target || agent?.id !== target.agentId) return;
    if (
      !agent.workspaces.some((workspace) => workspace.path === target.workspace)
    ) {
      p.onFileTargetHandled?.();
      return;
    }
    const parts = target.path.split(/[\\/]/);
    const name = parts.pop() ?? target.path;
    setRoot(target.workspace);
    setPath(parts.join("/") || ".");
    setPreview({ path: target.path, name });
    p.onFileTargetHandled?.();
  }, [p.openFileTarget, agent?.id]);
  const load = async () => {
    if (!root || !agent) return;
    setListing(
      await api("/agents/" + agent.id + "/files/browse", "POST", {
        workspace: root,
        path,
      }),
    );
  };
  useEffect(() => {
    void p.act(load);
  }, [root, path]);
  async function loadGit() {
    if (agent && root)
      setGit(
        await api("/agents/" + agent.id + "/git/status", "POST", {
          workspace: root,
        }),
      );
  }
  // External edits: debounced backend events refresh the listing and Git status (no polling here).
  useWorkspaceWatch(agent?.id, root, tab === "files" || tab === "git", () => {
    setTick((t) => t + 1);
    if (tab === "files") void load().catch(() => {});
    if (tab === "git") void loadGit().catch(() => {});
  });
  async function open(path: string, application?: string) {
    await api("/agents/" + agent!.id + "/files/open", "POST", {
      workspace: root,
      path,
      ...(application ? { application } : {}),
    });
  }
  const selectFolder = (agentId: string, folderPath: string) => {
    if (!canLeaveFileEditor()) return;
    pendingWorkspaceSelection.current = { agentId, path: folderPath };
    setWorkspaceAgentId(agentId);
    setRoot(folderPath);
    setPath(".");
    setPreview(null);
    setGit(null);
  };
  const toggleFolderAgent = (agentId: string) =>
    setCollapsedFolderAgents((previous) => {
      const next = new Set(previous);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  const folderName = (folderPath: string) =>
    folderPath.split(/[\\/]/).filter(Boolean).at(-1) || folderPath;
  if (!agent)
    return (
      <div className="empty">
        <p>
          {p.data.agents.length
            ? "Select an agent."
            : `No agents in ${p.data.teamView?.team.name ?? "this team"}.`}
        </p>
      </div>
    );
  return (
    <div className="workspace pane-content">
      <div className="section workspace-top">
        <div className="section-title">
          <h2>{VIEW_TITLE[tab]}</h2>
          <button
            title="Add a folder to this agent's file workspace"
            onClick={() => p.edit(agent)}
          >
            <Plus size={16} />
            Add folder
          </button>
        </div>
        <div className="row workspace-pickers">
          {tab !== "files" && (
            <select
              aria-label="Workspace agent"
              value={workspaceAgentId}
              onChange={(event) => {
                if (canLeaveFileEditor())
                  setWorkspaceAgentId(event.target.value);
              }}
            >
              {p.data.agents.map((workspaceAgent) => (
                <option key={workspaceAgent.id} value={workspaceAgent.id}>
                  {workspaceAgent.name}
                </option>
              ))}
            </select>
          )}
          {tab !== "files" && root && (
            <select
              aria-label="Workspace folder"
              value={root}
              onChange={(e) => {
                if (!canLeaveFileEditor()) return;
                setRoot(e.target.value);
                setPath(".");
                setPreview(null);
                setGit(null);
              }}
            >
              {agent.workspaces.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.path} · {w.access}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {preview?.isNew ? (
        <div className="scroll section workspace-body">
          {p.currentProject && (
            <p className="workspace-project-context">
              Current project: <b>{p.currentProject.name}</b>
            </p>
          )}
          <TextEditor
            key={agent.id + "new-file"}
            agentId={agent.id}
            workspace={root}
            path={preview.path}
            isNew
            onCancel={() => setPreview(null)}
            onSaved={() => {}}
            onCreated={(createdPath) => {
              const name = createdPath.split(/[\\/]/).pop() ?? createdPath;
              setPreview({ path: createdPath, name });
              setTick((value) => value + 1);
              void p.act(load);
            }}
          />
        </div>
      ) : !root && tab !== "files" ? (
        <div className="empty">
          <FolderOpen size={34} />
          <h3>No project folder open</h3>
          <p>
            Open a blank file now, or add a folder to browse and save project
            files.
          </p>
          <button
            onClick={() =>
              setPreview({
                path: "untitled.txt",
                name: "untitled.txt",
                isNew: true,
              })
            }
          >
            <Plus size={15} /> New file
          </button>
          <button onClick={() => p.edit(agent)}>Add a folder</button>
        </div>
      ) : (
        <div className="scroll section workspace-body">
          {p.currentProject && (
            <p className="workspace-project-context">
              Current project: <b>{p.currentProject.name}</b>
            </p>
          )}
          {tab === "preview" ? (
            <DevServerPanel
              key={agent.id + root}
              agentId={agent.id}
              workspace={root}
            />
          ) : tab === "review" ? (
            <ChangesReview
              key={agent.id + root}
              agentId={agent.id}
              workspace={root}
              agents={p.data.agents}
              onOpenConversation={p.openChat}
            />
          ) : tab === "files" ? (
            <>
              {root && (
                <div className="row between">
                  <div className="row">
                    <button
                      className="icon"
                      title="Parent folder"
                      disabled={path === "."}
                      onClick={() => {
                        if (!canLeaveFileEditor()) return;
                        const parts = path.split(/[\\/]/);
                        parts.pop();
                        setPath(parts.join("/") || ".");
                        setPreview(null);
                      }}
                    >
                      <ArrowLeft size={16} />
                    </button>
                    <code>{path === "." ? "Project root" : path}</code>
                  </div>
                  <button
                    className="icon"
                    title="Refresh files"
                    onClick={() => void p.act(load)}
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    className="primary"
                    title={`Create a file in ${root}${path === "." ? "" : `/${path}`}`}
                    onClick={() => {
                      if (!canLeaveFileEditor()) return;
                      const folder = path === "." ? "" : `${path}/`;
                      setPreview({
                        path: `${folder}untitled.txt`,
                        name: "untitled.txt",
                        isNew: true,
                      });
                    }}
                  >
                    <Plus size={15} />
                    New file
                  </button>
                </div>
              )}
              <div className="workspace-file-browser">
                <aside
                  className="workspace-agent-folders"
                  aria-label="Agent folders"
                >
                  <h3>Agent folders</h3>
                  <div role="tree" aria-label="Agent folders">
                    {p.data.agents.map((folderAgent) => {
                      const expanded = !collapsedFolderAgents.has(
                        folderAgent.id,
                      );
                      const isCurrentAgent =
                        folderAgent.id === workspaceAgentId;
                      return (
                        <div
                          key={folderAgent.id}
                          className="workspace-agent-folder-group"
                          role="treeitem"
                          aria-label={agentSelectorLabel(folderAgent)}
                          aria-level={1}
                          aria-expanded={
                            folderAgent.workspaces.length ? expanded : undefined
                          }
                          aria-selected={isCurrentAgent}
                        >
                          <div className="workspace-agent-folder-person">
                            {folderAgent.workspaces.length > 0 ? (
                              <button
                                className="icon workspace-folder-toggle"
                                title={`${expanded ? "Collapse" : "Expand"} ${agentDisplayName(folderAgent)} folders`}
                                aria-label={`${expanded ? "Collapse" : "Expand"} ${agentSelectorLabel(folderAgent)} folders`}
                                onClick={() =>
                                  toggleFolderAgent(folderAgent.id)
                                }
                              >
                                {expanded ? (
                                  <ChevronDown size={14} />
                                ) : (
                                  <ChevronRight size={14} />
                                )}
                              </button>
                            ) : (
                              <span className="workspace-folder-spacer" />
                            )}
                            <button
                              className={`workspace-agent-folder-name${isCurrentAgent ? " active" : ""}`}
                              onClick={() => {
                                if (!canLeaveFileEditor()) return;
                                setWorkspaceAgentId(folderAgent.id);
                              }}
                              title={agentSelectorLabel(folderAgent)}
                            >
                              <AgentAvatar
                                name={folderAgent.name}
                                nickname={folderAgent.nickname}
                                avatar={folderAgent.avatar}
                                environment={folderAgent.environment}
                                className="workspace-agent-folder-avatar"
                              />
                              <span>{agentDisplayName(folderAgent)}</span>
                            </button>
                          </div>
                          {expanded && folderAgent.workspaces.length > 0 && (
                            <div role="group">
                              {folderAgent.workspaces.map((workspace) => {
                                const active =
                                  isCurrentAgent && workspace.path === root;
                                return (
                                  <button
                                    key={workspace.path}
                                    className={`workspace-folder-node${active ? " active" : ""}`}
                                    role="treeitem"
                                    aria-level={2}
                                    aria-selected={active}
                                    onClick={() =>
                                      selectFolder(
                                        folderAgent.id,
                                        workspace.path,
                                      )
                                    }
                                    title={`${workspace.path} · ${workspace.access}`}
                                  >
                                    <FolderOpen size={15} />
                                    <span className="workspace-folder-node-label">
                                      <b>{folderName(workspace.path)}</b>
                                      <small>{workspace.path}</small>
                                    </span>
                                    <small className="workspace-folder-access">
                                      {workspace.access === "write"
                                        ? "Write"
                                        : "Read"}
                                    </small>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {expanded && folderAgent.workspaces.length === 0 && (
                            <p className="workspace-agent-no-folders">
                              No folders
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </aside>
                <aside
                  className="workspace-file-tree"
                  aria-label="Project files"
                >
                  <div className="file-list">
                    {!root ? (
                      <p className="workspace-no-folder">
                        Choose an agent folder to browse its files.
                      </p>
                    ) : (
                      listing?.entries.map((entry: any) => (
                        <button
                          key={entry.path}
                          aria-current={
                            preview?.path === entry.path ? "page" : undefined
                          }
                          onClick={() => {
                            if (
                              preview?.path !== entry.path &&
                              !canLeaveFileEditor()
                            )
                              return;
                            void p.act(async () => {
                              if (entry.type === "directory") {
                                setPath(entry.path);
                                setPreview(null);
                              } else {
                                setPreview({
                                  path: entry.path,
                                  name: entry.name,
                                });
                              }
                            });
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContext({
                              path: entry.path,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                        >
                          {entry.type === "directory" ? (
                            <FolderOpen size={16} />
                          ) : (
                            <File size={16} />
                          )}
                          <span>{entry.name}</span>
                          {entry.type === "directory" && (
                            <ChevronRight size={14} />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                  {root && (
                    <div className="row wrap workspace-file-actions">
                      <button onClick={() => void p.act(() => open("."))}>
                        Open project externally
                      </button>
                      <button
                        onClick={() => void p.act(() => open(path, "finder"))}
                      >
                        Reveal folder
                      </button>
                      <OpenWith
                        agentId={agent.id}
                        workspace={root}
                        path={path}
                        project
                      />
                    </div>
                  )}
                </aside>
                <section
                  className="workspace-file-editor"
                  aria-label="File editor"
                >
                  {preview ? (
                    <FilePreview
                      key={agent.id + root + preview.path}
                      agentId={agent.id}
                      workspace={root}
                      path={preview.path}
                      access={
                        agent.workspaces.find((w) => w.path === root)?.access ??
                        "read"
                      }
                      refreshKey={tick}
                    />
                  ) : (
                    <div className="empty compact">
                      <File size={30} />
                      <p>
                        {root
                          ? "Select a file to preview or edit it."
                          : "Open a folder or start with a new file."}
                      </p>
                      {!root && (
                        <button
                          onClick={() =>
                            setPreview({
                              path: "untitled.txt",
                              name: "untitled.txt",
                              isNew: true,
                            })
                          }
                        >
                          <Plus size={15} /> New file
                        </button>
                      )}
                    </div>
                  )}
                </section>
              </div>
            </>
          ) : (
            <>
              <GitWorkflowPanel
                key={agent.id + root}
                agentId={agent.id}
                workspace={root}
                tick={tick}
                onChanged={() => void loadGit().catch(() => {})}
              />
              <div className="row between">
                <div className="row">
                  <GitBranch size={17} />
                  <b>{git?.branch ?? "Loading repository…"}</b>
                </div>
                <button title="Refresh Git" onClick={() => void p.act(loadGit)}>
                  <RefreshCw size={15} />
                </button>
              </div>
              {git && !git.canMutate && (
                <p className="notice">
                  Attach the repository root with write access to stage and
                  commit.
                </p>
              )}
              {git?.status.map((file: any) => (
                <div className="git-file" key={file.path}>
                  <div className="row">
                    <code>{file.status}</code>
                    <button
                      className="file-name"
                      onClick={() =>
                        void p.act(async () => {
                          const result = await api(
                            "/agents/" + agent.id + "/git/diff",
                            "POST",
                            {
                              workspace: root,
                              path: file.path,
                              staged:
                                file.status[0] !== " " &&
                                file.status[0] !== "?",
                            },
                          );
                          setPreview({
                            name: file.path,
                            path: file.path,
                            content:
                              result.diff ||
                              "No tracked diff. This may be an untracked file.",
                          });
                        })
                      }
                    >
                      {file.path}
                    </button>
                  </div>
                  <div className="row">
                    <button
                      disabled={!git.canMutate}
                      onClick={() =>
                        void p.act(async () => {
                          await api(
                            "/agents/" + agent.id + "/git/mutate",
                            "POST",
                            {
                              workspace: root,
                              action: "stage",
                              paths: [file.path],
                            },
                          );
                          await loadGit();
                        })
                      }
                    >
                      Stage
                    </button>
                    <button
                      disabled={
                        !git.canMutate ||
                        file.status[0] === "?" ||
                        file.status[0] === " "
                      }
                      onClick={() =>
                        void p.act(async () => {
                          await api(
                            "/agents/" + agent.id + "/git/mutate",
                            "POST",
                            {
                              workspace: root,
                              action: "unstage",
                              paths: [file.path],
                            },
                          );
                          await loadGit();
                        })
                      }
                    >
                      Unstage
                    </button>
                  </div>
                </div>
              ))}
              {git?.status.length === 0 && (
                <p className="hint">Working tree is clean.</p>
              )}
              <GitRenamePair
                files={git?.status ?? []}
                disabled={!git?.canMutate}
                onStage={(from, to) =>
                  p.act(async () => {
                    await api("/agents/" + agent.id + "/git/mutate", "POST", {
                      workspace: root,
                      action: "stage",
                      paths: [],
                      renames: [{ from, to }],
                    });
                    await loadGit();
                  })
                }
              />
              <label>
                Commit staged changes
                <input
                  placeholder="Commit message"
                  value={commit}
                  onChange={(e) => setCommit(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={!git?.canMutate || !commit.trim()}
                onClick={() =>
                  void p.act(async () => {
                    await api("/agents/" + agent.id + "/git/mutate", "POST", {
                      workspace: root,
                      action: "commit",
                      message: commit,
                    });
                    setCommit("");
                    await loadGit();
                  })
                }
              >
                Commit staged
              </button>
              {preview && (
                <div className="file-preview">
                  <b>{preview.name}</b>
                  <pre>{preview.content}</pre>
                </div>
              )}
              <WorktreeManager
                key={agent.id + root}
                agentId={agent.id}
                workspace={root}
              />
              <h3>Worktrees</h3>
              {git?.worktrees.map((w: any) => (
                <div className="worktree" key={w.worktree}>
                  <GitBranch size={15} />
                  <div>
                    <b>
                      {w.branch?.replace("refs/heads/", "") ?? "Detached HEAD"}
                    </b>
                    <code>{w.worktree}</code>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
      {context && (
        <>
          <div className="menu-dismiss" onClick={() => setContext(null)} />
          <div
            className="context-menu"
            style={{
              left: Math.min(context.x, window.innerWidth - 240),
              top: Math.min(context.y, window.innerHeight - 240),
            }}
          >
            {[
              ["Default editor", undefined],
              ["Sublime Text", "sublime"],
              ["Visual Studio Code", "vscode"],
              ["System default application", "system"],
              ["Reveal in file manager", "finder"],
            ].map(([label, application]) => (
              <button
                key={label}
                onClick={() => {
                  void p.act(() => open(context.path, application));
                  setContext(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
export function Preferences(
  p: PaneProps & {
    /** Layouts and side-panel preferences (rendered by the App, which owns that state). */
    workspace?: React.ReactNode;
  },
) {
  const [settings, setSettings] = useState<any>({ defaultEditor: "sublime" }),
    [runtime, setRuntime] = useState<any>(null);
  useEffect(() => {
    void p.act(async () => {
      setSettings(await api("/settings"));
      setRuntime(await api("/runtimes"));
    });
  }, []);
  return (
    <div className="scroll section">
      <h2>Settings</h2>
      <section className="settings-card">
        <h3>Execution</h3>
        <p>
          Installed harnesses and their existing logins are used automatically.
          Pause execution when you want to hold new work.
        </p>
        <button
          onClick={() =>
            void p.act(() =>
              api("/execution", "PUT", { enabled: !p.data.liveExecution }),
            )
          }
        >
          {p.data.liveExecution ? "Pause execution" : "Resume execution"}
        </button>
        <p className="hint">
          Pausing holds new runs; active requests continue until stopped.
        </p>
      </section>
      <HarnessSettings act={p.act} />
      <FilesystemSettings act={p.act} />
      <section className="settings-card">
        <h3>Default text editor</h3>
        <p>Applies to files and project directories opened from Workspace.</p>
        <select
          aria-label="Default editor"
          value={settings.defaultEditor}
          onChange={(e) =>
            void p.act(async () =>
              setSettings(
                await api("/settings", "PUT", {
                  defaultEditor: e.target.value,
                }),
              ),
            )
          }
        >
          <option value="sublime">Sublime Text</option>
          <option value="vscode">Visual Studio Code</option>
          <option value="system">System default</option>
        </select>
        <p className="hint">
          On Windows and Linux, add Sublime’s subl command or VS Code’s code
          command to PATH. System opening uses the platform file manager.
        </p>
      </section>
      <EditorSettings />
      {p.workspace}
      <section className="settings-card">
        <h3>Reset</h3>
        <p>
          Forget open tabs, layouts, panel sizes and canvas positions on this
          computer. Message drafts are kept.
        </p>
        <button
          onClick={() => {
            for (const key of Object.keys(localStorage))
              if (
                key.startsWith("agentteam.") &&
                !key.startsWith("agentteam.draft")
              )
                localStorage.removeItem(key);
            window.location.reload();
          }}
        >
          Reset layout preferences
        </button>
      </section>
      <section className="settings-card">
        <h3>Local workspace</h3>
        <p>
          Agent configurations, conversations and activity are stored locally.
          Provider requests are sent through the selected provider. Credentials
          stay in your provider’s own login configuration.
        </p>
        <p className="hint">
          Native app handoff opens the provider’s application; conversation
          continuity depends on that application. CLI resume commands are
          available in each agent’s chat.
        </p>
      </section>
    </div>
  );
}
export function ActivityLog({
  events,
  data,
}: {
  events: TeamEvent[];
  data: Snapshot;
}) {
  const [history, setHistory] = useState<TeamEvent[]>([]);
  useEffect(() => {
    api("/events")
      .then(setHistory)
      .catch(() => {});
  }, []);
  // Only the active team's activity (and global events); other teams keep working unseen here,
  // but their running/attention counts stay visible in the team switcher.
  const index = data.teamView?.index;
  const combined = [
    ...new Map([...history, ...events].map((e) => [e.seq, e])).values(),
  ]
    .filter((e) => !index || eventVisible(index, data.activeTeamId, e))
    .sort((a, b) => b.seq - a.seq);
  return (
    <div className="scroll section">
      <span className="eyebrow">LIVE ACTIVITY</span>
      <h2>What’s happening</h2>
      {!combined.length && (
        <div className="empty">
          <Clock size={30} />
          <p>Activity will appear as your team works.</p>
        </div>
      )}
      {combined.map((e) => (
        <details className="event" key={e.seq}>
          <summary>
            <span
              className={
                "dot " +
                (e.type.includes("failed")
                  ? "red"
                  : e.type === "flow.transferred"
                    ? "green"
                    : "")
              }
            />
            <div>
              <b>{e.type.replaceAll(".", " · ")}</b>
              <small>
                {(data.teamView?.allAgents ?? data.agents).find(
                  (a) => a.id === e.data?.agentId || a.id === e.entityId,
                )?.name ?? ""}{" "}
                {new Date(e.createdAt).toLocaleTimeString()}
              </small>
            </div>
          </summary>
          <pre>{JSON.stringify(e.data, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

/** "Access & resources": the selected agent's effective folder access, then shared resources. */
export function AgentAccess(p: PaneProps) {
  const agent = p.data.agents.find((a) => a.id === p.selected);
  return (
    <div className="section access-page">
      <div className="section-title">
        <div>
          <h2>Access & resources</h2>
          <p className="hint">
            Which folders each agent may read or edit, and how shared folders
            are coordinated.
          </p>
        </div>
        <AgentPicker {...p} />
      </div>
      {agent ? (
        <AccessView agent={agent} data={p.data} edit={() => p.edit(agent)} />
      ) : (
        <p className="hint">No agents in this team.</p>
      )}
    </div>
  );
}
function AccessView({
  agent,
  data,
  edit,
}: {
  agent: Agent;
  data: Snapshot;
  edit: () => void;
}) {
  return (
    <div className="access-view">
      <div className="access-heading">
        <span className="eyebrow">EXPLICIT FILE ACCESS</span>
        <h2>{agentDisplayName(agent)}</h2>
        <p>
          These are the folders this agent can browse through AgentTeam. Each
          permission includes files and subfolders below that path.
        </p>
      </div>
      {!agent.workspaces.length && (
        <div className="notice">
          No attached folders. AgentTeam file and Git operations are denied.
        </div>
      )}
      {agent.workspaces.map((w) => (
        <div className={"access-folder " + w.access} key={w.path}>
          <div className="row between">
            <FolderOpen size={20} />
            <b>
              {w.explicitOnly
                ? "LISTED PATHS ONLY"
                : w.access === "write"
                  ? "READ & WRITE"
                  : "READ ONLY"}
            </b>
            <span className="badge" title="Rules and exclusions">
              {accessLabel(w)}
            </span>
            {w.active && <span className="badge green">Working directory</span>}
          </div>
          <code className="full-path">{w.path}</code>
          <div className="access-actions">
            <span>
              {w.explicitOnly || w.rules?.length
                ? "✓ Browse what the rules below allow"
                : "✓ Browse all descendants"}
            </span>
            <span>✓ Preview files</span>
            <span>
              {w.access === "write"
                ? "✓ Git stage / unstage / commit at repo root"
                : "— Git changes blocked"}
            </span>
            <span>— Symlink escapes and .git internals blocked</span>
          </div>
          <small>
            Also attached to:{" "}
            {data.agents
              .filter(
                (a) =>
                  a.id !== agent.id &&
                  a.workspaces.some((x) => x.path === w.path),
              )
              .map((a) => agentDisplayName(a))
              .join(", ") || "No other agents"}
          </small>
        </div>
      ))}
      <EffectiveAccess
        agentId={agent.id}
        events={JSON.stringify(agent.workspaces)}
      />
      <button onClick={edit}>
        <Settings2 size={15} />
        Edit folder access
      </button>
      <section className="settings-card">
        <h3>Provider runtime access</h3>
        <p>
          {agent.environment === "codex"
            ? "Codex currently runs in its read-only sandbox. It may read files outside these attached folders; this list does not confine the Codex process. File writes through the current adapter are disabled."
            : agent.environment === "claude"
              ? "The Claude chat adapter currently disables tools. It receives your prompt and the skill/instruction text loaded by AgentTeam, but cannot browse folders through this adapter."
              : "The Wolfram adapter sends prompts through LLMSynthesize. It imports a temporary request file and does not execute model-generated code. Your Wolfram process still runs with your operating-system permissions."}
        </p>
        <p className="hint">
          Native applications and external CLI sessions use their own
          permissions. Opening a file in your editor is a user action and is not
          limited by an agent’s read-only setting.
        </p>
      </section>
      <section className="settings-card">
        <h3>Always-loaded information</h3>
        <p>
          {agent.skills.filter((s) => s.mode === "always").length} skill(s), the
          agent role, and {agent.instructions.length} characters of personal
          instructions are sent with launches.
        </p>
        <p className="hint">
          Files are loaded when requested. Attaching a folder does not
          automatically send its contents to a provider.
        </p>
      </section>
    </div>
  );
}

const PROJECT_PANEL: Record<
  "recovery" | "shared",
  { title: string; hint: string }
> = {
  recovery: {
    title: "Recovery",
    hint: "Tasks interrupted by a restart or blocked on an uncertain effect, with the next safe step.",
  },
  shared: {
    title: "Shared state",
    hint: "Durable project facts and registered outputs that agents can reuse across tasks. Chat history lives in Chat; this view is empty until a field or artifact is created.",
  },
};
/** Limits, Recovery and Shared state: one per-project panel for each of the team's projects. */
export function ProjectPanels(p: PaneProps & { kind: "recovery" | "shared" }) {
  const info = PROJECT_PANEL[p.kind];
  return (
    <div className="scroll section">
      <div className="section-title">
        <div>
          <h2>{info.title}</h2>
          <p className="hint">{info.hint}</p>
        </div>
      </div>
      {!p.data.workflows.length && (
        <div className="empty compact">
          <h3>No projects in {p.data.teamView?.team.name ?? "this team"}</h3>
          <p>Assign the team a project first.</p>
          {p.openFeature && (
            <button onClick={() => p.openFeature!("projects")}>
              Open Projects
            </button>
          )}
        </div>
      )}
      {p.data.workflows.map((w) => (
        <section className="workflow" key={w.id}>
          <div className="row between">
            <b>{w.name}</b>
            <span
              className={"badge " + (w.status === "running" ? "green" : "")}
            >
              {w.status}
            </span>
          </div>
          {p.kind === "recovery" && (
            <WorkflowRecovery workflowId={w.id} act={p.act} />
          )}
          {p.kind === "shared" && (
            <>
              <WorkflowSharedState workflowId={w.id} />
              <WorkflowStateEditor workflowId={w.id} act={p.act} />
            </>
          )}
        </section>
      ))}
    </div>
  );
}
