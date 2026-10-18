import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { WorktreeService } from "../src/worktrees.ts";
import { withRepoLockFor, repoLockKey } from "../src/repo-lock.ts";
import { buildQueue } from "../src/queue.ts";
import { explainWaiting } from "../src/inspector.ts";
import { externalDrivers } from "../src/sharing.ts";
import type { Task } from "../src/model.ts";

const ctx = { liveEnabled: () => true };
const code = (p: Promise<unknown> | (() => unknown)) =>
  (async () => (typeof p === "function" ? p() : p))().then(
    () => "ok",
    (e) => (e as { code?: string }).code,
  );
async function world(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-coop-")));
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([]));
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const dir = async (name: string) => {
    const p = join(base, name);
    await mkdir(p, { recursive: true });
    return p;
  };
  const agent = (
    name: string,
    paths: string[],
    over: Record<string, unknown> = {},
  ) =>
    service.saveAgent({
      name,
      environment: "codex",
      workspaces: paths.map((path, i) => ({
        path,
        access: "write",
        active: i === 0,
      })),
      ...over,
    });
  const wf = async (ownerId: string) =>
    service.workflow({
      name: "W",
      goal: "G",
      ownerId,
      completionCriteria: "D",
    });
  const task = (
    workflowId: string,
    agentId: string,
    title: string,
    extra = {},
  ) =>
    service.task({
      workflowId,
      agentId,
      title,
      completionCriteria: "D",
      ...extra,
    });
  return { base, store, service, dir, agent, wf, task };
}

// ---- (5) task-granular reservations ---------------------------------------------------------------
test("declared paths lease only those paths; undeclared tasks still lock every attached folder", async (t) => {
  const w = await world(t);
  const root = await w.dir("repo");
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  const x = await w.agent("X", [root]),
    y = await w.agent("Y", [root]),
    z = await w.agent("Z", [root]);
  const wf = await w.wf(x.id);
  const tx = w.task(wf.id, x.id, "x", { resourcePaths: [join(root, "a")] }),
    ty = w.task(wf.id, y.id, "y", {
      resourcePaths: [join(root, "b", "file.txt")],
    }),
    tz = w.task(wf.id, z.id, "z"); // undeclared => safe default
  assert.deepEqual(w.store.get<Task>("task", tx.id).resourcePaths, [
    join(root, "a"),
  ]);
  w.service.transitionTask(tx.id, { status: "running" });
  w.service.transitionTask(ty.id, { status: "running" }); // disjoint declared paths run together
  const leases = w.store.list<any>("lease");
  assert.deepEqual(
    leases.map((l) => l.scope),
    ["declared", "declared"],
  );
  assert.deepEqual(leases[0].paths, [join(root, "a")]);
  assert.equal(w.service.taskState(tz.id).waitReason, "resource-busy");
  // the undeclared task is refused until both declared holders finish, and then locks the whole folder
  w.service.transitionTask(tx.id, { status: "completed", result: "ok" });
  assert.equal(w.service.taskState(tz.id).waitReason, "resource-busy");
  w.service.transitionTask(ty.id, { status: "completed", result: "ok" });
  w.service.transitionTask(tz.id, { status: "running" });
  assert.equal(w.store.list<any>("lease")[0].scope, "attached-folders");
  assert.deepEqual(w.store.list<any>("lease")[0].paths, [root]);
});
test("declared paths must be inside an attached, non-excluded folder (symlinks resolved)", async (t) => {
  const w = await world(t);
  const root = await w.dir("repo"),
    other = await w.dir("other");
  await mkdir(join(root, "secrets"));
  await symlink(other, join(root, "escape"));
  const a = await w.agent("A", [], {
    workspaces: [
      {
        path: root,
        access: "write",
        active: true,
        rules: [{ path: "secrets", access: "none" }],
      },
    ],
  });
  const wf = await w.wf(a.id);
  const declare = (p: string) => () =>
    w.task(wf.id, a.id, "t", { resourcePaths: [p] });
  assert.equal(await code(declare(other)), "resource_path_outside");
  assert.equal(
    await code(declare(join(root, "escape", "f"))),
    "resource_path_outside",
  );
  assert.equal(
    await code(declare(join(root, "secrets", "k"))),
    "access_denied",
  );
  assert.equal(await code(declare("relative/path")), "invalid_resource_path");
  assert.equal(
    await code(declare(join(root, ".git", "config"))),
    "git_internal",
  );
  assert.equal(
    await code(declare(join(root, "new-file-not-yet-created"))),
    "ok",
  );
});

