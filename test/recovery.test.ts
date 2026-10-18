import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createApi } from "../src/http.ts";
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  retryPolicySchema,
} from "../src/checkpoints.ts";
import type { Message, Session, Task } from "../src/model.ts";

type Provider = ConstructorParameters<typeof Scheduler>[2];
const hang: Provider = () => new Promise(() => undefined);
const flush = () => new Promise((r) => setImmediate(r));

/** Opens (or reopens) the same SQLite file: reopening is the crash/restart simulation. */
function boot(path: string, provider?: Provider) {
  const store = new Store(path),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd()),
    scheduler = new Scheduler(service, runs, provider);
  return { store, service, runs, scheduler };
}
/** What the real app does on startup (without the polling timer). */
function startup(b: ReturnType<typeof boot>) {
  b.runs.recover();
  b.scheduler.start();
  b.scheduler.stop();
  b.scheduler.stopped = false;
}
async function dir() {
  return mkdtemp(join(tmpdir(), "agentteam-recovery-"));
}
const statusOf = (b: ReturnType<typeof boot>, id: string) =>
  b.store.get<Task>("task", id).status;
const leases = (b: ReturnType<typeof boot>) =>
  b.store.list<{ id: string; agentId: string }>("lease");

async function world(b: ReturnType<typeof boot>, agentExtra: object = {}) {
  const lead = await b.service.saveAgent({
    name: "Lead",
    environment: "codex",
  });
  const agent = await b.service.saveAgent({
    name: "Worker",
    environment: "codex",
    ...agentExtra,
  });
  const wf = b.service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  const task = (agentId: string, extra: object = {}) =>
    b.service.task({
      workflowId: wf.id,
      agentId,
      title: "T",
      completionCriteria: "D",
      ...extra,
    });
  return { lead, agent, wf, task };
}
async function writable(name: string) {
  const root = await dir();
  const path = join(root, name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path);
  return { root, path: await realpath(path) };
}

test("provider execution crash: completed stays completed, running becomes resumable with its session", async () => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  let b = boot(db, async (_c, _e, emit) => {
    emit({ type: "session", data: "sess-1" });
    emit({ type: "text", data: "dep done" });
  });
  const w = await world(b);
  const dep = w.task(w.agent.id, { title: "Dep" });
  await b.scheduler.tick();
  await flush();
  assert.equal(statusOf(b, dep.id), "completed");
  const worker2 = await b.service.saveAgent({
    name: "W2",
    environment: "codex",
  });
  const main = w.task(worker2.id, { title: "Main", dependsOn: [dep.id] });
  b.scheduler.executeProvider = async (_c, _e, emit) => {
    emit({ type: "session", data: "sess-2" });
    emit({
      type: "tool",
      data: {
        toolCallId: "t1",
        kind: "read",
        status: "completed",
        title: "read file",
      },
    });
    await new Promise(() => undefined);
  };
  await b.scheduler.tick();
  assert.equal(statusOf(b, main.id), "running");
  assert.equal(leases(b).length, 1);
  // crash
  b.store.close();
  b = boot(db, hang);
  const calls: { args: string[] }[] = [];
  b.scheduler.executeProvider = async (command, _e, emit) => {
    calls.push(command);
    emit({ type: "text", data: "main done" });
  };
  startup(b);
  assert.equal(
    statusOf(b, dep.id),
    "completed",
    "completed work is not touched",
  );
  assert.equal(b.store.get<Task>("task", dep.id).result?.trim(), "dep done");
  assert.equal(statusOf(b, main.id), "interrupted");
  assert.equal(leases(b).length, 0, "dead process lease released");
  const view = b.service.recovery.view(main.id);
  assert.equal(view.checkpoint?.boundary, "task.interrupted");
  assert.equal(view.providerSessionId, "sess-2");
  assert.match(view.next[0], /Resume provider session sess-2/);
  assert.deepEqual(b.store.get<Task>("task", main.id).dependsOn, [dep.id]);
  // nothing runs by itself: interrupted work waits for an explicit resume
  await b.scheduler.tick();
  assert.equal(calls.length, 0);
  // checkpoints are immutable evidence
  const cp = b.service.recovery.checkpoints(main.id);
  assert.ok(cp.some((c) => c.boundary === "provider.session"));
  assert.ok(cp.some((c) => c.boundary === "tool"));
  assert.throws(() =>
    b.store.db
      .prepare("UPDATE entities SET data='{}' WHERE kind='checkpoint'")
      .run(),
  );
  assert.throws(() =>
    b.store.db.prepare("DELETE FROM entities WHERE kind='checkpoint'").run(),
  );
  b.service.recovery.requeue(main.id);
  assert.equal(statusOf(b, main.id), "queued");
  await b.scheduler.tick();
  await flush();
  assert.equal(
    calls.length,
    1,
    "only the interrupted step runs; the dependency is not re-run",
  );
  assert.ok(
    calls[0].args.includes("resume") && calls[0].args.includes("sess-2"),
  );
  assert.equal(statusOf(b, main.id), "completed");
  // recovery is idempotent
  const before = b.service.recovery.checkpoints(main.id).length;
  startup(b);
  assert.equal(b.service.recovery.checkpoints(main.id).length, before);
  b.store.close();
  await rm(root, { recursive: true });
});

