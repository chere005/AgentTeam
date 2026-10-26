import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./fixtures/execution-world.ts";
import type { Agent, Task } from "../src/model.ts";

// Recovery shows ONE typed decision and its button carries exactly that decision out: the same
// provider calls, the same attempt. These tests run the preview and then the action and compare.

const REFUSAL =
  "I couldn't do this task. I have no way to write files or run commands. Nothing was created, built, or run.";

async function writerWorld(t: Parameters<typeof world>[0]) {
  const w = await world(t);
  const folder = await w.folder("area");
  const agent = await w.service.saveAgent({
    name: "Writer",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const workflow = w.service.workflow({
    name: "Recovery",
    goal: "Write notes",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const create = (title = "Write notes.txt") =>
    w.service.task({
      workflowId: workflow.id,
      agentId: agent.id,
      title,
      completionCriteria: "Done",
    });
  return { w, folder, agent, workflow, create };
}

test("a failed task's retry is a new attempt and a provider call, even though the failed attempt's output was saved", async (t) => {
  const { w, create } = await writerWorld(t);
  const task = create();
  let calls = 0;
  w.setProvider(async (_c, _e, emit) => {
    calls++;
    emit({ type: "text", data: REFUSAL });
  });
  await w.until(() => w.store.get<Task>("task", task.id).status === "failed");
  assert.equal(calls, 1);
  const effect = w.service.recovery.ledger.list(task.id)[0];
  assert.equal(
    effect.state,
    "completed",
    "the provider run of attempt 1 completed",
  );

  const view = w.service.recovery.view(task.id);
  const decision = view.decision!;
  assert.equal(decision.kind, "new-attempt");
  assert.equal(decision.providerCall, true);
  assert.equal(decision.consumesAttempt, true);
  assert.deepEqual(decision.attempt, { current: 1, after: 2, max: 5 });
  assert.equal(decision.run?.key, `provider-run:${task.id}:2`);
  assert.equal(decision.run?.replay, false);
  assert.match(decision.summary, /Start attempt 2 of 5: a new provider call/);
  assert.match(decision.summary, /attempt 1's saved output stays as evidence/);
  // The panel no longer promises "no provider call" for the button that makes one.
  assert.doesNotMatch(view.next.join("\n"), /no provider call|Finalize/);
  assert.match(view.next[0], /Start attempt 2/);

  // The action does exactly what was shown.
  w.setProvider(async (_c, _e, emit) => {
    calls++;
    emit({ type: "text", data: "created and verified notes.txt" });
  });
  const { decision: executed } = w.service.recovery.requeueWithDecision(
    task.id,
  );
  assert.deepEqual(
    [executed.kind, executed.attempt, executed.providerCall],
    [decision.kind, decision.attempt, decision.providerCall],
  );
  assert.equal(
    w.service.recovery.state(task.id).attempt,
    decision.attempt.after,
  );
  await w.until(
    () => w.store.get<Task>("task", task.id).status === "completed",
  );
  assert.equal(calls, 2, "one new provider call, as announced");
  assert.equal(w.service.recovery.ledger.list(task.id).length, 2);
  // The failed attempt's output stays in the immutable checkpoint evidence.
  assert.ok(
    w.service.recovery
      .checkpoints(task.id)
      .some(
        (c) =>
          c.boundary === "task.failed" &&
          c.attempt === 1 &&
          String(c.data.result).trim() === REFUSAL,
      ),
  );
  assert.equal(
    w.service.recovery.view(task.id).decision,
    null,
    "nothing left to recover",
  );
});

test("an interrupted attempt whose output was saved is finalized with no provider call and no new attempt", async (t) => {
  const { w, create } = await writerWorld(t);
  const task = create();
  w.service.transitionTask(task.id, { status: "running" });
  const running = w.store.get<Task>("task", task.id);
  const run = w.service.recovery.startRun(running, true);
  w.service.recovery.finishRun(running, run.effectId, "saved output");
  w.service.recovery.recover(); // the app stopped before the transition
  assert.equal(w.store.get<Task>("task", task.id).status, "interrupted");

  const decision = w.service.recovery.view(task.id).decision!;
  assert.equal(decision.kind, "completion-only-replay");
  assert.equal(decision.providerCall, false);
  assert.equal(decision.consumesAttempt, false);
  assert.deepEqual(decision.attempt, { current: 1, after: 1, max: 5 });
  assert.equal(decision.run?.replay, true);
  assert.equal(decision.session, "none");
  assert.match(
    w.service.recovery.view(task.id).next[0],
    /Finalize from the saved provider output \(no provider call\)/,
  );

  let calls = 0;
  w.setProvider(async () => {
    calls++;
  });
  w.service.recovery.requeue(task.id);
  await w.until(
    () => w.store.get<Task>("task", task.id).status === "completed",
  );
  assert.equal(calls, 0, "no provider call, as announced");
  assert.equal(w.service.recovery.state(task.id).attempt, 1);
  assert.equal(
    w.store.get<Task>("task", task.id).result?.trim(),
    "saved output",
  );
});

test("an interrupted attempt without saved output is a provider call that uses no attempt; task-scoped runs start a fresh session", async (t) => {
  const { w, create, folder } = await writerWorld(t);
  const open = create();
  const scoped = w.service.task({
    workflowId: open.workflowId,
    agentId: open.agentId,
    title: "Scoped",
    completionCriteria: "Done",
    resourcePaths: [folder],
  });
  for (const task of [open, scoped]) {
    w.service.transitionTask(task.id, { status: "running" });
    w.service.recovery.observe(w.store.get<Task>("task", task.id), {
      type: "session",
      data: "sess-9",
    });
    w.service.transitionTask(task.id, { status: "interrupted" });
  }
  // `scoped` may not run beside `open` (same folder lease); judge the decisions first.
  const a = w.service.recovery.view(open.id).decision!;
  assert.equal(a.kind, "resume-run");
  assert.equal(a.providerCall, true);
  assert.equal(a.consumesAttempt, false);
  assert.equal(a.session, "resume");
  assert.equal(a.resumesSessionId, "sess-9");
  assert.deepEqual(a.attempt, { current: 1, after: 1, max: 5 });
  assert.match(
    w.service.recovery.view(open.id).next[0],
    /Resume provider session sess-9 \(attempt 1\)/,
  );
  const b = w.service.recovery.view(scoped.id).decision!;
  assert.equal(
    b.session,
    "fresh",
    "a task folder never resumes a session with broader access",
  );
  assert.equal(b.resumesSessionId, null);
  assert.match(
    w.service.recovery.view(scoped.id).next[0],
    /Re-run attempt 1 from the beginning/,
  );

  const commands: string[][] = [];
  w.setProvider(async (command, _e, emit) => {
    commands.push(command.args);
    emit({ type: "text", data: "resumed" });
  });
  w.service.recovery.requeue(open.id);
  await w.until(
    () => w.store.get<Task>("task", open.id).status === "completed",
  );
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes("--resume") && commands[0].includes("sess-9"));
  assert.equal(w.service.recovery.state(open.id).attempt, 1);
  w.service.recovery.requeue(scoped.id);
  await w.until(
    () => w.store.get<Task>("task", scoped.id).status === "completed",
  );
  assert.equal(commands.length, 2);
  assert.ok(
    !commands[1].includes("sess-9"),
    "a fresh session for the task folder",
  );
});

test("a delegating parent's continuation is a new run key in the same attempt", async (t) => {
  const w = await world(t);
  const folder = await w.folder("area");
  const manager = await w.service.saveAgent({
    name: "Manager",
    environment: "claude",
    roleType: "coordinator",
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  const worker = await w.service.saveAgent({
    name: "Worker",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  w.service.saveEdge({ from: manager.id, to: worker.id, kind: "delegate" });
  const workflow = w.service.workflow({
    name: "Delegation",
    goal: "Write notes",
    ownerId: manager.id,
    completionCriteria: "Done",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Coordinate",
    completionCriteria: "Done",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  const running = w.store.get<Task>("task", parent.id);
  const first = w.service.recovery.startRun(running, false);
  w.service.recovery.finishRun(running, first.effectId, "delegated");
  const child = w.service.orchestration.invokeTeammate(
    { agentId: manager.id, taskId: parent.id },
    { recipient: worker.id, title: "Write notes.txt" },
  ) as { childTaskId: string };
  assert.ok(w.service.delegations.defer(running, "delegated", folder));
  // While the child is unfinished the decision says the parent waits.
  const waiting = w.service.recovery.view(parent.id).decision!;
  assert.equal(waiting.kind, "delegation-continuation");
  assert.equal(waiting.allowed, false);
  assert.equal(waiting.blocker?.code, "delegated_work_pending");
  assert.throws(() => w.service.recovery.requeue(parent.id), {
    code: "delegated_work_pending",
  });
  // Finish the child: the continuation is now allowed, a provider call, the SAME attempt.
  w.service.transitionTask(child.childTaskId, { status: "running" });
  await w.service.limits.evaluate(
    w.store.get<Task>("task", child.childTaskId),
    "wrote it",
    folder,
  );
  w.service.transitionTask(child.childTaskId, {
    status: "completed",
    result: "wrote it",
  });
  const ready = w.service.recovery.view(parent.id).decision!;
  assert.equal(ready.kind, "delegation-continuation");
  assert.equal(ready.allowed, true);
  assert.equal(ready.providerCall, true);
  assert.equal(ready.consumesAttempt, false);
  assert.deepEqual(ready.attempt, { current: 1, after: 1, max: 5 });
  assert.deepEqual(ready.continuation, { current: 0, after: 1, max: 3 });
  assert.equal(ready.run?.key, `provider-run:${parent.id}:1:continuation:1`);
  assert.notEqual(ready.run?.key, first.effectId);
  let calls = 0;
  w.setProvider(async (command, _e, emit) => {
    calls++;
    assert.match(command.stdin, /Delegated work has finished/);
    emit({ type: "text", data: "all done" });
  });
  const { decision } = w.service.recovery.requeueWithDecision(parent.id);
  assert.equal(decision.kind, "delegation-continuation");
  await w.until(
    () => w.store.get<Task>("task", parent.id).status === "completed",
  );
  assert.equal(calls, 1);
  assert.equal(w.service.recovery.state(parent.id).attempt, 1);
  assert.equal(w.service.recovery.state(parent.id).continuation, 1);
  const keys = w.service.recovery.ledger
    .list(parent.id)
    .filter((e) => e.kind === "provider-run")
    .map((e) => e.key);
  assert.deepEqual(keys, [
    `provider-run:${parent.id}:1`,
    `provider-run:${parent.id}:1:continuation:1`,
  ]);
});

test("a possibly applied write is a decision for the user, never a replay", async (t) => {
  const { w, create } = await writerWorld(t);
  const task = create();
  w.service.transitionTask(task.id, { status: "running" });
  w.service.recovery.startRun(w.store.get<Task>("task", task.id), true);
  w.service.recovery.recover(); // restart while a mutating run was in flight
  assert.equal(w.store.get<Task>("task", task.id).status, "blocked");
  const view = w.service.recovery.view(task.id);
  const decision = view.decision!;
  assert.equal(decision.kind, "uncertain-effect-resolution");
  assert.equal(decision.allowed, false);
  assert.equal(decision.providerCall, false);
  assert.equal(decision.action, "decide-effect");
  assert.deepEqual(
    decision.outcomes?.map((o) => [o.decision, o.providerCall]),
    [
      ["retry", true],
      ["completed", false],
      ["abandon", false],
    ],
  );
  assert.match(view.next[0], /Decide on uncertain effect/);
  assert.throws(() => w.service.recovery.requeue(task.id), {
    code: "effect_uncertain",
  });
  w.service.recovery.ledger.decide(view.uncertainEffects[0].id, {
    decision: "retry",
    note: "nothing was written",
  });
  assert.equal(w.service.recovery.view(task.id).decision?.kind, "resume-run");
});

test("cancelling a parent names the delegated work it cancels; a failed leaf stays as evidence", async (t) => {
  const w = await world(t);
  const folder = await w.folder("area");
  const manager = await w.service.saveAgent({
    name: "Manager",
    environment: "claude",
    roleType: "coordinator",
  });
  const workers = [] as Agent[];
  for (const name of ["A", "B", "C"]) {
    const worker = await w.service.saveAgent({
      name,
      environment: "claude",
      roleType: "implementer",
      workspaces: [{ path: folder, access: "write", active: true }],
    });
    w.service.saveEdge({ from: manager.id, to: worker.id, kind: "delegate" });
    workers.push(worker);
  }
  const workflow = w.service.workflow({
    name: "Cascade",
    goal: "g",
    ownerId: manager.id,
    completionCriteria: "d",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Parent",
    completionCriteria: "d",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  const kids = workers.map(
    (worker) =>
      (
        w.service.orchestration.invokeTeammate(
          { agentId: manager.id, taskId: parent.id },
          { recipient: worker.id, title: `Work ${worker.name}` },
        ) as { childTaskId: string }
      ).childTaskId,
  );
  w.service.transitionTask(kids[0], { status: "running" });
  w.service.transitionTask(kids[0], { status: "failed", result: "broke" });
  assert.ok(
    w.service.delegations.defer(
      w.store.get<Task>("task", parent.id),
      "waiting",
      folder,
    ),
  );
  const decision = w.service.recovery.view(parent.id).decision!;
  assert.equal(decision.cancel.allowed, true);
  assert.deepEqual(
    decision.cancel.cascades.map((c) => c.taskId).sort(),
    [kids[1], kids[2]].sort(),
    "queued delegated work is cancelled with its parent; the failed leaf is not touched",
  );
  w.service.transitionTask(parent.id, { status: "cancelled" });
  assert.deepEqual(
    kids.map((id) => w.store.get<Task>("task", id).status),
    ["failed", "cancelled", "cancelled"],
  );
  // The failed leaf is offered its own Cancel/Dismiss decision data too.
  assert.equal(w.service.recovery.view(kids[0]).decision?.cancel.allowed, true);
});

test("a parent stopped on a setup-blocked leaf leads with that leaf and its one repair", async (t) => {
  const w = await world(t);
  const manager = await w.service.saveAgent({
    name: "Manager",
    environment: "claude",
    roleType: "coordinator",
  });
  const folderless = await w.service.saveAgent({
    name: "Folderless",
    environment: "claude",
    roleType: "implementer",
  });
  w.service.saveEdge({ from: manager.id, to: folderless.id, kind: "delegate" });
  const workflow = w.service.workflow({
    name: "Leaf",
    goal: "g",
    ownerId: manager.id,
    completionCriteria: "d",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Parent",
    completionCriteria: "d",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  // A leaf created before the capability gate existed (the old incident), blocked by the scheduler.
  const leaf = w.service.task({
    workflowId: workflow.id,
    agentId: folderless.id,
    title: "Leaf",
    completionCriteria: "d",
    invokedBy: manager.id,
    parentTaskId: parent.id,
  });
  w.setProvider(async () => {
    throw new Error("must not run");
  });
  await w.scheduler.tick();
  await w.settle();
  assert.equal(w.store.get<Task>("task", leaf.id).status, "blocked");
  assert.ok(
    w.service.delegations.defer(
      w.store.get<Task>("task", parent.id),
      "waiting",
      w.base,
    ),
  );
  const view = w.service.recovery.view(parent.id);
  assert.equal(view.rootCause?.taskId, leaf.id);
  assert.equal(view.rootCause?.kind, "setup");
  assert.equal(view.rootCause?.agentName, "Folderless");
  assert.equal(view.rootCause?.action?.kind, "choose-project-folder");
});

test("the recovery route returns the decision it executed", async (t) => {
  const { createApi } = await import("../src/http.ts");
  const { w, create } = await writerWorld(t);
  const task = create();
  w.setProvider(async (_c, _e, emit) => emit({ type: "text", data: REFUSAL }));
  await w.until(() => w.store.get<Task>("task", task.id).status === "failed");
  const server = createApi(w.service, "test-token", w.runs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const preview = await call("GET", `/tasks/${task.id}/recovery`);
  assert.equal(preview.body.decision.kind, "new-attempt");
  const overview = await call("GET", "/recovery");
  assert.equal(overview.body.tasks[0].decision.providerCall, true);
  const done = await call(
    "POST",
    `/tasks/${task.id}/retry-from-checkpoint`,
    {},
  );
  assert.equal(done.status, 202);
  assert.deepEqual(
    [
      done.body.executed.kind,
      done.body.executed.attempt,
      done.body.executed.providerCall,
    ],
    [
      preview.body.decision.kind,
      preview.body.decision.attempt,
      preview.body.decision.providerCall,
    ],
  );
  assert.equal(done.body.decision, null);
});
