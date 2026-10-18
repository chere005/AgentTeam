import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Task } from "../src/model.ts";

async function setup(provider?: ConstructorParameters<typeof Scheduler>[2]) {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd()),
    scheduler = new Scheduler(service, runs, provider);
  const agent = (name: string, extra: object = {}) =>
    service.saveAgent({ name, environment: "codex", ...extra });
  const lead = await agent("Lead");
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  const task = (agentId: string, extra: object = {}) =>
    service.task({
      workflowId: wf.id,
      agentId,
      title: "T",
      completionCriteria: "D",
      ...extra,
    });
  const edge = (from: string, to: string) =>
    service.saveEdge({ from, to, kind: "delegate" });
  const close = () => {
    scheduler.stop();
    store.close();
  };
  return {
    store,
    service,
    runs,
    scheduler,
    agent,
    lead,
    wf,
    task,
    edge,
    close,
  };
}
const tick = async (s: Scheduler, n = 1) => {
  for (let i = 0; i < n; i++) {
    await s.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
};
/**
 * Like `tick`, then waits until the task runs it started have settled. A fixed 5 ms sleep was flaky
 * under the parallel full-suite load: execute() awaits file system checks after the provider returns.
 * Only for providers that finish (a hanging provider would wait for the 5 s cap).
 */
const tickSettled = async (s: Scheduler, n = 1) => {
  for (let i = 0; i < n; i++) {
    await tick(s);
    for (
      let waited = 0;
      waited < 5000 &&
      [...s.runs.active.keys()].some((k) => k.startsWith("task:"));
      waited += 5
    )
      await new Promise((r) => setTimeout(r, 5));
  }
};
const get = (store: Store, id: string) => store.get<Task>("task", id);

test("turn limit trips with the exact reason, pauses, preserves work and needs an explicit extension", async () => {
  const t = await setup(async (_c, _e, emit) =>
    emit({ type: "text", data: "ok" }),
  );
  try {
    const a = await t.agent("A"),
      b = await t.agent("B");
    t.service.limits.setLimits(t.wf.id, { maxAgentTurns: 1 });
    const t1 = t.task(a.id),
      t2 = t.task(b.id);
    await tick(t.scheduler, 3);
    assert.equal(get(t.store, t1.id).status, "completed");
    assert.equal(get(t.store, t1.id).result?.trim(), "ok");
    assert.equal(get(t.store, t2.id).status, "queued");
    const status = t.service.limits.status(t.wf.id);
    assert.equal(status.trip?.kind, "turns");
    assert.equal(status.trip?.reason, "Maximum of 1 agent turns reached.");
    assert.equal(status.counters.agentTurns, 1);
    assert.equal(t.service.workflowStatus(t.wf.id).paused, true);
    // Resuming through the plain pause toggle cannot bypass the tripped limit.
    t.service.pauseWorkflow(t.wf.id, false);
    assert.throws(
      () => t.service.transitionTask(t2.id, { status: "running" }),
      /Maximum of 1 agent turns/,
    );
    // Explicit resume without raising the limit is refused and changes nothing.
    assert.throws(
      () => t.service.limits.resume(t.wf.id, {}),
      (e: any) => e.code === "limit_still_exceeded",
    );
    assert.ok(t.service.limits.status(t.wf.id).trip);
    const resumed = t.service.limits.resume(t.wf.id, {
      limits: { maxAgentTurns: 2 },
    });
    assert.equal(resumed.trip, null);
    assert.equal(resumed.limits.maxAgentTurns, 2);
    assert.equal(resumed.history.at(-1)?.type, "resume");
    assert.equal(t.service.workflowStatus(t.wf.id).paused, false);
    await tick(t.scheduler, 2);
    assert.equal(get(t.store, t2.id).status, "completed");
    assert.equal(get(t.store, t1.id).result?.trim(), "ok"); // earlier work untouched
  } finally {
    t.close();
  }
});

test("handoff, spawned-agent and retry limits trip on the attempt that would exceed them", async () => {
  const t = await setup();
  try {
    const a = await t.agent("A"),
      b = await t.agent("B"),
      c = await t.agent("C");
    t.edge(a.id, b.id);
    t.edge(a.id, c.id);
    t.service.limits.setLimits(t.wf.id, { maxSpawnedAgents: 1 });
    t.task(b.id, { invokedBy: a.id });
    assert.throws(
      () => t.task(c.id, { invokedBy: a.id }),
      (e: any) => e.code === "limit_exceeded" && /1 spawned/.test(e.message),
    );
    let s = t.service.limits.status(t.wf.id);
    assert.equal(s.trip?.kind, "spawned");
    assert.equal(t.store.list("task").length, 1);
    t.service.limits.resume(t.wf.id, {
      limits: { maxSpawnedAgents: 5, maxHandoffs: 2 },
    });
    t.task(c.id, { invokedBy: a.id }); // handoffs now 2
    assert.throws(() => t.task(b.id, { invokedBy: a.id }), /2 handoffs/);
    assert.equal(t.service.limits.status(t.wf.id).trip?.kind, "handoffs");
    t.service.limits.resume(t.wf.id, { limits: { maxHandoffs: null } });

    t.service.limits.setLimits(t.wf.id, { maxRetries: 1 });
    const d = await t.agent("D");
    const f = t.task(d.id);
    t.service.transitionTask(f.id, { status: "running" });
    t.service.transitionTask(f.id, { status: "failed", result: "boom" });
    t.service.transitionTask(f.id, { status: "queued" });
    t.service.transitionTask(f.id, { status: "running" });
    t.service.transitionTask(f.id, { status: "failed", result: "boom2" });
    assert.throws(
      () => t.service.transitionTask(f.id, { status: "queued" }),
      /Maximum of 1 retries/,
    );
    s = t.service.limits.status(t.wf.id);
    assert.equal(s.trip?.kind, "retries");
    assert.equal(s.counters.retries, 1);
    assert.equal(get(t.store, f.id).status, "failed");
    assert.equal(get(t.store, f.id).result, "boom2");
  } finally {
    t.close();
  }
});

test("runtime limit aborts running work, keeps partial output, and resume re-queues stopped tasks", async () => {
  let call = 0;
  const t = await setup(async (_c, _e, emit, signal) => {
    if (call++ === 0) {
      emit({ type: "text", data: "partial findings" });
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    }
    emit({ type: "text", data: "final" });
  });
  try {
    const a = await t.agent("A");
    t.service.limits.setLimits(t.wf.id, { maxRuntimeSeconds: 60 });
    const task = t.task(a.id);
    await tick(t.scheduler);
    assert.equal(get(t.store, task.id).status, "running");
    // Simulate elapsed active time instead of sleeping.
    const st = t.store.get<any>("workflow-limits", t.wf.id);
    st.counters.runtimeMs = 61_000;
    t.store.put("workflow-limits", st);
    await tick(t.scheduler, 2);
    const done = get(t.store, task.id);
    const s = t.service.limits.status(t.wf.id);
    assert.equal(s.trip?.kind, "runtime");
    assert.match(s.trip!.reason, /Maximum runtime of 60s reached/);
    assert.equal(done.status, "failed");
    assert.match(
      done.result!,
      /^Stopped by workflow limit: Maximum runtime of 60s/,
    );
    assert.match(s.tasks[0].partialResult!, /partial findings/);
    assert.equal(t.service.workflowStatus(t.wf.id).paused, true);
    assert.throws(
      () => t.service.limits.resume(t.wf.id, {}),
      (e: any) => e.code === "limit_still_exceeded",
    );
    t.service.limits.resume(t.wf.id, { limits: { maxRuntimeSeconds: 600 } });
    assert.equal(get(t.store, task.id).status, "queued");
    assert.equal(t.service.limits.status(t.wf.id).counters.retries, 0); // stop-by-limit is not a retry
    await tick(t.scheduler, 2);
    assert.equal(get(t.store, task.id).status, "completed");
  } finally {
    t.close();
  }
});

test("token budget counts only reported usage and shows unavailable honestly", async () => {
  let reported = false;
  const t = await setup(async (_c, _e, emit) => {
    if (reported)
      emit({
        type: "usage",
        data: {
          input_tokens: 600,
          output_tokens: 500,
          cache_read_input_tokens: 9000,
        },
      });
    emit({ type: "text", data: "ok" });
  });
  try {
    const a = await t.agent("A"),
      b = await t.agent("B");
    t.service.limits.setLimits(t.wf.id, { maxTokens: 1000 });
    const one = t.task(a.id);
    await tick(t.scheduler, 2);
    assert.equal(get(t.store, one.id).status, "completed");
    let s = t.service.limits.status(t.wf.id);
    assert.equal(s.usage.state, "unavailable");
    assert.equal(s.usage.totalTokens, null);
    assert.equal(s.usage.cost.state, "unavailable");
    assert.equal(s.trip, null);
    reported = true;
    t.task(b.id);
    await tick(t.scheduler, 2);
    s = t.service.limits.status(t.wf.id);
    assert.equal(s.usage.state, "partial");
    assert.equal(s.usage.totalTokens, 1100);
    assert.equal(s.usage.cacheTokens, 9000);
    assert.equal(s.trip?.kind, "tokens");
    assert.match(
      s.trip!.reason,
      /Reported token budget of 1000 reached \(1100 used/,
    );
    assert.throws(
      () => t.service.limits.resume(t.wf.id, { limits: { maxTokens: 1100 } }),
      (e: any) => e.code === "limit_still_exceeded",
    );
    t.service.limits.resume(t.wf.id, { limits: { maxTokens: 5000 } });
  } finally {
    t.close();
  }
});

test("completion checks: returned text alone is not success", async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-limits-")),
  );
  const t = await setup(async (_c, _e, emit) =>
    emit({
      type: "text",
      data: 'Done.\n```json\n{"summary":"x","files":["a"]}\n```',
    }),
  );
  try {
    const a = await t.agent("A", {
      workspaces: [{ path: dir, access: "write", active: true }],
    });
    const task = t.task(a.id, {
      completionChecks: [
        { type: "output-fields", fields: ["summary", "files"] },
        { type: "artifact-exists", path: "out/report.txt" },
      ],
    });
    await tickSettled(t.scheduler, 2);
    let cur = get(t.store, task.id);
    assert.equal(cur.status, "failed");
    assert.match(
      cur.result!,
      /Completion checks failed: Artifact out\/report.txt does not exist/,
    );
    const meta = t.service.limits.status(t.wf.id).tasks[0];
    assert.equal(meta.checkEvidence?.passed, false);
    assert.match(meta.partialResult!, /Done\./); // output kept as partial evidence
    // Text-only manual completion is refused by the service itself.
    assert.throws(
      () =>
        t.service.transitionTask(task.id, { status: "queued" }) &&
        t.service.transitionTask(task.id, { status: "running" }) &&
        t.service.transitionTask(task.id, {
          status: "completed",
          result: "trust me",
        }),
      (e: any) => e.code === "completion_checks_failed",
    );
    await writeFile(join(dir, "out.tmp"), "x");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "out"));
    await writeFile(join(dir, "out", "report.txt"), "r");
    t.service.transitionTask(task.id, { status: "failed", result: "again" });
    t.service.limits.setLimits(t.wf.id, { maxRetries: 10 });
    t.service.transitionTask(task.id, { status: "queued" });
    await tickSettled(t.scheduler, 2);
    cur = get(t.store, task.id);
    assert.equal(cur.status, "completed");
    assert.equal(
      t.service.limits.status(t.wf.id).tasks[0].checkEvidence?.passed,
      true,
    );
  } finally {
    t.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion checks reject traversal, missing fields, patterns and a closed validation gate", async () => {
  const t = await setup();
  try {
    const a = await t.agent("A");
    const task = t.task(a.id, { requiresValidation: true });
    const checks = (c: any[]) => t.service.limits.setChecks(task.id, c);
    const run = async (c: any[], text: string) => {
      checks(c);
      return t.service.limits.evaluate(
        get(t.store, task.id),
        text,
        process.cwd(),
      );
    };
    assert.match(
      (await run([{ type: "artifact-exists", path: "../etc/passwd" }], "x"))!
        .results[0].detail,
      /relative and inside/,
    );
    assert.match(
      (await run([{ type: "artifact-exists", path: "/etc/passwd" }], "x"))!
        .results[0].detail,
      /relative and inside/,
    );
    assert.equal(
      (await run([{ type: "output-fields", fields: ["a"] }], '{"a":""}'))!
        .passed,
      false,
    );
    assert.equal(
      (await run(
        [{ type: "output-fields", fields: ["a"] }],
        'text {"a":1} text',
      ))!.passed,
      true,
    );
    assert.equal(
      (await run(
        [{ type: "output-matches", pattern: "^OK$", flags: "m" }],
        "x\nOK",
      ))!.passed,
      true,
    );
    const gate = await run([{ type: "validation-gate" }], "x");
    assert.equal(gate!.passed, false);
    assert.match(
      gate!.results[0].detail,
      /Validation gate is closed \(missing\)/,
    );
  } finally {
    t.close();
  }
});