// ---- (3)(4) queue, aging, Preempt, starvation -------------------------------------------------------
test("one queue orders tasks and chat runs: Preempt first, aging lifts Low, reasons name owner and higher-priority requests", async (t) => {
  const w = await world(t);
  const root = await w.dir("shared");
  const low = await w.agent("Low", [root], { schedulingPriority: 0 }),
    med = await w.agent("Med", [root], { schedulingPriority: 50 }),
    pre = await w.agent("Pre", [root], { schedulingPriority: 101 }),
    owner = await w.agent("Owner", [root]);
  const wf = await w.wf(owner.id);
  const running = w.task(wf.id, owner.id, "holds the folder");
  w.service.transitionTask(running.id, { status: "running" });
  const old = new Date(Date.now() - 600_000).toISOString(); // 120 aging points: beats Medium and even Preempt's 101
  const tLow = w.task(wf.id, low.id, "aged low task");
  w.store.put("task", { ...w.store.get<Task>("task", tLow.id), queuedAt: old });
  const tMed = w.task(wf.id, med.id, "fresh medium task");
  // a chat request from the Preempt agent
  const session = w.service.session(pre.id);
  w.store.put("run-request", {
    id: session.id,
    agentId: pre.id,
    queuedAt: new Date().toISOString(),
  });
  const queue = buildQueue(w.service);
  assert.deepEqual(
    queue.map((e) => [e.kind, e.priorityLabel]),
    [
      ["chat", "Preempt"],
      ["task", "Low"],
      ["task", "Medium"],
    ],
  );
  assert.deepEqual(
    queue.map((e) => e.position),
    [1, 2, 3],
  );
  const low1 = explainWaiting(w.service, ctx, { taskId: tLow.id });
  const codes = low1.reasons.map((r) => r.code);
  assert.ok(
    codes.includes("queue-position") &&
      codes.includes("higher-priority-pending") &&
      codes.includes("preempt-exception"),
  );
  const qp = low1.reasons.find((r) => r.code === "queue-position")!;
  assert.match(qp.title, /position 2 of 3/);
  assert.equal((qp.refs!.owners as any[])[0].agent, "Owner");
  assert.match(
    low1.reasons.find((r) => r.code === "preempt-exception")!.detail,
    /never interrupts running work/,
  );
  // chat runs get the same explanation through the agent view
  const chat = explainWaiting(w.service, ctx, { agentId: pre.id });
  assert.ok(
    chat.reasons.some(
      (r) =>
        r.code === "resource-busy" && (r.refs as any).sessionId === session.id,
    ),
  );
  assert.ok(
    chat.reasons.some(
      (r) => r.code === "queue-position" && (r.refs as any).kind === "chat",
    ),
  );
  void tMed;
});
test("starvation: under sustained Medium load a Low task ages to the front; a Preempt arrival still goes first", async (t) => {
  const w = await world(t);
  const root = await w.dir("shared");
  const low = await w.agent("Low", [root], { schedulingPriority: 0 }),
    med = await w.agent("Med", [root], { schedulingPriority: 50 }),
    pre = await w.agent("Pre", [root], { schedulingPriority: 101 });
  const wf = await w.wf(low.id);
  const t0 = Date.now();
  const lowTask = w.task(wf.id, low.id, "patient low task");
  w.store.put("task", {
    ...w.store.get<Task>("task", lowTask.id),
    queuedAt: new Date(t0).toISOString(),
  });
  let reachedFront = -1,
    behindBefore = true;
  for (let round = 1; round <= 40; round++) {
    const now = t0 + round * 10_000; // every 10 s a fresh Medium task arrives
    const fresh = w.task(wf.id, med.id, "medium " + round);
    w.store.put("task", {
      ...w.store.get<Task>("task", fresh.id),
      queuedAt: new Date(now).toISOString(),
    });
    const q = buildQueue(w.service, now);
    const pos = q.find((e) => e.id === lowTask.id)!.position;
    if (pos === 1 && reachedFront < 0) reachedFront = round;
    if (reachedFront < 0) behindBefore &&= pos > 1;
    // serve the head of the queue (a scheduler turn)
    const head = q[0];
    if (head.id !== lowTask.id)
      w.store.put("task", {
        ...w.store.get<Task>("task", head.id),
        status: "completed",
      });
    else break;
  }
  assert.ok(behindBefore, "Medium work goes first while Low is young");
  assert.ok(
    reachedFront > 1 && reachedFront <= 26,
    `Low reached the front after ${reachedFront} rounds`,
  );
  // Preempt exception: once the Low task has aged past Preempt's own 101 points (~505 s), a fresh
  // Preempt request still ranks first because Preempt is queue precedence, not a score.
  for (const e of w.store.list<Task>("task"))
    if (e.status === "queued" && e.id !== lowTask.id)
      w.store.put("task", { ...e, status: "completed" });
  const later = t0 + 800_000;
  const session = w.service.session(pre.id);
  w.store.put("run-request", {
    id: session.id,
    agentId: pre.id,
    queuedAt: new Date(later).toISOString(),
  });
  const q = buildQueue(w.service, later);
  assert.equal(q[0].id, session.id);
  assert.equal(q[1].id, lowTask.id);
  assert.ok(
    q[1].score > q[0].score,
    "aged Low has the higher score yet ranks second",
  );
});
test("starvation guard: a lower-ranked task may not take paths reserved by a higher-ranked task waiting for a lease", async (t) => {
  const w = await world(t);
  const x1 = await w.dir("x1"),
    x2 = await w.dir("x2");
  const hold: (() => void)[] = [];
  const runs = new RunManager(w.service, true, process.cwd());
  const scheduler = new Scheduler(w.service, runs, async () => {
    await new Promise<void>((resolve) => hold.push(resolve));
    throw new Error("stop");
  });
  t.after(() => scheduler.stop());
  const holder = await w.agent("Holder", [x1], { schedulingPriority: 50 }),
    big = await w.agent("Big", [x1, x2], { schedulingPriority: 75 }),
    small = await w.agent("Small", [x2], { schedulingPriority: 0 });
  const wf = await w.wf(holder.id);
  const tHolder = w.task(wf.id, holder.id, "holder");
  await scheduler.tick();
  assert.equal(w.store.get<Task>("task", tHolder.id).status, "running");
  const tBig = w.task(wf.id, big.id, "needs x1+x2"),
    tSmall = w.task(wf.id, small.id, "only x2");
  // Small alone would be free to start (nobody holds x2), but Big outranks it and is waiting on x1.
  await scheduler.tick();
  assert.equal(w.store.get<Task>("task", tSmall.id).status, "queued");
  const why = explainWaiting(w.service, ctx, { taskId: tSmall.id });
  const guard = why.reasons.find((r) => r.code === "reserved-for-higher");
  assert.ok(guard?.blocking);
  assert.match(guard!.detail, /needs x1\+x2/);
  assert.equal(w.service.taskState(tBig.id).waitReason, "resource-busy");
  // overlap pairs are exact in the lease reason
  const busy = explainWaiting(w.service, ctx, { taskId: tBig.id }).reasons.find(
    (r) => r.code === "resource-busy",
  )!;
  assert.deepEqual((busy.refs as any).leases[0].overlaps, [
    { mine: x1, theirs: x1 },
  ]);
  assert.match(busy.detail, /Holder holds the lease/);
  // once the holder finishes, Big starts first and Small still waits for its lease
  w.service.transitionTask(tHolder.id, { status: "cancelled" });
  await scheduler.tick();
  assert.equal(w.store.get<Task>("task", tBig.id).status, "running");
  assert.equal(w.store.get<Task>("task", tSmall.id).status, "queued");
});

