import { z } from "zod";
import { assert, type Task, type Workflow } from "./model.ts";
import type { TeamService } from "./service.ts";

/**
 * Explicit control of long-lived background coordination, per workflow: status, the current goal,
 * pause/resume and stopping conditions. Stopping conditions ARE the workflow limits
 * (src/limits.ts, enforced by the backend); `stopWhen` is a free-text note for humans and the
 * assistant and is never enforced. A limit stop is resumed through the limits route, never by a
 * plain resume.
 */
export const coordinationSchema = z
  .object({
    currentGoal: z.string().trim().max(500).optional(),
    stopWhen: z.string().trim().max(1000).optional(),
  })
  .strict();
type CoordRecord = {
  id: string;
  currentGoal: string;
  stopWhen: string;
  updatedAt: string;
  history: { at: string; action: string; detail?: string }[];
};
const USED: Record<
  string,
  (s: ReturnType<TeamService["limits"]["status"]>) => number | null
> = {
  maxRuntimeSeconds: (s) => s.counters.runtimeSeconds,
  maxAgentTurns: (s) => s.counters.agentTurns,
  maxHandoffs: (s) => s.counters.handoffs,
  maxRetries: (s) => s.counters.retries,
  maxSpawnedAgents: (s) => s.counters.spawnedAgents,
  maxTokens: (s) => s.usage.totalTokens,
};

const KIND_KEY: Record<string, string> = {
  runtime: "maxRuntimeSeconds",
  turns: "maxAgentTurns",
  handoffs: "maxHandoffs",
  retries: "maxRetries",
  spawned: "maxSpawnedAgents",
  tokens: "maxTokens",
  depth: "maxDelegationDepth",
  loop: "maxDelegationDepth",
};

export class Coordination {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  private record(workflowId: string): CoordRecord {
    try {
      return this.store.get<CoordRecord>("coordination", workflowId);
    } catch {
      return {
        id: workflowId,
        currentGoal: "",
        stopWhen: "",
        updatedAt: "",
        history: [],
      };
    }
  }
  view(workflowId: string) {
    const status = this.service.workflowStatus(workflowId);
    const limits = this.service.limits.status(workflowId);
    const rec = this.record(workflowId);
    const count = (s: Task["status"]) =>
      status.tasks.filter((t) => t.status === s).length;
    const tripped = limits.trip;
    return {
      workflowId,
      name: status.name,
      ownerId: status.ownerId,
      /** The goal the workflow was created with. */
      goal: status.goal,
      /** What coordination is working toward right now (editable). */
      currentGoal: rec.currentGoal || status.goal,
      currentGoalSet: !!rec.currentGoal,
      stopWhen: rec.stopWhen,
      status: tripped ? "stopped-by-limit" : status.status,
      paused: status.paused,
      trip: tripped,
      tasks: {
        queued: count("queued"),
        running: count("running"),
        completed: count("completed"),
        failed: count("failed"),
        needsAttention:
          count("interrupted") + count("blocked") + count("failed"),
      },
      stopping: Object.entries(USED).map(([key, used]) => {
        const limit = (limits.limits as Record<string, number | null>)[key];
        const u = used(limits);
        return {
          key,
          limit,
          used: u,
          tripped: !!tripped && KIND_KEY[tripped.kind] === key,
        };
      }),
      hasStopCondition: Object.keys(USED).some(
        (k) => (limits.limits as Record<string, number | null>)[k] !== null,
      ),
      updatedAt: rec.updatedAt,
      history: rec.history.slice(-20),
    };
  }
  list() {
    return this.store.list<Workflow>("workflow").map((w) => this.view(w.id));
  }
  private note(
    workflowId: string,
    action: string,
    detail?: string,
    patch: Partial<CoordRecord> = {},
  ) {
    const rec = this.record(workflowId);
    const at = new Date().toISOString();
    this.store.put("coordination", {
      ...rec,
      ...patch,
      updatedAt: at,
      history: [...rec.history, { at, action, detail }].slice(-50),
    });
    this.store.emit("coordination." + action, workflowId, { detail });
  }
  set(workflowId: string, input: unknown) {
    const data = coordinationSchema.parse(input);
    this.store.get<Workflow>("workflow", workflowId);
    this.store.transaction(() => {
      const patch: Partial<CoordRecord> = {};
      if (data.currentGoal !== undefined) patch.currentGoal = data.currentGoal;
      if (data.stopWhen !== undefined) patch.stopWhen = data.stopWhen;
      this.note(
        workflowId,
        "updated",
        Object.keys(data).join(", ") || undefined,
        patch,
      );
    });
    return this.view(workflowId);
  }
  pause(workflowId: string) {
    this.store.transaction(() => {
      this.service.pauseWorkflow(workflowId, true);
      this.note(workflowId, "paused");
    });
    return this.view(workflowId);
  }
  resume(workflowId: string) {
    const limits = this.service.limits.status(workflowId);
    assert(
      !limits.trip,
      "limit_tripped",
      `Stopped by a limit (${limits.trip?.kind}): raise the limit and resume from the stopping conditions panel`,
    );
    this.store.transaction(() => {
      this.service.pauseWorkflow(workflowId, false);
      this.note(workflowId, "resumed");
    });
    return this.view(workflowId);
  }
}
