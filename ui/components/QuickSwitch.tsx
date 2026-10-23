import { useEffect, useMemo, useRef, useState } from "react";
import { File, MessageSquare, Search, X } from "lucide-react";
import type { Snapshot } from "../api";
import { api } from "../api";
import { agentDisplayName } from "../agent-identity";
import "./quick-switch.css";

type FileResult = {
  path: string;
  name: string;
  workspace: string;
  agentId: string;
};
type ChatResult = {
  kind: "agent" | "group";
  id: string;
  agentId: string;
  title: string;
  detail: string;
  searchText: string;
};
type Result =
  | {
      kind: "file";
      id: string;
      title: string;
      detail: string;
      file: FileResult;
    }
  | {
      kind: "chat";
      id: string;
      title: string;
      detail: string;
      chat: ChatResult;
    };
type GroupChat = {
  id: string;
  workflowId?: string;
  title: string;
  participantIds: string[];
  lastMessage: { text: string } | null;
};

const score = (query: string, value: string) => {
  const text = value.toLowerCase();
  let total = 0;
  for (const term of query.toLowerCase().trim().split(/\s+/).filter(Boolean)) {
    let at = 0,
      gaps = 0,
      previous = -2;
    for (const char of term) {
      const next = text.indexOf(char, at);
      if (next < 0) return 0;
      if (previous >= 0) gaps += next - previous - 1;
      previous = next;
      at = next + 1;
    }
    total += Math.max(1, 100 - gaps - (text.includes(term) ? 0 : at));
  }
  return total;
};
const clip = (text: string, max = 110) =>
  text.replace(/\s+/g, " ").trim().slice(0, max);

