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
  WolframSampleButton,
  WorkflowGateSummary,
} from "./Validation";
import { WorkflowLimits } from "./Limits";
import { WorkflowRecovery } from "./Recovery";
import { WorkflowSharedState } from "./SharedState";
import { HarnessSettings } from "./HarnessSettings";
import { GitWorkflowPanel } from "./GitWorkflow";
import { FilePreview, OpenWith } from "./FilePreview";
import { EditorSettings } from "./EditorSettings";
import { useWorkspaceWatch } from "./useWorkspaceWatch";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Square,
  MessageSquare,
  FolderOpen,
  File,
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
export type PaneProps = {
  data: Snapshot;
  selected: string;
  setSelected: (id: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  events: TeamEvent[];
  edit: (a: Agent) => void;
  /** Select an agent and show its conversation pane. */
  openChat?: (id: string) => void;
};
function AgentPicker(p: PaneProps) {
  return (
    <select
      aria-label="Agent"
      value={p.selected}
      onChange={(e) => p.setSelected(e.target.value)}
    >
      {p.data.agents.map((a) => (
        <option value={a.id} key={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
export function Chat(p: PaneProps) {
  const [messages, setMessages] = useState<any[]>([]),
    [draft, setDraft] = useState(""),
    [mode, setMode] = useState("chat"),
    [cli, setCli] = useState<any>(null);
  const end = useRef<HTMLDivElement>(null),
    agent = p.data.agents.find((a) => a.id === p.selected),
    session = p.data.sessions.find((s) => s.agentId === p.selected);
  const [sending, setSending] = useState(false);
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
  }, [p.selected]);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    api("/sessions/" + session.id + "/messages")
      .then((m) => {
        if (alive) setMessages(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session?.id, p.events]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  async function send() {
    if (!agent || !draft.trim() || sendLock.current || composing.current)
      return;
    sendLock.current = true;
    setSending(true);
    const text = draft;
    try {
      await p.act(async () => {
        const s = await api("/agents/" + agent.id + "/session", "POST");
        await api("/sessions/" + s.id + "/messages", "POST", { text });
        // Clear only what was sent: keep anything typed meanwhile or in another agent's draft.
        if (saved("draft." + agent.id, "") === text)
          persist("draft." + agent.id, "");
        if (currentAgent.current === agent.id)
          setDraft((d) => (d === text ? "" : d));
        if (p.data.liveExecution)
          await api("/sessions/" + s.id + "/run", "POST");
      });
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  if (!agent)
    return (
      <div className="empty">
        <MessageSquare size={32} />
        <h2>Your team starts here</h2>
        <p>Create an agent to start a conversation.</p>
      </div>
    );
  return (
    <div className="chat pane-content">
      <div className="chat-toolbar">
        <div>
          <span className="eyebrow">TALKING TO</span>
          <AgentPicker {...p} />
        </div>
        <div className="row">
          <button
            className="icon"
            title="Configure agent"
            onClick={() => p.edit(agent)}
          >
            <Settings2 size={17} />
          </button>
          <button
            onClick={() =>
              void p.act(() =>
                api("/agents/" + agent.id + "/control", "POST", {
                  owner: agent.control === "human" ? "team" : "human",
                }),
              )
            }
          >
            {agent.control === "human" ? "Return to team" : "Take control"}
          </button>
        </div>
      </div>
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
                setCli(await window.agentteam.openAgent(agent.id, "cli"));
                setMode("cli");
              })
            }
          >
            CLI
          </button>
          <button
            onClick={() =>
              void p.act(async () => {
                const result = await window.agentteam.openAgent(
                  agent.id,
                  "native",
                );
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
                CLI sessions run in your own terminal. Take control first to
                keep the team scheduler from using this agent at the same time.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="messages scroll">
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
                    : `Talk to ${agent.name}`}
                </h1>
                <p>
                  {agent.kind === "team-assistant"
                    ? "Design your team, discuss a plan, and turn the work into clear steps. Your coordinator can see the agents, connections and workflows."
                    : agent.role ||
                      "Give this agent a task, ask a question, or explore an idea."}
                </p>
                <div className="suggestions">
                  {(agent.kind === "team-assistant"
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
            {messages.map((m) => (
              <article className={"message " + m.role} key={m.id}>
                <div className="message-label">
                  <span
                    className={
                      "avatar small " +
                      (m.role === "user" ? "user" : agent.environment)
                    }
                  >
                    {m.role === "user" ? "Y" : agent.name[0]}
                  </span>
                  <b>{m.role === "user" ? "You" : agent.name}</b>
                  <time>
                    {new Date(m.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <span className="badge">{m.status}</span>
                </div>
                <div className="message-text">{m.text}</div>
              </article>
            ))}
            {session?.state === "running" && (
              <div className="thinking">
                <span className="state-orbit processing" />
                {agent.name} is processing…
              </div>
            )}
            <div ref={end} />
          </div>
          <div className="composer-wrap">
            {!p.data.liveExecution && (
              <div className="notice">
                Execution is paused. Messages stay queued until you resume in
                Settings.
              </div>
            )}
            <div className="composer">
              <textarea
                aria-label="Message"
                placeholder={`Message ${agent.name}…`}
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
                  {agent.workspaces.length} folders · {agent.skills.length}{" "}
                  skills · Enter to send · Shift+Enter for newline
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
  const selected = p.data.agents.find((a) => a.id === p.selected);
  return (
    <div className="scroll section">
      <div className="section-title">
        <div>
          <span className="eyebrow">ORCHESTRATION</span>
          <h2>Workflows</h2>
        </div>
        <div className="row">
          <WolframSampleButton act={p.act} />
          <button title="New workflow" onClick={() => setCreating(!creating)}>
            <Plus size={16} />
            New
          </button>
        </div>
      </div>
      <div className="summary-grid">
        <div>
          <strong>
            {p.data.workflows.filter((w) => w.status === "running").length}
          </strong>
          <span>Running</span>
        </div>
        <div>
          <strong>
            {p.data.workflows.filter((w) => w.status === "queued").length}
          </strong>
          <span>Queued</span>
        </div>
        <div>
          <strong>
            {p.data.workflows.filter((w) => w.status === "completed").length}
          </strong>
          <span>Complete</span>
        </div>
      </div>
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
              });
              setCreating(false);
              setName("");
              setGoal("");
            });
          }}
        >
          <h3>Create workflow</h3>
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
            Create workflow
          </button>
        </form>
      )}
      {!p.data.workflows.length && !creating && (
        <div className="empty compact">
          <ListTodoIcon />
          <h3>Room for your next project</h3>
          <p>
            Create a workflow, add tasks, and watch the team move them forward.
          </p>
          <button onClick={() => setCreating(true)}>Create workflow</button>
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
          <p>{w.goal}</p>
          <SampleSetup workflow={w} act={p.act} />
          <WorkflowGateSummary tasks={w.tasks} />
          <WorkflowLimits workflowId={w.id} act={p.act} />
          <WorkflowRecovery workflowId={w.id} act={p.act} />
          <WorkflowSharedState workflowId={w.id} />
          <div className="progress">
            <span
              style={{
                width: `${w.tasks.length ? (100 * w.tasks.filter((t) => t.status === "completed").length) / w.tasks.length : 0}%`,
              }}
            />
          </div>
          <div className="row between quiet">
            <small>
              {w.tasks.filter((t) => t.status === "completed").length} /{" "}
              {w.tasks.length} tasks
            </small>
            <button
              className="icon"
              title={w.paused ? "Resume workflow" : "Pause workflow"}
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
              <TaskValidation
                task={t}
                liveExecution={p.data.liveExecution}
                act={p.act}
              />
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
                  });
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
                      {a.name}
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
                        {a.name}
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
                      {a.name}
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
export function Skills(p: PaneProps) {
  const [catalog, setCatalog] = useState<any>(null),
    [source, setSource] = useState("bundled"),
    [env, setEnv] = useState("codex"),
    [search, setSearch] = useState("");
  const refresh = () => api("/skills").then(setCatalog);
  useEffect(() => {
    void p.act(refresh);
  }, []);
  const entries = catalog?.[source]?.groups?.[env] ?? [],
    agent = p.data.agents.find((a) => a.id === p.selected);
  return (
    <div className="scroll section">
      <div className="section-title">
        <div>
          <span className="eyebrow">CAPABILITIES</span>
          <h2>Skills library</h2>
        </div>
        <button
          title="Rescan skills"
          onClick={() =>
            void p.act(async () => {
              await api("/skills/refresh", "POST");
              await refresh();
            })
          }
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="tabs">
        <button
          className={source === "bundled" ? "active" : ""}
          onClick={() => setSource("bundled")}
        >
          Recommended
        </button>
        <button
          className={source === "installed" ? "active" : ""}
          onClick={() => setSource("installed")}
        >
          Already installed
        </button>
      </div>
      <div className="row filters">
        <select
          aria-label="Skill environment"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        >
          {["codex", "claude", "wolfram", "unknown"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <input
          aria-label="Search library"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Language, database, framework…"
        />
      </div>
      <p className="hint">
        {source === "bundled"
          ? "Pinned starter skills with upstream attribution. Format compatibility is shown; provider execution is not benchmarked."
          : "Discovered from your existing harness directories. Original files are left in place."}
      </p>
      <div className="row">
        <span className="quiet">Add to</span>
        <AgentPicker {...p} />
      </div>
      <div className="skills-grid">
        {entries
          .filter((s: any) =>
            (s.name + " " + s.description)
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((s: any) => {
            const assigned = agent?.skills.some((x) => x.id === s.id);
            return (
              <article className="skill-tile" key={s.id}>
                <div className="row between">
                  <b>{s.name}</b>
                  <span className="badge">{s.compatibility}</span>
                </div>
                <p>{s.description}</p>
                <small>{s.harness}</small>
                <code>{s.path}</code>
                <button
                  disabled={
                    !agent || !s.environments.includes(agent.environment)
                  }
                  onClick={() =>
                    void p.act(() =>
                      api("/agents/" + agent!.id, "PUT", {
                        ...agentInput(agent!),
                        skills: assigned
                          ? agent!.skills.filter((x) => x.id !== s.id)
                          : [
                              ...agent!.skills,
                              {
                                id: s.id,
                                mode: "always",
                                allowUnverified: false,
                              },
                            ],
                      }),
                    )
                  }
                >
                  {assigned ? "Remove from agent" : "Add to agent"}
                </button>
              </article>
            );
          })}
      </div>
      {!entries.length && (
        <div className="empty">
          <p>No skills found for this environment.</p>
        </div>
      )}
    </div>
  );
}
export function Workspace(p: PaneProps) {
  const agent = p.data.agents.find((a) => a.id === p.selected),
    [root, setRoot] = useState(""),
    [path, setPath] = useState("."),
    [listing, setListing] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [git, setGit] = useState<any>(null),
    [tab, setTab] = useState("access"),
    [commit, setCommit] = useState(""),
    [tick, setTick] = useState(0),
    [context, setContext] = useState<{
      path: string;
      x: number;
      y: number;
    } | null>(null);
  useEffect(() => {
    setRoot(
      agent?.workspaces.find((w) => w.active)?.path ??
        agent?.workspaces[0]?.path ??
        "",
    );
    setPath(".");
    setPreview(null);
    setGit(null);
    setListing(null);
  }, [p.selected, agent?.workspaces.map((w) => w.path).join("|")]);
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
  if (!agent)
    return (
      <div className="empty">
        <p>Select an agent.</p>
      </div>
    );
  return (
    <div className="workspace pane-content">
      <div className="section workspace-top">
        <div className="section-title">
          <h2>Workspace</h2>
          <button title="Configure folders" onClick={() => p.edit(agent)}>
            <Plus size={16} />
            Folder
          </button>
        </div>
        <AgentPicker {...p} />
        {root && (
          <select
            aria-label="Workspace folder"
            value={root}
            onChange={(e) => {
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
        <div className="tabs">
          <button
            className={tab === "access" ? "active" : ""}
            onClick={() => setTab("access")}
          >
            Access
          </button>
          <button
            className={tab === "files" ? "active" : ""}
            onClick={() => setTab("files")}
          >
            Files
          </button>
          <button
            className={tab === "git" ? "active" : ""}
            disabled={!root}
            onClick={() => {
              setTab("git");
              void loadGit().catch(() => {});
            }}
          >
            Git
          </button>
          <button
            className={tab === "review" ? "active" : ""}
            disabled={!root}
            onClick={() => setTab("review")}
          >
            Review
          </button>
          <button
            className={tab === "preview" ? "active" : ""}
            disabled={!root}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
        </div>
      </div>
      {tab === "access" ? (
        <AccessView agent={agent} data={p.data} edit={() => p.edit(agent)} />
      ) : !root ? (
        <div className="empty">
          <FolderOpen size={34} />
          <h3>No folders attached</h3>
          <p>Choose a project directory for this agent.</p>
          <button onClick={() => p.edit(agent)}>Attach folder</button>
        </div>
      ) : (
        <div className="scroll section workspace-body">
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
              <div className="row between">
                <div className="row">
                  <button
                    className="icon"
                    title="Parent folder"
                    disabled={path === "."}
                    onClick={() => {
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
              </div>
              <div className="file-list">
                {listing?.entries.map((entry: any) => (
                  <button
                    key={entry.path}
                    onClick={() =>
                      void p.act(async () => {
                        if (entry.type === "directory") {
                          setPath(entry.path);
                          setPreview(null);
                        } else
                          setPreview({
                            path: entry.path,
                            name: entry.name,
                          });
                      })
                    }
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
                    {entry.type === "directory" && <ChevronRight size={14} />}
                  </button>
                ))}
              </div>
              <div className="row">
                <button onClick={() => void p.act(() => open("."))}>
                  Open project in editor
                </button>
                <button onClick={() => void p.act(() => open(path, "finder"))}>
                  Reveal folder
                </button>
                <OpenWith
                  agentId={agent.id}
                  workspace={root}
                  path={path}
                  project
                />
              </div>
              {preview && (
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
              )}
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
export function Preferences(p: PaneProps) {
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
      <span className="eyebrow">PREFERENCES</span>
      <h2>Make this workspace yours</h2>
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
      <section className="settings-card">
        <h3>Layout</h3>
        <p>
          Choose the content of either pane with its dropdown. Use the top-right
          buttons to hide navigation, swap panes or hide the right pane. Drag
          the divider to resize.
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
  const combined = [
    ...new Map([...history, ...events].map((e) => [e.seq, e])).values(),
  ].sort((a, b) => b.seq - a.seq);
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
                {data.agents.find(
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
    <div className="scroll section">
      <div className="access-heading">
        <span className="eyebrow">EXPLICIT FILE ACCESS</span>
        <h2>{agent.name}</h2>
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
            <b>{w.access === "write" ? "READ & WRITE" : "READ ONLY"}</b>
            {w.active && <span className="badge green">Working directory</span>}
          </div>
          <code className="full-path">{w.path}</code>
          <div className="access-actions">
            <span>✓ Browse all descendants</span>
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
              .map((a) => a.name)
              .join(", ") || "No other agents"}
          </small>
        </div>
      ))}
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
