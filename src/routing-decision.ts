import type { TeamService } from "./service.ts";

/**
 * The routing decision recorded when a delegated task is created (additive `routing` field on the
 * task). Tasks always name their assignee, so the decision says which routing rules matched the
 * task text at that moment and whether the rules would have chosen the assignee. The inspector's
 * transfer view reads it, so "originating rule" is exact instead of inferred from today's rules.
 */
export type RoutingDecision = {
  /** When the decision was made (task creation). */
  at: string;
  kind: "delegate";
  /** What the rules alone would have done for this text. */
  status: "selected" | "ambiguous" | "unmatched" | "unavailable";
  /** Agent the rules selected (status "selected"). */
  selectedAgentId: string | null;
  /** The agent the task was actually assigned to. */
  assigneeId: string;
  /** True when a rule matched that targets the assignee. */
  assigneeMatched: boolean;
  reason: string;
  /** Every matching eligible rule, highest priority first. */
  matches: {
    ruleId: string;
    priority: number;
    scope: "intake" | "action";
    agentId: string;
  }[];
};

export function decideRouting(
  service: Pick<TeamService, "route">,
  task: {
    title: string;
    instructions: string;
    invokedBy: string;
    agentId: string;
    tags?: string[];
    changedFiles?: string[];
  },
  now = new Date(),
): RoutingDecision {
  const base = {
    at: now.toISOString(),
    kind: "delegate" as const,
    assigneeId: task.agentId,
  };
  try {
    const routed = service.route({
      text: `${task.title}\n${task.instructions}`.slice(0, 100_000),
      fromAgentId: task.invokedBy,
      kind: "delegate",
      tags: task.tags ?? [],
      changedFiles: task.changedFiles ?? [],
    });
    const matches = routed.matches.slice(0, 50);
    return {
      ...base,
      status: routed.status,
      selectedAgentId:
        routed.status === "selected" && "agentId" in routed
          ? routed.agentId
          : null,
      assigneeMatched: matches.some((m) => m.agentId === task.agentId),
      reason: routed.reason,
      matches,
    };
  } catch (e) {
    // Recording must never block task creation.
    return {
      ...base,
      status: "unavailable",
      selectedAgentId: null,
      assigneeMatched: false,
      reason: `Routing preview failed: ${(e as Error).message}`.slice(0, 300),
      matches: [],
    };
  }
}
