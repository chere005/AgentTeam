import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Search, ArrowDown, Wrench } from "lucide-react";
import { api, persist, saved, type Agent, type TeamEvent } from "../api";
import {
  FOCUS_EVENT,
  focusMessage,
  liveActivity,
  markSeen,
  nearBottom,
  takePendingFocus,
  unreadCounts,
  type SavedScroll,
  type SummaryRow,
} from "../conversation";
import "./conversation.css";

/** Unread assistant replies per agent, from the backend summary and the last-seen counters. */
export function useUnread(events: TeamEvent[], open: string) {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>(() =>
    saved("seenReplies", {}),
  );
  const last = events.length ? events[events.length - 1].seq : 0;
  useEffect(() => {
    let alive = true;
    api("/conversations/summary")
      .then((r) => alive && setRows(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [last]);
  const openedFor = useRef("");
  const [atOpen, setAtOpen] = useState(0);
  useEffect(() => {
    if (!rows.length) return;
    // Replies that arrived while another conversation was open: shown as a divider on switch.
    if (openedFor.current !== open) {
      const row = rows.find((r) => r.agentId === open);
      if (row) {
        openedFor.current = open;
        const was = seen[open];
        setAtOpen(
          was === undefined ? 0 : Math.max(0, row.assistantCount - was),
        );
      }
    }
    setSeen((s) => {
      const next = markSeen(rows, s, open);
      if (JSON.stringify(next) === JSON.stringify(s)) return s;
      persist("seenReplies", next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, open]);
  return { counts: unreadCounts(rows, seen, open), rows, seen, atOpen };
}

/**
 * Per-agent scroll memory: restores where the user was, follows new output only while they are at
 * the bottom, and otherwise offers a "new messages" jump instead of yanking the view.
 */
export function useChatScroll(
  agentId: string,
  count: number,
  box: RefObject<HTMLDivElement | null>,
) {
  const [below, setBelow] = useState(0);
  const restored = useRef("");
  const stuck = useRef(true);
  const lastCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    restored.current = "";
    lastCount.current = 0;
    stuck.current = true;
    setBelow(0);
  }, [agentId]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !count) return;
    if (restored.current !== agentId) {
      restored.current = agentId;
      const s = saved<SavedScroll | null>("scroll." + agentId, null);
      const jump = takePendingFocus(agentId);
      if (jump) {
        stuck.current = false;
      } else if (s && !s.bottom) {
        el.scrollTop = s.top;
        stuck.current = false;
      } else el.scrollTop = el.scrollHeight;
      lastCount.current = count;
      return;
    }
    if (count > lastCount.current) {
      if (stuck.current)
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      else setBelow((n) => n + count - lastCount.current);
    }
    lastCount.current = count;
  }, [agentId, count, box]);
  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    stuck.current = nearBottom(el);
    if (stuck.current) setBelow(0);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () =>
        persist("scroll." + agentId, {
          top: el.scrollTop,
          bottom: stuck.current,
        } satisfies SavedScroll),
      150,
    );
  }, [agentId, box]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const toBottom = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stuck.current = true;
    setBelow(0);
  }, [box]);
  /** Scrolls a message into view and highlights it briefly (search results, task/event/review links). */
  const reveal = useCallback(
    (messageId: string) => {
      const el = box.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!el) return false;
      stuck.current = false;
      el.scrollIntoView({ block: "center" });
      el.classList.add("message-focus");
      setTimeout(() => el.classList.remove("message-focus"), 2500);
      return true;
    },
    [box],
  );
  useEffect(() => {
    const go = () => {
      const id = takePendingFocus(agentId);
      if (id) setTimeout(() => reveal(id), 0);
    };
    window.addEventListener(FOCUS_EVENT, go);
    // A focus that arrived with the conversation switch (before the messages loaded).
    if (count) go();
    return () => window.removeEventListener(FOCUS_EVENT, go);
  }, [agentId, count, reveal]);
  return { onScroll, below, toBottom, reveal };
}

