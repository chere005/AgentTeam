import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";

test("editing existing tasks and rules: requires-validation toggle and rule update", async (t) => {
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    server = createApi(team, "tok", new RunManager(team, false, process.cwd()));
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
        authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
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
  const task = (
    await call("/tasks", "POST", {
      workflowId: wf.id,
      agentId: a.id,
      title: "T",
      completionCriteria: "D",
    })
  ).json;
  const path = `/tasks/${task.id}/requires-validation`;
  assert.equal(
    (
      await fetch(base + path, {
        method: "PUT",
        body: JSON.stringify({ requiresValidation: true }),
      })
    ).status,
    401,
  );
  assert.equal(
    (await call(path, "PUT", { requiresValidation: "yes" })).status,
    400,
  );
  assert.equal((await call(path, "PUT", { bogus: true })).status, 400);
  assert.equal(
    (
      await call("/tasks/nope/requires-validation", "PUT", {
        requiresValidation: true,
      })
    ).status,
    404,
  );
  const on = await call(path, "PUT", { requiresValidation: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.requiresValidation, true);
  assert.equal(on.json.waitReason, "validation-required");
  // A validation-gate completion check depends on the requirement.
  await call(`/tasks/${task.id}/completion-checks`, "PUT", {
    checks: [{ type: "validation-gate" }],
  });
  const refused = await call(path, "PUT", { requiresValidation: false });
  assert.equal(refused.status, 409);
  assert.match(
    JSON.stringify(refused.json),
    /validation-gate completion check/,
  );
  await call(`/tasks/${task.id}/completion-checks`, "PUT", { checks: [] });
  const off = await call(path, "PUT", { requiresValidation: false });
  assert.equal(off.json.requiresValidation, undefined);
  assert.equal(off.json.waitReason, null);
  // Never while running.
  await call(`/tasks/${task.id}/status`, "POST", { status: "running" });
  const running = await call(path, "PUT", { requiresValidation: true });
  assert.equal(running.status, 409);
  assert.match(JSON.stringify(running.json), /running/);

  // Rules: update in place, same validation as creation.
  const rule = (
    await call("/rules", "POST", {
      agentId: a.id,
      scope: "action",
      targetId: b.id,
      priority: 5,
      match: { textIncludes: ["db"], catchAll: false },
      mode: "advisory",
      kind: "delegate",
    })
  ).json;
  const edited = await call("/rules/" + rule.id, "PUT", {
    agentId: a.id,
    scope: "action",
    targetId: b.id,
    priority: 7,
    match: { textIncludes: ["db"], catchAll: false },
    mode: "mandatory",
    kind: "review",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.id, rule.id);
  assert.equal(edited.json.mode, "mandatory");
  const rules = (await call("/rules")).json;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].priority, 7);
  const bad = await call("/rules/" + rule.id, "PUT", {
    agentId: a.id,
    scope: "action",
    targetId: b.id,
    priority: 7,
    match: { textIncludes: ["db"], catchAll: false },
    mode: "mandatory",
    kind: "delegate",
  });
  assert.equal(bad.status, 400);
  assert.equal((await call("/rules")).json[0].kind, "review");
  assert.equal((await call("/rules/missing", "PUT", {})).status, 404);
});

test("requires-validation cannot be switched off after a validation attempt that did not pass", async () => {
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  try {
    const a = await team.saveAgent({ name: "A", environment: "codex" });
    const wf = team.workflow({
      name: "W",
      goal: "G",
      ownerId: a.id,
      completionCriteria: "D",
    });
    const task = team.task({
      workflowId: wf.id,
      agentId: a.id,
      title: "T",
      completionCriteria: "D",
      requiresValidation: true,
    });
    // A recorded failed kernel attempt for the task's current inputs (no kernel is run here).
    const inputHash = team.validation.gate(
      store.get("task", task.id),
    ).inputHash;
    store.put("validation", {
      id: "attempt-1",
      seq: 1,
      taskId: task.id,
      attempt: 1,
      inputHash,
      sourceHash: "x",
      spec: {
        claim: "1+1==3",
        source: "validationAssertions = {}",
        evidenceKind: "symbolic-proof",
        assumptions: [],
        domains: [],
        derivation: "",
        inputs: {},
      },
      kernel: {
        version: "14.3",
        stdout: "False",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
      },
      assertions: [{ name: "sum", passed: false }],
      status: "fail",
      reason: "Assertion failed",
      startedAt: "",
      finishedAt: "",
    });
    assert.equal(team.taskState(task.id).waitReason, "validation-required");
    assert.throws(
      () => team.setRequiresValidation(task.id, { requiresValidation: false }),
      (e: any) => e.code === "validation_not_passed" && e.status === 409,
    );
    assert.equal(
      store.get<any>("task", task.id).requiresValidation,
      true,
      "the gate stays closed",
    );
    // Before any attempt the requirement can still be withdrawn.
    const fresh = team.task({
      workflowId: wf.id,
      agentId: a.id,
      title: "Fresh",
      completionCriteria: "D",
      requiresValidation: true,
    });
    assert.equal(
      team.setRequiresValidation(fresh.id, { requiresValidation: false })
        .requiresValidation,
      undefined,
    );
  } finally {
    store.close();
  }
});

test("output-matches checks: invalid patterns are refused on save, catastrophic backtracking is bounded", async () => {
  const { boundedRegexTest } = await import("../src/limits.ts");
  const { completionCheckSchema } = await import("../src/limits-schema.ts");
  assert.equal(
    completionCheckSchema.safeParse({ type: "output-matches", pattern: "(a" })
      .success,
    false,
  );
  assert.equal(
    completionCheckSchema.safeParse({
      type: "output-matches",
      pattern: "\\p{L}",
      flags: "u",
    }).success,
    true,
  );
  assert.equal(boundedRegexTest("^OK$", "m", "x\nOK"), true);
  assert.equal(boundedRegexTest("^OK$", "", "x\nOK"), false);
  // Agent output crafted against the user's pattern must not hang the backend.
  const started = Date.now();
  assert.equal(
    boundedRegexTest("(a+)+$", "", "a".repeat(40) + "b", 100),
    "timeout",
  );
  assert.ok(Date.now() - started < 5000);

  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  try {
    const a = await team.saveAgent({ name: "A", environment: "codex" });
    const wf = team.workflow({
      name: "W",
      goal: "G",
      ownerId: a.id,
      completionCriteria: "D",
    });
    const task = team.task({
      workflowId: wf.id,
      agentId: a.id,
      title: "T",
      completionCriteria: "D",
    });
    team.limits.setChecks(task.id, [
      { type: "output-matches", pattern: "(a+)+$", flags: "" },
    ]);
    const ev = await team.limits.evaluate(
      store.get("task", task.id),
      "a".repeat(40) + "b",
      process.cwd(),
    );
    assert.equal(ev!.passed, false);
    assert.match(ev!.results[0].detail, /was stopped/);
  } finally {
    store.close();
  }
});
