import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { ReadinessService, type DiscoveryLike } from "../src/readiness.ts";
import type { Message, Session, Task } from "../src/model.ts";
import type { RuntimeWait } from "../src/runtime-waits.ts";
import { AppError } from "../src/model.ts";
import { toProviderError } from "../src/provider-errors.ts";

const discovery: DiscoveryLike = {
  runtimes: [],
  settled: true,
  scanning: false,
  refresh: async () => [],
  readiness: () => ({ state: "ready" }),
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-sandbox-startup-"));
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const input = {
    name: "Writer",
    environment: "claude",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: dir, access: "write", active: true }],
  };
  const agent = await service.saveAgent(input);
  const runs = new RunManager(service, true, dir);
  runs.runtimePlatform = "win32";
  runs.readiness = () => ({ state: "ready" });
  const readiness = new ReadinessService({
    service,
    discovery,
    runs,
    platform: "win32",
  }).start();
  let calls = 0;
  const execute: RunManager["execute"] = async (
    _command,
    _environment,
    emit,
  ) => {
    calls++;
    emit({ type: "text", data: "File tools ran successfully" });
  };
  runs.execute = execute;
  const scheduler = new Scheduler(service, runs, execute);
  return {
    store,
    service,
    agent,
    input,
    runs,
    readiness,
    scheduler,
    calls: () => calls,
    close: async () => {
      scheduler.stop();
      readiness.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function stopped(runs: RunManager) {
  for (let i = 0; i < 100 && runs.active.size; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runs.active.size, 0, "fixture provider execution stopped");
}

test("scheduler blocks unsupported Claude shell before any provider/effect and resumes once after tool repair", async () => {
  const w = await fixture();
  try {
    const workflow = w.service.workflow({
      name: "Write",
      ownerId: w.agent.id,
      goal: "Write a file",
      completionCriteria: "Created",
    });
    const task = w.service.task({
      workflowId: workflow.id,
      agentId: w.agent.id,
      title: "Write a file",
      completionCriteria: "Created",
    });
    await w.scheduler.tick();
    await stopped(w.runs);
    assert.equal(w.calls(), 0);
    assert.equal(w.store.list("effect").length, 0);
    assert.equal(w.store.list("lease").length, 0);
    assert.equal(w.store.get<Task>("task", task.id).status, "blocked");
    assert.equal(
      w.service.taskState(task.id).runtimeBlocker?.code,
      "sandbox_unavailable",
    );
    assert.equal(
      w.store.list<RuntimeWait>("runtime-wait")[0].reason,
      "sandbox-unavailable",
    );
    assert.equal(w.service.recovery.view(task.id).retry.allowed, false);
    assert.match(w.service.recovery.view(task.id).next[0], /sandbox/i);
    const checkpointsBefore = w.service.recovery.checkpoints(task.id).length;
    for (let i = 0; i < 3; i++) {
      assert.throws(() => w.service.recovery.requeue(task.id), {
        code: "runtime_capability_blocked",
      });
    }
    assert.equal(
      w.service.recovery.checkpoints(task.id).length,
      checkpointsBefore,
    );
    assert.equal(w.service.recovery.state(task.id).attempt, 1);
    for (let i = 0; i < 3; i++) {
      w.store.emit("runtimes.discovered", "runtimes");
      w.readiness.flush();
      await w.scheduler.tick();
    }
    assert.equal(
      w.calls(),
      0,
      "unchanged capability must not cause retry loops",
    );
    await w.service.saveAgent(
      { ...w.input, tools: ["read", "write"] },
      w.agent.id,
    );
    w.readiness.flush();
    assert.equal(w.store.get<Task>("task", task.id).status, "queued");
    await w.scheduler.tick();
    await stopped(w.runs);
    assert.equal(w.calls(), 1);
    assert.equal(w.store.get<Task>("task", task.id).status, "completed");
    assert.equal(w.service.recovery.state(task.id).attempt, 1);
    await w.scheduler.tick();
    assert.equal(w.calls(), 1);
  } finally {
    await w.close();
  }
});

test("queued chat records a sandbox blocker without consuming messages, and repair delivers them once", async () => {
  const w = await fixture();
  try {
    const session = w.service.session(w.agent.id);
    const message = w.service.message(session.id, { text: "Create the file" });
    await w.runs.start(session.id);
    await w.scheduler.tick();
    await stopped(w.runs);
    assert.equal(w.calls(), 0);
    assert.equal(w.store.list("effect").length, 0);
    assert.equal(w.store.list("lease").length, 0);
    assert.equal(w.store.get<Session>("session", session.id).state, "idle");
    assert.equal(w.store.get<Message>("message", message.id).status, "queued");
    assert.equal(w.store.list("run-request").length, 0);
    assert.equal(
      w.store.list<RuntimeWait>("runtime-wait")[0].reason,
      "sandbox-unavailable",
    );
    w.readiness.flush();
    await w.scheduler.tick();
    assert.equal(w.calls(), 0);
    await w.service.saveAgent(
      { ...w.input, tools: ["read", "write"] },
      w.agent.id,
    );
    w.readiness.flush();
    await w.scheduler.tick();
    await stopped(w.runs);
    assert.equal(w.calls(), 1);
    assert.equal(
      w.store.get<Message>("message", message.id).status,
      "delivered",
    );
    assert.equal(
      w.store
        .list<Message>("message")
        .filter((m) => m.sessionId === session.id && m.role === "assistant")
        .length,
      1,
    );
    assert.equal(w.store.list("runtime-wait").length, 0);
    assert.deepEqual(w.readiness.requeueReady(), []);
    await w.scheduler.tick();
    assert.equal(w.calls(), 1);
  } finally {
    await w.close();
  }
});

test("a sandbox failure after a mutating launch stays behind uncertain-effect recovery", async () => {
  const w = await fixture();
  try {
    w.runs.runtimePlatform = "linux";
    let launched = 0;
    w.scheduler.executeProvider = async () => {
      launched++;
      throw toProviderError(
        new AppError(
          502,
          "sandbox_unavailable",
          "Sandbox required but unavailable",
        ),
      );
    };
    const workflow = w.service.workflow({
      name: "Write",
      ownerId: w.agent.id,
      goal: "Write",
      completionCriteria: "Created",
    });
    const task = w.service.task({
      workflowId: workflow.id,
      agentId: w.agent.id,
      title: "Write",
      completionCriteria: "Created",
    });
    await w.scheduler.tick();
    await stopped(w.runs);
    assert.equal(launched, 1);
    assert.equal(w.store.get<Task>("task", task.id).status, "failed");
    assert.equal(
      w.store.list("runtime-wait").length,
      0,
      "provider output cannot create a pre-process wait",
    );
    assert.equal(w.service.recovery.ledger.uncertainFor(task.id).length, 1);
    await w.service.saveAgent(
      { ...w.input, tools: ["read", "write"] },
      w.agent.id,
    );
    w.readiness.flush();
    await w.scheduler.tick();
    assert.equal(launched, 1);
    assert.throws(() => w.service.recovery.requeue(task.id), {
      code: "effect_uncertain",
    });
  } finally {
    await w.close();
  }
});
