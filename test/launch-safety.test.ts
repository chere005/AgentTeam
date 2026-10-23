import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import type { Agent, Task } from "../src/model.ts";

function serviceFor(t: any) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return { store, service: new TeamService(store, new SkillCatalog([])) };
}

test("agent configuration cannot change while its task is running", async (t) => {
  const { service } = serviceFor(t);
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
  });
  const workflow = service.workflow({
    name: "Build",
    goal: "Ship",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build",
    completionCriteria: "Done",
  });

  service.transitionTask(task.id, { status: "running" });
  await assert.rejects(
    service.saveAgent(
      { name: "Builder", environment: "codex", instructions: "Changed" },
      agent.id,
    ),
    { code: "agent_busy" },
  );
});

test("agent configuration cannot change if a task starts during workspace preparation", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-agent-race-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const { store, service } = serviceFor(t);
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
  });
  const workflow = service.workflow({
    name: "Build",
    goal: "Ship",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build",
    completionCriteria: "Done",
  });
  const originalTransaction = store.transaction.bind(store);
  let activated = false;
  (store as any).transaction = (operation: (...args: any[]) => unknown) => {
    if (!activated) {
      activated = true;
      store.put("task", {
        ...store.get<Task>("task", task.id),
        status: "running",
      });
    }
    return originalTransaction(operation as never);
  };

  await assert.rejects(
    service.saveAgent(
      {
        name: "Builder",
        environment: "codex",
        instructions: "Changed",
        workspaces: [{ path: root, access: "write", active: true }],
      },
      agent.id,
    ),
    { code: "agent_busy" },
  );
  assert.equal(activated, true);
  assert.equal(store.get<Agent>("agent", agent.id).instructions, "");
});

test("a global filesystem block added during launch preparation aborts the plan", async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-launch-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace"),
    blocked = join(base, "blocked");
  await Promise.all([mkdir(root), mkdir(blocked)]);
  const { store, service } = serviceFor(t);
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
    tools: ["read", "edit", "write"],
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const workflow = service.workflow({
    name: "Build",
    goal: "Ship",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build",
    completionCriteria: "Done",
    resourcePaths: [root],
  });

  let releaseScan!: () => void;
  let enteredScan!: () => void;
  const scanGate = new Promise<void>((resolve) => (releaseScan = resolve));
  const scanEntered = new Promise<void>((resolve) => (enteredScan = resolve));
  service.skills.scan = async () => {
    enteredScan();
    await scanGate;
    return { groups: {}, warnings: [], total: 0 };
  };

  const launch = service.launchPlan(agent.id, task.id);
  await scanEntered;
  filesystemPolicy(store).add({
    paths: [blocked],
    acknowledgePermanent: true,
  });
  releaseScan();
  await assert.rejects(launch, { code: "filesystem_sandbox_required" });
});

test("a launch plan is discarded if agent configuration changes while preparing", async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-plan-race-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  await mkdir(root);
  const { store, service } = serviceFor(t);
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
    tools: ["read", "edit", "write"],
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const workflow = service.workflow({
    name: "Build",
    goal: "Ship",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build",
    completionCriteria: "Done",
    resourcePaths: [root],
  });
  let releaseScan!: () => void;
  let enteredScan!: () => void;
  const scanGate = new Promise<void>((resolve) => (releaseScan = resolve));
  const scanEntered = new Promise<void>((resolve) => (enteredScan = resolve));
  service.skills.scan = async () => {
    enteredScan();
    await scanGate;
    return { groups: {}, warnings: [], total: 0 };
  };

  const launch = service.launchPlan(agent.id, task.id);
  await scanEntered;
  store.put("agent", { ...agent, instructions: "Changed while pending" });
  releaseScan();
  await assert.rejects(launch, { code: "agent_changed" });
});
