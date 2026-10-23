import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { TeamService } from "../src/service.ts";
import { SkillCatalog } from "../src/skills.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Task } from "../src/model.ts";

async function waitFor(check: () => boolean) {
  const until = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < until, "fixture did not settle");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function world(t: any, write = false) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-execution-")),
  );
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([]));
  const agent = await service.saveAgent({
    name: "Worker",
    environment: "codex",
    workspaces: write
      ? [{ path: directory, access: "write", active: true }]
      : [],
  });
  const workflow = service.workflow({
    name: "Fixture",
    goal: "Test controls",
    ownerId: agent.id,
    completionCriteria: "done",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Work",
    completionCriteria: "done",
    ...(write ? { resourcePaths: [directory] } : {}),
  });
  const runs = new RunManager(service, true, directory);
  t.after(async () => {
    runs.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    service,
    runs,
    task,
    directory,
    status: () => store.get<Task>("task", task.id).status,
  };
}

test("wrap up drains active work without interrupting it, persists pause and holds queued dependents until resume", async (t) => {
  const w = await world(t);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let interrupted = false;
  const scheduler = new Scheduler(
    w.service,
    w.runs,
    async (_command, _environment, emit, signal) => {
      signal.addEventListener("abort", () => {
        interrupted = true;
      });
      await done;
      emit({ type: "text", data: "Finished current request" });
    },
  );
  const next = w.service.task({
    workflowId: w.task.workflowId,
    agentId: w.task.agentId,
    title: "Next",
    completionCriteria: "done",
    dependsOn: [w.task.id],
  });
  await scheduler.tick();
  await waitFor(() => w.status() === "running");
  assert.equal(w.runs.changeExecution("wrap-up").mode, "draining");
  assert.equal(interrupted, false);
  assert.equal(w.runs.executionState().readyToClose, false);
  finish();
  await waitFor(() => w.runs.active.size === 0);
  assert.equal(w.status(), "completed");
  assert.deepEqual(w.runs.executionState(), {
    mode: "paused",
    active: 0,
    readyToClose: true,
  });
  await scheduler.tick();
  assert.equal(w.store.get<Task>("task", next.id).status, "queued");
  assert.equal(w.store.get<any>("settings", "execution").enabled, false);
  w.runs.changeExecution("resume");
  await scheduler.tick();
  await waitFor(
    () => w.store.get<Task>("task", next.id).status === "completed",
  );
});

for (const write of [false, true])
  test(`pause immediately saves partial work and ${write ? "keeps uncertain writes in Recovery" : "resumes a safe interrupted task"}`, async (t) => {
    const w = await world(t, write);
    let started = false;
    const scheduler = new Scheduler(
      w.service,
      w.runs,
      async (_command, _environment, emit, signal) => {
        started = true;
        emit({ type: "text", data: "Partial work from this attempt" });
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("Interrupted")),
            { once: true },
          ),
        );
      },
    );
    await scheduler.tick();
    await waitFor(() => started);
    assert.equal(w.runs.changeExecution("pause-now").mode, "stopping");
    assert.throws(() => w.runs.changeExecution("resume"), {
      code: "execution_stopping",
    });
    await waitFor(() => w.runs.active.size === 0);
    assert.equal(w.status(), "interrupted");
    assert.match(w.store.get<Task>("task", w.task.id).result!, /Partial work/);
    assert.equal(w.runs.executionState().readyToClose, true);
    assert.equal(
      w.service.recovery.ledger.uncertainFor(w.task.id).length,
      write ? 1 : 0,
    );
    w.runs.changeExecution("resume");
    assert.equal(w.status(), write ? "interrupted" : "queued");
    if (write) assert.throws(() => w.service.recovery.requeue(w.task.id));
  });
