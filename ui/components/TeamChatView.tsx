import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Users } from "lucide-react";
import type { Agent, Snapshot, TeamEvent } from "../api";
import { api } from "../api";
import { agentDisplayName, agentSelectorLabel } from "../agent-identity";
import { AgentAvatar } from "./AgentAvatar";
import { Chat } from "./Panes";
import { GroupChatPanel } from "./InvocationPanel";
import type { PaneProps } from "./Panes";
import "./team-chat.css";

type ChatSummary = {
  id: string;
  invocationId?: string;
  title: string;
  participantIds: string[];
  lastMessage: { text: string; createdAt: string } | null;
  humanParticipated: boolean;
};
type InvocationSummary = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  request: { title: string };
  createdAt: string;
};

function moveTreeFocus(event: KeyboardEvent<HTMLElement>) {
  const item = event.currentTarget;
  const rows = [
    ...(item
      .closest('[role="tree"]')
      ?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
  ];
  const index = rows.indexOf(item);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.max(
            0,
            Math.min(
              rows.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
  rows[next]?.focus();
}

export function TeamChatView({
  data,
  events,
  selected,
  setSelected,
  requestedGroupChatId,
  onGroupChatTargetHandled,
  paneProps,
}: {
  data: Snapshot;
  events: TeamEvent[];
  selected: string;
  setSelected: (id: string) => void;
  requestedGroupChatId?: string | null;
  onGroupChatTargetHandled?: () => void;
  paneProps: PaneProps;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [invocations, setInvocations] = useState<InvocationSummary[]>([]);
  const [groupChatId, setGroupChatId] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const allAgents = data.teamView?.allAgents ?? data.agents;
  const names = new Map(
    allAgents.map((agent) => [agent.id, agentDisplayName(agent)]),
  );
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void Promise.all([
        api(`/group-chats?teamId=${encodeURIComponent(data.activeTeamId)}`),
        api("/orchestration/invocations"),
      ])
        .then(([items, exchanges]: [ChatSummary[], InvocationSummary[]]) => {
          if (!alive) return;
          setChats(items);
          setInvocations(exchanges);
          setGroupChatId((current) =>
            current && items.some((chat) => chat.id === current) ? current : "",
          );
        })
        .catch(() => {});
    };
    void refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [data.activeTeamId]);
  useEffect(() => {
    if (!requestedGroupChatId) return;
    setGroupChatId(requestedGroupChatId);
    onGroupChatTargetHandled?.();
  }, [requestedGroupChatId]);
  useEffect(() => {
    if (!requestedGroupChatId) setGroupChatId("");
  }, [selected]);

  // Keep the navigation in the selected team context. An outside-team participant appears by
  // name in each shared chat, but unrelated agent roots stay out of this team's sidebar.
  const people = data.agents;
  const agentById = new Map(people.map((agent) => [agent.id, agent]));
  const reports = new Map<string, Agent[]>();
  for (const person of people) {
    if (person.parentId && agentById.has(person.parentId))
      reports.set(person.parentId, [
        ...(reports.get(person.parentId) ?? []),
        person,
      ]);
  }
  const roots = people.filter(
    (person) => !person.parentId || !agentById.has(person.parentId),
  );
  const chatsByAgent = new Map<string, ChatSummary[]>();
  for (const chat of chats) {
    for (const id of chat.participantIds) {
      if (!agentById.has(id)) continue;
      chatsByAgent.set(id, [...(chatsByAgent.get(id) ?? []), chat]);
    }
  }
  const unattachedChats = chats.filter(
    (chat) => !chat.participantIds.some((id) => agentById.has(id)),
  );
  const myChats = chats.filter((chat) => chat.humanParticipated);
  const activeGroup = chats.find((chat) => chat.id === groupChatId);
  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openAgent = (id: string) => {
    setGroupChatId("");
    setSelected(id);
  };
  const openGroup = (id: string, viewingAgentId?: string) => {
    const chat = chats.find((item) => item.id === id);
    const owner =
      viewingAgentId ??
      people.find((person) => chat?.participantIds.includes(person.id))?.id;
    if (owner) setSelected(owner);
    setGroupChatId(id);
  };
  const selectConversation = async (value: string, agentId: string) => {
    if (!value) {
      openAgent(agentId);
      return;
    }
    if (value.startsWith("invocation:")) {
      const invocationId = value.slice("invocation:".length);
      try {
        const chat = await api("/group-chats", "POST", { invocationId });
        setChats((current) =>
          current.some((item) => item.id === chat.id)
            ? current
            : [chat, ...current],
        );
        openGroup(chat.id, agentId);
      } catch (error) {
        console.error("Could not open agent conversation", error);
      }
      return;
    }
    openGroup(value, agentId);
  };

  const renderChatNode = (
    chat: ChatSummary,
    parentAgentId?: string,
    level = 2,
  ): ReactNode => {
    const participantNames = chat.participantIds
      .map((id) => names.get(id))
      .filter(Boolean)
      .join(", ");
    const primaryAgentId = people.find((person) =>
      chat.participantIds.includes(person.id),
    )?.id;
    const active = groupChatId === chat.id;
    return (
      <div
        key={`${parentAgentId ?? "unattached"}:${chat.id}`}
        role="treeitem"
        aria-label={`${chat.title}${participantNames ? ` — ${participantNames}` : ""}`}
        aria-level={level}
        aria-current={active ? "page" : undefined}
        tabIndex={active && parentAgentId === primaryAgentId ? 0 : -1}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openGroup(chat.id);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.currentTarget.parentElement
              ?.closest<HTMLElement>('[role="treeitem"]')
              ?.focus();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            moveTreeFocus(event);
          }
        }}
      >
        <div
          className={`team-chat-tree-row team-chat-side-chat${active ? " active" : ""}`}
          onClick={() => openGroup(chat.id, parentAgentId)}
        >
          <span className="team-chat-tree-spacer" />
          <span className="team-chat-avatar group-avatar">
            <Users size={14} />
          </span>
          <span className="team-chat-side-chat-text">
            <b title={chat.title}>{chat.title}</b>
            {participantNames && (
              <small title={participantNames}>{participantNames}</small>
            )}
          </span>
        </div>
      </div>
    );
  };

  const agentNode = (
    agent: Agent,
    level = 1,
    ancestry = new Set<string>(),
  ): ReactNode => {
    if (ancestry.has(agent.id)) return null;
    const nextAncestry = new Set(ancestry).add(agent.id);
    const sideChats = chatsByAgent.get(agent.id) ?? [];
    const children = reports.get(agent.id) ?? [];
    const expanded = !collapsed.has(agent.id);
    const active = !groupChatId && selected === agent.id;
    const displayName = agentDisplayName(agent);
    return (
      <div
        key={agent.id}
        role="treeitem"
        aria-label={agentSelectorLabel(agent)}
        aria-level={level}
        aria-expanded={
          sideChats.length || children.length ? expanded : undefined
        }
        aria-selected={active}
        tabIndex={active || (!selected && agent === people[0]) ? 0 : -1}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const item = event.currentTarget;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAgent(agent.id);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            if ((sideChats.length || children.length) && !expanded)
              toggle(agent.id);
            else
              item
                .querySelector<HTMLElement>(
                  '[role="group"] > [role="treeitem"]',
                )
                ?.focus();
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (sideChats.length && expanded) toggle(agent.id);
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
            moveTreeFocus(event);
          }
        }}
      >
        <div
          className={`team-chat-tree-row${active ? " active" : ""}`}
          onClick={() => openAgent(agent.id)}
        >
          {sideChats.length || children.length ? (
            <button
              className="team-chat-tree-toggle"
              tabIndex={-1}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${agentSelectorLabel(agent)}`}
              onClick={(event) => {
                event.stopPropagation();
                toggle(agent.id);
              }}
            >
              {expanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
          ) : (
            <span className="team-chat-tree-spacer" />
          )}
          <AgentAvatar
            name={agent.name}
            nickname={agent.nickname}
            avatar={agent.avatar}
            environment={agent.environment}
            className="team-chat-picker-avatar"
          />
          <span className="team-chat-tree-name" title={agent.name}>
            {displayName}
          </span>
        </div>
        {(sideChats.length > 0 || children.length > 0) && expanded && (
          <div role="group">
            {sideChats.map((chat) => renderChatNode(chat, agent.id, level + 1))}
            {children.map((child) => agentNode(child, level + 1, nextAncestry))}
          </div>
        )}
      </div>
    );
  };

  const conversationAgent = people.find((person) => person.id === selected);
  const agentConversations = conversationAgent
    ? (chatsByAgent.get(conversationAgent.id) ?? [])
    : [];
  const knownInvocationIds = new Set(
    agentConversations.map((chat) => chat.invocationId).filter(Boolean),
  );
  const unlistedInvocations = conversationAgent
    ? invocations
        .filter(
          (item) =>
            (item.fromAgentId === conversationAgent.id ||
              item.toAgentId === conversationAgent.id) &&
            !knownInvocationIds.has(item.id),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const conversationPicker = conversationAgent ? (
    <div className="team-chat-conversation-picker">
      <label>
        Conversation
        <select
          aria-label={`Conversation for ${agentDisplayName(conversationAgent)}`}
          value={groupChatId}
          onChange={(event) =>
            void selectConversation(event.target.value, conversationAgent.id)
          }
        >
          <option value="">
            Main chat · {agentDisplayName(conversationAgent)}
          </option>
          {agentConversations.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title}
            </option>
          ))}
          {unlistedInvocations.map((item) => (
            <option key={item.id} value={`invocation:${item.id}`}>
              {item.request.title} · open shared chat
            </option>
          ))}
        </select>
      </label>
      <small>
        Shared-chat replies appear as you and go to its participating agents.
      </small>
    </div>
  ) : null;

  return (
    <div className="team-chat-view">
      <nav className="team-chat-sidebar" aria-label="Team conversations">
        <div className="team-chat-sidebar-title">
          <b>{data.teamView?.team.name ?? "Team"}</b>
          <span>Chats</span>
        </div>
        <div className="team-chat-list-heading">
          <MessageSquare size={14} /> Your chats
        </div>
        <div
          className="team-chat-personal-chats"
          role="group"
          aria-label="Your chats"
        >
          {myChats.length ? (
            myChats.map((chat) => {
              const participantNames = chat.participantIds
                .map((id) => names.get(id))
                .filter(Boolean)
                .join(", ");
              return (
                <button
                  key={chat.id}
                  className={`team-chat-item group${groupChatId === chat.id ? " active" : ""}`}
                  onClick={() => openGroup(chat.id)}
                >
                  <span className="team-chat-avatar group-avatar">
                    <Users size={14} />
                  </span>
                  <span className="team-chat-item-text">
                    <b>{chat.title}</b>
                    <small>{participantNames}</small>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="team-chat-empty-hint">
              Group chats you join appear here.
            </div>
          )}
        </div>
        <div className="team-chat-sidebar-divider" />
        <div className="team-chat-list-heading">
          <Users size={14} /> Agents
        </div>
        <div role="tree" aria-label="Agent chats" className="team-chat-tree">
          {roots.map((agent) => agentNode(agent))}
        </div>
        {unattachedChats.length > 0 && (
          <>
            <div className="team-chat-list-heading">
              <MessageSquare size={14} /> Other conversations
            </div>
            {unattachedChats.map((chat) => {
              const participantNames = chat.participantIds
                .map((id) => names.get(id))
                .filter(Boolean)
                .join(", ");
              return (
                <button
                  key={chat.id}
                  className={`team-chat-item group${groupChatId === chat.id ? " active" : ""}`}
                  onClick={() => openGroup(chat.id)}
                >
                  <span className="team-chat-avatar group-avatar">
                    <Users size={14} />
                  </span>
                  <span className="team-chat-item-text">
                    <b>{chat.title}</b>
                    <small>{participantNames || "No team participants"}</small>
                  </span>
                </button>
              );
            })}
          </>
        )}
      </nav>
      <section className="team-chat-content" aria-label="Conversation">
        {conversationPicker}
        {activeGroup ? (
          <GroupChatPanel
            key={activeGroup.id}
            chatId={activeGroup.id}
            agents={allAgents}
            title={activeGroup.title}
          />
        ) : (
          <Chat {...paneProps} selected={selected} events={events} />
        )}
      </section>
    </div>
  );
}