test("uncertain mutating effect blocks the task until the user decides", async () => {
  const ws = await writable("repo"),
    db = join(ws.root, "t.sqlite");
  let b = boot(db, hang);
  const w = await world(b, {
    workspaces: [{ path: ws.path, access: "write", active: true }],
  });
  const t = w.task(w.agent.id);
  await b.scheduler.tick();
  assert.equal(statusOf(b, t.id), "running");
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(statusOf(b, t.id), "blocked");
  const view = b.service.recovery.view(t.id);
  assert.equal(view.uncertainEffects.length, 1);
  assert.match(view.next[0], /Decide on uncertain effect/);
  assert.throws(() => b.service.recovery.requeue(t.id), /uncertain/);
  await assert.rejects(
    async () =>
      b.service.recovery.ledger.decide(view.uncertainEffects[0].id, {
        decision: "completed",
      }),
    /Provide the result/,
  );
  let calls = 0;
  b.scheduler.executeProvider = async (_c, _e, emit) => {
    calls++;
    emit({ type: "text", data: "redone" });
  };
  b.service.recovery.ledger.decide(view.uncertainEffects[0].id, {
    decision: "retry",
    note: "nothing was written",
  });
  assert.equal(statusOf(b, t.id), "interrupted");
  b.service.recovery.requeue(t.id);
  await b.scheduler.tick();
  await flush();
  assert.equal(calls, 1);
  assert.equal(statusOf(b, t.id), "completed");
  b.store.close();
  await rm(ws.root, { recursive: true });
});

test("an abort while the run context is prepared never records or starts a provider run", async () => {
  const ws = await writable("repo"),
    db = join(ws.root, "t.sqlite");
  let calls = 0;
  const b = boot(db, async (_c, _e, emit) => {
    calls++;
    emit({ type: "text", data: "ran" });
  });
  const w = await world(b, {
    workspaces: [{ path: ws.path, access: "write", active: true }],
  });
  // An included knowledge source makes run-context preparation asynchronous (file system reads).
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(ws.path, "notes.md"), "zebra notes\n");
  const { capabilitiesFor } = await import("../src/run-context.ts");
  await capabilitiesFor(b.service).knowledge.create(w.agent.id, {
    name: "N",
    folder: ws.path,
    include: true,
  });
  const t = w.task(w.agent.id, { instructions: "zebra" });
  await b.scheduler.tick();
  assert.equal(statusOf(b, t.id), "running");
  // The task is still preparing its context: abort it now (what a limit trip does).
  assert.equal(b.service.limits.abortTask(t.id), true);
  for (let i = 0; i < 200 && statusOf(b, t.id) === "running"; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.notEqual(statusOf(b, t.id), "running");
  assert.notEqual(statusOf(b, t.id), "blocked");
  assert.equal(calls, 0, "the provider never started");
  assert.equal(
    b.service.recovery.ledger.list().filter((e) => e.taskId === t.id).length,
    0,
    "no provider-run effect was recorded, so nothing can be left uncertain",
  );
  b.store.close();
  await rm(ws.root, { recursive: true });
});

