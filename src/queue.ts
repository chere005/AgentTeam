import { comparePriority, priorityName } from "./priorities.ts";
import { overlaps, type Lease } from "./resources.ts";
import type { Agent, Task } from "./model.ts";
import type { TeamService } from "./service.ts";
import type { WaitReason } from "./inspector.ts";

/** Seconds of waiting that add one priority point (same constant as ResourceCoordinator.score). */
export const AGING_SECONDS = 5;

export type QueueEntry = {
  kind: "task" | "chat";
  /** Task id, or the conversation (session) id for a chat run request. */
  id: string;
  agentId: string;
  workflowId: string | null;
  title: string;
  queuedAt: string;
  priority: number;
  priorityLabel: string;
  /** priority + aging points, the value the scheduler sorts by (Preempt sorts ahead of everything). */
  score: number;
  waitedSeconds: number;
  agingPoints: number;
  preempt: boolean;
  /** 1-based rank across tasks and chat runs combined. */
  position: number;
};

/**
 * One ordering for tasks AND chat run requests, shared by the scheduler, the resource snapshot and
 * the run inspector so every surface reports the same position, aging and Preempt precedence.
 */
export function buildQueue(service: TeamService, now = Date.now()) {
  const store = service.store,
    res = service.resources;
  const make = (
    kind: QueueEntry["kind"],
    id: string,
    agentId: string,
    workflowId: string | null,
    title: string,
    queuedAt: string | undefined,
  ): QueueEntry => {
    const priority = res.priority(agentId);
    const at = Date.parse(queuedAt ?? new Date(now).toISOString());
    const waited = Math.max(0, now - at) / 1000;
    return {
      kind,
      id,
      agentId,
      workflowId,
      title,
      queuedAt: queuedAt ?? new Date(now).toISOString(),
      priority,
      priorityLabel: priorityName(priority),
      score: priority + (waited * 1000) / (AGING_SECONDS * 1000),
      waitedSeconds: Math.round(waited),
      agingPoints: waited / AGING_SECONDS,
      preempt: priority === 101,
      position: 0,
    };
  };
  const agents = new Map(store.list<Agent>("agent").map((a) => [a.id, a]));
  const entries = [
    ...store
      .list<Task>("task")
      .filter((t) => t.status === "queued")
      .map((t) =>
        make("task", t.id, t.agentId, t.workflowId, t.title, t.queuedAt),
      ),
    ...store
      .list<{ id: string; agentId: string; queuedAt: string }>("run-request")
      .map((r) =>
        make(
          "chat",
          r.id,
          r.agentId,
          null,
          "Chat · " + (agents.get(r.agentId)?.name ?? r.agentId),
          r.queuedAt,
        ),
      ),
  ].sort((a, b) =>
    comparePriority(
      { priority: a.priority, score: a.score },
      { priority: b.priority, score: b.score },
    ),
  );
  entries.forEach((e, i) => (e.position = i + 1));
  return entries;
}

function resourcePaths(service: TeamService, e: QueueEntry) {
  return service.resources.pathsFor(e.agentId, e.id).paths;
}
/** Leases that currently conflict with this entry (its owners). */
function holders(service: TeamService, e: QueueEntry): Lease[] {
  return service.resources.conflicts(e.agentId, e.workflowId, e.id);
}
/**
 * Starvation guard: entries ranked ahead of `entry` that are waiting ONLY for a lease and overlap
 * its paths hold a reservation, so a lower-ranked entry may not slip onto those paths first (it
 * would otherwise keep re-taking the paths and starve the higher-ranked one forever).
 */
export function reservationHolders(
  service: TeamService,
  queue: QueueEntry[],
  entry: QueueEntry,
) {
  const mine = resourcePaths(service, entry);
  return queue
    .filter((e) => e.position < entry.position)
    .filter(
      (e) => holders(service, e).length > 0 && onlyLeaseBlocked(service, e),
    )
    .filter((e) =>
      resourcePaths(service, e).some((p) => mine.some((m) => overlaps(p, m))),
    );
}
function onlyLeaseBlocked(service: TeamService, e: QueueEntry) {
  if (e.kind === "chat") return true;
  const wait = service.taskState(e.id).waitReason;
  return wait === "resource-busy";
}