test("delegation loops are detected with the call chain and trip the workflow", async () => {
  const t = await setup();
  try {
    const a = await t.agent("A"),
      b = await t.agent("B"),
      c = await t.agent("C");
    t.edge(a.id, b.id);
    t.edge(b.id, c.id);
    t.edge(c.id, a.id);
    t.edge(b.id, a.id);
    const root = t.task(a.id);
    t.service.transitionTask(root.id, { status: "running" });
    const child = t.task(b.id, { invokedBy: a.id }); // parent inferred = root
    assert.equal(child.parentTaskId, root.id);
    t.service.transitionTask(child.id, { status: "running" });
    assert.throws(
      () => t.task(a.id, { invokedBy: b.id }),
      (e: any) =>
        e.code === "delegation_loop" &&
        /A is already in this call chain \(A -> B -> A\)/.test(e.message),
    );
    const s = t.service.limits.status(t.wf.id);
    assert.equal(s.trip?.kind, "loop");
    assert.equal(t.service.workflowStatus(t.wf.id).paused, true);
    assert.equal(t.store.list("task").length, 2);
    // Resume is explicit, and the loop attempt stays recorded in history.
    t.service.limits.resume(t.wf.id, {});
    const grand = t.task(c.id, { invokedBy: b.id, parentTaskId: child.id });
    assert.equal(
      t.service.limits.status(t.wf.id).tasks.find((x) => x.taskId === grand.id)
        ?.depth,
      2,
    );
    assert.throws(
      () => t.task(a.id, { invokedBy: c.id, parentTaskId: grand.id }),
      /delegation_loop|call chain/,
    );
    assert.equal(
      t.service.limits.status(t.wf.id).history.filter((h) => h.type === "trip")
        .length,
      2,
    );
  } finally {
    t.close();
  }
});