export function NewBelow({ n, jump }: { n: number; jump: () => void }) {
  if (!n) return null;
  return (
    <button className="jump-new" data-testid="jump-new" onClick={jump}>
      <ArrowDown size={14} /> {n} new {n === 1 ? "message" : "messages"}
    </button>
  );
}
export function UnreadDivider({ n }: { n: number }) {
  return (
    <div
      className="unread-divider"
      data-testid="unread-divider"
      role="separator"
    >
      <span>
        {n} new {n === 1 ? "reply" : "replies"}
      </span>
    </div>
  );
}

/** Partial text and tool activity of the running provider call, from events the runtime already emits. */
export function LiveActivity({
  events,
  sessionId,
  name,
}: {
  events: TeamEvent[];
  sessionId: string;
  name: string;
}) {
  const live = liveActivity(events, sessionId);
  if (!live.active) return null;
  const latestTool = live.tools[live.tools.length - 1];
  return (
    <details
      className="live-activity"
      data-testid="live-activity"
      aria-live="polite"
    >
      <summary className="live-activity-summary">
        <span className="state-orbit processing" />
        <b>{name} is working</b>
        <span className="live-activity-current">
          {latestTool?.title ??
            (live.tools.length ? "Working" : "Waiting for response")}
        </span>
        {live.tools.length > 0 && (
          <span className="badge">
            {live.tools.length} tool{" "}
            {live.tools.length === 1 ? "step" : "steps"}
          </span>
        )}
      </summary>
      <div className="live-activity-details">
        {live.tools.length > 0 && (
          <ul className="live-tools" data-testid="live-tools">
            {live.tools.map((t) => (
              <li key={t.id} className={"tool-" + t.status}>
                <Wrench size={12} /> <span>{t.title}</span>
                <span className="badge">{t.status}</span>
              </li>
            ))}
          </ul>
        )}
        {live.text ? (
          <div className="message-text partial" data-testid="live-text">
            {live.text}
          </div>
        ) : (
          <div className="hint">Waiting for the provider’s first output…</div>
        )}
      </div>
    </details>
  );
}

