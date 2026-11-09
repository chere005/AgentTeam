/**
 * One model of "what limits this run". Pure: the backend (`TeamService.effectiveLimits`) gathers
 * the inputs and the UI renders the result, so scheduler/readiness checks and the Limits block
 * read the same numbers.
 *
 * Sources: project stopping limits (src/limits.ts), the invoking agent's concurrent-invocation
 * cap (`Agent.maxConcurrentInvocations`), shared-folder concurrency of a project (coordination),
 * team-level caps (none exist today: teams are presentation/ownership only, see team-spaces.ts)
 * and provider/subscription quota (never exposed by the connected CLIs, so reported "unknown").
 *
 * Conflict rule (conservative): every finite limit applies; a limit that is reached binds first,
 * otherwise the most consumed one (used / max) binds. Nothing is ever loosened.
 */
export type LimitSource = "project" | "agent" | "team" | "provider";
export type LimitUnit = "count" | "seconds" | "tokens";
export type LimitState = "unlimited" | "ok" | "reached" | "unknown";
/** Where a limit is edited, so the UI can link to it. */
export type LimitEdit =
  | { target: "project"; workflowId: string }
  | { target: "agent"; agentId: string }
  | { target: "team" }
  | { target: "provider"; environment: string }
  | { target: "none" };
export type LimitRow = {
  key: string;
  source: LimitSource;
  label: string;
  /** null = unlimited (or unknown when state is "unknown"). */
  max: number | null;
  /** null = not measurable (per-task shape limits, unreported tokens, unknown quota). */
  used: number | null;
  unit: LimitUnit;
  /** "run": counts consumption across the run/project. "task": per-task shape limit, never ranked. */
  scope: "run" | "task";
  state: LimitState;
  binding: boolean;
  edit: LimitEdit;
};
export type EffectiveLimits = {
  rows: LimitRow[];
  /** key of the binding row, null when nothing is limited. */
  binding: string | null;
  /** The project was stopped by a limit (reason as recorded). */
  trip: { kind: string; reason: string } | null;
};
export type ProjectLimitsInput = {
  workflowId: string;
  limits: {
    maxRuntimeSeconds: number | null;
    maxAgentTurns: number | null;
    maxHandoffs: number | null;
    maxRetries: number | null;
    maxSpawnedAgents: number | null;
    maxTokens: number | null;
    maxChildrenPerTask: number | null;
    maxDelegationDepth: number;
  };
  counters: {
    runtimeSeconds: number;
    agentTurns: number;
    handoffs: number;
    retries: number;
    spawnedAgents: number;
  };
  /** Provider-reported tokens; null when no turn reported any. */
  tokensUsed: number | null;
  trip: { kind: string; reason: string } | null;
  /** Shared-folder parallel access, when enabled for the project. */
  sharedConcurrency?: { max: number; active: number } | null;
};
export type AgentLimitsInput = {
  agentId: string;
  maxConcurrentInvocations: number | null;
  running: number;
};
export type TeamLimitInput = {
  key: string;
  label: string;
  max: number | null;
  used: number | null;
  unit?: LimitUnit;
};
export type ProviderQuotaInput = {
  environment: string;
  /** Present only when a runtime exposes its plan quota. */
  quota?: { max: number; used: number; unit?: LimitUnit } | null;
};
export type LimitInputs = {
  project?: ProjectLimitsInput | null;
  agent?: AgentLimitsInput | null;
  team?: TeamLimitInput[];
  provider?: ProviderQuotaInput | null;
};

/** A counter that has reached its maximum. `max === null` never reaches. */
export function isReached(used: number, max: number | null): boolean {
  return max !== null && used >= max;
}
/** Would starting one more unit (turn, handoff, invocation slot) exceed `max`? */
export function wouldExceed(used: number, max: number | null): boolean {
  return max !== null && used + 1 > max;
}
/** The agent's concurrent-invocation capacity (`TeamService.capacity` delegates here). */
export function slotsAvailable(limit: number | null, running: number): boolean {
  return limit === null || running < limit;
}

function row(
  r: Omit<LimitRow, "state" | "binding"> & { unknownQuota?: boolean },
): LimitRow {
  const { unknownQuota, ...rest } = r;
  const state: LimitState = unknownQuota
    ? "unknown"
    : rest.max === null
      ? "unlimited"
      : rest.used !== null && isReached(rest.used, rest.max)
        ? "reached"
        : "ok";
  return { ...rest, state, binding: false };
}

