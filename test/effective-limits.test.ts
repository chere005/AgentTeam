import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveLimits,
  isReached,
  wouldExceed,
  slotsAvailable,
  type ProjectLimitsInput,
} from "../src/effective-limits.ts";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";

const project = (
  over: Partial<ProjectLimitsInput> = {},
): ProjectLimitsInput => ({
  workflowId: "w",
  limits: {
    maxRuntimeSeconds: null,
    maxAgentTurns: 10,
    maxHandoffs: null,
    maxRetries: null,
    maxSpawnedAgents: null,
    maxTokens: null,
    maxChildrenPerTask: null,
    maxDelegationDepth: 4,
  },
  counters: {
    runtimeSeconds: 0,
    agentTurns: 2,
    handoffs: 0,
    retries: 0,
    spawnedAgents: 0,
  },
  tokensUsed: null,
  trip: null,
  ...over,
});
const row = (r: ReturnType<typeof resolveEffectiveLimits>, key: string) =>
  r.rows.find((x) => x.key === key)!;

test("helpers", () => {
  assert.equal(isReached(3, 3), true);
  assert.equal(isReached(3, null), false);
  assert.equal(wouldExceed(3, 3), true);
  assert.equal(wouldExceed(2, 3), false);
  assert.equal(slotsAvailable(null, 99), true);
  assert.equal(slotsAvailable(2, 2), false);
});

test("nothing limited: no binding row, provider quota unknown and never binds", () => {
  const r = resolveEffectiveLimits({
    project: project({ limits: { ...project().limits, maxAgentTurns: null } }),
    provider: { environment: "codex" },
  });
  assert.equal(r.binding, null);
  assert.equal(row(r, "provider.quota").state, "unknown");
  assert.equal(row(r, "project.turns").state, "unlimited");
});

test("most consumed finite limit binds across sources", () => {
  const r = resolveEffectiveLimits({
    project: project(), // turns 2/10
    agent: { agentId: "a", maxConcurrentInvocations: 2, running: 1 }, // 1/2
    provider: { environment: "claude" },
  });
  assert.equal(r.binding, "agent.invocations");
  assert.equal(r.rows.filter((x) => x.binding).length, 1);
});

test("a reached limit binds over a more consumed ratio elsewhere; ties keep source order", () => {
  const r = resolveEffectiveLimits({
    project: project({ counters: { ...project().counters, agentTurns: 10 } }),
    agent: { agentId: "a", maxConcurrentInvocations: 1, running: 1 },
  });
  assert.equal(row(r, "project.turns").state, "reached");
  assert.equal(r.binding, "project.turns");
});

test("a recorded trip binds its row and is reported", () => {
  const r = resolveEffectiveLimits({
    project: project({
      trip: { kind: "turns", reason: "Maximum of 10 agent turns reached." },
    }),
    agent: { agentId: "a", maxConcurrentInvocations: 1, running: 1 },
  });
  assert.equal(r.binding, "project.turns");
  assert.equal(r.trip?.kind, "turns");
});

test("per-task shape limits are shown but never ranked; unreported tokens do not rank", () => {
  const r = resolveEffectiveLimits({
    project: project({
      limits: { ...project().limits, maxAgentTurns: null, maxTokens: 100 },
    }),
  });
  assert.equal(row(r, "project.depth").scope, "task");
  assert.equal(row(r, "project.tokens").used, null);
  assert.equal(r.binding, null);
});

test("known provider quota and team caps take part in ranking", () => {
  const r = resolveEffectiveLimits({
    project: project(),
    provider: { environment: "claude", quota: { max: 100, used: 95 } },
    team: [{ key: "x", label: "Team cap", max: 10, used: 1 }],
  });
  assert.equal(r.binding, "provider.quota");
});

test("TeamService.effectiveLimits agrees with capacity() and limits.status()", async () => {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const lead = await service.saveAgent({
    name: "Lead",
    environment: "codex",
    maxConcurrentInvocations: 3,
  });
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  service.limits.setLimits(wf.id, { maxAgentTurns: 5 });
  const r = service.effectiveLimits({ workflowId: wf.id, agentId: lead.id });
  assert.equal(row(r, "project.turns").max, 5);
  assert.equal(
    row(r, "agent.invocations").max,
    service.capacity(lead.id).limit,
  );
  assert.equal(row(r, "provider.quota").state, "unknown");
  store.close();
});