export function RunProgress({
  name,
  startedAt,
  timeoutMs,
  now,
}: {
  name: string;
  startedAt?: string;
  timeoutMs?: number;
  now: number;
}) {
  const start = startedAt ? Date.parse(startedAt) : now;
  const elapsed = Math.max(0, now - (Number.isFinite(start) ? start : now));
  const budget = timeoutMs ?? 3_600_000;
  const remaining = Math.max(0, budget - elapsed);
  const percent = Math.min(100, Math.round((elapsed / budget) * 100));
  const duration = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours
      ? `${hours}h ${minutes}m`
      : minutes
        ? `${minutes}m ${seconds}s`
        : `${seconds}s`;
  };
  return (
    <div className="run-progress" role="status" data-testid="run-progress">
      <div className="run-progress-heading">
        <span className="state-orbit processing" />
        <b>{name} is working</b>
        <span className="run-progress-time">
          {duration(elapsed)} elapsed · up to {duration(remaining)} remaining
        </span>
      </div>
      <div
        className="run-progress-track"
        role="progressbar"
        aria-label="Provider time limit used; this does not indicate task completion"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        title="Shows time used from the provider limit, not work completion"
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

type OwnershipView = {
  holder: "team" | "embedded" | "cli" | "native";
  label: string;
  since: string;
  separateSession: boolean;
  warning: string | null;
  busy: boolean;
  can: Record<"embedded" | "cli" | "native", { ok: boolean; reason: string }>;
};
const HOLDER = {
  team: "Team (background tasks)",
  embedded: "You, in the embedded chat",
  cli: "Interactive CLI",
  native: "Native app",
} as const;

/** Explicit Take control / Return ownership for embedded chat, CLI, native app and background tasks. */
export function OwnershipBar({
  agent,
  events,
  act,
  quiet = false,
}: {
  agent: Agent;
  events: TeamEvent[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  /** Hide the bar while the team drives the agent as usual (no warning): nothing to decide. */
  quiet?: boolean;
}) {
  const [view, setView] = useState<OwnershipView | null>(null);
  const last = events.length ? events[events.length - 1].seq : 0;
  useEffect(() => {
    let alive = true;
    setView(null);
    api("/ownership/" + agent.id)
      .then((v) => alive && setView(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [agent.id, agent.control, last]);
  if (!view) return null;
  if (quiet && view.holder === "team" && !view.warning) return null;
  const take = (mode: "embedded" | "cli" | "native") =>
    void act(() => api("/ownership/" + agent.id + "/take", "POST", { mode }));
  return (
    <div className="ownership-bar" data-testid="ownership">
      <span>
        <span className="eyebrow">DRIVEN BY</span>{" "}
        <b data-testid="ownership-holder">{HOLDER[view.holder]}</b>
      </span>
      <span className="row">
        {view.holder === "team" ? (
          <button
            disabled={!view.can.embedded.ok}
            title={
              view.can.embedded.reason ||
              "Pause team tasks for this agent and drive it yourself"
            }
            onClick={() => take("embedded")}
          >
            Take control
          </button>
        ) : (
          <button
            onClick={() =>
              void act(() => api("/ownership/" + agent.id + "/return", "POST"))
            }
          >
            Return ownership
          </button>
        )}
      </span>
      {view.warning && (
        <div
          className="ownership-warning"
          role="status"
          data-testid="ownership-warning"
        >
          {view.warning}
        </div>
      )}
    </div>
  );
}
/** Takes ownership for `mode`, opens the external interface, and gives ownership back if opening fails. */
export async function takeThenOpen(agentId: string, mode: "cli" | "native") {
  await api("/ownership/" + agentId + "/take", "POST", { mode });
  try {
    return await window.agentteam.openAgent(agentId, mode);
  } catch (e) {
    await api("/ownership/" + agentId + "/return", "POST").catch(
      () => undefined,
    );
    throw e;
  }
}

type Hit = {
  messageId: string;
  agentId: string;
  agentName: string;
  role: string;
  createdAt: string;
  snippet: string;
};
export function ConversationSearch({
  agentId,
  openChat,
}: {
  agentId?: string;
  openChat?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState("");
  async function run() {
    setError("");
    if (q.trim().length < 2) {
      setError("Type at least 2 characters");
      return;
    }
    try {
      const r = await api("/conversations/search", "POST", {
        q: q.trim(),
        ...(all || !agentId ? {} : { agentId }),
      });
      setHits(r.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="conv-search" role="search">
      <div className="row">
        <input
          aria-label="Search messages"
          placeholder="Search messages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          all agents
        </label>
        <button onClick={() => void run()}>
          <Search size={14} /> Search
        </button>
      </div>
      {error && (
        <div role="alert" className="limit-error">
          {error}
        </div>
      )}
      {hits && !hits.length && <p className="hint">No matching messages.</p>}
      <ul className="hits" data-testid="search-hits">
        {hits?.map((h) => (
          <li key={h.messageId}>
            <button
              className="link"
              onClick={() => {
                focusMessage(h.agentId, h.messageId);
                openChat?.(h.agentId);
              }}
            >
              <b>{h.agentName}</b> · {h.role} ·{" "}
              {new Date(h.createdAt).toLocaleString()}
              <span className="snippet">{h.snippet}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Link from a task, event or review comment to the conversation point it relates to. */
export function ConversationLink({
  taskId,
  eventSeq,
  commentId,
  openChat,
  label = "Open conversation point",
}: {
  taskId?: string;
  eventSeq?: number;
  commentId?: string;
  openChat: (agentId: string) => void;
  label?: string;
}) {
  const [error, setError] = useState("");
  const query = taskId
    ? "taskId=" + encodeURIComponent(taskId)
    : commentId
      ? "commentId=" + encodeURIComponent(commentId)
      : "eventSeq=" + eventSeq;
  return (
    <>
      <button
        className="link"
        data-testid="conversation-link"
        onClick={async () => {
          setError("");
          try {
            const p = await api("/conversations/link?" + query);
            if (p.messageId) focusMessage(p.agentId, p.messageId);
            openChat(p.agentId);
            if (p.match === "none")
              setError("No messages yet in that conversation");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {label}
      </button>
      {error && <span className="hint"> {error}</span>}
    </>
  );
}