test("user can mark an uncertain run applied (no provider call) or abandon it", async () => {
  const ws = await writable("repo"),
    db = join(ws.root, "t.sqlite");
  let b = boot(db, hang);
  const w = await world(b, {
    workspaces: [{ path: ws.path, access: "write", active: true }],
  });
  const t1 = w.task(w.agent.id);
  await b.scheduler.tick();
  b.store.close();
  b = boot(db);
  startup(b);
  let calls = 0;
  b.scheduler.executeProvider = async () => {
    calls++;
  };
  const eff = b.service.recovery.ledger.uncertainFor(t1.id)[0];
  b.service.recovery.ledger.decide(eff.id, {
    decision: "completed",
    result: "applied by hand",
  });
  b.service.recovery.requeue(t1.id);
  await b.scheduler.tick();
  await flush();
  assert.equal(
    calls,
    0,
    "a decided-completed effect is replayed, never repeated",
  );
  assert.equal(b.store.get<Task>("task", t1.id).result, "applied by hand");
  assert.equal(statusOf(b, t1.id), "completed");
  // abandon
  const t2 = b.service.task({
    workflowId: w.wf.id,
    agentId: w.agent.id,
    title: "second",
    completionCriteria: "D",
  });
  b.scheduler.executeProvider = hang;
  await b.scheduler.tick();
  b.store.close();
  b = boot(db);
  startup(b);
  const eff2 = b.service.recovery.ledger.uncertainFor(t2.id)[0];
  b.service.recovery.ledger.decide(eff2.id, { decision: "abandon" });
  assert.equal(statusOf(b, t2.id), "cancelled");
  b.store.close();
  await rm(ws.root, { recursive: true });
});

test("provider output saved before the crash is finalized without calling the provider again", async () => {
  const ws = await writable("repo"),
    db = join(ws.root, "t.sqlite");
  let b = boot(db);
  const w = await world(b, {
    workspaces: [{ path: ws.path, access: "write", active: true }],
  });
  const t = w.task(w.agent.id);
  b.service.transitionTask(t.id, { status: "running" });
  const run = b.service.recovery.startRun(
    b.store.get<Task>("task", t.id),
    true,
  );
  b.service.recovery.finishRun(
    b.store.get<Task>("task", t.id),
    run.effectId,
    "saved output",
  );
  b.store.close(); // crash before the completed transition
  b = boot(db);
  startup(b);
  assert.equal(statusOf(b, t.id), "interrupted");
  assert.match(
    b.service.recovery.view(t.id).next[0],
    /Finalize from the saved provider output/,
  );
  let calls = 0;
  b.scheduler.executeProvider = async () => {
    calls++;
  };
  b.service.recovery.requeue(t.id);
  await b.scheduler.tick();
  await flush();
  assert.equal(calls, 0);
  assert.equal(b.store.get<Task>("task", t.id).result?.trim(), "saved output");
  assert.equal(statusOf(b, t.id), "completed");
  b.store.close();
  await rm(ws.root, { recursive: true });
});

