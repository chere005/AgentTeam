/**
 * Pure attention-inbox derivation. Inputs are the existing snapshot plus the optional
 * `/approvals`, `/recovery` and per-workflow limit-trip responses; nothing here calls the API.
 * Items are ordered by urgency (approvals first) and then by title so the list is stable.
 */
/** Structural subset of the UI Snapshot (kept import-free so node tests can load this file). */
type SnapshotLike = {
  agents: { id: string; name: string }[];
  edges: { from: string; to: string; kind: string; enabled: boolean }[];
  workflows: {
    id: string;
    name: string;
    paused: boolean;
    tasks: { id: string; title: string; status: string; agentId: string }[];
  }[];
  activity: {
    agentId: string;
    queuedTasks: { id: string; waitReason: string | null }[];
  }[];
};

export type InboxKind =
  | "approval"
  | "failed"
  | "interrupted"
  | "blocked"
  | "limit"
  | "validation"
  | "paused"
  | "review";
/** Where an item links to; mapped to a pane id by the UI. */
export type InboxTarget = "workflows" | "workspace" | "chat" | "team";
export type InboxItem = {
  id: string;
  kind: InboxKind;
  title: string;
  detail: string;
  agentId?: string;
  workflowId?: string;
  target: InboxTarget;
};
export type InboxInput = {
  data: SnapshotLike;
  approvals?: {
    id: string;
    agentId?: string;
    request?: { toolCall?: { title?: string } };
  }[];
  recovery?: {
    task: { id: string };
    uncertainEffects?: { id: string; description: string }[];
  }[];
  /** Limit-trip reasons keyed by workflow id (only paused workflows are worth asking). */
  trips?: Record<string, { reason: string } | null | undefined>;
  dismissed?: ReadonlySet<string> | readonly string[];
};
export const kindLabel: Record<InboxKind, string> = {
  approval: "Awaiting approval",
  failed: "Failed task",
  interrupted: "Interrupted task",
  blocked: "Blocked task",
  limit: "Limit reached",
  validation: "Validation required",
  paused: "Workflow paused",
  review: "Ready for review",
};
const order: InboxKind[] = [
  "approval",
  "blocked",
  "limit",
  "failed",
  "interrupted",
  "validation",
  "review",
  "paused",
];
export function buildInbox(input: InboxInput): InboxItem[] {
  const { data } = input;
  const items: InboxItem[] = [];
  const agentName = (id?: string) =>
    data.agents.find((a) => a.id === id)?.name ?? "An agent";
  const taskIndex = new Map<string, { title: string; workflowId: string }>();
  for (const w of data.workflows)
    for (const t of w.tasks)
      taskIndex.set(t.id, { title: t.title, workflowId: w.id });
  for (const a of input.approvals ?? [])
    items.push({
      id: "approval:" + a.id,
      kind: "approval",
      title: `${agentName(a.agentId)} needs permission`,
      detail: a.request?.toolCall?.title ?? "Tool action awaiting a decision",
      agentId: a.agentId,
      target: "workflows",
    });
  const uncertain = new Map<string, string[]>();
  for (const r of input.recovery ?? [])
    if (r.uncertainEffects?.length)
      uncertain.set(
        r.task.id,
        r.uncertainEffects.map((e) => e.description),
      );
  const readyReview = new Set<string>();
  for (const w of data.workflows) {
    const paused = w.paused;
    const trip = input.trips?.[w.id];
    if (trip)
      items.push({
        id: "limit:" + w.id,
        kind: "limit",
        title: `${w.name} stopped by a limit`,
        detail: trip.reason,
        workflowId: w.id,
        target: "workflows",
      });
    else if (paused)
      items.push({
        id: "paused:" + w.id,
        kind: "paused",
        title: `${w.name} is paused`,
        detail: "Resume it from Workflows to continue scheduling.",
        workflowId: w.id,
        target: "workflows",
      });
    for (const t of w.tasks) {
      const who = agentName(t.agentId);
      if (t.status === "failed")
        items.push({
          id: "failed:" + t.id,
          kind: "failed",
          title: `${t.title} failed`,
          detail: `${who} in ${w.name}`,
          agentId: t.agentId,
          workflowId: w.id,
          target: "workflows",
        });
      else if (t.status === "interrupted")
        items.push({
          id: "interrupted:" + t.id,
          kind: "interrupted",
          title: `${t.title} was interrupted`,
          detail: `${who} in ${w.name}; resume from its checkpoint.`,
          agentId: t.agentId,
          workflowId: w.id,
          target: "workflows",
        });
      else if (t.status === "blocked")
        items.push({
          id: "blocked:" + t.id,
          kind: "blocked",
          title: `${t.title} needs a decision`,
          detail:
            uncertain.get(t.id)?.join("; ") ??
            `${who} in ${w.name}: an external effect is uncertain.`,
          agentId: t.agentId,
          workflowId: w.id,
          target: "workflows",
        });
      else if (t.status === "completed") {
        const reviewer = data.edges.find(
          (e) => e.enabled && e.kind === "review" && e.from === t.agentId,
        );
        if (reviewer && !readyReview.has(t.agentId)) {
          readyReview.add(t.agentId);
          items.push({
            id: "review:" + t.id,
            kind: "review",
            title: `${t.title} is ready for review`,
            detail: `${who} finished; ${agentName(reviewer.to)} can review.`,
            agentId: t.agentId,
            workflowId: w.id,
            target: "workspace",
          });
        }
      }
    }
  }
  for (const act of data.activity)
    for (const q of act.queuedTasks)
      if (q.waitReason === "validation-required") {
        const t = taskIndex.get(q.id);
        items.push({
          id: "validation:" + q.id,
          kind: "validation",
          title: `${t?.title ?? "A task"} waits for validation`,
          detail: `${agentName(act.agentId)}: a required check has not passed.`,
          agentId: act.agentId,
          workflowId: t?.workflowId,
          target: "workflows",
        });
      }
  const dismissed = new Set(input.dismissed ?? []);
  return items
    .filter((i) => !dismissed.has(i.id))
    .sort(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        a.title.localeCompare(b.title),
    );
}