export function resolveEffectiveLimits(input: LimitInputs): EffectiveLimits {
  const rows: LimitRow[] = [];
  const p = input.project;
  if (p) {
    const edit: LimitEdit = { target: "project", workflowId: p.workflowId };
    const run = (
      key: string,
      label: string,
      max: number | null,
      used: number | null,
      unit: LimitUnit = "count",
    ) =>
      rows.push(
        row({
          key: `project.${key}`,
          source: "project",
          label,
          max,
          used,
          unit,
          scope: "run",
          edit,
        }),
      );
    run(
      "runtime",
      "Runtime",
      p.limits.maxRuntimeSeconds,
      p.counters.runtimeSeconds,
      "seconds",
    );
    run("turns", "Agent turns", p.limits.maxAgentTurns, p.counters.agentTurns);
    run("handoffs", "Handoffs", p.limits.maxHandoffs, p.counters.handoffs);
    run("retries", "Retries", p.limits.maxRetries, p.counters.retries);
    run(
      "spawned",
      "Spawned agents",
      p.limits.maxSpawnedAgents,
      p.counters.spawnedAgents,
    );
    run(
      "tokens",
      "Reported tokens",
      p.limits.maxTokens,
      p.tokensUsed,
      "tokens",
    );
    if (p.sharedConcurrency)
      run(
        "shared-concurrency",
        "Shared-folder concurrency",
        p.sharedConcurrency.max,
        p.sharedConcurrency.active,
      );
    for (const [key, label, max] of [
      ["children", "Children per task", p.limits.maxChildrenPerTask],
      ["depth", "Delegation depth", p.limits.maxDelegationDepth],
    ] as const)
      rows.push(
        row({
          key: `project.${key}`,
          source: "project",
          label,
          max,
          used: null,
          unit: "count",
          scope: "task",
          edit,
        }),
      );
  }
  const a = input.agent;
  if (a)
    rows.push(
      row({
        key: "agent.invocations",
        source: "agent",
        label: "Concurrent invoked agents",
        max: a.maxConcurrentInvocations,
        used: a.running,
        unit: "count",
        scope: "run",
        edit: { target: "agent", agentId: a.agentId },
      }),
    );
  for (const t of input.team ?? [])
    rows.push(
      row({
        key: `team.${t.key}`,
        source: "team",
        label: t.label,
        max: t.max,
        used: t.used,
        unit: t.unit ?? "count",
        scope: "run",
        edit: { target: "team" },
      }),
    );
  const q = input.provider;
  if (q)
    rows.push(
      row({
        key: "provider.quota",
        source: "provider",
        label: `${q.environment} subscription quota`,
        max: q.quota?.max ?? null,
        used: q.quota?.used ?? null,
        unit: q.quota?.unit ?? "count",
        scope: "run",
        unknownQuota: !q.quota,
        edit: { target: "provider", environment: q.environment },
      }),
    );

  // Binding: the tripped project limit if the project was stopped; otherwise a reached limit;
  // otherwise the most consumed finite one. Ties keep source order (project, agent, team, provider).
  const tripKey = p?.trip ? tripRowKey(p.trip.kind) : null;
  const ranked = rows.filter(
    (r) =>
      r.scope === "run" &&
      r.state !== "unknown" &&
      r.max !== null &&
      r.used !== null,
  );
  let binding: LimitRow | undefined = tripKey
    ? rows.find((r) => r.key === tripKey)
    : undefined;
  binding ??= ranked.find((r) => r.state === "reached");
  if (!binding) {
    let best = -1;
    for (const r of ranked) {
      const ratio = r.used! / r.max!;
      if (ratio > best) {
        best = ratio;
        binding = r;
      }
    }
  }
  if (binding) binding.binding = true;
  return {
    rows,
    binding: binding?.key ?? null,
    trip: p?.trip ? { kind: p.trip.kind, reason: p.trip.reason } : null,
  };
}

/** Map a recorded trip kind (src/limits.ts `TripKind`) to its row key. */
export function tripRowKey(kind: string): string | null {
  const map: Record<string, string> = {
    runtime: "project.runtime",
    turns: "project.turns",
    handoffs: "project.handoffs",
    retries: "project.retries",
    spawned: "project.spawned",
    tokens: "project.tokens",
    depth: "project.depth",
  };
  return map[kind] ?? null;
}

/** Compact value text shared by every Limits block: "3 / 10", "12 / unlimited", "unknown". */
export function formatLimitRow(r: LimitRow): string {
  if (r.state === "unknown") return "not exposed by the runtime";
  const unit = r.unit === "seconds" ? "s" : "";
  const used = r.used === null ? "–" : `${r.used.toLocaleString()}${unit}`;
  const max = r.max === null ? "unlimited" : `${r.max.toLocaleString()}${unit}`;
  return r.scope === "task" ? `max ${max}` : `${used} / ${max}`;
}
