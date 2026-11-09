/**
 * Where a chat's project setup card belongs (pure, import-free so node tests can load it).
 * Unfinished work ("active") sits after the newest messages, right under the reply that asks for
 * it; finished projects ("history") stay above the conversation; a preparation cancelled before
 * anything ran (every task cancelled) is not shown.
 */
export function setupCardPlacement(workflow: {
  tasks: { status: string }[];
}): "active" | "history" | null {
  const { tasks } = workflow;
  if (tasks.length && tasks.every((t) => t.status === "cancelled")) return null;
  return !tasks.length ||
    tasks.some((t) => !["completed", "cancelled"].includes(t.status))
    ? "active"
    : "history";
}