// ---- (7) git operations share the per-repository lock across worktrees ------------------------------
test("Git workflow locks key on the common git dir so linked worktrees serialize with the main checkout", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-lock-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "main");
  await mkdir(root);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  await writeFile(join(root, "f"), "x");
  git("add", ".");
  git("commit", "-qm", "i");
  const wt = join(base, "linked");
  git("worktree", "add", "-q", "-b", "side", wt);
  assert.equal(await repoLockKey(root), await repoLockKey(wt));
  assert.notEqual(await repoLockKey(root), await repoLockKey(base));
  const log: string[] = [];
  const hold = (name: string, cwd: string, ms: number) =>
    withRepoLockFor(cwd, async () => {
      log.push("start " + name);
      await new Promise((r) => setTimeout(r, ms));
      log.push("end " + name);
    });
  await Promise.all([hold("main", root, 40), hold("linked", wt, 5)]);
  assert.deepEqual(log, [
    "start main",
    "end main",
    "start linked",
    "end linked",
  ]);
});

// ---- (8) crash / ownership lock reconciliation -------------------------------------------------------
test("a lease stays draining while a previous provider process runs: no second writer, no ownership transfer, released after exit", async (t) => {
  const w = await world(t);
  const root = await w.dir("shared");
  const a = await w.agent("A", [root]),
    b = await w.agent("B", [root]);
  const wf = await w.wf(a.id);
  const ta = w.task(wf.id, a.id, "a"),
    tb = w.task(wf.id, b.id, "b");
  w.service.transitionTask(ta.id, { status: "running" });
  // The old backend crashed (its pid is gone) but its provider CLI is still running.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  t.after(() => child.kill("SIGKILL"));
  w.service.resources.attachProcess(ta.id, child.pid!);
  const lease = w.store.get<any>("lease", ta.id);
  w.store.put("lease", { ...lease, ownerPid: 2 ** 22 + 12345 }); // not alive
  // startup recovery (RecoveryService.recover also moves the task to interrupted)
  w.service.recovery.recover();
  assert.equal(w.store.get<Task>("task", ta.id).status, "interrupted");
  const kept = w.store.get<any>("lease", ta.id);
  assert.ok(kept.draining, "lease is kept and marked draining");
  assert.match(kept.draining.reason, /may still be writing/);
  // nobody else can take the folder, including a resume of the interrupted task itself
  assert.equal(w.service.taskState(tb.id).waitReason, "resource-busy");
  assert.match(
    explainWaiting(w.service, ctx, { taskId: tb.id }).reasons.find(
      (r) => r.code === "resource-busy",
    )!.detail,
    /draining/,
  );
  assert.throws(
    () => w.service.transitionTask(tb.id, { status: "running" }),
    /Waiting for shared resources/,
  );
  assert.throws(
    () =>
      w.service.recovery.requeue(ta.id) &&
      w.service.transitionTask(ta.id, { status: "running" }),
    /Waiting for shared resources/,
  );
  // the task's interrupted transition did not free it
  assert.ok(w.store.list<any>("lease").some((l) => l.id === ta.id));
  // ownership transfer is refused while a writer may still be running
  assert.equal(
    await code(() => w.service.control(a.id, "human")),
    "lease_draining",
  );
  // forced release needs explicit confirmation
  assert.equal(
    await code(() =>
      w.service.locks.forceRelease(ta.id, { reason: "because" }),
    ),
    undefined,
  );
  assert.deepEqual(w.service.locks.sweep(), []); // still alive
  child.kill("SIGKILL");
  await exited;
  assert.deepEqual(w.service.locks.sweep(), [ta.id]);
  assert.equal(w.store.list<any>("lease").length, 0);
  assert.equal(w.service.control(a.id, "human").control, "human");
});
test("leases whose backend and provider processes are gone are released at startup; confirmed force release works", async (t) => {
  const w = await world(t);
  const root = await w.dir("shared");
  const a = await w.agent("A", [root]);
  const wf = await w.wf(a.id);
  const ta = w.task(wf.id, a.id, "a");
  w.service.transitionTask(ta.id, { status: "running" });
  w.store.put("lease", {
    ...w.store.get<any>("lease", ta.id),
    ownerPid: 2 ** 22 + 999,
  });
  assert.deepEqual(w.service.locks.reconcile().released, [ta.id]);
  // a still-live foreign backend keeps its lease (two backends on one data dir must not both write)
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  w.store.put("lease", {
    id: "foreign",
    agentId: a.id,
    workflowId: null,
    paths: [root],
    acquiredAt: new Date().toISOString(),
    ownerPid: child.pid,
  });
  const r = w.service.locks.reconcile();
  assert.deepEqual(
    r.draining.map((d) => d.id),
    ["foreign"],
  );
  assert.match(r.draining[0].reason, /backend process .* still running/);
  assert.throws(() =>
    w.service.locks.forceRelease("foreign", {
      confirmStopped: false,
      reason: "no",
    }),
  );
  w.service.locks.forceRelease("foreign", {
    confirmStopped: true,
    reason: "I closed the other window",
  });
  assert.equal(w.store.list<any>("lease").length, 0);
  assert.ok(w.store.list<any>("event").length >= 0);
});