/** Plain-language lease conflict: who holds what, and the exact overlapping path pairs. */
export function resourceBusyReason(
  service: TeamService,
  e: { agentId: string; workflowId: string | null; id: string },
): WaitReason | null {
  const store = service.store;
  const conflicts = service.resources.conflicts(e.agentId, e.workflowId, e.id);
  if (!conflicts.length) return null;
  const mine = service.resources.pathsFor(e.agentId, e.id);
  const name = (id: string) => store.get<Agent>("agent", id).name;
  const taskIds = new Set(store.list<Task>("task").map((t) => t.id));
  return {
    code: "resource-busy",
    blocking: true,
    title: "Shared files or folders are leased",
    detail: conflicts
      .map((lease: Lease) => {
        const pairs = mine.paths.flatMap((p) =>
          lease.paths
            .filter((o) => overlaps(p, o))
            .map((o) => (p === o ? p : `${p} ~ ${o}`)),
        );
        const kind = taskIds.has(lease.id)
          ? "task"
          : lease.id.startsWith("git:")
            ? "Git action"
            : "conversation";
        return `${name(lease.agentId)} holds the lease (${kind} ${lease.id.slice(0, 8)}, since ${lease.acquiredAt}) over ${pairs.join(", ")}${lease.draining ? " [draining: " + lease.draining.reason + "]" : ""}`;
      })
      .join("; "),
    refs: {
      reserves: mine.scope,
      leases: conflicts.map((l: Lease) => ({
        id: l.id,
        agentId: l.agentId,
        owner: name(l.agentId),
        scope: l.scope ?? "attached-folders",
        paths: l.paths.filter((o) => mine.paths.some((p) => overlaps(p, o))),
        overlaps: mine.paths.flatMap((p) =>
          l.paths
            .filter((o) => overlaps(p, o))
            .map((o) => ({ mine: p, theirs: o })),
        ),
      })),
    },
  };
}

/** Queue position, aging, owner and pending higher-priority requests for one task or chat run. */
export function queueReasons(service: TeamService, id: string): WaitReason[] {
  const queue = buildQueue(service);
  const entry = queue.find((e) => e.id === id);
  if (!entry) return [];
  const store = service.store;
  const name = (aid: string) => store.get<Agent>("agent", aid).name;
  const ahead = queue.slice(0, entry.position - 1);
  const pendingHigher = ahead.filter(
    (a) => a.preempt !== entry.preempt || a.priority > entry.priority,
  );
  // Preempt exception: ranks ahead although this entry has more aged points.
  const preemptJumped = ahead.filter(
    (a) => a.preempt && !entry.preempt && a.score < entry.score,
  );
  const owners = holders(service, entry).map((l) => ({
    leaseId: l.id,
    agentId: l.agentId,
    agent: name(l.agentId),
  }));
  const reasons: WaitReason[] = [];
  const brief = (a: QueueEntry) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    agent: name(a.agentId),
    priority: a.priorityLabel,
    effectiveScore: Math.round(a.score * 10) / 10,
  });
  reasons.push({
    code: "queue-position",
    blocking: false,
    title: `Queue position ${entry.position} of ${queue.length}`,
    detail:
      `${entry.priorityLabel} priority (${entry.priority}); waited ${entry.waitedSeconds} s, aging adds ${entry.agingPoints.toFixed(1)} points, effective score ${entry.score.toFixed(1)}.` +
      (entry.preempt
        ? " Preempt gets queue precedence but never interrupts running work."
        : "") +
      (ahead.length
        ? " Ahead: " +
          ahead
            .slice(0, 5)
            .map((a) => `"${a.title}" (${name(a.agentId)})`)
            .join(", ") +
          "."
        : "") +
      (owners.length
        ? ` Current owner${owners.length > 1 ? "s" : ""}: ${[...new Set(owners.map((o) => o.agent))].join(", ")}.`
        : ""),
    refs: {
      position: entry.position,
      total: queue.length,
      kind: entry.kind,
      priority: entry.priority,
      effectivePriority: entry.score,
      waitedSeconds: entry.waitedSeconds,
      agingPoints: entry.agingPoints,
      owners,
      ahead: ahead.slice(0, 5).map(brief),
    },
  });
  if (pendingHigher.length)
    reasons.push({
      code: "higher-priority-pending",
      blocking: false,
      title: `${pendingHigher.length} higher-priority request${pendingHigher.length === 1 ? "" : "s"} ahead`,
      detail:
        pendingHigher
          .slice(0, 5)
          .map(
            (a) =>
              `"${a.title}" (${a.priorityLabel}, score ${a.score.toFixed(1)})`,
          )
          .join("; ") + ".",
      refs: { requests: pendingHigher.slice(0, 10).map(brief) },
    });
  if (preemptJumped.length)
    reasons.push({
      code: "preempt-exception",
      blocking: false,
      title: "Preempt request takes precedence over aging",
      detail: `${preemptJumped.map((a) => `"${a.title}"`).join(", ")} ${preemptJumped.length === 1 ? "has" : "have"} Preempt priority, so ${preemptJumped.length === 1 ? "it goes" : "they go"} first even though this request has waited longer. Preempt never interrupts running work; it only wins the next free turn. Continuous Preempt traffic can delay normal work.`,
      refs: { requests: preemptJumped.map(brief) },
    });
  const reservers = reservationHolders(service, queue, entry);
  if (reservers.length && !holders(service, entry).length)
    reasons.push({
      code: "reserved-for-higher",
      blocking: true,
      title: "Paths are reserved for a higher-ranked request",
      detail: `${reservers.map((a) => `"${a.title}" (${name(a.agentId)})`).join(", ")} outrank${reservers.length === 1 ? "s" : ""} this request and wait only for a lease on overlapping paths; starting this one first could starve it.`,
      refs: { requests: reservers.map(brief) },
    });
  return reasons;
}