test("delegation crash preserves invoker, parent, dependencies and delivers the handoff exactly once", async () => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  let b = boot(db, hang);
  const lead = await b.service.saveAgent({
    name: "Lead",
    environment: "codex",
    maxConcurrentInvocations: 1,
  });
  const child = await b.service.saveAgent({
    name: "Child",
    environment: "codex",
  });
  b.service.saveEdge({ from: lead.id, to: child.id, kind: "delegate" });
  const wf = b.service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  const parent = b.service.task({
    workflowId: wf.id,
    agentId: lead.id,
    title: "Parent",
    completionCriteria: "D",
  });
  b.service.transitionTask(parent.id, { status: "running" });
  const dep = b.service.task({
    workflowId: wf.id,
    agentId: lead.id,
    title: "Dep",
    completionCriteria: "D",
  });
  const c = b.service.task({
    workflowId: wf.id,
    agentId: child.id,
    invokedBy: lead.id,
    parentTaskId: parent.id,
    title: "Child",
    completionCriteria: "D",
  });
  b.service.transitionTask(c.id, { status: "running" });
  b.store.close();
  b = boot(db);
  startup(b);
  const p = b.store.get<Task>("task", c.id);
  assert.equal(p.status, "interrupted");
  assert.equal(p.invokedBy, lead.id);
  assert.equal(p.parentTaskId, parent.id);
  assert.equal(b.store.get<Task>("task", parent.id).status, "interrupted");
  assert.equal(b.store.get<Task>("task", dep.id).status, "queued");
  assert.equal(
    b.service.capacity(lead.id).running,
    0,
    "interrupted work holds no invocation slot",
  );
  assert.equal(leases(b).length, 0);
  const limitsBefore = b.service.limits.state(wf.id).counters;
  b.scheduler.executeProvider = async (_c, _e, emit) =>
    emit({ type: "text", data: "child result" });
  b.service.recovery.requeue(c.id);
  assert.equal(
    b.service.limits.state(wf.id).counters.retries,
    limitsBefore.retries,
    "resuming after a crash does not spend retry budget",
  );
  await b.scheduler.tick();
  await flush();
  assert.equal(statusOf(b, c.id), "completed");
  const flows = b.store
    .history(0, 10_000)
    .filter(
      (e) =>
        e.type === "flow.transferred" &&
        (e.data as any).taskId === c.id &&
        (e.data as any).kind === "result",
    );
  assert.equal(flows.length, 1);
  assert.equal(
    b.service.limits.state(wf.id).counters.handoffs,
    limitsBefore.handoffs + 1,
    "one result handoff, none for the crash or resume",
  );
  b.store.close();
  await rm(root, { recursive: true });
});

test("feedback delivery: an unstarted run request survives restart and runs once; a mutating in-flight chat run needs a decision", async () => {
  const ws = await writable("repo"),
    db = join(ws.root, "t.sqlite");
  let b = boot(db);
  const agent = await b.service.saveAgent({
    name: "Dev",
    environment: "codex",
    workspaces: [{ path: ws.path, access: "write", active: true }],
  });
  const session = b.service.session(agent.id);
  const queued = b.service.message(session.id, {
    text: "Please address review comment",
  });
  await b.runs.start(session.id); // queues a run request (feedback delivery)
  assert.equal(b.store.list("run-request").length, 1);
  b.store.close();
  b = boot(db);
  b.runs.recover();
  assert.equal(b.store.list("run-request").length, 1, "request not lost");
  assert.equal(b.store.get<Message>("message", queued.id).status, "queued");
  // second message: started and in flight when the process dies
  b.store.put("message", { ...queued, status: "processing" });
  b.store.put("session", { ...session, state: "running" });
  b.store.remove("run-request", session.id);
  b.service.resources.acquire(session.id, agent.id, null);
  b.service.recovery.ledger.begin({
    taskId: session.id,
    key: "chat:" + queued.id,
    kind: "chat-run",
    description: "Chat run",
    mutating: true,
    ref: { messageId: queued.id },
  });
  b.store.close();
  b = boot(db);
  b.runs.recover();
  b.service.recovery.recover();
  assert.equal(
    b.store.get<Message>("message", queued.id).status,
    "failed",
    "never blindly re-delivered",
  );
  assert.equal(b.store.get<Session>("session", session.id).state, "idle");
  assert.equal(leases(b).length, 0);
  const eff = b.service.recovery.ledger.uncertainFor(session.id);
  assert.equal(eff.length, 1);
  b.service.recovery.ledger.decide(eff[0].id, { decision: "retry" });
  assert.equal(b.store.get<Message>("message", queued.id).status, "queued");
  assert.equal(b.store.list("run-request").length, 1);
  b.store.close();
  await rm(ws.root, { recursive: true });
});