test("live delegation cycles are caught even without parent links; recursion depth is bounded", async () => {
  const t = await setup();
  try {
    const agents: Awaited<ReturnType<typeof t.agent>>[] = [];
    for (let i = 0; i < 6; i++) agents.push(await t.agent("N" + i));
    for (let i = 0; i < 5; i++) t.edge(agents[i].id, agents[i + 1].id);
    t.edge(agents[1].id, agents[0].id);
    // queued ping-pong: N0 -> N1 queued, then N1 -> N0
    t.task(agents[1].id, { invokedBy: agents[0].id });
    assert.throws(
      () => t.task(agents[0].id, { invokedBy: agents[1].id }),
      (e: any) => e.code === "delegation_loop",
    );
    t.service.limits.resume(t.wf.id, {});
    t.service.limits.setLimits(t.wf.id, { maxDelegationDepth: 2 });
    const root = t.task(agents[0].id);
    t.service.transitionTask(root.id, { status: "running" });
    const d1 = t.task(agents[1].id, {
      invokedBy: agents[0].id,
      parentTaskId: root.id,
    });
    t.service.transitionTask(d1.id, { status: "running" });
    const d2 = t.task(agents[2].id, {
      invokedBy: agents[1].id,
      parentTaskId: d1.id,
    });
    t.service.transitionTask(d2.id, { status: "running" });
    assert.throws(
      () =>
        t.task(agents[3].id, { invokedBy: agents[2].id, parentTaskId: d2.id }),
      (e: any) =>
        e.code === "depth_limit" &&
        /depth of 2 exceeded \(this invocation would be depth 3\)/.test(
          e.message,
        ),
    );
    assert.equal(t.service.limits.status(t.wf.id).trip?.kind, "depth");
  } finally {
    t.close();
  }
});

