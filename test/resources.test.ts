import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { contains, overlaps } from "../src/resources.ts";
import type { Task } from "../src/model.ts";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "agentteam-resources-"));
  await mkdir(join(root, "child"));
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([]));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const a = await service.saveAgent({
      name: "A",
      environment: "codex",
      workspaces: [{ path: root, access: "write" }],
    }),
    b = await service.saveAgent({
      name: "B",
      environment: "codex",
      workspaces: [{ path: join(root, "child"), access: "read" }],
    });
  const wf = service.workflow({
    name: "Work",
    ownerId: a.id,
    goal: "G",
    completionCriteria: "D",
  });
  return { root, store, service, a, b, wf };
}
test("overlapping folders are exclusive and terminal tasks release locks", async (t) => {
  const { service, a, b, wf } = await fixture(t);
  const one = service.task({
      workflowId: wf.id,
      agentId: a.id,
      title: "One",
      completionCriteria: "D",
    }),
    two = service.task({
      workflowId: wf.id,
      agentId: b.id,
      title: "Two",
      completionCriteria: "D",
    });
  service.transitionTask(one.id, { status: "running" });
  assert.equal(service.taskState(two.id).waitReason, "resource-busy");
  assert.throws(
    () => service.transitionTask(two.id, { status: "running" }),
    /shared resources/,
  );
  service.transitionTask(one.id, { status: "failed", result: "Failed" });
  service.transitionTask(two.id, { status: "running" });
  assert.equal(service.resources.snapshot().leases.length, 1);
});
test("chat leases and workflow leases share the same exclusion boundary", async (t) => {
  const { service, a, b, wf } = await fixture(t);
  service.resources.acquire("chat", a.id, null);
  assert.throws(
    () => service.resources.acquire("task", b.id, wf.id),
    /shared resources/,
  );
  service.resources.release("chat");
  service.resources.acquire("task", b.id, wf.id);
  assert.throws(
    () => service.resources.acquire("chat", a.id, null),
    /shared resources/,
  );
});
test("aging gives low priority queued work a turn ahead of fresh high priority work", async (t) => {
  const { root, service, store, a, b, wf } = await fixture(t);
  await service.resources.save({
    name: "Shared",
    path: root,
    priorities: [
      { agentId: a.id, priority: 100 },
      { agentId: b.id, priority: 0 },
    ],
  });
  const high = service.task({
      workflowId: wf.id,
      agentId: a.id,
      title: "High",
      completionCriteria: "D",
    }),
    low = service.task({
      workflowId: wf.id,
      agentId: b.id,
      title: "Low",
      completionCriteria: "D",
    });
  assert.equal(service.resources.ordered([low, high])[0].id, high.id);
  low.queuedAt = new Date(Date.now() - 505000).toISOString();
  store.put("task", low);
  assert.equal(service.resources.ordered([high, low])[0].id, low.id);
});
test("guided parallel access waits for a plan and excludes other workflows", async (t) => {
  const { root, service, a, b, wf } = await fixture(t);
  const resource = await service.resources.save({ name: "Shared", path: root });
  const config = service.resources.configureWorkflow(wf.id, {
    enabled: true,
    coordinatorId: a.id,
    resourceIds: [resource.id],
    maxConcurrent: 2,
  });
  const worker = service.task({
    workflowId: wf.id,
    agentId: b.id,
    title: "Worker",
    completionCriteria: "D",
  });
  assert.deepEqual(worker.dependsOn, [config.planTaskId]);
  assert.throws(
    () => service.transitionTask(worker.id, { status: "running" }),
    /Dependencies/,
  );
  service.transitionTask(config.planTaskId!, { status: "running" });
  service.transitionTask(config.planTaskId!, {
    status: "completed",
    result: "Work on distinct files",
  });
  service.resources.acquire("parallel-a", a.id, wf.id);
  service.transitionTask(worker.id, { status: "running" });
  const other = service.workflow({
    name: "Other",
    ownerId: a.id,
    goal: "G",
    completionCriteria: "D",
  });
  assert.throws(
    () => service.resources.acquire("other", a.id, other.id),
    /shared resources/,
  );
  assert.throws(
    () => service.resources.acquire("third", a.id, wf.id),
    /shared resources/,
  );
});
test("sibling folders are distinct while parents cover descendants", () => {
  const root = join(tmpdir(), "team");
  assert(contains(root, join(root, "a")));
  assert(!overlaps(join(root, "a"), join(root, "ab")));
  assert(!contains(root, join(root, "..", "escape")));
});

test("Preempt ranks ahead of aged work without changing legacy Max priorities", async (t) => {
  const { root, service, store, a, b, wf } = await fixture(t);
  const first = service.task({
    workflowId: wf.id,
    agentId: a.id,
    title: "First",
    completionCriteria: "Done",
  });
  const old = service.task({
    workflowId: wf.id,
    agentId: b.id,
    title: "Waiting",
    completionCriteria: "Done",
  });
  old.queuedAt = new Date(Date.now() - 86400000).toISOString();
  store.put("task", old);
  await service.resources.save({
    name: "Priority test",
    path: root,
    priorities: [
      { agentId: a.id, priority: 100 },
      { agentId: b.id, priority: 0 },
    ],
  });
  assert.equal(service.resources.ordered([first, old])[0].id, old.id);
  await service.resources.save({
    name: "Preempt test",
    path: root,
    priorities: [{ agentId: a.id, priority: 101 }],
  });
  assert.equal(service.resources.ordered([old, first])[0].id, first.id);
  service.resources.acquire("already-running", b.id, null);
  assert.throws(
    () => service.resources.acquire("preempt", a.id, null),
    /shared resources/,
  );
});
