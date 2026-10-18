/**
 * Explains an agent's max-concurrency limit: which running children currently occupy it and why
 * further invocations wait. Mirrors TeamService.capacity()/taskState(): only tasks invoked by the
 * agent count, and a queued task reports "invocation-limit" while the limit is full.
 */
export type InvocationTask = {
  id: string;
  title: string;
  agentId: string;
  invokedBy?: string;
  status: string;
};
export type InvocationSummary = {
  limit: number | null;
  running: { id: string; title: string; agentName: string }[];
  waiting: { id: string; title: string; agentName: string; reason: string }[];
  full: boolean;
  explanation: string;
};
export const waitReasonText: Record<string, string> = {
  "invocation-limit":
    "the invoking agent is at its concurrent invocation limit",
  dependencies: "it depends on unfinished tasks",
  "resource-busy": "shared files or folders are in use",
  "human-control": "the agent is under human control",
  "workflow-paused": "its workflow is paused",
  "validation-required": "a required validation has not passed",
};
export function invocationSummary(
  agentId: string,
  limit: number | null,
  tasks: InvocationTask[],
  agentNames: Record<string, string>,
  waitReasons: Record<string, string | null> = {},
): InvocationSummary {
  const mine = tasks.filter((t) => t.invokedBy === agentId);
  const name = (t: InvocationTask) => agentNames[t.agentId] ?? t.agentId;
  const running = mine
    .filter((t) => t.status === "running")
    .map((t) => ({ id: t.id, title: t.title, agentName: name(t) }));
  const full = limit !== null && running.length >= limit;
  const waiting = mine
    .filter((t) => t.status === "queued")
    .map((t) => ({
      id: t.id,
      title: t.title,
      agentName: name(t),
      reason: waitReasons[t.id] ?? (full ? "invocation-limit" : "scheduling"),
    }));
  const explanation =
    limit === null
      ? `No limit: all ${running.length} running children run in parallel.`
      : full
        ? waiting.length
          ? `${running.length} of ${limit} slots are in use by the running children below, so ${waiting.length} more invocation${waiting.length === 1 ? " waits" : "s wait"} until one finishes.`
          : `${running.length} of ${limit} slots are in use; the next invocation will wait until one finishes.`
        : `${running.length} of ${limit} slots in use.`;
  return { limit, running, waiting, full, explanation };
}