test("max children per task is enforced on creation and start without bypassing invocation locks", async () => {
  const t = await setup();
  try {
    const p = await t.agent("P", { maxConcurrentInvocations: 1 }),
      x = await t.agent("X"),
      y = await t.agent("Y"),
      z = await t.agent("Z");
    for (const c of [x, y, z]) t.edge(p.id, c.id);
    t.service.limits.setLimits(t.wf.id, { maxChildrenPerTask: 2 });
    const root = t.task(p.id);
    t.service.transitionTask(root.id, { status: "running" });
    const c1 = t.task(x.id, { invokedBy: p.id });
    const c2 = t.task(y.id, { invokedBy: p.id });
    assert.throws(
      () => t.task(z.id, { invokedBy: p.id }),
      (e: any) => e.code === "children_limit",
    );
    assert.equal(t.service.limits.status(t.wf.id).trip, null); // a cap rejects, it does not stop the workflow
    // The agent-level concurrency lock still applies.
    t.service.transitionTask(c1.id, { status: "running" });
    assert.throws(
      () => t.service.transitionTask(c2.id, { status: "running" }),
      (e: any) => e.code === "invocation_limit",
    );
    t.service.transitionTask(c1.id, { status: "completed", result: "r" });
    // Finished children free a slot.
    t.task(z.id, { invokedBy: p.id });
  } finally {
    t.close();
  }
});

