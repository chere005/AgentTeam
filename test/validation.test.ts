import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import {
  KernelUnavailableError,
  ValidationService,
  WolframscriptRunner,
  type KernelResult,
  type KernelRunner,
} from "../src/validation.ts";
import type { Task } from "../src/model.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";

const ok = (over: Partial<KernelResult> = {}): KernelResult => ({
  kernelVersion: "14.3.0 for Fake (test)",
  stdout: "True\n",
  exitCode: 0,
  durationMs: 5,
  assertions: [{ name: "sum", passed: true }],
  ...over,
});
const spec = (over: object = {}) => ({
  claim: "1+1==2",
  source: 'validationAssertions = {<|"name"->"sum","passed"->(1+1==2)|>}',
  evidenceKind: "symbolic-proof" as const,
  ...over,
});
class FakeRunner implements KernelRunner {
  calls = 0;
  running = 0;
  maxRunning = 0;
  gates: (() => void)[] = [];
  handler: (n: number) => Promise<KernelResult> | KernelResult = () => ok();
  async run({ signal }: { signal: AbortSignal }) {
    this.calls++;
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      return await this.handler(this.calls);
    } finally {
      this.running--;
    }
  }
}
async function setup() {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([]));
  const runner = new FakeRunner();
  service.validation = new ValidationService(store, service.resources, {
    runner,
  });
  const lead = await service.saveAgent({ name: "Lead", environment: "codex" });
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  const mk = (extra: object = {}) =>
    service.task({
      workflowId: wf.id,
      agentId: lead.id,
      title: "Step",
      instructions: "use x=2",
      completionCriteria: "D",
      requiresValidation: true,
      ...extra,
    });
  const task = (id: string) => store.get<Task>("task", id);
  return { store, service, runner, mk, task, v: service.validation };
}

test("correct math passes and opens the gate", async () => {
  const { service, mk, task, v } = await setup();
  const t = mk();
  assert.equal(service.taskState(t.id).waitReason, "validation-required");
  const rec = await v.start(t.id, spec()).done;
  assert.equal(rec.status, "pass");
  assert.equal(rec.kernel?.version, "14.3.0 for Fake (test)");
  assert.equal(v.gate(task(t.id)).open, true);
  assert.equal(service.taskState(t.id).waitReason, null);
  service.transitionTask(t.id, { status: "running" });
});

test("deliberately wrong math fails and keeps dependents blocked", async () => {
  const { service, runner, mk, task, v } = await setup();
  runner.handler = () =>
    ok({ stdout: "False\n", assertions: [{ name: "sum", passed: false }] });
  const t = mk();
  const rec = await v.start(t.id, spec({ claim: "1+1==3" })).done;
  assert.equal(rec.status, "fail");
  assert.equal(v.gate(task(t.id)).reason, "failed");
  assert.throws(() => service.transitionTask(t.id, { status: "running" }), {
    code: "validation_required",
  });
  const dep = mk({ dependsOn: [t.id], requiresValidation: false });
  assert.equal(service.taskState(dep.id).waitReason, "dependencies");
});

test("stale evidence re-blocks when inputs change", async () => {
  const { store, service, mk, task, v } = await setup();
  const up = mk({ requiresValidation: false, title: "Upstream" });
  const t = mk({ dependsOn: [up.id] });
  service.transitionTask(up.id, { status: "running" });
  service.transitionTask(up.id, { status: "completed", result: "x=2" });
  assert.equal((await v.start(t.id, spec()).done).status, "pass");
  assert.equal(v.gate(task(t.id)).open, true);
  // Inputs change (upstream result differs): the old pass no longer counts.
  store.put("task", { ...task(up.id), result: "x=3" });
  const g = v.gate(task(t.id));
  assert.equal(g.open, false);
  assert.equal(g.reason, "stale");
  assert.equal(service.taskState(t.id).waitReason, "validation-required");
  assert.equal(v.effectiveStatus(v.records(t.id)[0], g.inputHash), "stale");
});

