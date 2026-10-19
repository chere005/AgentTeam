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

/** Same fence the backend extracts (src/assistant.ts PROPOSAL_FENCE / `extract`). */
export const PROPOSAL_FENCE = "agentteam-proposal";
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "proposal"; json: string; index: number };
/**
 * Splits a Team Assistant reply into prose and ```agentteam-proposal blocks (same regex as the
 * backend extract), so the chat can hide the raw JSON behind "Show JSON". Display only: the
 * proposal itself always comes from the backend's validated extract.
 */
export function splitProposalBlocks(text: string): MessagePart[] {
  const re = new RegExp(
    "```" + PROPOSAL_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)```",
    "g",
  );
  const parts: MessagePart[] = [];
  let last = 0,
    index = 0;
  for (const m of text.matchAll(re)) {
    const before = text.slice(last, m.index).replace(/\s+$/, "");
    if (before.trim()) parts.push({ kind: "text", text: before });
    parts.push({ kind: "proposal", json: m[1].trim(), index: index++ });
    last = m.index! + m[0].length;
  }
  const rest = text.slice(last).replace(/^\s+/, "");
  if (rest.trim() || !parts.length) parts.push({ kind: "text", text: rest });
  return parts;
}
export const hasProposalBlock = (text: string) =>
  text.includes("```" + PROPOSAL_FENCE);

/**
 * The messages a run is processing right now, from the session events (`session.started` carries
 * `messageIds`, or `messageId` from older backends; any end event closes it). Events arrive before
 * a refetched message list does, so the status label follows them instead of a possibly stale list.
 */
export function processingMessageIds(
  events: EventLike[],
  sessionId: string,
): string[] {
  let current: string[] = [];
  for (const e of events) {
    if (e.entityId !== sessionId) continue;
    if (e.type === "session.started")
      current = Array.isArray(e.data?.messageIds)
        ? e.data.messageIds.filter((x: unknown) => typeof x === "string")
        : typeof e.data?.messageId === "string"
          ? [e.data.messageId]
          : [];
    else if (END.has(e.type)) current = [];
  }
  return current;
}
/**
 * Status label for a chat message. The stored status can lag behind (the list is refetched after
 * events), so a user message the running provider call is working on reads "processing" even while
 * the fetched copy still says "queued"; one sent after the run started stays "queued" (it goes into
 * the next run). Without a start event in view (e.g. after a reload) the stored status is shown.
 */
export function messageStatusLabel(
  m: { id: string; role: string; status: string },
  processingIds: string[],
): string {
  if (m.role !== "user") return m.status;
  if (processingIds.includes(m.id) && m.status === "queued")
    return "processing";
  return m.status;
}