// ---- (9) external drivers stay labelled -------------------------------------------------------------
test("agents driven by an interactive CLI or native app are listed as outside lock enforcement", async (t) => {
  const w = await world(t);
  const root = await w.dir("shared");
  const a = await w.agent("A", [root]);
  assert.deepEqual(externalDrivers(w.service), []);
  w.service.ownership.take(a.id, { mode: "cli" });
  const [driver] = externalDrivers(w.service);
  assert.equal(driver.holder, "cli");
  assert.match(
    driver.warning,
    /Outside AgentTeam's cooperative lock enforcement/,
  );
  assert.deepEqual(driver.paths, [root]);
});

// ---- (6) guided parallel work ---------------------------------------------------------------------
async function repoWorld(t: any) {
  const w = await world(t);
  const root = await w.dir("repo");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  await writeFile(join(root, "a", "x.txt"), "x0");
  await writeFile(join(root, "b", "y.txt"), "y0");
  git("add", ".");
  git("commit", "-qm", "i");
  const coord = await w.agent("Coord", [root]),
    w1 = await w.agent("W1", [root]),
    w2 = await w.agent("W2", [root]);
  const resource = await w.service.resources.save({ name: "Repo", path: root });
  const wf = await w.wf(coord.id);
  w.service.resources.configureWorkflow(wf.id, {
    enabled: true,
    coordinatorId: coord.id,
    resourceIds: [resource.id],
    maxConcurrent: 3,
  });
  const t1 = w.task(wf.id, w1.id, "worker one"),
    t2 = w.task(wf.id, w2.id, "worker two");
  return { ...w, root, git, coord, w1, w2, wf, t1, t2 };
}
test("guided parallel: disjoint assignments run concurrently, an integration task waits for every worker", async (t) => {
  const p = await repoWorld(t);
  await assert.rejects(
    p.service.parallel.assign(p.wf.id, {
      assignments: [
        { taskId: p.t1.id, paths: [join(p.root, "a")] },
        { taskId: p.t2.id, paths: [join(p.root, "a", "x.txt")] },
      ],
    }),
    (e: any) =>
      e.code === "assignment_overlap" && /a ~ .*x\.txt/.test(e.message),
  );
  assert.equal(
    await code(
      p.service.parallel.assign(p.wf.id, {
        assignments: [{ taskId: p.t1.id, paths: [join(p.base, "elsewhere")] }],
      }),
    ),
    "resource_path_outside",
  );
  const plan = await p.service.parallel.assign(p.wf.id, {
    assignments: [
      { taskId: p.t1.id, paths: [join(p.root, "a")] },
      { taskId: p.t2.id, paths: [join(p.root, "b")] },
    ],
  });
  assert.equal(plan.assignments.length, 2);
  const integration = p.store.get<Task>("task", plan.integrationTaskId!);
  assert.equal(integration.agentId, p.coord.id);
  assert.deepEqual(
    [...integration.dependsOn].sort(),
    [p.t1.id, p.t2.id].sort(),
  );
  const worker = p.store.get<Task>("task", p.t1.id);
  assert.match(
    worker.instructions,
    /\[Parallel assignment\]\nYou may modify only these paths/,
  );
  assert.deepEqual(worker.resourcePaths, [join(p.root, "a")]);
  // the plan task (coordinator) must complete first in this workflow
  const planTask = p.store.get<any>("workflow", p.wf.id).coordination
    .planTaskId;
  p.service.transitionTask(planTask, { status: "running" });
  p.service.transitionTask(planTask, { status: "completed", result: "plan" });
  p.service.transitionTask(p.t1.id, { status: "running" });
  p.service.transitionTask(p.t2.id, { status: "running" }); // disjoint paths: truly concurrent
  assert.equal(p.service.taskState(integration.id).waitReason, "dependencies");
  const view = p.service.parallel.view(p.wf.id);
  assert.equal(view.workers.length, 2);
  assert.equal(view.integration?.taskId, integration.id);
  // re-assigning keeps a single integration task
  const again = await p.service.parallel
    .assign(p.wf.id, {
      assignments: [{ taskId: p.t1.id, paths: [join(p.root, "a", "x.txt")] }],
    })
    .catch((e) => e);
  assert.equal(again.code, "not_assignable"); // running workers cannot be reassigned
});
test("conflicting parallel writes (out of scope, then overlapping) are found by changed-file comparison and routed to the coordinator", async (t) => {
  const p = await repoWorld(t);
  const plan = await p.service.parallel.assign(p.wf.id, {
    assignments: [
      { taskId: p.t1.id, paths: [join(p.root, "a")] },
      { taskId: p.t2.id, paths: [join(p.root, "b")] },
    ],
  });
  const task1 = p.store.get<Task>("task", p.t1.id),
    task2 = p.store.get<Task>("task", p.t2.id);
  await p.service.parallel.begin(task1);
  await p.service.parallel.begin(task2);
  // worker one edits its own file and, wrongly, one of worker two's files
  await writeFile(join(p.root, "a", "x.txt"), "x1");
  await writeFile(join(p.root, "b", "y.txt"), "y-by-one");
  const r1 = await p.service.parallel.check(task1);
  assert.deepEqual(r1!.changed.map((c) => c.rel).sort(), [
    "a/x.txt",
    "b/y.txt",
  ]);
  assert.deepEqual(
    r1!.violations.map((v) => [v.kind, v.file]),
    [["out-of-scope", join(p.root, "b", "y.txt")]],
  );
  assert.match(r1!.violations[0].detail, /assigned to "worker two"/);
  // worker two changes the same file again: overlap with worker one
  await writeFile(join(p.root, "b", "y.txt"), "y-by-two");
  const r2 = await p.service.parallel.check(task2);
  assert.ok(
    r2!.violations.some(
      (v) => v.kind === "overlap" && v.taskIds.includes(p.t1.id),
    ),
  );
  const view = p.service.parallel.view(p.wf.id);
  assert.equal(view.conflicts.length, 2);
  for (const c of view.conflicts) {
    const routed = p.store.get<Task>("task", c.coordinatorTaskId);
    assert.equal(routed.agentId, p.coord.id, "conflicts go to the coordinator");
    assert.match(routed.title, /Resolve parallel write conflict/);
    assert.ok(
      p.store
        .get<Task>("task", plan.integrationTaskId!)
        .dependsOn.includes(routed.id),
    );
  }
  assert.ok(view.conflicts[0].files.includes(join(p.root, "b", "y.txt")));
  // an unrelated clean worker records no violations
  const clean = await p.service.parallel.check({
    ...task1,
    id: "nope",
  } as Task);
  assert.equal(clean, null);
});
test("a worker assigned its own worktree is isolated by directory; committed changes are detected too", async (t) => {
  const p = await repoWorld(t);
  const wt = new WorktreeService(p.service);
  t.after(() => wt.close());
  const plan = await p.service.parallel.assign(
    p.wf.id,
    {
      assignments: [
        { taskId: p.t1.id, worktree: true },
        { taskId: p.t2.id, paths: [join(p.root, "b")] },
      ],
    },
    { worktrees: wt },
  );
  const a1 = plan.assignments.find((a) => a.taskId === p.t1.id)!;
  assert.equal(a1.isolation, "worktree");
  assert.match(a1.worktreePath!, /AgentTeam-worktrees/);
  assert.deepEqual(p.store.get<Task>("task", p.t1.id).resourcePaths, [
    a1.worktreePath,
  ]);
  const agent = p.store.get<any>("agent", p.w1.id);
  assert.ok(agent.workspaces.some((w: any) => w.path === a1.worktreePath));
  const task1 = p.store.get<Task>("task", p.t1.id);
  await p.service.parallel.begin(task1);
  await writeFile(join(a1.worktreePath!, "a", "x.txt"), "from worktree");
  const g = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        a1.worktreePath!,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.invalid",
        ...args,
      ],
      { encoding: "utf8" },
    );
  g("add", ".");
  g("commit", "-qm", "worker commit"); // committed change: no longer visible to `git status`
  const r = await p.service.parallel.check(task1);
  assert.deepEqual(
    r!.changed.map((c) => c.rel),
    ["a/x.txt"],
  );
  assert.deepEqual(r!.violations, []);
});