test("cancelling a parent cancels queued descendants, aborts running ones and keeps partial results", async () => {
  const started: string[] = [];
  const t = await setup(async (cmd, _e, emit, signal) => {
    started.push(
      cmd.stdin || String((cmd.acp ?? (cmd.request as any))?.prompt),
    );
    emit({ type: "text", data: "child partial" });
    await new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  });
  try {
    const p = await t.agent("P"),
      x = await t.agent("X"),
      y = await t.agent("Y"),
      w = await t.agent("W");
    for (const c of [x, y, w]) t.edge(p.id, c.id);
    t.edge(x.id, w.id);
    const root = t.task(p.id);
    t.service.transitionTask(root.id, { status: "running" });
    const running = t.task(x.id, { invokedBy: p.id });
    const queuedChild = t.task(y.id, {
      invokedBy: p.id,
      dependsOn: [running.id],
    });
    const grandchild = t.task(w.id, {
      invokedBy: x.id,
      parentTaskId: running.id,
      dependsOn: [running.id],
    });
    await tick(t.scheduler);
    assert.equal(get(t.store, running.id).status, "running");
    // User cancels the parent (manual status path for a task not owned by a provider process).
    t.service.transitionTask(root.id, { status: "cancelled", result: "stop" });
    await tick(t.scheduler, 2);
    const final = (id: string) => get(t.store, id);
    assert.equal(final(running.id).status, "cancelled");
    assert.match(final(running.id).result!, /ancestor task .* was cancelled/);
    assert.equal(final(grandchild.id).status, "cancelled");
    assert.equal(final(queuedChild.id).status, "cancelled"); // inferred parent: root
    const s = t.service.limits.status(t.wf.id);
    assert.equal(
      s.tasks.find((x) => x.taskId === running.id)?.partialResult?.trim(),
      "child partial",
    );
    const events = t.store
      .history()
      .filter((e) => e.type === "delegation.returned");
    const ev = events.find(
      (e: any) => e.data.childTaskId === running.id,
    ) as any;
    assert.equal(ev.data.parentTaskId, root.id);
    assert.equal(ev.data.outcome, "cancelled");
    assert.equal(ev.data.partialResult.trim(), "child partial");
  } finally {
    t.close();
  }
});