test("lock crash: leases of dead processes are released, never double-held, and ownership is re-acquired once", async () => {
  const ws = await writable("shared"),
    db = join(ws.root, "t.sqlite");
  let b = boot(db, hang);
  const mk = (name: string) =>
    b.service.saveAgent({
      name,
      environment: "codex",
      workspaces: [{ path: ws.path, access: "read", active: true }],
    });
  const a1 = await mk("A1"),
    a2 = await mk("A2");
  const wf = b.service.workflow({
    name: "W",
    goal: "G",
    ownerId: a1.id,
    completionCriteria: "D",
  });
  const mkTask = (agentId: string, title: string) =>
    b.service.task({
      workflowId: wf.id,
      agentId,
      title,
      completionCriteria: "D",
    });
  const t1 = mkTask(a1.id, "one"),
    t2 = mkTask(a2.id, "two");
  await b.scheduler.tick();
  assert.equal(leases(b).length, 1);
  assert.equal(b.service.taskState(t2.id).waitReason, "resource-busy");
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(leases(b).length, 0);
  // the other agent can take the freed folder: no stale holder
  assert.equal(b.service.taskState(t2.id).waitReason, null);
  b.service.transitionTask(t2.id, { status: "running" });
  assert.deepEqual(
    leases(b).map((l) => l.id),
    [t2.id],
  );
  b.service.recovery.requeue(t1.id);
  assert.equal(b.service.taskState(t1.id).waitReason, "resource-busy");
  assert.throws(
    () => b.service.transitionTask(t1.id, { status: "running" }),
    /Waiting for shared resources/,
  );
  b.service.transitionTask(t2.id, { status: "completed", result: "ok" });
  assert.equal(leases(b).length, 0);
  b.service.transitionTask(t1.id, { status: "running" });
  assert.deepEqual(
    leases(b).map((l) => l.id),
    [t1.id],
  );
  b.store.close();
  await rm(ws.root, { recursive: true });
});

test("pending approval persists across restart, is answerable after, and resumes at the same point", async () => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  const request = {
    sessionId: "s",
    toolCall: { toolCallId: "tc1", title: "Write file", kind: "edit" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  } as any;
  let b = boot(db, async (_c, _e, _emit, signal, hooks) => {
    await hooks!.permission!(request, signal);
  });
  const w = await world(b);
  const t = w.task(w.agent.id);
  await b.scheduler.tick();
  await flush();
  assert.equal(b.service.approvals.list().length, 1);
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(statusOf(b, t.id), "interrupted");
  const [pending] = b.service.approvals.list();
  assert.equal(pending.orphaned, true);
  assert.equal(pending.taskId, t.id);
  const view = b.service.recovery.view(t.id);
  assert.equal(view.pendingApprovals.length, 1);
  assert.match(view.next[0], /Answer pending approval: Write file/);
  assert.throws(() => b.service.recovery.requeue(t.id), /pending approval/);
  assert.throws(
    () => b.service.approvals.respond(pending.id, "nope"),
    /Unknown approval option/,
  );
  b.service.approvals.respond(pending.id, "allow");
  assert.equal(b.service.approvals.list().length, 0);
  assert.throws(
    () => b.service.approvals.respond(pending.id, "allow"),
    /no longer pending/,
  );
  const history = b.service.approvals.history();
  assert.equal(history[0].status, "resolved");
  assert.equal(history[0].answeredAfterRestart, true);
  assert.ok(
    b.service.recovery
      .checkpoints(t.id)
      .some(
        (c) =>
          c.boundary === "approval.resolved" && (c.data as any).afterRestart,
      ),
  );
  // the resumed run raises the same request and receives the recorded answer without a new prompt
  let outcome: unknown;
  b.scheduler.executeProvider = async (_c, _e, emit, signal, hooks) => {
    outcome = (await hooks!.permission!(request, signal)).outcome;
    emit({ type: "text", data: "wrote it" });
  };
  b.service.recovery.requeue(t.id);
  await b.scheduler.tick();
  await flush();
  assert.deepEqual(outcome, { outcome: "selected", optionId: "allow" });
  assert.equal(b.service.approvals.list().length, 0);
  assert.equal(statusOf(b, t.id), "completed");
  b.store.close();
  await rm(root, { recursive: true });
});

