/** Pure conversation-workspace logic (no React/DOM): live streaming view, unread counts, scroll rules, focus bus. */
export type EventLike = {
  seq: number;
  type: string;
  entityId: string;
  data: any;
};
export type LiveTool = {
  id: string;
  title: string;
  kind: string;
  status: string;
};
export type Live = {
  /** A provider run for this conversation is in progress. */
  active: boolean;
  /** Text the provider has emitted so far (partial while active). */
  text: string;
  tools: LiveTool[];
  /** ACP emits text chunks; direct adapters emit whole messages. */
  chunked: boolean;
};
const END = new Set([
  "session.completed",
  "session.failed",
  "session.cancelled",
  "session.interrupted",
  "session.idle",
]);
export const LIVE_TEXT_CAP = 20_000;
export const LIVE_TOOL_CAP = 20;

/**
 * Folds the runtime events the backend already emits (`runtime.text`, `runtime.tool`, bracketed by
 * `session.started` and the end events) into the in-flight state of one conversation. Nothing is
 * invented: a provider that only reports finished messages shows them as they arrive.
 */
export function liveActivity(events: EventLike[], sessionId: string): Live {
  const live: Live = { active: false, text: "", tools: [], chunked: false };
  const tools = new Map<string, LiveTool>();
  for (const e of events) {
    if (e.entityId !== sessionId) continue;
    if (e.type === "session.started") {
      live.active = true;
      live.text = "";
      live.chunked = e.data?.transport === "acp";
      tools.clear();
    } else if (END.has(e.type)) {
      live.active = false;
    } else if (e.type === "runtime.text" && typeof e.data === "string") {
      live.active = true;
      live.text += (live.chunked || !live.text ? "" : "\n") + e.data;
      if (live.text.length > LIVE_TEXT_CAP)
        live.text = live.text.slice(live.text.length - LIVE_TEXT_CAP);
    } else if (
      e.type === "runtime.tool" &&
      e.data &&
      typeof e.data === "object"
    ) {
      const id = String(e.data.toolCallId ?? tools.size + 1);
      const prev = tools.get(id);
      tools.set(id, {
        id,
        title: String(e.data.title ?? prev?.title ?? "Tool call"),
        kind: String(e.data.kind ?? prev?.kind ?? "other"),
        status: String(e.data.status ?? prev?.status ?? "pending"),
      });
    }
  }
  live.tools = [...tools.values()].slice(-LIVE_TOOL_CAP);
  return live;
}

export type SummaryRow = { agentId: string; assistantCount: number };
/** Assistant replies not yet seen. An agent never seen before starts at zero (no flood on first run). */
export function unreadCounts(
  rows: SummaryRow[],
  seen: Record<string, number>,
  open?: string,
) {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const s = seen[r.agentId];
    out[r.agentId] =
      r.agentId === open || s === undefined
        ? 0
        : Math.max(0, r.assistantCount - s);
  }
  return out;
}
/** Seen counters after viewing `open` (and first sight of every other agent). */
export function markSeen(
  rows: SummaryRow[],
  seen: Record<string, number>,
  open?: string,
) {
  const next = { ...seen };
  for (const r of rows)
    if (r.agentId === open || next[r.agentId] === undefined)
      next[r.agentId] = r.assistantCount;
  return next;
}
/** Index in `messages` before which to draw the "new" divider, or -1. */
export function dividerIndex(messages: { role: string }[], unread: number) {
  if (unread <= 0) return -1;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "assistant" && ++seen === unread) return i;
  return -1;
}
export const STICK_PX = 80;
export const nearBottom = (el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}) => el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;

export type SavedScroll = { top: number; bottom: boolean };
export const unreadLabel = (n: number) => (n > 99 ? "99+" : String(n));

const FOCUS = "agentteam:focus-message";
let pending: { agentId: string; messageId: string } | null = null;
/** Ask the conversation pane to scroll to a message (from search, a task, an event or a review comment). */
export function focusMessage(agentId: string, messageId: string) {
  pending = { agentId, messageId };
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(FOCUS, { detail: pending }));
}
export function takePendingFocus(agentId: string) {
  if (pending?.agentId !== agentId) return null;
  const p = pending;
  pending = null;
  return p.messageId;
}
export const FOCUS_EVENT = FOCUS;