test("cancellation of a cooperative run", async () => {
  const { store, runner, mk, task, v } = await setup();
  runner.run = ({ signal }: { signal: AbortSignal }) =>
    new Promise<KernelResult>((resolve) =>
      signal.addEventListener("abort", () => resolve(ok({ exitCode: 1 }))),
    );
  const t = mk();
  const { runId, done } = v.start(t.id, spec());
  await new Promise((r) => setTimeout(r, 10));
  v.cancel(runId);
  const rec = await done;
  assert.equal(rec.status, "cancelled");
  assert.equal(v.gate(task(t.id)).reason, "cancelled");
  assert.equal(v.resources.slotCount("wolfram-validation"), 0);
  assert.equal(v.activeRuns().length, 0);
  assert.throws(() =>
    store.db.exec("DELETE FROM entities WHERE kind='validation'"),
  );
});

test("missing kernel is inconclusive, never pass", async () => {
  const { runner, mk, task, v } = await setup();
  runner.run = async () => {
    throw new KernelUnavailableError("wolframscript not found");
  };
  const t = mk();
  const rec = await v.start(t.id, spec()).done;
  assert.equal(rec.status, "inconclusive");
  assert.match(rec.reason, /unavailable/);
  assert.equal(v.gate(task(t.id)).open, false);
  const real = new WolframscriptRunner("/nonexistent/wolframscript-xyz");
  await assert.rejects(
    real.run({
      source: "1",
      timeoutMs: 1000,
      signal: new AbortController().signal,
    }),
    KernelUnavailableError,
  );
});

test("hard cap of two concurrent validation runs", async () => {
  const { service, runner, mk, v } = await setup();
  const releases: (() => void)[] = [];
  runner.handler = () =>
    new Promise<KernelResult>((resolve) => releases.push(() => resolve(ok())));
  assert.equal(v.maxConcurrent, 2);
  const capped = new ValidationService(v.store, service.resources, {
    maxConcurrent: 10,
    runner,
  });
  assert.equal(capped.maxConcurrent, 2);
  const runs = [mk(), mk(), mk()].map((t) => v.start(t.id, spec()));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(releases.length, 2);
  assert.equal(v.resources.slotCount("wolfram-validation"), 2);
  assert.deepEqual(
    v
      .activeRuns()
      .map((r) => r.state)
      .sort(),
    ["running", "running", "waiting"],
  );
  releases[0]();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(releases.length, 2 + 1);
  releases[1]();
  releases[2]();
  const records = await Promise.all(runs.map((r) => r.done));
  assert.ok(records.every((r) => r.status === "pass"));
  assert.equal(runner.maxRunning, 2);
  assert.equal(v.resources.slotCount("wolfram-validation"), 0);
});

test("nonempty agent output and kernel-less records are not evidence", async () => {
  const { store, service, runner, mk, task, v } = await setup();
  const t = mk();
  // Agent claims validated, task result is nonempty prose.
  store.put("task", { ...task(t.id), result: "Validated! All checks passed." });
  assert.equal(v.gate(task(t.id)).open, false);
  // Runner returns output but no assertions, or no version, or nonzero exit.
  for (const bad of [
    ok({ assertions: [] }),
    ok({ kernelVersion: "" }),
    ok({ exitCode: 2 }),
    ok({ stdout: "  " }),
    ok({ timedOut: true }),
  ]) {
    runner.handler = () => bad;
    const t2 = mk();
    const rec = await v.start(t2.id, spec()).done;
    assert.equal(rec.status, "inconclusive");
    assert.equal(v.gate(task(t2.id)).open, false);
  }
  // A forged pass record without kernel output is rejected by the gate.
  const t3 = mk();
  const h = v.gate(task(t3.id)).inputHash;
  store.put("validation", {
    id: "forged",
    seq: 99,
    taskId: t3.id,
    attempt: 1,
    inputHash: h,
    sourceHash: "x",
    spec: {
      ...spec(),
      assumptions: [],
      domains: [],
      derivation: "",
      inputs: {},
    },
    kernel: null,
    assertions: [],
    status: "pass",
    reason: "trust me",
    startedAt: "",
    finishedAt: "",
  });
  assert.equal(v.gate(task(t3.id)).open, false);
  assert.equal(service.taskState(t3.id).waitReason, "validation-required");
});