test("effect ledger: idempotent keys, in-flight and uncertain refusal, retry only when known not applied", async () => {
  const root = await dir(),
    b = boot(join(root, "t.sqlite"));
  const w = await world(b);
  const t = w.task(w.agent.id);
  const L = b.service.recovery.ledger;
  const input = {
    taskId: t.id,
    key: "git-push:1",
    kind: "git",
    description: "git push",
    mutating: true,
  };
  const first = L.begin(input);
  assert.equal(first.action, "run");
  assert.throws(() => L.begin(input), /already in progress/);
  L.complete(first.effect.id, "pushed");
  const again = L.begin(input);
  assert.equal(again.action, "replay");
  assert.equal(again.effect.result, "pushed");
  assert.equal(
    L.list(t.id).length,
    1,
    "same key never creates a second effect",
  );
  const u = L.begin({ ...input, key: "git-push:2" });
  L.markUncertain(u.effect.id, "connection lost");
  assert.throws(() => L.begin({ ...input, key: "git-push:2" }), /uncertain/);
  L.decide(u.effect.id, { decision: "retry" });
  assert.equal(L.begin({ ...input, key: "git-push:2" }).effect.attempts, 2);
  const f = L.begin({ ...input, key: "x" });
  L.fail(f.effect.id, "refused");
  assert.equal(L.begin({ ...input, key: "x" }).action, "run");
  assert.throws(
    () => L.decide(first.effect.id, { decision: "retry" }),
    /Only uncertain/,
  );
  // an uncertain effect also blocks starting the task
  const t2 = w.task(w.agent.id, { title: "x" });
  L.markUncertain(
    L.begin({ ...input, taskId: t2.id, key: "k3" }).effect.id,
    "?",
  );
  assert.throws(
    () => b.service.transitionTask(t2.id, { status: "running" }),
    /uncertain/,
  );
  b.store.close();
  await rm(root, { recursive: true });
});

test("retry policy: bounded backoff, attempt cap, explicit retry-from-checkpoint and automatic retry", async () => {
  assert.equal(backoffDelay(DEFAULT_RETRY_POLICY, 1), 5000);
  assert.equal(backoffDelay(DEFAULT_RETRY_POLICY, 2), 10_000);
  assert.equal(
    backoffDelay(DEFAULT_RETRY_POLICY, 40),
    300_000,
    "capped at maxBackoffMs",
  );
  assert.equal(backoffDelay({ ...DEFAULT_RETRY_POLICY, backoffMs: 0 }, 9), 0);
  assert.throws(() => retryPolicySchema.parse({ maxAttempts: 0 }));
  assert.throws(() => retryPolicySchema.parse({ maxAttempts: 51 }));
  assert.throws(() => retryPolicySchema.parse({ backoffFactor: 0.5 }));
  assert.throws(() => retryPolicySchema.parse({ unknown: 1 }));
  const root = await dir(),
    b = boot(join(root, "t.sqlite"), async () => {
      throw new Error("provider exploded");
    });
  const w = await world(b);
  const t = w.task(w.agent.id);
  b.service.recovery.setPolicy(t.id, {
    maxAttempts: 2,
    backoffMs: 1000,
    auto: false,
  });
  await b.scheduler.tick();
  await flush();
  assert.equal(statusOf(b, t.id), "failed");
  assert.match(b.service.recovery.view(t.id).retry.reason, /attempt 2 of 2/);
  b.service.recovery.requeue(t.id); // explicit retry-from-checkpoint ignores backoff
  assert.equal(b.service.recovery.state(t.id).attempt, 2);
  await b.scheduler.tick();
  await flush();
  assert.equal(statusOf(b, t.id), "failed");
  assert.throws(
    () => b.service.recovery.requeue(t.id),
    /Attempt limit reached/,
  );
  assert.equal(b.service.recovery.view(t.id).retry.allowed, false);
  b.service.recovery.setPolicy(t.id, {
    maxAttempts: 3,
    backoffMs: 1000,
    auto: true,
  });
  // automatic retry waits for the backoff and stops at the cap
  const s = b.service.recovery.state(t.id);
  assert.ok(Date.parse(s.notBefore!) > Date.now());
  b.service.recovery.sweep(Date.now());
  assert.equal(statusOf(b, t.id), "failed", "backoff not elapsed");
  b.service.recovery.sweep(Date.parse(s.notBefore!) + 1);
  assert.equal(statusOf(b, t.id), "queued");
  assert.equal(b.service.recovery.state(t.id).attempt, 3);
  await b.scheduler.tick();
  await flush();
  b.service.recovery.sweep(Date.now() + 10 * 60_000);
  assert.equal(
    statusOf(b, t.id),
    "failed",
    "attempts exhausted: auto retry stops",
  );
  // history of every attempt is kept as immutable checkpoints
  const failures = b.service.recovery
    .checkpoints(t.id)
    .filter((c) => c.boundary === "task.failed");
  assert.equal(failures.length, 3);
  assert.ok(
    failures.every((c) => /provider exploded/.test(String(c.data.result))),
  );
  b.store.close();
  await rm(root, { recursive: true });
});

