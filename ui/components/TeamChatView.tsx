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
  title: string;
  participantIds: string[];
  lastMessage: { text: string; createdAt: string } | null;
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
  const [groupChatId, setGroupChatId] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const allAgents = data.teamView?.allAgents ?? data.agents;
  const names = new Map(
    allAgents.map((agent) => [agent.id, agentDisplayName(agent)]),
  );
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api(`/group-chats?teamId=${encodeURIComponent(data.activeTeamId)}`)
        .then((items: ChatSummary[]) => {
          if (alive) {
            setChats(items);
            setGroupChatId((current) =>
              current && items.some((chat) => chat.id === current)
                ? current
                : "",
            );
          }
        })
        .catch(() => {});
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
  const openGroup = (id: string) => setGroupChatId(id);

  const renderChatNode = (
    chat: ChatSummary,
    parentAgentId?: string,
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
        aria-level={parentAgentId ? 2 : 1}
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
          onClick={() => openGroup(chat.id)}
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

  const agentNode = (agent: Agent): ReactNode => {
    const sideChats = chatsByAgent.get(agent.id) ?? [];
    const expanded = !collapsed.has(agent.id);
    const active = !groupChatId && selected === agent.id;
    const displayName = agentDisplayName(agent);
    return (
      <div
        key={agent.id}
        role="treeitem"
        aria-label={agentSelectorLabel(agent)}
        aria-level={1}
        aria-expanded={sideChats.length ? expanded : undefined}
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
            if (sideChats.length && !expanded) toggle(agent.id);
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
          {sideChats.length ? (
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
        {sideChats.length > 0 && expanded && (
          <div role="group">
            {sideChats.map((chat) => renderChatNode(chat, agent.id))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="team-chat-view">
      <nav className="team-chat-sidebar" aria-label="Team conversations">
        <div className="team-chat-sidebar-title">
          <b>{data.teamView?.team.name ?? "Team"}</b>
          <span>Chats</span>
        </div>
        <div className="team-chat-list-heading">
          <Users size={14} /> People
        </div>
        <div role="tree" aria-label="Agent chats" className="team-chat-tree">
          {people.map((agent) => agentNode(agent))}
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
