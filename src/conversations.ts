import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Message,
  type Session,
  type Task,
} from "./model.ts";
import type { TeamService } from "./service.ts";

/**
 * Conversation workspace read model: per-agent unread summary, message search and links from a
 * task, event or review comment to the conversation point. Read-only.
 */
export const searchSchema = z
  .object({
    q: z.string().trim().min(2).max(200),
    agentId: z.string().optional(),
    role: z.enum(["user", "assistant"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export type ConversationPoint = {
  agentId: string;
  agentName: string;
  sessionId: string;
  messageId: string | null;
  /** Why this message: exact reference, or the nearest message in time. */
  match: "exact" | "nearest" | "none";
};

const snippet = (text: string, at: number, len: number) => {
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, at + len + 70);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end).replace(/\s+/g, " ") +
    (end < text.length ? "…" : "")
  );
};

export class Conversations {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  /** One row per agent: enough to compute unread markers client-side against the last seen message. */
  summary() {
    const messages = this.store.list<Message>("message");
    return this.store.list<Agent>("agent").map((a) => {
      const sessions = this.store
        .list<Session>("session")
        .filter((s) => s.agentId === a.id);
      const own = messages.filter((m) =>
        sessions.some((s) => s.id === m.sessionId),
      );
      const assistant = own.filter((m) => m.role === "assistant");
      const last = own[own.length - 1];
      return {
        agentId: a.id,
        sessionId: sessions[0]?.id ?? null,
        running: sessions.some((s) => s.state === "running"),
        messageCount: own.length,
        assistantCount: assistant.length,
        lastMessageId: last?.id ?? null,
        lastMessageAt: last?.createdAt ?? null,
        lastAssistantMessageId: assistant[assistant.length - 1]?.id ?? null,
        assistantMessageIds: assistant.slice(-100).map((m) => m.id),
      };
    });
  }
  search(input: unknown) {
    const q = searchSchema.parse(input);
    const needle = q.q.toLowerCase();
    const agents = new Map(
      this.store.list<Agent>("agent").map((a) => [a.id, a]),
    );
    const sessions = new Map(
      this.store.list<Session>("session").map((s) => [s.id, s]),
    );
    const hits: {
      messageId: string;
      sessionId: string;
      agentId: string;
      agentName: string;
      role: string;
      createdAt: string;
      snippet: string;
    }[] = [];
    for (const m of this.store.list<Message>("message").reverse()) {
      const session = sessions.get(m.sessionId);
      if (!session) continue;
      if (q.agentId && session.agentId !== q.agentId) continue;
      if (q.role && m.role !== q.role) continue;
      const at = m.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      hits.push({
        messageId: m.id,
        sessionId: m.sessionId,
        agentId: session.agentId,
        agentName: agents.get(session.agentId)?.name ?? session.agentId,
        role: m.role,
        createdAt: m.createdAt,
        snippet: snippet(m.text, at, needle.length),
      });
      if (hits.length >= q.limit) break;
    }
    return { query: q.q, hits, limit: q.limit };
  }
  private point(
    agentId: string,
    messageId: string | null,
    match: ConversationPoint["match"],
    sessionId?: string,
  ): ConversationPoint {
    const agent = this.store.get<Agent>("agent", agentId);
    const session =
      (sessionId && this.store.get<Session>("session", sessionId)) ||
      this.store.list<Session>("session").find((s) => s.agentId === agentId);
    return {
      agentId,
      agentName: agent.name,
      sessionId: session?.id ?? "",
      messageId: session ? messageId : null,
      match: session ? match : "none",
    };
  }
  private nearest(sessionId: string | undefined, at: string | undefined) {
    if (!sessionId || !at) return null;
    const when = Date.parse(at);
    const own = this.store
      .list<Message>("message")
      .filter((m) => m.sessionId === sessionId);
    if (!own.length) return null;
    return (
      own.find((m) => Date.parse(m.createdAt) >= when) ?? own[own.length - 1]
    ).id;
  }
  /** Resolves a task, event or review comment to the conversation point it relates to. */
  link(input: { taskId?: string; eventSeq?: string; commentId?: string }) {
    const given = [input.taskId, input.eventSeq, input.commentId].filter(
      Boolean,
    );
    assert(
      given.length === 1,
      "invalid_link",
      "Give exactly one of taskId, eventSeq or commentId",
      400,
    );
    if (input.commentId) {
      const c = this.store
        .list<{
          id: string;
          agentId: string;
          sessionId: string;
          messageId: string;
        }>("review-comment")
        .find((x) => x.id === input.commentId);
      if (!c) throw new AppError(404, "not_found", "Review comment not found");
      const exists = this.store
        .list<Message>("message")
        .some((m) => m.id === c.messageId);
      // The feedback went to the target agent's session, which is the conversation to open.
      const target = this.store.get<Session>("session", c.sessionId);
      return this.point(
        target.agentId,
        exists ? c.messageId : null,
        exists ? "exact" : "none",
        c.sessionId,
      );
    }
    if (input.taskId) {
      const task = this.store.get<Task>("task", input.taskId);
      const session = this.store
        .list<Session>("session")
        .find((s) => s.agentId === task.agentId);
      const id = this.nearest(session?.id, task.queuedAt);
      return this.point(task.agentId, id, id ? "nearest" : "none");
    }
    const seq = z.coerce.number().int().min(1).parse(input.eventSeq);
    const event = this.store.history(seq - 1, 1)[0];
    if (!event || event.seq !== seq)
      throw new AppError(404, "not_found", "Event not found");
    const data = (event.data ?? {}) as Record<string, unknown>;
    // Session events carry the session id as entity; message events name the message.
    let session: Session | undefined;
    try {
      session = this.store.get<Session>("session", event.entityId);
    } catch {}
    if (session) {
      const messageId =
        typeof data.messageId === "string" &&
        this.store.list<Message>("message").some((m) => m.id === data.messageId)
          ? (data.messageId as string)
          : null;
      const id = messageId ?? this.nearest(session.id, event.createdAt);
      return this.point(
        session.agentId,
        id,
        messageId ? "exact" : id ? "nearest" : "none",
        session.id,
      );
    }
    let agentId = typeof data.agentId === "string" ? data.agentId : null;
    if (!agentId) {
      try {
        agentId = this.store.get<Task>("task", event.entityId).agentId;
      } catch {}
    }
    if (!agentId)
      throw new AppError(
        404,
        "no_conversation",
        "This event is not linked to a conversation",
      );
    const s = this.store
      .list<Session>("session")
      .find((x) => x.agentId === agentId);
    const id = this.nearest(s?.id, event.createdAt);
    return this.point(agentId, id, id ? "nearest" : "none");
  }
}