test("validation gate stays closed across restart and resumed work cannot bypass it", async () => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  let b = boot(db);
  const w = await world(b);
  const gated = w.task(w.agent.id, { requiresValidation: true });
  assert.equal(b.service.taskState(gated.id).waitReason, "validation-required");
  // a gated task found running (e.g. its validation record became stale) is interrupted, not passed
  b.store.put("task", {
    ...b.store.get<Task>("task", gated.id),
    status: "running",
  });
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(statusOf(b, gated.id), "interrupted");
  assert.match(
    b.service.recovery.view(gated.id).next.join("\n"),
    /required validation/,
  );
  b.service.recovery.requeue(gated.id);
  assert.equal(b.service.taskState(gated.id).waitReason, "validation-required");
  assert.throws(
    () => b.service.transitionTask(gated.id, { status: "running" }),
    /validation/i,
  );
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(
    b.service.validation.gate(b.store.get<Task>("task", gated.id)).open,
    false,
  );
  b.store.close();
  await rm(root, { recursive: true });
});

test("limits: tripped workflows stay paused after restart; resumed turns are counted", async () => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  let b = boot(db, hang);
  const w = await world(b);
  const t = w.task(w.agent.id);
  b.service.limits.setLimits(w.wf.id, { maxAgentTurns: 1 });
  await b.scheduler.tick();
  assert.equal(b.service.limits.state(w.wf.id).counters.turns, 1);
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(statusOf(b, t.id), "interrupted");
  assert.equal(
    b.service.limits.state(w.wf.id).counters.turns,
    1,
    "counters survive",
  );
  b.service.recovery.requeue(t.id);
  assert.throws(
    () => b.service.transitionTask(t.id, { status: "running" }),
    /Maximum of 1 agent turns/,
  );
  assert.equal(b.service.workflowStatus(w.wf.id).status, "paused");
  b.store.close();
  await rm(root, { recursive: true });
});

