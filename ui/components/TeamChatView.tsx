import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, Users } from "lucide-react";
import { chatTree, type ChatTreeNode } from "../chat-tree";
import type { Agent, Snapshot, TeamEvent } from "../api";
import { api } from "../api";
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
  const agents = data.teamView?.allAgents ?? data.agents;
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
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
  const agentNode = (
    { agent, children }: ChatTreeNode,
    depth = 1,
  ): React.ReactNode => {
    const expanded = !collapsed.has(agent.id);
    const active = !groupChatId && selected === agent.id;
    return (
      <div
        key={agent.id}
        role="treeitem"
        aria-label={agent.name}
        aria-level={depth}
        aria-expanded={children.length ? expanded : undefined}
        aria-selected={active}
        tabIndex={active || (!selected && depth === 1) ? 0 : -1}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const item = event.currentTarget;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAgent(agent.id);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            if (children.length && !expanded) toggle(agent.id);
            else
              item
                .querySelector<HTMLElement>(
                  '[role="group"] > [role="treeitem"]',
                )
                ?.focus();
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (children.length && expanded) toggle(agent.id);
            else
              item.parentElement
                ?.closest<HTMLElement>('[role="treeitem"]')
                ?.focus();
          } else if (
            ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          ) {
            event.preventDefault();
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
        }}
      >
        <div
          className={`team-chat-tree-row${active ? " active" : ""}`}
          style={{ paddingLeft: 8 + (depth - 1) * 18 }}
          onClick={() => openAgent(agent.id)}
        >
          {children.length ? (
            <button
              className="team-chat-tree-toggle"
              tabIndex={-1}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${agent.name}`}
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
          <span className="team-chat-picker-avatar" aria-hidden="true">
            {agent.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="team-chat-tree-name" title={agent.name}>
            {agent.name}
          </span>
        </div>
        {children.length > 0 && expanded && (
          <div role="group">
            {children.map((child) => agentNode(child, depth + 1))}
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
          <Users size={14} /> Agents
        </div>
        <div role="tree" aria-label="Agent chats" className="team-chat-tree">
          {chatTree(data.agents).map((node) => agentNode(node))}
        </div>
        <div className="team-chat-list-heading">
          <MessageSquare size={14} /> Agent conversations
        </div>
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`team-chat-item group${groupChatId === chat.id ? " active" : ""}`}
            onClick={() => setGroupChatId(chat.id)}
          >
            <span className="team-chat-avatar group-avatar">
              <Users size={14} />
            </span>
            <span className="team-chat-item-text">
              <b>{chat.title}</b>
              <small>
                {chat.participantIds
                  .map((id) => names.get(id) ?? "Agent")
                  .join(", ")}
              </small>
            </span>
          </button>
        ))}
        {!chats.length && (
          <p className="team-chat-empty-hint">
            Open a handoff in an agent’s chat to start a shared conversation.
          </p>
        )}
      </nav>
      <section className="team-chat-content" aria-label="Conversation">
        {activeGroup ? (
          <GroupChatPanel
            key={activeGroup.id}
            chatId={activeGroup.id}
            agents={agents as Agent[]}
            title={activeGroup.title}
          />
        ) : (
          <Chat {...paneProps} selected={selected} events={events} />
        )}
      </section>
    </div>
  );
}
