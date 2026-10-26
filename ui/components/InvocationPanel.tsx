import { useEffect, useState } from "react";
import type { Agent, Snapshot } from "../api";
import { api } from "../api";
import {
  invocationSummary,
  invocationTaskState,
  sandboxUnavailable,
  waitReasonText,
} from "../../src/invocation-view";
import { usePersistedDetails } from "./persisted-details";
import { MessageMarkdown } from "./Markdown";
import { AgentAvatar } from "./AgentAvatar";
import { agentDisplayName, agentSelectorLabel } from "../agent-identity";
import { explicitlyReportsNoWork } from "../../src/task-results";
import "./runtime-ui.css";

type InvocationRecord = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  request: { title: string; instructions?: string };
  createdAt: string;
};

type GroupChatState = {
  id: string;
  participantIds: string[];
  participants?: { agentId: string; state: string; queued: boolean }[];
  messages: {
    id: string;
    role: "human" | "agent";
    senderAgentId?: string;
    text: string;
    createdAt: string;
  }[];
};

function instructionPreview(text: string) {
  const preview = text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/[`*_#>-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return preview.length > 180 ? `${preview.slice(0, 177)}…` : preview;
}

export function GroupChatPanel({
  chatId,
  agents,
  title,
}: {
  chatId: string;
  agents: Agent[];
  title?: string;
}) {
  const [chat, setChat] = useState<GroupChatState | null>(null);
  const [draft, setDraft] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const names = Object.fromEntries(
    agents.map((a) => [a.id, agentDisplayName(a)]),
  );
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api(`/group-chats/${encodeURIComponent(chatId)}`)
        .then((value) => alive && setChat(value))
        .catch((e) => alive && setError(String(e)));
    void refresh();
    const timer = setInterval(refresh, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [chatId]);
  async function send() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/group-chats/${encodeURIComponent(chatId)}/messages`, "POST", {
        text: draft,
      });
      setDraft("");
      setChat(await api(`/group-chats/${encodeURIComponent(chatId)}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function addAgent() {
    if (!invite || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/group-chats/${encodeURIComponent(chatId)}/participants`,
        "POST",
        { agentId: invite },
      );
      setChat(result.chat);
      setInvite("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const available = agents.filter((a) => !chat?.participantIds.includes(a.id));
  return (
    <section className="group-chat" aria-label="Agent group chat">
      <div className="group-chat-heading">
        <b>{title ?? "Group chat"}</b>
        <span>
          {chat?.participants
            ?.map(
              (participant) =>
                `${names[participant.agentId] ?? "Agent"} · ${participant.state === "running" ? "working" : participant.queued ? "queued" : "idle"}`,
            )
            .join(" · ")}
        </span>
      </div>
      <div className="group-chat-messages" aria-live="polite">
        {chat?.messages.map((message) => (
          <article
            key={message.id}
            className={`group-chat-message ${message.role}`}
          >
            <div className="group-chat-message-head">
              {message.role === "human" ? (
                <span className="avatar small user">Y</span>
              ) : (
                (() => {
                  const sender = agents.find(
                    (a) => a.id === message.senderAgentId,
                  );
                  return sender ? (
                    <AgentAvatar
                      name={sender.name}
                      nickname={sender.nickname}
                      avatar={sender.avatar}
                      environment={sender.environment}
                      className={`avatar small ${sender.environment}`}
                    />
                  ) : null;
                })()
              )}
              <b>
                {message.role === "human"
                  ? "You"
                  : (names[message.senderAgentId ?? ""] ?? "Agent")}
              </b>
            </div>
            <div className="message-text">
              <MessageMarkdown
                text={message.text}
                collapsible={message.role !== "human"}
              />
            </div>
          </article>
        ))}
        {!chat?.messages.length && (
          <p className="quiet">
            Add a comment to start the shared conversation.
          </p>
        )}
      </div>
      <div className="row wrap group-chat-invite">
        <select
          aria-label="Invite agent to group chat"
          value={invite}
          onChange={(event) => setInvite(event.target.value)}
        >
          <option value="">Add an agent…</option>
          {available.map((a) => (
            <option key={a.id} value={a.id}>
              {agentSelectorLabel(a)}
            </option>
          ))}
        </select>
        <button
          className="secondary"
          disabled={!invite || busy}
          onClick={() => void addAgent()}
        >
          Invite
        </button>
      </div>
      <textarea
        aria-label="Group chat comment"
        placeholder="Add a comment for everyone…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        className="secondary"
        disabled={!draft.trim() || busy}
        onClick={() => void send()}
      >
        {busy ? "Sending…" : "Send to group"}
      </button>
      <small className="quiet">
        Comments go to every participant. Shared chat text is sent through each
        agent’s provider session; files are never attached automatically.
      </small>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function InvocationPanel({
  agent,
  limit,
  data,
  openRecovery,
}: {
  agent: Agent;
  limit: number | null;
  data: Snapshot;
  openRecovery?: () => void;
}) {
  const names = Object.fromEntries(
    data.agents.map((a) => [a.id, agentDisplayName(a)]),
  );
  const reasons: Record<string, string | null> = {};
  const tasks = data.workflows.flatMap((w) => w.tasks);
  for (const a of data.activity)
    for (const t of a.queuedTasks) reasons[t.id] = t.waitReason;
  const summary = invocationSummary(agent.id, limit, tasks, names, reasons);
  const [records, setRecords] = useState<InvocationRecord[]>([]);
  const related = records
    .filter(
      (record) =>
        record.fromAgentId === agent.id || record.toAgentId === agent.id,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active =
    summary.running.length > 0 ||
    summary.waiting.length > 0 ||
    related.length > 0 ||
    tasks.some((task) => task.agentId === agent.id);
  const [open, onToggle] = usePersistedDetails(
    agent.id,
    "conversations",
    active,
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = () =>
      api("/orchestration/invocations")
        .then((items) => {
          if (alive) setRecords(items);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);

  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const assigned = tasks
    .filter((task) => task.agentId === agent.id)
    .sort((a, b) => (b.queuedAt ?? "").localeCompare(a.queuedAt ?? ""));
  const represented = new Set(related.map((record) => record.id));
  const [groupChats, setGroupChats] = useState<Record<string, string>>({});
  async function openGroupChat(invocationId: string) {
    try {
      const chat = await api("/group-chats", "POST", { invocationId });
      setGroupChats((current) => ({ ...current, [invocationId]: chat.id }));
    } catch (error) {
      console.error("Could not open group chat", error);
    }
  }
  return (
    <details
      className="agent-section invocation-history"
      open={open}
      onToggle={onToggle}
    >
      <summary>
        <b>Team assignments &amp; conversations</b>
        <small>
          {related.length ? `${related.length} handoffs` : "No handoffs yet"}
        </small>
      </summary>
      <section
        className="invocation-panel"
        aria-label="Assigned work and conversations"
        data-testid="invocation-panel"
      >
        <h4>
          Invocation limit: {limit === null ? "Unlimited" : limit} · running{" "}
          {summary.running.length}
          {limit === null ? "" : " / " + limit}
        </h4>
        <span>{summary.explanation}</span>
        {summary.running.length > 0 && (
          <ul aria-label="Running children">
            {summary.running.map((t) => (
              <li key={t.id}>
                Running · {t.agentName}: {t.title}
              </li>
            ))}
          </ul>
        )}
        {summary.waiting.length > 0 && (
          <ul aria-label="Waiting invocations">
            {summary.waiting.map((t) => (
              <li key={t.id}>
                {t.reason === "dependency-failed" ? "Blocked" : "Waiting"} ·{" "}
                {t.agentName}: {t.title} (
                {t.detail ?? waitReasonText[t.reason] ?? t.reason})
              </li>
            ))}
          </ul>
        )}
        {related.map((record) => {
          const task = byTask.get(record.id);
          const state = task ? invocationTaskState(task, tasks, names) : null;
          const noWork =
            state?.status !== "blocked" &&
            explicitlyReportsNoWork(task?.result);
          const displayedStatus = noWork
            ? "failed"
            : (state?.status ?? "queued");
          return (
            <article
              className="invocation-exchange"
              key={record.id}
              data-task-id={record.id}
            >
              <b>
                {names[record.fromAgentId] ?? "Agent"} →{" "}
                {names[record.toAgentId] ?? "Teammate"}: {record.request.title}
              </b>
              <small className={`invocation-status ${displayedStatus}`}>
                {noWork ? "didn’t complete" : (state?.label ?? displayedStatus)}
              </small>
              {state?.detail && (
                <p className="notice invocation-waiting">{state.detail}</p>
              )}
              {state?.recovery && openRecovery && (
                <button className="secondary" onClick={openRecovery}>
                  Open Recovery
                </button>
              )}
              {task?.result && !sandboxUnavailable(task.result) && (
                <div className="invocation-result">
                  <b>
                    {noWork
                      ? "Agent says no work was done"
                      : task.status === "completed"
                        ? "Agent result"
                        : "Latest update"}
                  </b>
                  <MessageMarkdown text={task.result} collapsible />
                </div>
              )}
              {task?.status === "running" && !task.result && (
                <p className="quiet invocation-waiting">
                  Agent is running · waiting for its first result.
                </p>
              )}
              {task?.status === "completed" && !task.result && (
                <p className="quiet invocation-waiting">
                  Completed without a reported result.
                </p>
              )}
              {record.request.instructions && (
                <details
                  className="invocation-instructions"
                  data-testid="manager-instructions"
                >
                  <summary>
                    <b>Manager’s instructions</b>
                    <span>
                      {instructionPreview(record.request.instructions)}
                    </span>
                  </summary>
                  <MessageMarkdown
                    text={record.request.instructions}
                    collapsible
                  />
                </details>
              )}
              {groupChats[record.id] ? (
                <GroupChatPanel
                  chatId={groupChats[record.id]}
                  agents={data.teamView?.allAgents ?? data.agents}
                />
              ) : (
                <button
                  className="secondary"
                  onClick={() => void openGroupChat(record.id)}
                >
                  Open group chat
                </button>
              )}
            </article>
          );
        })}
        {assigned
          .filter((task) => !represented.has(task.id))
          .map((task) => {
            const state = invocationTaskState(task, tasks, names);
            const noWork =
              state.status !== "blocked" &&
              explicitlyReportsNoWork(task.result);
            const displayedStatus = noWork ? "failed" : state.status;
            return (
              <article
                className="invocation-exchange"
                key={task.id}
                data-task-id={task.id}
              >
                <b>
                  {task.invokedBy
                    ? `${names[task.invokedBy] ?? "Teammate"} → ${agentDisplayName(agent)}`
                    : "Assigned work"}
                  : {task.title}
                </b>
                <small className={`invocation-status ${displayedStatus}`}>
                  {noWork ? "didn’t complete" : state.label}
                </small>
                {state.detail && (
                  <p className="notice invocation-waiting">{state.detail}</p>
                )}
                {state.recovery && openRecovery && (
                  <button className="secondary" onClick={openRecovery}>
                    Open Recovery
                  </button>
                )}
                {task.result && !sandboxUnavailable(task.result) && (
                  <div className="invocation-result">
                    <b>
                      {noWork
                        ? "Agent says no work was done"
                        : task.status === "completed"
                          ? "Agent result"
                          : "Latest update"}
                    </b>
                    <MessageMarkdown text={task.result} collapsible />
                  </div>
                )}
                {task.instructions && (
                  <details className="invocation-instructions">
                    <summary>
                      <b>Instructions</b>
                      <span>{instructionPreview(task.instructions)}</span>
                    </summary>
                    <MessageMarkdown text={task.instructions} collapsible />
                  </details>
                )}
              </article>
            );
          })}
        {!assigned.length && !related.length && (
          <p className="quiet">
            No team work has been assigned to this agent yet.
          </p>
        )}
        <small className="quiet">
          Requests, status and teammate results appear here. Native provider
          subagents remain outside AgentTeam's task tracking.
        </small>
      </section>
    </details>
  );
}