test("numerical evidence needs tolerances; attempts are bounded", async () => {
  const { runner, mk, v } = await setup();
  const t = mk();
  assert.throws(() =>
    v.start(t.id, spec({ evidenceKind: "numerical-evidence" })),
  );
  runner.handler = () => ok({ assertions: [{ name: "a", passed: false }] });
  for (let i = 0; i < 3; i++) await v.start(t.id, spec()).done;
  assert.equal(v.records(t.id).length, 3);
  assert.deepEqual(
    v.records(t.id).map((r) => r.attempt),
    [1, 2, 3],
  );
  assert.throws(() => v.start(t.id, spec()), { code: "attempts_exhausted" });
  const rec = await v.start(
    mk().id,
    spec({
      evidenceKind: "numerical-evidence",
      tolerance: { absolute: 1e-9, precision: 30 },
    }),
  ).done;
  assert.equal(rec.spec.tolerance?.absolute, 1e-9);
});

test("validation API routes require auth and run through the gate", async (t) => {
  const { store, service, runner, mk } = await setup();
  const runs = new RunManager(service, false, process.cwd());
  const server = createApi(service, "tok", runs);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const task = mk();
  assert.equal(
    (await fetch(url + `/tasks/${task.id}/validations`)).status,
    401,
  );
  const call = (path: string, init: RequestInit = {}) =>
    fetch(url + path, {
      ...init,
      headers: {
        authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
    });
  // Kernel runs follow the live-execution switch, like provider runs.
  const disabled = await call(`/tasks/${task.id}/validations?wait=1`, {
    method: "POST",
    body: JSON.stringify(spec()),
  });
  assert.equal(disabled.status, 403);
  assert.equal(runner.calls, 0);
  runs.enabled = true;
  const bad = await call(`/tasks/${task.id}/validations?wait=1`, {
    method: "POST",
    body: JSON.stringify({ ...spec(), status: "pass" }),
  });
  assert.equal(bad.status, 400);
  const res = await call(`/tasks/${task.id}/validations?wait=1`, {
    method: "POST",
    body: JSON.stringify(spec()),
  });
  assert.equal(res.status, 201);
  const rec = (await res.json()) as { id: string; status: string };
  assert.equal(rec.status, "pass");
  const view = (await (
    await call(`/tasks/${task.id}/validations`)
  ).json()) as any;
  assert.equal(view.gate.open, true);
  assert.equal((await call(`/validations/${rec.id}`)).status, 200);
  assert.equal(runner.calls, 1);
  void store;
});

// Opt-in: AGENTTEAM_WOLFRAM_SMOKE=1 runs against a REAL local Wolfram kernel via wolframscript.
// Skipped by default; the fake-runner tests above are NOT evidence of end-to-end kernel validation.
test(
  "REAL-KERNEL SMOKE (opt-in, AGENTTEAM_WOLFRAM_SMOKE=1)",
  { skip: process.env.AGENTTEAM_WOLFRAM_SMOKE !== "1" },
  async () => {
    const store = new Store(":memory:"),
      service = new TeamService(store, new SkillCatalog([]));
    const lead = await service.saveAgent({ name: "L", environment: "codex" });
    const wf = service.workflow({
      name: "W",
      goal: "G",
      ownerId: lead.id,
      completionCriteria: "D",
    });
    const mkTask = () =>
      service.task({
        workflowId: wf.id,
        agentId: lead.id,
        title: "S",
        completionCriteria: "D",
        requiresValidation: true,
      });
    const good = await service.validation.start(
      mkTask().id,
      spec({
        source:
          'validationAssertions = {<|"name"->"identity","passed"->(Simplify[Sin[x]^2+Cos[x]^2]===1)|>}',
      }),
    ).done;
    assert.equal(good.status, "pass", JSON.stringify(good.kernel));
    assert.match(good.kernel!.version, /\d/);
    const bad = await service.validation.start(
      mkTask().id,
      spec({
        source:
          'validationAssertions = {<|"name"->"wrong","passed"->(Simplify[Sin[x]^2+Cos[x]^2]===2)|>}',
      }),
    ).done;
    assert.equal(bad.status, "fail");
  },
);

test("restart mid-run leaves no record, gate closed, and slots cleared on startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-val-restart-"));
  const file = join(dir, "db.sqlite");
  try {
    const store = new Store(file),
      service = new TeamService(store, new SkillCatalog([]));
    const runner = new FakeRunner();
    // A kernel run that never settles: the process "dies" while it is in flight.
    runner.handler = () => new Promise<KernelResult>(() => undefined);
    service.validation = new ValidationService(store, service.resources, {
      runner,
    });
    const lead = await service.saveAgent({ name: "L", environment: "codex" });
    const wf = service.workflow({
      name: "W",
      goal: "G",
      ownerId: lead.id,
      completionCriteria: "D",
    });
    const t = service.task({
      workflowId: wf.id,
      agentId: lead.id,
      title: "S",
      completionCriteria: "D",
      requiresValidation: true,
    });
    const run = service.validation.start(t.id, spec());
    run.done.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.validation.activeRuns()[0].state, "running");
    assert.equal(service.resources.slotCount("wolfram-validation"), 1);
    assert.equal(service.validation.records(t.id).length, 0);
    store.db.close();

    // "Restart": reopen the same database with fresh services.
    const store2 = new Store(file),
      service2 = new TeamService(store2, new SkillCatalog([]));
    assert.equal(service2.resources.slotCount("wolfram-validation"), 0);
    assert.equal(service2.validation.activeRuns().length, 0);
    assert.equal(service2.validation.records(t.id).length, 0);
    const task = store2.get<Task>("task", t.id);
    const gate = service2.validation.gate(task);
    assert.equal(gate.open, false);
    assert.equal(gate.reason, "missing");
    assert.equal(gate.attemptsUsed, 0);
    assert.equal(service2.taskState(t.id).waitReason, "validation-required");
    assert.throws(() => service2.transitionTask(t.id, { status: "running" }), {
      code: "validation_required",
    });
    store2.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled run, then a restart, keeps the gate closed without consuming an attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-val-cancel-"));
  const file = join(dir, "db.sqlite");
  try {
    const store = new Store(file),
      service = new TeamService(store, new SkillCatalog([]));
    const runner = new FakeRunner();
    runner.run = ({ signal }: { signal: AbortSignal }) =>
      new Promise<KernelResult>((resolve) =>
        signal.addEventListener("abort", () => resolve(ok({ exitCode: 1 }))),
      );
    service.validation = new ValidationService(store, service.resources, {
      runner,
    });
    const lead = await service.saveAgent({ name: "L", environment: "codex" });
    const wf = service.workflow({
      name: "W",
      goal: "G",
      ownerId: lead.id,
      completionCriteria: "D",
    });
    const t = service.task({
      workflowId: wf.id,
      agentId: lead.id,
      title: "S",
      completionCriteria: "D",
      requiresValidation: true,
    });
    const { runId, done } = service.validation.start(t.id, spec());
    await new Promise((r) => setTimeout(r, 10));
    service.validation.cancel(runId);
    assert.equal((await done).status, "cancelled");
    store.db.close();
    const store2 = new Store(file),
      service2 = new TeamService(store2, new SkillCatalog([]));
    const gate = service2.validation.gate(store2.get<Task>("task", t.id));
    assert.equal(gate.open, false);
    assert.equal(gate.reason, "cancelled");
    assert.equal(gate.attemptsUsed, 0);
    assert.equal(service2.resources.slotCount("wolfram-validation"), 0);
    store2.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
