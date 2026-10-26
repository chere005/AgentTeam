import { tempDataDir } from "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  failedInvocationDependencies,
  invocationSummary,
  invocationTaskState,
  type InvocationTask,
} from "../src/invocation-view.ts";
import { Store } from "../src/store.ts";
import { TeamService } from "../src/service.ts";
import { SkillCatalog } from "../src/skills.ts";
import { explainWaiting } from "../src/inspector.ts";
import type { Task } from "../src/model.ts";
import { summarizeGroup } from "../ui/groups.ts";

const names = {
  manager: "Planner",
  writer: "Integrator",
  reviewer: "Reporter",
};
const failed: InvocationTask = {
  id: "write",
  title: "Write roll-call file",
  agentId: "writer",
  invokedBy: "manager",
  status: "failed",
  result:
    "[process-failure] Sandbox required but unavailable: Windows feature gate off. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.",
};
const dependent: InvocationTask = {
  id: "report",
  title: "Report roll call",
  agentId: "reviewer",
  invokedBy: "manager",
  status: "queued",
  dependsOn: [failed.id],
};

test("a free invocation slot still names the failed prerequisite and its cause", () => {
  const summary = invocationSummary("manager", 1, [failed, dependent], names);
  assert.equal(summary.full, false);
  assert.match(summary.explanation, /0 of 1 slots/);
  assert.equal(summary.waiting[0].reason, "dependency-failed");
  assert.match(
    summary.waiting[0].detail!,
    /Integrator.*Write roll-call file: sandbox unavailable/,
  );
  assert.doesNotMatch(summary.waiting[0].detail!, /failIfUnavailable=false/);
  const state = invocationTaskState(dependent, [failed, dependent], names);
  assert.equal(state.status, "blocked");
  assert.equal(state.recovery, true);
});

test("dependency explanation follows queued chains, handles cycles and clears after retry", () => {
  const middle: InvocationTask = { ...dependent, id: "middle" };
  const last: InvocationTask = {
    ...dependent,
    id: "last",
    dependsOn: [middle.id],
  };
  assert.deepEqual(
    failedInvocationDependencies(last, [failed, middle, last], names).map(
      (b) => b.id,
    ),
    [failed.id],
  );
  const cycle = { ...middle, dependsOn: [last.id] };
  assert.deepEqual(
    failedInvocationDependencies(last, [cycle, last], names),
    [],
  );
  const retried = { ...failed, status: "queued", result: undefined };
  assert.deepEqual(
    failedInvocationDependencies(dependent, [retried, dependent], names),
    [],
  );
  assert.equal(
    invocationTaskState(dependent, [retried, dependent], names).status,
    "queued",
  );
});

test("sandbox failures show a supported recovery instead of disabling enforcement", () => {
  const state = invocationTaskState(failed, [failed], names);
  assert.equal(state.label, "Blocked: sandbox unavailable");
  assert.match(state.detail!, /WSL2/);
  assert.doesNotMatch(
    state.detail!,
    /failIfUnavailable=false|unsandboxed execution/,
  );
});

test("delegating parents remain waiting or need attention until required children finish", () => {
  const parent: InvocationTask = {
    id: "parent",
    title: "Coordinate",
    agentId: "manager",
    status: "blocked",
  };
  const child = { ...dependent, parentTaskId: parent.id };
  assert.equal(
    invocationTaskState(parent, [parent, child], names).label,
    "Waiting for delegated work",
  );
  const badChild = { ...failed, parentTaskId: parent.id };
  const state = invocationTaskState(parent, [parent, badChild], names);
  assert.equal(state.label, "Needs attention");
  assert.match(state.detail!, /Integrator: sandbox unavailable/);
  const backend = {
    ...parent,
    delegation: {
      state: "waiting" as const,
      childIds: [child.id],
      message: "Waiting for a required review.",
    },
  };
  assert.equal(
    invocationTaskState(backend, [backend], names).detail,
    "Waiting for a required review.",
  );
});

test("collapsed canvas groups preserve blocked attention without asking waiting parents to resume", () => {
  const group = {
    id: "team",
    name: "Team",
    agentIds: ["blocked", "waiting", "old"],
    collapsed: true,
  };
  const summary = summarizeGroup(group, [
    {
      agentId: "blocked",
      state: "blocked",
      failedTaskIds: [],
      blockedTaskIds: ["task"],
      interruptedTaskIds: [],
    },
    {
      agentId: "waiting",
      state: "waiting",
      failedTaskIds: [],
      waitingTaskIds: ["parent"],
      interruptedTaskIds: [],
    },
    {
      agentId: "old",
      state: "interrupted",
      failedTaskIds: [],
      interruptedTaskIds: ["legacy"],
    },
  ]);
  assert.equal(summary.attention, 2);
  assert.equal(summary.failed, 0);
});

test("inspector names failed prerequisites and distinguishes delegation from uncertain effects", async () => {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  try {
    const manager = await service.saveAgent({
      name: "Planner",
      environment: "codex",
    });
    const writer = await service.saveAgent({
      name: "Integrator",
      environment: "claude",
    });
    const workflow = service.workflow({
      name: "Roll call",
      goal: "Write files",
      ownerId: manager.id,
      completionCriteria: "Files verified",
    });
    const first = service.task({
      workflowId: workflow.id,
      agentId: writer.id,
      title: "Write Integrator.txt",
      completionCriteria: "File verified",
    });
    const second = service.task({
      workflowId: workflow.id,
      agentId: manager.id,
      title: "Report files",
      dependsOn: [first.id],
      completionCriteria: "Files verified",
    });
    service.transitionTask(first.id, { status: "running" });
    service.transitionTask(first.id, {
      status: "failed",
      result: failed.result,
    });
    const context = { liveEnabled: () => true };
    const explanation = explainWaiting(service, context, { taskId: second.id });
    const reason = explanation.reasons.find(
      (r) => r.code === "dependency-failed",
    );
    assert.ok(reason);
    assert.match(explanation.headline, /^Blocked:/);
    assert.match(
      reason.detail,
      /Write Integrator.txt.*Integrator.*sandbox unavailable/,
    );
    assert.doesNotMatch(reason.detail, /failIfUnavailable=false/);
    store.put("task", { ...second, status: "blocked" });
    store.put("task", {
      ...store.get<Task>("task", first.id),
      parentTaskId: second.id,
    });
    const parent = explainWaiting(service, context, { taskId: second.id });
    assert.ok(parent.reasons.some((r) => r.code === "delegation-blocked"));
    assert.ok(!parent.reasons.some((r) => /uncertain effect/.test(r.title)));
  } finally {
    store.close();
  }
});
