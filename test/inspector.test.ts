// Must stay the first import: points AGENTTEAM_DATA_DIR at a temp folder before config.ts loads.
import { tempDataDir } from "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager, executeCommand } from "../src/runtime.ts";
import { dataDir } from "../src/config.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createApi } from "../src/http.ts";
import {
  buildTimeline,
  explainWaiting,
  previewAccess,
  previewRun,
  transfers,
  type InspectorContext,
} from "../src/inspector.ts";
import { Playground } from "../src/playground.ts";
import { Redactor } from "../src/redact.ts";
import { exportBundle } from "../src/diagnostics.ts";
import type { Task } from "../src/model.ts";

type Provider = ConstructorParameters<typeof Scheduler>[2];
async function setup(provider?: Provider) {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd()),
    scheduler = new Scheduler(service, runs, provider);
  const dirs: string[] = [];
  const dir = async (sub?: string) => {
    const d = await mkdtemp(join(tmpdir(), "agentteam-insp-"));
    dirs.push(d);
    if (sub) await mkdir(join(d, sub), { recursive: true });
    return sub ? join(d, sub) : d;
  };
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
  const ctx: InspectorContext & { live: boolean; ready: any } = {
    live: true,
    ready: { state: "ready" },
    liveEnabled() {
      return this.live;
    },
    readiness() {
      return this.ready;
    },
  };
  const close = async () => {
    scheduler.stop();
    store.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
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
    ctx,
    dir,
    close,
  };
}
const tick = async (s: Scheduler, n = 1) => {
  for (let i = 0; i < n; i++) {
    await s.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
};
const codes = (e: { reasons: { code: string; blocking: boolean }[] }) =>
  e.reasons.filter((r) => r.blocking).map((r) => r.code);

test("timeline: events of one task share a correlation id, link to files and conversations, and filter", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentteam-insp-ws-"));
  const t = await setup(async (_c, _e, emit) => {
    emit({
      type: "tool",
      data: {
        toolCallId: "1",
        kind: "edit",
        title: "Edit a.ts",
        status: "completed",
        locations: [{ path: "/proj/src/a.ts" }],
      },
    });
    emit({ type: "text", data: "done" });
  });
  try {
    const worker = await t.agent("Worker", {
      model: "gpt-x",
      effort: "high",
      workspaces: [{ path: workspace, access: "write", active: true }],
    });
    t.service.saveEdge({ from: t.lead.id, to: worker.id, kind: "delegate" });
    t.service.session(worker.id);
    const ok = t.task(worker.id, { title: "Do it", invokedBy: t.lead.id });
    await tick(t.scheduler, 3);
    assert.equal(t.store.get<Task>("task", ok.id).status, "completed");
    const line = buildTimeline(t.service, { taskId: ok.id });
    const types = line.entries.map((e) => e.type);
    for (const expected of [
      "task.created",
      "flow.transferred",
      "task.settings",
      "resource.acquired",
      "task.status",
      "task.runtime",
      "resource.released",
    ])
      assert.ok(types.includes(expected), `missing ${expected}`);
    assert.deepEqual(
      [...new Set(line.entries.map((e) => e.correlationId))],
      ["task:" + ok.id],
    );
    assert.equal(line.correlations.length, 1);
    const settings = line.entries.find((e) => e.type === "task.settings")!;
    assert.match(settings.summary, /codex \/ gpt-x \/ high/);
    assert.equal(settings.category, "setting");
    assert.deepEqual(
      line.entries.filter((e) => e.category === "lock").map((e) => e.summary),
      ["Lock acquired", "Lock released"],
    );
    // seq order is preserved and results are categorised
    assert.deepEqual(
      line.entries.map((e) => e.seq),
      [...line.entries.map((e) => e.seq)].sort((a, b) => a - b),
    );
    assert.ok(line.entries.some((e) => e.category === "result"));
    // conversation link
    const convo = t.service.session(worker.id);
    assert.equal(line.entries[0].conversation?.sessionId, convo.id);
    // file link + filter
    const withFile = buildTimeline(t.service, { file: "src/a.ts" });
    assert.ok(withFile.entries.length >= 1);
    assert.ok(
      withFile.entries.every((e) => e.files.includes("/proj/src/a.ts")),
    );
    assert.equal(withFile.entries[0].category, "tool");
    // agent filter matches both ends of a transfer
    const leadSide = buildTimeline(t.service, { agentId: t.lead.id });
    assert.ok(leadSide.entries.some((e) => e.type === "flow.transferred"));
    assert.ok(
      buildTimeline(t.service, { agentId: worker.id }).entries.some(
        (e) => e.type === "flow.transferred",
      ),
    );
    assert.equal(
      buildTimeline(t.service, { agentId: "nobody" }).entries.length,
      0,
    );
    // workflow / type / category / prefix filters
    const wfOnly = buildTimeline(t.service, { workflowId: t.wf.id });
    assert.ok(wfOnly.entries.length >= line.entries.length);
    assert.ok(
      buildTimeline(t.service, { type: "lock" }).entries.every(
        (e) => e.category === "lock",
      ),
    );
    assert.ok(
      buildTimeline(t.service, { type: "task." }).entries.every((e) =>
        e.type.startsWith("task."),
      ),
    );
    assert.deepEqual(
      buildTimeline(t.service, { type: "task.status,resource.released" })
        .entries.map((e) => e.type)
        .filter((x, i, a) => a.indexOf(x) === i)
        .sort(),
      ["resource.released", "task.status"],
    );
    assert.ok(buildTimeline(t.service, { q: "gpt-x" }).entries.length >= 1);
    assert.equal(buildTimeline(t.service, { limit: 2 }).entries.length, 2);
    assert.equal(buildTimeline(t.service, { limit: 2 }).truncated, true);
    // severity: failures are errors, debug chatter is hidden by minSeverity
    const bad = t.task(worker.id, { title: "Breaks" });
    t.service.transitionTask(bad.id, { status: "running" });
    t.service.transitionTask(bad.id, { status: "failed", result: undefined });
    const errors = buildTimeline(t.service, { severity: "error" });
    assert.ok(errors.entries.length >= 1);
    assert.ok(errors.entries.every((e) => e.severity === "error"));
    assert.ok(errors.entries.every((e) => e.taskId === bad.id));
    const info = buildTimeline(t.service, { minSeverity: "info" });
    assert.ok(info.entries.every((e) => e.severity !== "debug"));
    assert.ok(
      buildTimeline(t.service, {}).entries.some((e) => e.severity === "debug"),
    );
    assert.throws(() => buildTimeline(t.service, { bogus: 1 } as never));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await t.close();
  }
});

