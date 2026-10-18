import type { Task } from "./model.ts";
import type { TeamService } from "./service.ts";

/**
 * Read model over the `run.context` events: the approximate instruction-context cost of each
 * recent run of one agent (role, always-loaded instructions, skills, cited knowledge). Counts
 * only; never skill or knowledge text. Same approximation as the event (characters / 4).
 */
export type ContextCostRun = {
  seq: number;
  at: string;
  /** Task title, or "Conversation" for a chat run. */
  label: string;
  kind: "task" | "conversation";
  total: number;
  role: number;
  instructions: number;
  skills: number;
  knowledge: number;
  skillsLoaded: number;
  /** Skills only listed (on demand, not matched by the request). */
  skillsListed: number;
};
export type ContextCost = {
  agentId: string;
  /** Oldest first, at most `limit` runs. */
  runs: ContextCostRun[];
  summary: { count: number; latest: number; average: number; max: number };
  note: string;
};

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

export function contextCost(
  service: TeamService,
  agentId: string,
  limit = 30,
): ContextCost {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = service.store.db
    .prepare(
      "SELECT seq, entity_id, data, created_at FROM events WHERE type='run.context' AND json_extract(data,'$.agentId')=? ORDER BY seq DESC LIMIT ?",
    )
    .all(agentId, n);
  const runs: ContextCostRun[] = rows
    .map((row) => {
      const data = JSON.parse(String(row.data)) as {
        approxTokens?: Record<string, unknown>;
        skills?: { state?: string; loaded?: boolean }[];
      };
      const t = data.approxTokens ?? {};
      let task: Task | null = null;
      try {
        task = service.store.get<Task>("task", String(row.entity_id));
      } catch {
        /* a conversation run (session id) or a removed task */
      }
      const skills = Array.isArray(data.skills) ? data.skills : [];
      return {
        seq: Number(row.seq),
        at: String(row.created_at),
        label: task ? task.title.slice(0, 120) : "Conversation",
        kind: task ? ("task" as const) : ("conversation" as const),
        total: num(t.total),
        role: num(t.role),
        instructions: num(t.instructions),
        skills: num(t.skills),
        knowledge: num(t.knowledge),
        skillsLoaded: skills.filter((s) => s.state === "loaded").length,
        skillsListed: skills.filter((s) => s.state === "listed").length,
      };
    })
    .reverse();
  const totals = runs.map((r) => r.total);
  return {
    agentId,
    runs,
    summary: {
      count: runs.length,
      latest: totals.at(-1) ?? 0,
      average: totals.length
        ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
        : 0,
      max: Math.max(0, ...totals),
    },
    note: "Approximate: characters / 4, instruction text only (the request and tool output are not counted).",
  };
}