test("recovery API requires the bearer token and drives resume, policy and decisions", async (t) => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  let b = boot(db, hang);
  const w = await world(b);
  const task = w.task(w.agent.id);
  await b.scheduler.tick();
  b.store.close();
  b = boot(db);
  startup(b);
  const server = createApi(b.service, "tok", b.runs);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    b.store.close();
    await rm(root, { recursive: true });
  });
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = (path: string, method = "GET", body?: unknown, auth = true) =>
    fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { authorization: "Bearer tok" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  for (const p of [
    "/recovery",
    `/tasks/${task.id}/recovery`,
    `/tasks/${task.id}/checkpoints`,
    "/effects",
    "/approvals/history",
  ])
    assert.equal((await call(p, "GET", undefined, false)).status, 401, p);
  assert.equal(
    (await call(`/tasks/${task.id}/resume`, "POST", {}, false)).status,
    401,
  );
  const overview: any = await (await call("/recovery")).json();
  assert.equal(overview.tasks[0].task.status, "interrupted");
  assert.equal(overview.tasks[0].checkpoint.boundary, "task.interrupted");
  assert.equal(
    (await call(`/tasks/${task.id}/retry-policy`, "PUT", { maxAttempts: 0 }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(`/tasks/${task.id}/retry-policy`, "PUT", {
        maxAttempts: 4,
        auto: false,
      })
    ).status,
    200,
  );
  const cps: any[] = await (await call(`/tasks/${task.id}/checkpoints`)).json();
  assert.ok(cps.length >= 2);
  assert.equal(
    (await call(`/tasks/${task.id}/resume`, "POST", {})).status,
    202,
  );
  assert.equal(statusOf(b, task.id), "queued");
  assert.equal(
    (await call(`/tasks/${task.id}/resume`, "POST", {})).status,
    409,
  );
  assert.equal(
    (await call(`/effects/nope/decision`, "POST", { decision: "retry" }))
      .status,
    404,
  );
});

test("interrupted/blocked tasks: resumable at the last attempt, keep the agent non-idle, expire their approvals on cancel", async () => {
  const root = await dir(),
    db = join(root, "t.sqlite");
  const request = {
    sessionId: "s",
    toolCall: { toolCallId: "tc1", title: "Write file", kind: "edit" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  } as any;
  let b = boot(db, async (_c, _e, _emit, signal, hooks) => {
    await hooks!.permission!(request, signal);
  });
  const w = await world(b);
  const t = w.task(w.agent.id);
  b.service.recovery.setPolicy(t.id, { maxAttempts: 1 });
  await b.scheduler.tick();
  await flush();
  b.store.close();
  b = boot(db);
  startup(b);
  assert.equal(statusOf(b, t.id), "interrupted");
  // resuming continues attempt 1 of 1; it is not a retry
  assert.equal(b.service.recovery.view(t.id).retry.allowed, true);
  const activity = b.service.activity(w.agent.id);
  assert.equal(activity.state, "interrupted");
  assert.deepEqual(activity.interruptedTaskIds, [t.id]);
  assert.equal(b.service.approvals.list().length, 1);
  b.service.transitionTask(t.id, { status: "cancelled" });
  assert.equal(
    b.service.approvals.list().length,
    0,
    "orphaned approval closed",
  );
  assert.equal(b.service.activity(w.agent.id).state, "idle");
  b.store.close();
  await rm(root, { recursive: true });
});

test("limit resume skips a limit-stopped task whose aborted mutating run is uncertain", async () => {
  const ws = await writable("repo"),
    db = join(ws.root, "t.sqlite");
  const b = boot(
    db,
    (_c, _e, _emit, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  );
  const w = await world(b, {
    workspaces: [{ path: ws.path, access: "write", active: true }],
  });
  const t = w.task(w.agent.id);
  b.service.limits.setLimits(w.wf.id, { maxAgentTurns: 5 });
  await b.scheduler.tick();
  assert.equal(statusOf(b, t.id), "running");
  b.service.limits.trip(w.wf.id, "turns", "test trip", 5, 5, {
    abortRunning: true,
  });
  for (let i = 0; i < 20 && statusOf(b, t.id) === "running"; i++) await flush();
  assert.equal(statusOf(b, t.id), "failed");
  assert.equal(b.service.recovery.ledger.uncertainFor(t.id).length, 1);
  const resumed = b.service.limits.resume(w.wf.id, {
    limits: { maxAgentTurns: 10 },
  });
  assert.equal(resumed.trip, null);
  assert.equal(statusOf(b, t.id), "failed", "left for an explicit decision");
  assert.equal(b.service.workflowStatus(w.wf.id).paused, false);
  b.store.close();
  await rm(ws.root, { recursive: true });
});