export function QuickSwitch({
  data,
  currentProject,
  close,
  openFile,
  openAgentChat,
  openGroupChat,
}: {
  data: Snapshot;
  currentProject: Snapshot["workflows"][number] | null;
  close: () => void;
  openFile: (file: FileResult) => void;
  openAgentChat: (agentId: string) => void;
  openGroupChat: (chatId: string, agentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileResult[]>([]);
  const [chats, setChats] = useState<ChatResult[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let alive = true;
    const sessions = data.sessions.filter((s) =>
      data.agents.some((agent) => agent.id === s.agentId),
    );
    const names = new Map(
      data.agents.map((agent) => [agent.id, agentDisplayName(agent)]),
    );
    const canonicalNames = new Map(
      data.agents.map((agent) => [agent.id, agent.name]),
    );
    void Promise.all([
      api(`/group-chats?teamId=${encodeURIComponent(data.activeTeamId)}`)
        .then((items: GroupChat[]) =>
          items
            .filter(
              (chat) =>
                !currentProject || chat.workflowId === currentProject.id,
            )
            .map((chat) => ({
              kind: "group" as const,
              id: chat.id,
              agentId: chat.participantIds[0] ?? "",
              title: chat.title,
              detail: chat.participantIds
                .map((id) => names.get(id) ?? "Agent")
                .join(", "),
              searchText: `${chat.title} ${chat.lastMessage?.text ?? ""} ${chat.participantIds.map((id) => `${names.get(id) ?? ""} ${canonicalNames.get(id) ?? ""}`).join(" ")}`,
            })),
        )
        .catch(() => [] as ChatResult[]),
      ...sessions.slice(0, 60).map(async (session) => {
        try {
          const messages: {
            role: string;
            text: string;
            groupChatId?: string;
          }[] = await api(`/sessions/${session.id}/messages`);
          const plain = messages.filter((message) => !message.groupChatId);
          const latest = [...plain]
            .reverse()
            .find((message) => message.role === "user");
          const agentName = names.get(session.agentId) ?? "Agent";
          const title = clip(latest?.text ?? "") || agentName;
          return {
            kind: "agent" as const,
            id: session.id,
            agentId: session.agentId,
            title,
            detail: agentName,
            searchText: `${agentName} ${canonicalNames.get(session.agentId) ?? ""} ${plain.map((message) => message.text).join(" ")}`,
          };
        } catch {
          return null;
        }
      }),
    ]).then(([groups, ...sessionsFound]) => {
      if (!alive) return;
      setChats([
        ...(groups as ChatResult[]),
        ...(sessionsFound.filter(Boolean) as ChatResult[]),
      ]);
    });
    return () => {
      alive = false;
    };
  }, [data.activeTeamId, data.agents, data.sessions, currentProject?.id]);

  const { scope, term } = useMemo(() => {
    const match = query.trim().match(/^(files?|f|chats?|c):\s*(.*)$/i);
    if (!match) return { scope: "all", term: query.trim() };
    return {
      scope: /^f/i.test(match[1]) ? "files" : "chats",
      term: match[2].trim(),
    };
  }, [query]);

  useEffect(() => {
    if (!term || scope === "chats") {
      setFiles([]);
      setLoadingFiles(false);
      return;
    }
    const projectAgentIds = currentProject
      ? new Set([
          ...(currentProject.tasks ?? []).map((task) => task.agentId),
          currentProject.ownerId,
        ])
      : null;
    const candidates = data.agents
      .filter((agent) => !projectAgentIds || projectAgentIds.has(agent.id))
      .flatMap((agent) =>
        agent.workspaces
          .filter(
            (workspace) =>
              !currentProject?.setup?.workspace ||
              workspace.path === currentProject.setup.workspace,
          )
          .map((workspace) => ({
            agentId: agent.id,
            workspace: workspace.path,
          })),
      );
    const unique = [
      ...new Map(candidates.map((item) => [item.workspace, item])).values(),
    ];
    let alive = true;
    const timer = window.setTimeout(() => {
      setLoadingFiles(true);
      void Promise.all(
        unique.slice(0, 24).map(async ({ agentId, workspace }) => {
          try {
            const items: Omit<FileResult, "agentId">[] = await api(
              `/agents/${agentId}/files/search`,
              "POST",
              { workspace, query: term },
            );
            return items.map((item) => ({ ...item, agentId }));
          } catch {
            return [] as FileResult[];
          }
        }),
      ).then((results) => {
        if (!alive) return;
        setFiles(results.flat());
        setLoadingFiles(false);
      });
    }, 130);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [term, scope, currentProject?.id, data.agents]);

  const results = useMemo(() => {
    const matches: { result: Result; score: number }[] = [];
    if (scope !== "chats" && term) {
      for (const file of files) {
        const value = score(term, file.path);
        if (value)
          matches.push({
            result: {
              kind: "file",
              id: `${file.workspace}:${file.path}`,
              title: file.name,
              detail: file.path,
              file,
            },
            score: value + 5,
          });
      }
    }
    if (scope !== "files") {
      for (const chat of chats) {
        const value = term ? score(term, chat.searchText) : 0;
        if (!term || value)
          matches.push({
            result: {
              kind: "chat",
              id: `${chat.kind}:${chat.id}`,
              title: chat.title,
              detail: chat.detail,
              chat,
            },
            score: value,
          });
      }
    }
    return matches
      .sort(
        (a, b) =>
          b.score - a.score || a.result.title.localeCompare(b.result.title),
      )
      .slice(0, 80)
      .map(({ result }) => result);
  }, [scope, term, files, chats]);

  useEffect(() => setCursor(0), [query, results.length]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const choose = (result: Result) => {
    close();
    if (result.kind === "file") openFile(result.file);
    else if (result.chat.kind === "group")
      openGroupChat(result.chat.id, result.chat.agentId);
    else openAgentChat(result.chat.agentId);
  };
  const mod = /Mac/i.test(navigator.platform) ? "⌘P" : "Ctrl+P";

  return (
    <div
      className="quick-switch-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        className="quick-switch"
        role="dialog"
        aria-modal="true"
        aria-label="Quick search"
      >
        <div className="quick-switch-search">
          <Search size={17} />
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-label="Search files and chats"
            aria-expanded="true"
            aria-controls="quick-switch-results"
            placeholder="Search files and chats…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (results.length)
                  setCursor(
                    (at) =>
                      (at +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        results.length) %
                      results.length,
                  );
              } else if (event.key === "Enter" && results[cursor]) {
                event.preventDefault();
                choose(results[cursor]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <kbd>{mod}</kbd>
          <button
            className="icon"
            aria-label="Close quick search"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <div className="quick-switch-filters">
          {currentProject ? (
            <>
              Project: <b>{currentProject.name}</b> ·{" "}
            </>
          ) : (
            <>
              Team: <b>{data.teamView?.team.name ?? "current team"}</b> ·{" "}
            </>
          )}
          Search files and chats · <code>files:</code> / <code>f:</code> ·{" "}
          <code>chats:</code> / <code>c:</code>
        </div>
        <ul
          id="quick-switch-results"
          ref={list}
          role="listbox"
          aria-label="Files and chats"
          className="quick-switch-results"
        >
          {results.map((result, index) => (
            <li key={result.id} role="presentation">
              <button
                data-index={index}
                role="option"
                aria-selected={cursor === index}
                className={cursor === index ? "active" : ""}
                onMouseMove={() => setCursor(index)}
                onClick={() => choose(result)}
              >
                {result.kind === "file" ? (
                  <File size={16} />
                ) : (
                  <MessageSquare size={16} />
                )}
                <span>
                  <b>{result.title}</b>
                  <small>{result.detail}</small>
                </span>
                <em>
                  {result.kind === "file"
                    ? "File"
                    : result.chat.kind === "group"
                      ? "Group chat"
                      : "Chat"}
                </em>
              </button>
            </li>
          ))}
          {!results.length && (
            <li className="quick-switch-empty">
              {loadingFiles
                ? "Searching project files…"
                : term
                  ? "No matching files or chats."
                  : "Start typing to search files and chats."}
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
