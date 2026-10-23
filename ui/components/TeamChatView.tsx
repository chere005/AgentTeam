import { useEffect, useState } from "react";
import { MessageSquare, Users } from "lucide-react";
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
        {data.agents.map((agent) => (
          <button
            key={agent.id}
            className={`team-chat-item${!groupChatId && selected === agent.id ? " active" : ""}`}
            onClick={() => {
              setGroupChatId("");
              setSelected(agent.id);
            }}
          >
            <span className="team-chat-avatar">{agent.name.slice(0, 1)}</span>
            <span>{agent.name}</span>
          </button>
        ))}
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