test("waiting explainer: dependencies, pause, limits, control, validation, capacity, busy agent, leases", async () => {
  const t = await setup();
  try {
    const a = await t.agent("A"),
      b = await t.agent("B");
    // dependencies
    const first = t.task(a.id, { title: "First" });
    const second = t.task(b.id, { title: "Second", dependsOn: [first.id] });
    let e = explainWaiting(t.service, t.ctx, { taskId: second.id });
    assert.deepEqual(codes(e), ["dependencies"]);
    assert.match(
      e.reasons.find((r) => r.code === "dependencies")!.detail,
      /"First" \(A\) is queued/,
    );
    assert.match(e.headline, /^Waiting: Waiting for 1 dependency/);
    // queue position is context, not a blocker
    const pos = e.reasons.find((r) => r.code === "queue-position")!;
    assert.equal(pos.blocking, false);
    assert.equal((pos.refs as any).total, 2);
    // first task is eligible
    e = explainWaiting(t.service, t.ctx, { taskId: first.id });
    assert.deepEqual(codes(e), []);
    assert.match(e.headline, /^Eligible/);
    // paused
    t.service.pauseWorkflow(t.wf.id, true);
    assert.ok(
      codes(explainWaiting(t.service, t.ctx, { taskId: first.id })).includes(
        "workflow-paused",
      ),
    );
    t.service.pauseWorkflow(t.wf.id, false);
    // live execution disabled / runtime readiness
    t.ctx.live = false;
    assert.ok(
      codes(explainWaiting(t.service, t.ctx, { taskId: first.id })).includes(
        "live-disabled",
      ),
    );
    t.ctx.live = true;
    t.ctx.ready = { state: "resolving" };
    assert.ok(
      codes(explainWaiting(t.service, t.ctx, { taskId: first.id })).includes(
        "runtime-resolving",
      ),
    );
    t.ctx.ready = { state: "unavailable", message: "codex is not installed" };
    e = explainWaiting(t.service, t.ctx, { taskId: first.id });
    assert.ok(codes(e).includes("runtime-unavailable"));
    assert.match(
      e.reasons.find((r) => r.code === "runtime-unavailable")!.detail,
      /codex is not installed/,
    );
    t.ctx.ready = { state: "ready" };
    // human control
    t.service.control(a.id, "human");
    assert.ok(
      codes(explainWaiting(t.service, t.ctx, { taskId: first.id })).includes(
        "human-control",
      ),
    );
    assert.ok(
      codes(explainWaiting(t.service, t.ctx, { agentId: a.id })).includes(
        "human-control",
      ),
    );
    t.service.control(a.id, "team");
    // retry backoff
    t.store.put("task-recovery", {
      ...t.service.recovery.state(first.id),
      notBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.ok(
      codes(explainWaiting(t.service, t.ctx, { taskId: first.id })).includes(
        "retry-backoff",
      ),
    );
    t.store.put("task-recovery", {
      ...t.service.recovery.state(first.id),
      notBefore: null,
    });
    // validation gate
    const gated = t.task(b.id, {
      title: "Needs proof",
      requiresValidation: true,
    });
    e = explainWaiting(t.service, t.ctx, { taskId: gated.id });
    assert.ok(codes(e).includes("validation-required"));
    assert.equal(
      (e.reasons.find((r) => r.code === "validation-required")!.refs as any)
        .reason,
      "missing",
    );
    // busy agent: one task per agent at a time
    t.service.transitionTask(first.id, { status: "running" });
    const sameAgent = t.task(a.id, { title: "Also A" });
    e = explainWaiting(t.service, t.ctx, { taskId: sameAgent.id });
    assert.ok(codes(e).includes("agent-busy"));
    assert.match(
      e.reasons.find((r) => r.code === "agent-busy")!.detail,
      /"First"/,
    );
    assert.equal(
      explainWaiting(t.service, t.ctx, { taskId: first.id }).waiting,
      false,
    );
    // agent level reuses the same reason list and tags the task
    const agentView = explainWaiting(t.service, t.ctx, { agentId: a.id });
    assert.ok(
      agentView.reasons.some(
        (r) => r.code === "agent-busy" && r.taskId === sameAgent.id,
      ),
    );
    assert.equal(agentView.subject.kind, "agent");
    t.service.transitionTask(first.id, { status: "completed", result: "ok" });
  } finally {
    await t.close();
  }
});

test("waiting explainer: workflow limit trips, invocation capacity, lease owner with overlapping paths, queue priority", async () => {
  const t = await setup();
  try {
    const root = await t.dir(),
      sub = join(root, "pkg");
    await mkdir(sub);
    const owner = await t.agent("Owner", {
      workspaces: [{ path: root, access: "write", active: true }],
    });
    const neighbour = await t.agent("Neighbour", {
      workspaces: [{ path: sub, access: "write", active: true }],
    });
    const held = t.task(owner.id, { title: "Holds root" });
    t.service.transitionTask(held.id, { status: "running" });
    const waits = t.task(neighbour.id, { title: "Wants pkg" });
    const e = explainWaiting(t.service, t.ctx, { taskId: waits.id });
    assert.ok(codes(e).includes("resource-busy"));
    const r = e.reasons.find((x) => x.code === "resource-busy")!;
    assert.match(r.detail, /Owner holds the lease/);
    assert.ok(r.detail.includes(sub), "names the overlapping path");
    assert.equal((r.refs as any).leases[0].agentId, owner.id);
    assert.equal(
      (r.refs as any).leases[0].paths[0],
      await (await import("node:fs/promises")).realpath(root),
    );
    t.service.transitionTask(held.id, { status: "completed", result: "ok" });
    assert.ok(
      !codes(explainWaiting(t.service, t.ctx, { taskId: waits.id })).includes(
        "resource-busy",
      ),
    );

    // invocation capacity
    const boss = await t.agent("Boss", { maxConcurrentInvocations: 1 });
    const w1 = await t.agent("W1"),
      w2 = await t.agent("W2");
    for (const w of [w1, w2])
      t.service.saveEdge({ from: boss.id, to: w.id, kind: "delegate" });
    const c1 = t.task(w1.id, { title: "Child 1", invokedBy: boss.id });
    t.service.transitionTask(c1.id, { status: "running" });
    const c2 = t.task(w2.id, { title: "Child 2", invokedBy: boss.id });
    const cap = explainWaiting(t.service, t.ctx, { taskId: c2.id });
    assert.ok(codes(cap).includes("invocation-limit"));
    assert.match(
      cap.reasons.find((x) => x.code === "invocation-limit")!.detail,
      /1 of 1 slots/,
    );
    t.service.transitionTask(c1.id, { status: "completed", result: "ok" });
    t.service.transitionTask(c2.id, { status: "cancelled" });

    // priority, aging and queue position
    const low = await t.agent("Low", { schedulingPriority: 0 }),
      high = await t.agent("High", { schedulingPriority: 75 }),
      pre = await t.agent("Pre", { schedulingPriority: 101 });
    for (const x of ["Pending"]) void x;
    t.service.transitionTask(waits.id, { status: "cancelled" });
    const tl = t.task(low.id, { title: "low job" });
    const th = t.task(high.id, { title: "high job" });
    const tp = t.task(pre.id, { title: "preempt job" });
    const qp = (id: string) =>
      explainWaiting(t.service, t.ctx, { taskId: id }).reasons.find(
        (x) => x.code === "queue-position",
      )!;
    assert.equal((qp(tp.id).refs as any).position, 1);
    assert.equal((qp(th.id).refs as any).position, 2);
    assert.equal((qp(tl.id).refs as any).position, 3);
    assert.match(
      qp(tp.id).detail,
      /Preempt priority \(101\).*never interrupts/,
    );
    assert.match(
      qp(tl.id).detail,
      /Ahead: "preempt job" \(Pre\), "high job" \(High\)/,
    );
    assert.match(qp(tl.id).detail, /aging adds/);

    // limit trip: exact reason; also reported before the trip is recorded
    const used = t.service.limits.status(t.wf.id).counters.agentTurns;
    const turnCap = used + 1;
    t.service.limits.setLimits(t.wf.id, { maxAgentTurns: turnCap });
    t.service.transitionTask(th.id, { status: "running" });
    t.service.transitionTask(th.id, { status: "completed", result: "ok" });
    let lim = explainWaiting(t.service, t.ctx, { taskId: tl.id });
    assert.match(
      lim.reasons.find((x) => x.code === "workflow-limit")!.detail,
      new RegExp(`${turnCap} of ${turnCap} agent turns`),
    );
    assert.throws(() => t.service.transitionTask(tl.id, { status: "running" }));
    lim = explainWaiting(t.service, t.ctx, { taskId: tl.id });
    assert.match(
      lim.reasons.find(
        (x) => x.code === "workflow-limit" && /stopped/.test(x.title),
      )!.detail,
      new RegExp(`Maximum of ${turnCap} agent turns reached\\.`),
    );
  } finally {
    await t.close();
  }
});

test("waiting explainer: approvals, uncertain effects, interrupted and failed tasks", async () => {
  const t = await setup();
  try {
    const a = await t.agent("A");
    const task = t.task(a.id, { title: "Needs a decision" });
    const controller = new AbortController();
    const answered = t.service.approvals.request(
      a.id,
      {
        sessionId: "s",
        toolCall: {
          toolCallId: "c",
          title: "Run rm -rf build",
          kind: "execute",
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      } as never,
      controller.signal,
      task.id,
    );
    let e = explainWaiting(t.service, t.ctx, { taskId: task.id });
    assert.ok(codes(e).includes("approval-pending"));
    assert.match(
      e.reasons.find((r) => r.code === "approval-pending")!.detail,
      /Run rm -rf build/,
    );
    controller.abort();
    await answered;
    const fx = t.service.recovery.ledger.begin({
      taskId: task.id,
      key: "push:1",
      kind: "git",
      description: "git push origin main",
      mutating: true,
    });
    t.service.recovery.ledger.markUncertain(fx.effect.id, "connection lost");
    e = explainWaiting(t.service, t.ctx, { taskId: task.id });
    assert.ok(codes(e).includes("uncertain-effect"));
    assert.match(
      e.reasons.find((r) => r.code === "uncertain-effect")!.detail,
      /git push origin main/,
    );
    // interrupted
    const run = t.task(a.id, { title: "Was running" });
    t.service.recovery.ledger.decide(fx.effect.id, { decision: "abandon" });
    t.service.transitionTask(task.id, { status: "cancelled" });
    t.service.transitionTask(run.id, { status: "running" });
    t.service.transitionTask(run.id, { status: "interrupted" });
    e = explainWaiting(t.service, t.ctx, { taskId: run.id });
    assert.ok(codes(e).includes("interrupted"));
    assert.equal(e.waiting, true);
    // failed: retry gate is surfaced
    t.service.transitionTask(run.id, { status: "cancelled" });
    const f = t.task(a.id, { title: "Fails" });
    t.service.transitionTask(f.id, { status: "running" });
    t.service.transitionTask(f.id, { status: "failed", result: "boom" });
    e = explainWaiting(t.service, t.ctx, { taskId: f.id });
    assert.equal(e.waiting, false);
    assert.ok(
      e.reasons.some(
        (r) => r.code === "failed" && /Retry-from-checkpoint/.test(r.detail),
      ),
    );
    // finished tasks have nothing pending
    assert.equal(
      explainWaiting(t.service, t.ctx, { taskId: task.id }).waiting,
      false,
    );
  } finally {
    await t.close();
  }
});

test("transfers: request, response, duration and originating edge/rule; access and routing preview", async () => {
  const t = await setup(async (_c, _e, emit) => {
    await new Promise((r) => setTimeout(r, 30));
    emit({ type: "text", data: "all done" });
  });
  try {
    const root = await t.dir();
    const worker = await t.agent("Worker", {
      workspaces: [{ path: root, access: "read", active: true }],
    });
    const edge = t.service.saveEdge({
      from: t.lead.id,
      to: worker.id,
      kind: "delegate",
    });
    t.service.saveRule({
      agentId: worker.id,
      scope: "intake",
      priority: 5,
      match: { textIncludes: ["refactor"] },
      kind: "delegate",
    });
    const task = t.task(worker.id, {
      title: "Please refactor",
      instructions: "Split the module",
      invokedBy: t.lead.id,
    });
    let [tr] = transfers(t.service, { edgeId: edge.id });
    assert.equal(tr.state, "pending");
    assert.equal(tr.durationMs, null);
    await tick(t.scheduler, 3);
    await new Promise((r) => setTimeout(r, 60));
    [tr] = transfers(t.service, { taskId: task.id });
    assert.equal(tr.state, "returned");
    assert.equal(tr.request?.title, "Please refactor");
    assert.equal(tr.request?.text, "Split the module");
    assert.match(tr.response!.text, /all done/);
    assert.ok(tr.durationMs! >= 0);
    assert.equal(tr.rule.edge?.id, edge.id);
    assert.equal(tr.rule.edge?.kind, "delegate");
    assert.equal(tr.rule.matchedRules.length, 1);
    assert.equal(tr.rule.matchedRules[0].agentId, worker.id);
    assert.match(tr.rule.note, /inferred/);
    assert.equal(transfers(t.service, { edgeId: "other" }).length, 0);

    // access preview
    const ctx = t.ctx;
    const preview = await previewAccess(t.service, ctx, {
      agentId: worker.id,
      invokedBy: t.lead.id,
      paths: [
        { path: join(root, "a.txt"), access: "read" },
        { path: join(root, "a.txt"), access: "write" },
        { path: "/definitely/elsewhere/x", access: "read" },
        { path: "relative/x", access: "read" },
        { path: join(root, ".git", "config"), access: "read" },
      ],
    });
    const byPath = preview.decisions.filter((d) => d.kind === "path");
    assert.deepEqual(
      byPath.map((d) => d.allowed),
      [true, false, false, false, false],
    );
    assert.match(byPath[1].reason, /read-only/);
    assert.match(byPath[2].reason, /Outside every folder/);
    assert.match(byPath[4].reason, /\.git/);
    assert.equal(preview.allowed, false);
    assert.equal(
      preview.decisions.find((d) => d.kind === "communication")!.allowed,
      true,
    );
    assert.match(preview.note, /sandbox enforcement is not implemented/);
    const denied = await previewAccess(t.service, ctx, {
      agentId: t.lead.id,
      invokedBy: worker.id,
    });
    assert.equal(
      denied.decisions.find((d) => d.kind === "communication")!.allowed,
      false,
    );
    // combined preview reuses routing: explicit recipient without an edge is denied, not thrown
    const run = await previewRun(t.service, ctx, {
      route: { text: "x", fromAgentId: worker.id, targetId: t.lead.id },
    });
    assert.equal(run.routing.status, "denied");
    assert.equal(run.routing.code, "connection_denied");
    const routed = await previewRun(t.service, ctx, {
      route: { text: "please refactor this" },
      access: { paths: [{ path: root, access: "read" }] },
    });
    assert.equal(routed.routing.status, "selected");
    assert.equal(routed.routing.agentId, worker.id);
    assert.equal(routed.access?.agentId, worker.id);
    await assert.rejects(previewAccess(t.service, ctx, { agentId: "none" }));
  } finally {
    await t.close();
  }
});

test("playground: fixture-only isolated runs, expectations, saved examples and run comparison", async () => {
  const t = await setup();
  try {
    const liveDir = await t.dir();
    const planner = await t.agent("Planner", {
      model: "model-a",
      workspaces: [{ path: liveDir, access: "write", active: true }],
    });
    const builder = await t.agent("Builder", {
      workspaces: [{ path: liveDir, access: "write", active: true }],
    });
    t.service.saveEdge({ from: planner.id, to: builder.id, kind: "delegate" });
    const before = {
      tasks: t.store.list("task").length,
      leases: t.store.list("lease").length,
      files: await readdir(liveDir),
    };
    const playground = new Playground(
      t.service,
      () => new Redactor({ secretFiles: [] }),
    );
    const example = playground.saveExample({
      name: "Plan then build",
      description: "Two step team evaluation",
      files: { "input/spec.txt": "controlled input", "notes.md": "n" },
      tasks: [
        {
          key: "plan",
          title: "Plan",
          agent: "Planner",
          instructions: "Plan it",
        },
        { key: "build", title: "Build", agent: "Builder", dependsOn: ["plan"] },
      ],
      fixture: {
        Planner: { text: "PLAN: step one" },
        Builder: {
          text: "BUILT",
          tools: [
            { title: "Edit a.ts", kind: "edit", locations: ["src/a.ts"] },
          ],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      },
      expected: {
        workflowStatus: "completed",
        maxTurns: 2,
        tasks: {
          plan: { status: "completed", resultIncludes: ["PLAN"] },
          build: {
            status: "completed",
            resultMatches: "^BUILT",
            resultExcludes: ["ERROR"],
          },
        },
      },
    });
    assert.equal(playground.examples().length, 1);
    const run1 = await playground.execute({
      exampleId: example.id,
      label: "baseline",
    });
    assert.equal(run1.mode, "fixture");
    assert.equal(run1.workflowStatus, "completed");
    assert.equal(run1.stalled, false);
    assert.deepEqual(
      run1.outcomes.map((o) => [o.key, o.status]),
      [
        ["plan", "completed"],
        ["build", "completed"],
      ],
    );
    assert.match(run1.outcomes[0].result, /PLAN: step one/);
    assert.equal(
      run1.expectations.passed,
      true,
      JSON.stringify(run1.expectations),
    );
    assert.deepEqual(run1.workspace.files.map((f) => f.path).sort(), [
      "input/spec.txt",
      "notes.md",
    ]);
    assert.equal(run1.turns, 2);
    assert.ok(
      run1.timeline.some((e) => e.category === "tool" && e.taskKey === "build"),
    );
    assert.ok(
      run1.timeline.some(
        (e) => e.type === "task.settings" && /model-a/.test(e.summary),
      ),
    );
    // live data untouched: no tasks, leases, files or temp workspaces left behind
    assert.equal(t.store.list("task").length, before.tasks);
    assert.equal(t.store.list("lease").length, before.leases);
    assert.deepEqual(await readdir(liveDir), before.files);
    const leftovers = (await readdir(tmpdir())).filter((n) =>
      n.startsWith("agentteam-playground-"),
    );
    assert.deepEqual(leftovers, []);
    // changed model + prompt + fixture: configuration, outcome and timeline differences
    const run2 = await playground.execute({
      exampleId: example.id,
      label: "after change",
      overrides: {
        agents: { Planner: { model: "model-b", instructions: "Be terse." } },
        fixture: { ...example.fixture, Planner: { text: "different plan" } },
      },
    });
    assert.equal(run2.expectations.passed, false);
    assert.ok(
      run2.expectations.checks.some(
        (c) => !c.passed && /includes "PLAN"/.test(c.name),
      ),
    );
    const diff = playground.compare(run1.id, run2.id);
    assert.equal(diff.config.changed, true);
    const planner2 = diff.config.agents.find((a) => a.name === "Planner")!;
    assert.deepEqual(planner2.changes.map((c) => c.field).sort(), [
      "instructions",
      "instructionsHash",
      "model",
    ]);
    assert.equal(
      diff.outcomes.tasks.find((o) => o.key === "plan")!.resultChanged,
      true,
    );
    assert.equal(
      diff.outcomes.tasks.find((o) => o.key === "build")!.resultChanged,
      false,
    );
    assert.ok(diff.timeline.added.some((s) => s.includes("model-b")));
    assert.ok(diff.timeline.removed.some((s) => s.includes("model-a")));
    assert.equal(diff.expectations.a, true);
    assert.equal(diff.expectations.b, false);
    assert.match(diff.summary, /Configuration changed; 1 of 2 task outcome/);
    const same = playground.compare(run1.id, run1.id);
    assert.equal(same.config.changed, false);
    assert.equal(same.timeline.added.length + same.timeline.removed.length, 0);
    assert.equal(playground.runs().length, 2);
    assert.equal(playground.runs()[0].label, "baseline");
    // failures and stalls are reported, not hidden
    const failing = await playground.execute({
      example: {
        name: "failing",
        tasks: [
          { key: "a", title: "A", agent: "Planner" },
          {
            key: "v",
            title: "Gated",
            agent: "Builder",
            requiresValidation: true,
          },
        ],
        fixture: { Planner: { fail: "scripted failure" } },
        expected: { tasks: { a: { status: "completed" } } },
      },
    });
    assert.equal(failing.outcomes[0].status, "failed");
    assert.equal(failing.stalled, true);
    assert.match(
      failing.outcomes[1].waiting ?? "",
      /Waiting: Required validation/,
    );
    assert.equal(failing.expectations.passed, false);
    // input validation
    await assert.rejects(
      playground.execute({
        example: {
          name: "x",
          tasks: [{ key: "a", title: "A", agent: "Ghost" }],
        },
      }),
      /not on the team/,
    );
    await assert.rejects(
      playground.execute({
        example: {
          name: "x",
          files: { "../escape": "x" },
          tasks: [{ key: "a", title: "A", agent: "Planner" }],
        },
      }),
      /relative to the workspace/,
    );
    assert.throws(
      () =>
        playground.saveExample({
          name: "x",
          tasks: [
            { key: "a", title: "A", agent: "Planner", dependsOn: ["zz"] },
          ],
        }),
      /unknown task/,
    );
    playground.deleteExample(example.id);
    assert.equal(playground.examples().length, 0);
  } finally {
    await t.close();
  }
});

// ---- redaction -------------------------------------------------------------------------------
function unzip(buffer: Buffer) {
  const files: Record<string, string> = {};
  let off = 0;
  while (buffer.readUInt32LE(off) === 0x04034b50) {
    const size = buffer.readUInt32LE(off + 18),
      nameLen = buffer.readUInt16LE(off + 26),
      extra = buffer.readUInt16LE(off + 28);
    const name = buffer.subarray(off + 30, off + 30 + nameLen).toString();
    const data = buffer.subarray(
      off + 30 + nameLen + extra,
      off + 30 + nameLen + extra + size,
    );
    files[name] = inflateRawSync(data).toString();
    off += 30 + nameLen + extra + size;
  }
  return files;
}

test("diagnostic bundle: canary secrets (env, token file, bearer headers, secret keys) never appear", async () => {
  const canaries = {
    envToken: "canary-env-TOKEN-7f3a9c1d2e4b",
    envKey: "canary-env-APIKEY-55aa77bb99cc",
    envSecret: "canary-env-SECRET-0d1e2f3a4b5c",
    file: "canary-file-token-81d3a7e55c0b9f42aa",
    bearer: "canary-bearer-9a8b7c6d5e4f3a2b",
    api: "canary-token-literal-1a2b3c4d5e6f",
    keyField: "canary-keyfield-b4b4b4b4b4b4",
    skey: "sk-canaryopenaikey1234567890abcdef",
  };
  const saved = Object.fromEntries(
    ["CANARY_API_TOKEN", "CANARY_PROVIDER_KEY", "CANARY_DB_SECRET"].map((n) => [
      n,
      process.env[n],
    ]),
  );
  process.env.CANARY_API_TOKEN = canaries.envToken;
  process.env.CANARY_PROVIDER_KEY = canaries.envKey;
  process.env.CANARY_DB_SECRET = canaries.envSecret;
  const t = await setup(async (_c, _e, emit) => {
    emit({
      type: "tool",
      data: {
        toolCallId: "1",
        kind: "execute",
        title: `curl -H "Authorization: Bearer ${canaries.bearer}" and ${canaries.file}`,
        status: "completed",
        api_key: canaries.keyField,
        rawInput: { env: `TOKEN=${canaries.envToken}` },
        locations: [{ path: "/work/private.txt" }],
      },
    });
    emit({
      type: "text",
      data: `result mentions ${canaries.envSecret} and ${canaries.skey}`,
    });
  });
  const dir = await t.dir();
  const tokenFile = join(dir, "api-token");
  await writeFile(tokenFile, canaries.file + "\n");
  await writeFile(join(dir, "private.txt"), "FILE-CONTENT-CANARY");
  try {
    const a = await t.agent("Worker", {
      role: `role with ${canaries.api}`,
      instructions: "PRIVATE-PROMPT-CANARY " + canaries.envToken,
      workspaces: [{ path: dir, access: "write", active: true }],
    });
    const task = t.task(a.id, {
      title: "Use " + canaries.envKey,
      instructions: "Header: Authorization: Bearer " + canaries.bearer,
    });
    await tick(t.scheduler, 3);
    assert.equal(t.store.get<Task>("task", task.id).status, "completed");
    const controller = new AbortController();
    const pending = t.service.approvals.request(
      a.id,
      {
        sessionId: "s",
        toolCall: {
          toolCallId: "c",
          title: "Run with " + canaries.envToken,
          kind: "execute",
          rawInput: { secret: canaries.skey },
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      } as never,
      controller.signal,
      task.id,
    );
    t.service.recovery.ledger.begin({
      taskId: task.id,
      key: "k",
      kind: "x",
      description: "push using " + canaries.envSecret,
      mutating: false,
    });
    const options = {
      redaction: { literals: [canaries.api], secretFiles: [tokenFile] },
      runtimes: () => [
        { id: "codex", path: `/usr/bin/codex?token=${canaries.api}` },
      ],
    };
    const json = exportBundle(t.service, t.ctx, { format: "json", ...options });
    const zipped = exportBundle(t.service, t.ctx, {
      format: "zip",
      ...options,
    });
    const unzipped = unzip(Buffer.from(zipped.data, "base64"));
    assert.ok(Object.keys(unzipped).includes("timeline.json"));
    assert.ok(Object.keys(unzipped).includes("manifest.json"));
    assert.equal(zipped.contentType, "application/zip");
    const outputs: [string, string][] = [
      ["json", json.data],
      ...Object.entries(unzipped).map(([n, v]) => [n, v] as [string, string]),
    ];
    for (const [name, text] of outputs) {
      for (const [label, canary] of Object.entries(canaries))
        assert.ok(
          !text.includes(canary),
          `${label} canary leaked into ${name}`,
        );
      assert.ok(
        !text.includes("FILE-CONTENT-CANARY"),
        "file contents leaked into " + name,
      );
      assert.ok(
        !text.includes("PRIVATE-PROMPT-CANARY"),
        "prompt text leaked into " + name,
      );
      assert.ok(
        !text.includes(Buffer.from(canaries.file).toString("base64")),
        "encoded secret in " + name,
      );
    }
    JSON.parse(json.data); // still valid JSON after scrubbing
    for (const text of Object.values(unzipped)) JSON.parse(text);
    // Useful content survives: the timeline and path (names, not contents), env var NAMES only.
    const timeline = JSON.parse(unzipped["timeline.json"]);
    assert.ok(
      timeline.entries.some((e: any) => e.files.includes("/work/private.txt")),
    );
    const env = JSON.parse(unzipped["environment.json"]);
    assert.ok(env.maskedEnvironmentVariableNames.includes("CANARY_API_TOKEN"));
    assert.ok(
      env.maskedEnvironmentVariableNames.includes("CANARY_PROVIDER_KEY"),
    );
    assert.ok(json.redaction.literalsRemoved > 0);
    assert.ok(json.redaction.keysRemoved > 0);
    assert.ok(json.redaction.secretEnvNames.includes("CANARY_DB_SECRET"));
    assert.ok(json.bytes > 500);
    // approval raw input is omitted entirely
    assert.ok(!unzipped["approvals.json"].includes("rawInput"));
    controller.abort();
    await pending;
  } finally {
    for (const [n, v] of Object.entries(saved))
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    await t.close();
  }
});

test("diagnostic bundle: prompts, raw tool input, diffs, provider output and file contents never appear (non-secret canaries)", async () => {
  // Plain words, so no credential pattern or secret-key rule can hide a leak: only the allow-list can.
  const canaries = {
    rawInput: "marmalade-rawinput-command-canary",
    rawInputPath: "lantern-rawinput-nested-canary",
    diffOld: "periwinkle-diff-oldtext-canary",
    diffNew: "tangerine-diff-newtext-canary",
    output: "saxophone-provider-output-canary",
    taskInstructions: "cobblestone-task-instructions-canary",
    agentInstructions: "hummingbird-agent-instructions-canary",
    role: "watercress-role-canary",
    goal: "gondola-workflow-goal-canary",
    approvalInput: "quartzite-approval-rawinput-canary",
    file: "meadowlark-file-content-canary",
  };
  const t = await setup(async (_c, _e, emit) => {
    emit({
      type: "tool",
      data: {
        toolCallId: "1",
        kind: "execute",
        title: "Run build",
        status: "completed",
        rawInput: {
          command: `make ${canaries.rawInput}`,
          options: { note: canaries.rawInputPath },
        },
        locations: [{ path: "/work/src/a.ts" }],
      },
    });
    emit({
      type: "tool",
      data: {
        toolCallId: "2",
        kind: "edit",
        title: "Edit a.ts",
        status: "completed",
        content: [
          {
            type: "diff",
            path: "/work/src/a.ts",
            oldText: `old ${canaries.diffOld}`,
            newText: `new ${canaries.diffNew}`,
          },
        ],
        locations: [{ path: "/work/src/a.ts" }],
      },
    });
    emit({ type: "text", data: `The answer is ${canaries.output}` });
  });
  const dir = await t.dir();
  await writeFile(join(dir, "notes.txt"), canaries.file);
  try {
    const a = await t.agent("Worker", {
      role: canaries.role,
      instructions: canaries.agentInstructions,
      workspaces: [{ path: dir, access: "write", active: true }],
    });
    const wf = t.service.workflow({
      name: "Canary workflow",
      goal: canaries.goal,
      ownerId: a.id,
      completionCriteria: "D",
    });
    const task = t.service.task({
      workflowId: wf.id,
      agentId: a.id,
      title: "Build it",
      instructions: canaries.taskInstructions + " see notes.txt",
      completionCriteria: "D",
    });
    await tick(t.scheduler, 3);
    const done = t.store.get<Task>("task", task.id);
    assert.equal(done.status, "completed");
    assert.match(done.result ?? "", new RegExp(canaries.output));
    const controller = new AbortController();
    const pending = t.service.approvals.request(
      a.id,
      {
        sessionId: "s",
        toolCall: {
          toolCallId: "c",
          title: "Run tests",
          kind: "execute",
          rawInput: { command: canaries.approvalInput },
          locations: [{ path: "/work/src/a.ts" }],
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      } as never,
      controller.signal,
      task.id,
    );
    const options = { redaction: { secretFiles: [], literals: [] } };
    const json = exportBundle(t.service, t.ctx, { format: "json", ...options });
    const zipped = exportBundle(t.service, t.ctx, {
      format: "zip",
      ...options,
    });
    const unzipped = unzip(Buffer.from(zipped.data, "base64"));
    assert.deepEqual(Object.keys(unzipped).sort(), [...zipped.files].sort());
    const outputs: [string, string][] = [
      ["json", json.data],
      ...Object.entries(unzipped),
    ];
    for (const [name, text] of outputs) {
      for (const [label, canary] of Object.entries(canaries))
        assert.ok(!text.includes(canary), `${label} leaked into ${name}`);
      assert.ok(!text.includes("rawInput"), `rawInput key in ${name}`);
      assert.ok(!text.includes("oldText"), `diff content key in ${name}`);
    }
    // Still useful: tool steps with status/kind/title, the paths they touched, digests of prompts.
    const timeline = JSON.parse(unzipped["timeline.json"]);
    const toolEntry = timeline.entries.find(
      (e: any) => e.category === "tool" && e.detail.title === "Run build",
    );
    assert.ok(toolEntry, "tool steps are still listed");
    assert.equal(toolEntry.detail.status, "completed");
    assert.equal(toolEntry.detail.kind, "execute");
    assert.ok(toolEntry.files.includes("/work/src/a.ts"));
    assert.ok(timeline.entries.every((e: any) => !("data" in e)));
    const config = JSON.parse(unzipped["config.json"]);
    const worker = config.agents.find((x: any) => x.name === "Worker");
    assert.equal(worker.role.length, canaries.role.length);
    assert.match(worker.role.sha256, /^[0-9a-f]{12}$/);
    const tasks = JSON.parse(unzipped["tasks.json"]);
    const exported = tasks.find((x: any) => x.id === task.id);
    assert.deepEqual(Object.keys(exported.result).sort(), ["length", "sha256"]);
    const workflows = JSON.parse(unzipped["workflows.json"]);
    assert.equal(
      workflows.find((x: any) => x.id === wf.id).goal.length,
      canaries.goal.length,
    );
    controller.abort();
    await pending;
  } finally {
    await t.close();
  }
});

test("playground: the sandbox cannot reach the real provider executor for chat runs", async () => {
  const t = await setup();
  try {
    const liveDir = await t.dir();
    await t.agent("Planner", {
      workspaces: [{ path: liveDir, access: "write", active: true }],
    });
    const playground = new Playground(
      t.service,
      () => new Redactor({ secretFiles: [] }),
    );
    const calls: unknown[] = [];
    playground.onSandbox = ({ service, runs }) => {
      assert.notEqual(runs.execute, executeCommand);
      const sandboxed = runs.execute;
      runs.execute = async (...args) => {
        try {
          return await sandboxed(...args);
        } catch (e) {
          calls.push((e as { code?: string }).code);
          throw e;
        }
      };
      // A conversation queued inside the copy (e.g. delivered feedback) would be scheduled.
      const planner = service.store
        .list<{ id: string; name: string }>("agent")
        .find((a) => a.name === "Planner")!;
      const session = service.session(planner.id);
      service.message(session.id, { text: "hello" });
      void runs.start(session.id);
    };
    const run = await playground.execute({
      example: {
        name: "chat",
        tasks: [{ key: "a", title: "A", agent: "Planner" }],
        fixture: { Planner: { text: "ok" } },
      },
    });
    assert.equal(run.outcomes[0].status, "completed");
    assert.deepEqual(calls, ["playground_no_chat"]);
  } finally {
    await t.close();
  }
});

test("playground: a setup failure does not leave the playground busy", async () => {
  const t = await setup();
  try {
    await t.agent("Planner");
    const playground = new Playground(
      t.service,
      () => new Redactor({ secretFiles: [] }),
    );
    const example = {
      name: "x",
      tasks: [{ key: "a", title: "A", agent: "Planner" }],
    };
    const saved = Object.fromEntries(
      ["TMPDIR", "TMP", "TEMP"].map((k) => [k, process.env[k]]),
    );
    const missing = join(await t.dir(), "missing", "deeper");
    for (const k of Object.keys(saved)) process.env[k] = missing;
    try {
      await assert.rejects(playground.execute({ example }), /ENOENT/);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    assert.equal(playground.running, false);
    const run = await playground.execute({ example });
    assert.equal(run.outcomes[0].status, "completed");
  } finally {
    await t.close();
  }
});

test("redactor: credential shapes, secret-named keys, encoded copies and bounded output", () => {
  const r = new Redactor({
    literals: ["live-api-token-abcdef123456"],
    secretFiles: [],
    env: {},
  });
  const out = r.value({
    note: "Authorization: Bearer abcdefghijklmnop and sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuv",
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH1234",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
    line: "password=hunter2hunter2 apiKey: zzzzzzzz1234",
    password: "plain",
    nested: {
      Authorization: "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      count: 3,
      maxTokens: 100,
    },
    encoded:
      encodeURIComponent("live-api-token-abcdef123456") +
      " " +
      Buffer.from("live-api-token-abcdef123456").toString("base64"),
    plain: "see live-api-token-abcdef123456",
    long: "x".repeat(5000),
    [`key-live-api-token-abcdef123456`]: 1,
  }) as any;
  const text = JSON.stringify(out);
  for (const bad of [
    "abcdefghijklmnop",
    "sk-abcdef",
    "ghp_abc",
    "eyJhbGci",
    "MIIEabc",
    "hunter2hunter2",
    "zzzzzzzz1234",
    "QWxhZGRpbjpvcGVu",
    "live-api-token",
    "bGl2ZS1hcGk",
  ])
    assert.ok(!text.includes(bad), bad + " survived: " + text);
  assert.equal(out.password, "[REDACTED]");
  assert.equal(out.nested.Authorization, "[REDACTED]");
  assert.equal(out.nested.count, 3);
  assert.equal(
    out.nested.maxTokens,
    100,
    "numeric counters named like tokens are kept",
  );
  assert.ok(out.long.length < 2100 && out.long.includes("truncated"));
  assert.equal(r.leaks(text), 0);
});

test("inspector API: authenticated routes, waiting/timeline/preview/export over HTTP", async (t) => {
  // The default secret source (data dir api-token) must be the temp dir, never the user's.
  assert.equal(dataDir, tempDataDir);
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    server = createApi(
      team,
      "tok-inspector-secret-value",
      new RunManager(team, false, process.cwd()),
    );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        authorization: "Bearer tok-inspector-secret-value",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  for (const [method, path] of [
    ["GET", "/inspector/timeline"],
    ["GET", "/inspector/waiting"],
    ["POST", "/inspector/bundle"],
    ["POST", "/inspector/playground/run"],
    ["GET", "/inspector/examples"],
  ])
    assert.equal((await fetch(base + path, { method })).status, 401, path);
  const a = (await call("/agents", "POST", { name: "A", environment: "codex" }))
    .json;
  const b = (await call("/agents", "POST", { name: "B", environment: "codex" }))
    .json;
  const wf = (
    await call("/workflows", "POST", {
      name: "W",
      goal: "G",
      ownerId: a.id,
      completionCriteria: "D",
    })
  ).json;
  const t1 = (
    await call("/tasks", "POST", {
      workflowId: wf.id,
      agentId: a.id,
      title: "one",
      completionCriteria: "D",
    })
  ).json;
  const t2 = (
    await call("/tasks", "POST", {
      workflowId: wf.id,
      agentId: b.id,
      title: "two",
      completionCriteria: "D",
      dependsOn: [t1.id],
    })
  ).json;
  const waiting = await call(`/inspector/tasks/${t2.id}/waiting`);
  assert.equal(waiting.status, 200);
  assert.ok(
    waiting.json.reasons.some(
      (r: any) => r.code === "dependencies" && r.blocking,
    ),
  );
  assert.ok(waiting.json.reasons.some((r: any) => r.code === "live-disabled"));
  assert.equal(
    (await call(`/inspector/agents/${b.id}/waiting`)).json.subject.kind,
    "agent",
  );
  assert.equal((await call("/inspector/tasks/nope/waiting")).status, 404);
  const list = await call("/inspector/waiting");
  assert.equal(list.json.length, 2);
  const line = await call(
    `/inspector/timeline?taskId=${t1.id}&minSeverity=info`,
  );
  assert.equal(line.status, 200);
  assert.ok(line.json.entries.length >= 1);
  assert.equal((await call("/inspector/timeline?bogus=1")).status, 400);
  assert.equal((await call("/inspector/timeline?limit=0")).status, 400);
  const prev = await call("/inspector/preview", "POST", {
    route: { text: "hello", targetId: b.id },
  });
  assert.equal(prev.json.routing.status, "selected");
  assert.equal(prev.json.access.agentId, b.id);
  const ex = await call("/inspector/examples", "POST", {
    name: "e",
    tasks: [{ key: "a", title: "A", agent: "A" }],
  });
  assert.equal(ex.status, 201);
  const run = await call(`/inspector/examples/${ex.json.id}/run`, "POST", {
    label: "r1",
  });
  assert.equal(run.status, 201);
  assert.equal(run.json.workflowStatus, "completed");
  const run2 = await call("/inspector/playground/run", "POST", {
    exampleId: ex.json.id,
    overrides: { agents: { A: { model: "other" } } },
  });
  const cmp = await call("/inspector/compare", "POST", {
    a: run.json.id,
    b: run2.json.id,
  });
  assert.equal(cmp.json.config.changed, true);
  assert.equal(
    (await call("/inspector/compare", "POST", { a: "x", b: run2.json.id }))
      .status,
    404,
  );
  assert.equal((await call("/inspector/runs")).json.length, 2);
  assert.equal(
    (await call(`/inspector/examples/${ex.json.id}`, "DELETE")).status,
    200,
  );
  const bundle = await call("/inspector/bundle", "POST", { format: "zip" });
  assert.equal(bundle.status, 200);
  const files = unzip(Buffer.from(bundle.json.data, "base64"));
  for (const text of Object.values(files))
    assert.ok(!text.includes("tok-inspector-secret-value"));
  assert.ok(files["config.json"].includes('"name": "A"'));
  assert.equal(
    (await call("/inspector/bundle", "POST", { format: "tar" })).status,
    400,
  );
});
