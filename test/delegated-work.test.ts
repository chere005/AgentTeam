import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { TeamService } from "../src/service.ts";
import { SkillCatalog } from "../src/skills.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Message, Task } from "../src/model.ts";

async function setup(filename = ":memory:") {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-parent-")),
  );
  const store = new Store(filename);
  const service = new TeamService(store, new SkillCatalog([]));
  const parentAgent = await service.saveAgent({
    name: "Manager",
    environment: "claude",
    roleType: "coordinator",
    workspaces: [{ path: dir, access: "read", active: true }],
  });
  const childAgent = await service.saveAgent({
    name: "Worker",
    environment: "claude",
    tools: ["read", "write"],
    workspaces: [{ path: dir, access: "write", active: true }],
  });
  service.saveEdge({
    from: parentAgent.id,
    to: childAgent.id,
    kind: "delegate",
  });
  const workflow = service.workflow({
    name: "Roll call",
    ownerId: parentAgent.id,
    goal: "Create the worker's roll-call file",
    completionCriteria: "File has the expected content",
  });
  const parent = service.task({
    workflowId: workflow.id,
    agentId: parentAgent.id,
    title: "Coordinate roll call",
    completionCriteria: "The actual roll-call file is verified",
    completionChecks: [
      {
        type: "artifact-matches",
        path: "worker.txt",
        pattern: "^Worker reporting for duty\\.$",
      },
    ],
  });
  return { dir, store, service, parentAgent, childAgent, workflow, parent };
}
async function until(
  runs: RunManager,
  scheduler: Scheduler,
  ready: () => boolean,
) {
  for (let i = 0; i < 500; i++) {
    await scheduler.tick();
    if (ready() && runs.active.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(
    "Fixture did not reach its expected stopped state: " +
      JSON.stringify(
        runs.service.store
          .list<Task>("task")
          .map((t) => ({ id: t.id, status: t.status, result: t.result })),
      ),
  );
}

test("a parent releases its lease, waits for real child artifacts, then continues once", async () => {
  const w = await setup();
  const runs = new RunManager(w.service, true, w.dir);
  runs.prepareExecutableChats = false;
  let parentCalls = 0,
    childCalls = 0;
  let childId = "";
  const scheduler = new Scheduler(
    w.service,
    runs,
    async (command, _environment, emit) => {
      if (
        command.args[command.args.indexOf("--tools") + 1]
          ?.split(",")
          .includes("Write")
      ) {
        childCalls++;
        assert.equal(w.store.get<Task>("task", w.parent.id).status, "blocked");
        assert.equal(w.service.activity(w.parentAgent.id).state, "waiting");
        assert.deepEqual(
          w.service.activity(w.parentAgent.id).interruptedTaskIds,
          [],
        );
        assert.deepEqual(w.service.activity(w.parentAgent.id).waitingTaskIds, [
          w.parent.id,
        ]);
        assert.ok(
          !w.store
            .list<{ id: string }>("lease")
            .some((lease) => lease.id === w.parent.id),
        );
        await writeFile(
          join(w.dir, "worker.txt"),
          "Worker reporting for duty.",
        );
        emit({ type: "text", data: "The worker file was created." });
      } else {
        parentCalls++;
        if (parentCalls === 1) {
          childId = w.service.orchestration.invokeTeammate(
            { agentId: w.parentAgent.id, taskId: w.parent.id },
            {
              recipient: w.childAgent.id,
              title: "Write roll-call file",
              completionCriteria: "Correct file content",
              completionChecks: [
                {
                  type: "artifact-matches",
                  path: "worker.txt",
                  pattern: "^Worker reporting for duty\\.$",
                },
              ],
            },
          ).childTaskId;
          emit({
            type: "text",
            data: "None of the roll-call files exist yet. All three tasks are queued, but nothing has run.",
          });
        } else {
          assert.equal(parentCalls, 2, "one continuation only");
          assert.match(command.stdin, /Delegated work has finished/);
          emit({
            type: "text",
            data: "The worker's roll-call file is present and its contents have been verified.",
          });
        }
      }
    },
  );
  try {
    await until(
      runs,
      scheduler,
      () => w.store.get<Task>("task", w.parent.id).status === "completed",
    );
    assert.equal(w.store.get<Task>("task", childId).status, "completed");
    assert.equal(w.service.workflowStatus(w.workflow.id).status, "completed");
    assert.equal(parentCalls, 2);
    assert.equal(childCalls, 1);
    assert.equal(w.service.recovery.state(w.parent.id).attempt, 1);
    assert.equal(w.service.recovery.state(w.parent.id).continuation, 1);
    const effects = w.service.recovery.ledger
      .list(w.parent.id)
      .filter((effect) => effect.kind === "provider-run");
    assert.equal(effects.length, 2);
    assert.equal(new Set(effects.map((effect) => effect.key)).size, 2);
    assert.ok(effects.every((effect) => effect.state === "completed"));
    assert.equal(w.store.list("delegation-wait").length, 0);
    for (let i = 0; i < 3; i++) await scheduler.tick();
    assert.equal(parentCalls, 2);
  } finally {
    scheduler.stop();
    w.store.close();
    await rm(w.dir, { recursive: true, force: true });
  }
});

test("failed delegated work stays blocked across restart; repair resumes without replaying the first turn", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "agentteam-parent-db-"));
  const filename = join(dbDir, "state.sqlite");
  const w = await setup(filename);
  let service = w.service,
    store = w.store;
  let scheduler: Scheduler | undefined;
  try {
    service.transitionTask(w.parent.id, { status: "running" });
    const child = service.orchestration.invokeTeammate(
      { agentId: w.parentAgent.id, taskId: w.parent.id },
      {
        recipient: w.childAgent.id,
        title: "Write roll-call file",
        completionCriteria: "Correct file content",
        completionChecks: [
          {
            type: "artifact-matches",
            path: "worker.txt",
            pattern: "^Worker reporting for duty\\.$",
          },
        ],
      },
    );
    const initial = service.recovery.startRun(w.parent, false);
    service.recovery.finishRun(
      w.parent,
      initial.effectId,
      "The worker is queued.",
    );
    assert.equal(
      service.delegations.defer(w.parent, "The worker is queued.", w.dir),
      true,
    );
    service.transitionTask(child.childTaskId, { status: "running" });
    service.transitionTask(child.childTaskId, {
      status: "failed",
      result: "Required sandbox unavailable",
    });
    assert.equal(service.activity(w.parentAgent.id).state, "blocked");
    assert.deepEqual(service.activity(w.parentAgent.id).blockedTaskIds, [
      w.parent.id,
    ]);
    assert.throws(
      () =>
        service.transitionTask(w.parent.id, {
          status: "completed",
          result: "Done",
        }),
      { code: "delegated_work_pending" },
    );
    assert.throws(() => service.recovery.requeue(w.parent.id), {
      code: "delegated_work_pending",
    });
    store.close();
    store = new Store(filename);
    service = new TeamService(store, new SkillCatalog([]));
    service.recovery.recover();
    assert.equal(service.taskState(w.parent.id).delegation?.state, "blocked");
    await service.delegations.sweep();
    assert.equal(store.get<Task>("task", w.parent.id).status, "blocked");
    service.recovery.requeue(child.childTaskId);
    let parentCalls = 0,
      childCalls = 0;
    const runs = new RunManager(service, true, w.dir);
    runs.prepareExecutableChats = false;
    scheduler = new Scheduler(service, runs, async (command, _env, emit) => {
      if (
        command.args[command.args.indexOf("--tools") + 1]
          ?.split(",")
          .includes("Write")
      ) {
        childCalls++;
        await writeFile(
          join(w.dir, "worker.txt"),
          "Worker reporting for duty.",
        );
        emit({ type: "text", data: "Created worker.txt" });
      } else {
        parentCalls++;
        assert.match(command.stdin, /Delegated work has finished/);
        emit({
          type: "text",
          data: "The worker file has been independently checked.",
        });
      }
    });
    await until(
      runs,
      scheduler,
      () => store.get<Task>("task", w.parent.id).status === "completed",
    );
    assert.equal(parentCalls, 1);
    assert.equal(childCalls, 1);
    assert.equal(service.recovery.state(w.parent.id).attempt, 1);
    assert.equal(service.recovery.state(child.childTaskId).attempt, 2);
    assert.equal(service.recovery.ledger.list(w.parent.id).length, 2);
  } finally {
    scheduler?.stop();
    store.close();
    await rm(w.dir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("changed child artifacts keep the parent stopped until fresh evidence passes", async () => {
  const w = await setup();
  try {
    w.service.transitionTask(w.parent.id, { status: "running" });
    const child = w.service.orchestration.invokeTeammate(
      { agentId: w.parentAgent.id, taskId: w.parent.id },
      {
        recipient: w.childAgent.id,
        title: "Write roll-call file",
        completionCriteria: "Correct file content",
        completionChecks: [
          {
            type: "artifact-matches",
            path: "worker.txt",
            pattern: "^Worker reporting for duty\\.$",
          },
        ],
      },
    );
    w.service.delegations.defer(w.parent, "Waiting for the worker", w.dir);
    w.service.transitionTask(child.childTaskId, { status: "running" });
    await writeFile(join(w.dir, "worker.txt"), "Worker reporting for duty.");
    const task = w.store.get<Task>("task", child.childTaskId);
    await w.service.limits.evaluate(task, "Created worker.txt", w.dir);
    w.service.transitionTask(task.id, {
      status: "completed",
      result: "Created worker.txt",
    });
    await writeFile(join(w.dir, "worker.txt"), "wrong identity");
    await w.service.delegations.sweep();
    assert.equal(w.store.get<Task>("task", w.parent.id).status, "blocked");
    assert.equal(w.service.taskDependencySatisfied(task.id), false);
    assert.equal(w.service.taskState(w.parent.id).delegation?.state, "blocked");
    await writeFile(join(w.dir, "worker.txt"), "Worker reporting for duty.");
    // A refreshed artifact check must be able to restore a previously invalidated completion.
    await w.service.delegations.sweep();
    assert.equal(w.store.get<Task>("task", w.parent.id).status, "queued");
  } finally {
    w.store.close();
    await rm(w.dir, { recursive: true, force: true });
  }
});

test("a chat manager's early reply waits for its child and publishes one final continuation", async () => {
  const w = await setup();
  w.service.transitionTask(w.parent.id, { status: "cancelled" });
  const runs = new RunManager(w.service, true, w.dir);
  runs.prepareExecutableChats = false;
  runs.teammateToolsUrl = () => "http://127.0.0.1:1/mcp"; // No network: fixture uses the policy service.
  let managerCalls = 0;
  let managerToken = "";
  let parentId = "";
  const execute: RunManager["execute"] = async (
    command,
    _environment,
    emit,
  ) => {
    if (
      command.args[command.args.indexOf("--tools") + 1]
        ?.split(",")
        .includes("Write")
    ) {
      await writeFile(join(w.dir, "worker.txt"), "Worker reporting for duty.");
      emit({
        type: "text",
        data: "Created worker.txt with the requested identity.",
      });
      return;
    }
    managerCalls++;
    if (managerCalls === 1) {
      assert.ok(command.teammateTools);
      managerToken = command.teammateTools.token;
      parentId = w.store
        .list<Task>("task")
        .find(
          (task) =>
            task.agentId === w.parentAgent.id && task.status === "running",
        )!.id;
      emit({ type: "session", data: "fixture-chat-manager" });
      w.service.orchestration.invokeTeammate(
        { agentId: w.parentAgent.id, taskId: parentId },
        {
          recipient: w.childAgent.id,
          title: "Write roll-call file",
          completionCriteria: "Expected file content",
          completionChecks: [
            {
              type: "artifact-matches",
              path: "worker.txt",
              pattern: "^Worker reporting for duty\\.$",
            },
          ],
        },
      );
      emit({
        type: "text",
        data: "None of the roll-call files exist yet. All three tasks are queued, but nothing has run.",
      });
    } else {
      assert.equal(managerCalls, 2);
      assert.match(command.stdin, /Delegated work has finished/);
      emit({
        type: "text",
        data: "The worker roll-call file is now verified and complete.",
      });
    }
  };
  runs.execute = execute;
  const scheduler = new Scheduler(w.service, runs, execute);
  const session = w.service.session(w.parentAgent.id);
  // The expected content comes from the user's own words, so the literal check is enforced.
  w.service.message(session.id, {
    text: "Have the worker create its roll-call file containing: Worker reporting for duty.",
  });
  try {
    await runs.start(session.id);
    await until(
      runs,
      scheduler,
      () =>
        !!parentId &&
        w.store.get<Task>("task", parentId).status === "completed",
    );
    const messages = w.store
      .list<Message>("message")
      .filter(
        (message) =>
          message.sessionId === session.id && message.role === "assistant",
      );
    assert.equal(messages.length, 2);
    assert.match(messages[0].text, /nothing has run/);
    assert.match(messages[1].text, /now verified and complete/);
    assert.equal(managerCalls, 2);
    assert.equal(
      w.store.list("invocation").length,
      1,
      "the original child wasn't delegated again",
    );
    assert.equal(
      w.service.recovery.state(parentId).providerSessionId,
      "fixture-chat-manager",
    );
    assert.throws(() => runs.toolSessions.authenticate(managerToken), {
      code: "unauthorized",
    });
  } finally {
    scheduler.stop();
    w.store.close();
    await rm(w.dir, { recursive: true, force: true });
  }
});
