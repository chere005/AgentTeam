import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyRequest,
  groundedLiteral,
  checkSlot,
} from "../src/execution-contract.ts";
import { capabilityScopeHash } from "../src/launch-capability.ts";
import { world } from "./fixtures/execution-world.ts";
import type { Task, Agent } from "../src/model.ts";

const request = "Write a Python program pi.py and run it; verify the output.";
async function prepared(t: Parameters<typeof world>[0]) {
  const w = await world(t);
  const folder = await w.folder();
  const planner = await w.service.saveAgent({
    name: "Planner",
    environment: "claude",
    roleType: "coordinator",
    tools: ["read"],
  });
  const worker = await w.service.saveAgent({
    name: "Builder",
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const reviewer = await w.service.saveAgent({
    name: "Reviewer",
    environment: "codex",
    roleType: "reviewer",
    tools: ["read"],
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  w.service.saveEdge({ from: planner.id, to: worker.id, kind: "delegate" });
  w.service.saveEdge({ from: planner.id, to: reviewer.id, kind: "delegate" });
  w.service.saveEdge({ from: worker.id, to: reviewer.id, kind: "delegate" });
  const wf = w.service.workflow({
    name: "Prepared",
    goal: request,
    ownerId: planner.id,
    completionCriteria: "done",
  });
  w.service.contracts.seedProject({
    workflowId: wf.id,
    text: request,
    source: "request",
    projectFolder: folder,
    owner: planner,
  });
  const parent = w.service.task({
    workflowId: wf.id,
    agentId: planner.id,
    title: "Coordinate",
    completionCriteria: "done",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  const invoke = (
    args: object,
    context = { agentId: planner.id, taskId: parent.id },
  ) =>
    w.service.orchestration.invokeTeammate(context, {
      recipient: worker.id,
      title: "Do the requested work",
      instructions: "Complete the assignment.",
      ...args,
    }) as { childTaskId: string; unverifiedChecks?: { slot: string }[] };
  return { w, folder, planner, worker, reviewer, wf, parent, invoke };
}
test("classifier separates artifacts, execution, ordinary prose and read-only review", () => {
  const cases: [string, string][] = [
    [request, "executable-implementation"],
    ["Fix the bug in parser.py and run the tests", "executable-implementation"],
    ["Write notes.txt summarizing our Python code style guide.", "file-edit"],
    ["Write a Python program that prints hello", "file-edit"],
    ["Have the poet write a short poem about Python.", "response-only"],
    ["Make a list of good Rust books", "response-only"],
    ["Please review the code in python/pi.py", "response-only"],
    ["Explain src/foo.ts", "response-only"],
    ["Can you make a class schedule for my kids?", "response-only"],
    ["I need to fix my job application", "response-only"],
    ["Write me a swift reply", "response-only"],
    ["Create a library reading list", "response-only"],
  ];
  for (const [text, kind] of cases)
    assert.equal(classifyRequest(text).workKind, kind, text);
});
test("short invented literals, character classes and unknown counted lengths never certify themselves", () => {
  for (const pattern of ["^WRONG$", "^12345$", "^[B][A][D]$", "^3\\.\\d{458}$"])
    assert.equal(
      groundedLiteral(pattern, "compute pi to 500 digits"),
      false,
      pattern,
    );
  assert.equal(
    groundedLiteral("^3\\.\\d{499}$", "3 followed by 499 digits"),
    true,
  );
});
test("review children stay read-only through nested delegation and the scheduler", async (t) => {
  const c = await prepared(t);
  const child = c.invoke({
    title: "Write and run pi.py",
    instructions: request,
  });
  c.w.service.transitionTask(c.parent.id, {
    status: "interrupted",
    result: "The coordinator turn stopped.",
  });
  c.w.service.transitionTask(child.childTaskId, { status: "running" });
  const review = c.invoke(
    {
      recipient: c.reviewer.id,
      title: "Review pi.py and list defects",
      instructions: "Review the program and its run output.",
    },
    { agentId: c.worker.id, taskId: child.childTaskId },
  );
  const task = c.w.store.get<Task>("task", review.childTaskId);
  assert.deepEqual(
    c.w.service.launchReadiness.evaluateProspective(c.reviewer, { task })
      .required,
    ["read"],
  );
  assert.equal(
    c.w.service.launchReadiness.evaluateProspective(c.reviewer, { task }).ready,
    true,
  );
  assert.equal(c.w.service.contracts.task(task.id)!.workKind, "response-only");
  assert.equal(
    c.w.service.orchestration
      .tools({ agentId: c.reviewer.id, taskId: task.id })
      .some((x) => x.name === "invoke_teammate"),
    false,
  );
  c.w.service.transitionTask(child.childTaskId, {
    status: "blocked",
    result: "Waiting on review",
  });
  c.w.setProvider(async (_c, _e, emit) =>
    emit({ type: "text", data: "Reviewed the program." }),
  );
  await c.w.until(
    () => c.w.store.get<Task>("task", task.id).status === "completed",
  );
});
test("mixed discussion cannot drop project requirements; explicit read-only analysis has its own contract", async (t) => {
  const c = await prepared(t);
  c.w.service.contracts.setRequirements(c.wf.id, {
    expectedFiles: ["pi.py"],
    checks: [{ type: "output-matches", pattern: "^3\\.14$" }],
  });
  const mixed = c.invoke({
    title: "Describe the method and write pi.py",
    instructions: "Do the work.",
  });
  assert.equal(
    c.w.service.contracts.task(mixed.childTaskId)!.workKind,
    "executable-implementation",
  );
  assert.ok(
    c.w.store
      .get<Task>("task", mixed.childTaskId)
      .completionChecks?.some((x) => x.type === "output-matches"),
  );
  const analysis = c.invoke({
    recipient: c.reviewer.id,
    title: "Explain the algorithm choices",
    instructions: "Summarize in prose.",
    contract: { workKind: "response-only" },
  });
  assert.equal(
    c.w.service.contracts.task(analysis.childTaskId)!.workKind,
    "response-only",
  );
  assert.equal(
    c.w.service.launchReadiness.evaluateProspective(c.reviewer, {
      task: c.w.store.get<Task>("task", analysis.childTaskId),
    }).ready,
    true,
  );
});
test("same-kind checks coexist and withdrawal removes exactly the chosen unresolved slot", async (t) => {
  const c = await prepared(t);
  const checks = [
    { type: "output-matches" as const, pattern: "^3\\.\\d{499}$" },
    { type: "output-matches" as const, pattern: "48912279381830119491" },
  ];
  const result = c.invoke({ completionChecks: checks });
  const contract = c.w.service.contracts.task(result.childTaskId)!;
  assert.equal(contract.requiredChecks.length, 2);
  assert.notEqual(checkSlot(checks[0]), checkSlot(checks[1]));
  c.w.service.contracts.confirmCheck(contract.id, checkSlot(checks[0]), {
    withdraw: true,
  });
  assert.deepEqual(
    c.w.service.contracts
      .unresolved({ id: result.childTaskId })
      .map((x) => x.slot),
    [checkSlot(checks[1])],
  );
});
test("refused same work follows recipient switches, then does not leak into unrelated accepted work", async (t) => {
  const c = await prepared(t);
  const bad = await c.w.service.saveAgent({
    name: "No folder",
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "write", "shell"],
  });
  c.w.service.saveEdge({ from: c.planner.id, to: bad.id, kind: "delegate" });
  assert.throws(() =>
    c.invoke({
      recipient: bad.id,
      title: "Write and run pi.py",
      instructions: request,
      completionChecks: [
        { type: "artifact-exists", path: "pi.py" },
        { type: "output-matches", pattern: "^WRONG$" },
      ],
    }),
  );
  const retried = c.invoke({
    title: "Write and run pi.py",
    instructions: request,
  });
  assert.equal(
    c.w.service.contracts.unresolved({ id: retried.childTaskId }).length,
    1,
  );
  const unrelated = c.invoke({
    title: "Write README.md",
    instructions: "Write the documentation.",
  });
  assert.equal(
    c.w.service.contracts.unresolved({ id: unrelated.childTaskId }).length,
    0,
  );
  assert.equal(
    c.w.store
      .get<Task>("task", unrelated.childTaskId)
      .completionChecks?.some((x) => "path" in x && x.path === "pi.py") ??
      false,
    false,
  );
});
test("omitted paths remain scoped to the canonical project and symlink escapes are refused", async (t) => {
  const c = await prepared(t);
  const outside = await c.w.folder("outside");
  await c.w.service.saveAgent(
    {
      name: c.worker.name,
      environment: "claude",
      roleType: "implementer",
      tools: ["read", "write", "shell"],
      workspaces: [
        { path: outside, access: "write", active: true },
        { path: c.folder, access: "write", active: false },
      ],
    },
    c.worker.id,
  );
  const child = c.invoke({});
  const plan = await c.w.service.launchPlan(c.worker.id, child.childTaskId);
  assert.equal(plan.cwd, c.folder);
  assert.deepEqual(
    plan.providerRoots.map((x) => x.path),
    [c.folder],
  );
  const link = join(c.folder, "escape");
  await symlink(
    outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => c.invoke({ resourcePaths: [link] }), {
    code: "scope_outside_contract",
  });
});
test("direct leaf coding chat blocks without a provider call, while ordinary questions remain usable", async (t) => {
  const w = await world(t);
  const worker = await w.service.saveAgent({
    name: "Leaf",
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "write", "shell"],
  });
  let calls = 0;
  w.setProvider(async (_c, _e, emit) => {
    calls++;
    emit({ type: "text", data: "An explanation." });
  });
  await w.chat(worker.id, request);
  assert.equal(calls, 0);
  assert.equal(w.tasks()[0].status, "blocked");
  assert.equal(
    w.service.launchReadiness.delegationReadiness(worker.id).notice?.code,
    "agent-not-ready",
  );
  await w.chat(worker.id, "Explain how precision works");
  assert.equal(calls, 1);
});
test("a failed leaf previews its current setup repair, and a changed scope never resumes its old provider session", async (t) => {
  const c = await prepared(t);
  const child = c.invoke({
    title: "Write and run pi.py",
    instructions: request,
  });
  c.w.service.transitionTask(c.parent.id, {
    status: "interrupted",
    result: "The coordinator turn stopped.",
  });
  const task = c.w.store.get<Task>("task", child.childTaskId);
  c.w.service.transitionTask(task.id, { status: "running" });
  c.w.service.recovery.recordLaunchScope(
    task.id,
    capabilityScopeHash(
      c.w.service.launchReadiness.prospectivePlan(c.worker, task),
      c.w.service.launchReadiness.host(),
    ),
  );
  c.w.service.recovery.observe(task, { type: "session", data: "old-session" });
  c.w.service.transitionTask(task.id, {
    status: "failed",
    result: "Failed before finishing",
  });
  await c.w.service.saveAgent(
    {
      name: c.worker.name,
      environment: "claude",
      roleType: "implementer",
      tools: ["read", "write", "shell"],
    },
    c.worker.id,
  );
  const decision = c.w.service.recovery.view(task.id).decision!;
  assert.equal(decision.kind, "setup-repair");
  assert.equal(decision.providerCall, false);
  assert.equal(
    c.w.service.recovery.retryGate(c.w.store.get<Task>("task", task.id))
      .allowed,
    false,
  );
  assert.throws(() => c.w.service.recovery.requeue(task.id), {
    code: "capability_missing",
  });
  await c.w.service.saveAgent(
    {
      name: c.worker.name,
      environment: "claude",
      roleType: "implementer",
      tools: ["read", "write"],
      workspaces: [{ path: c.folder, access: "write", active: true }],
    },
    c.worker.id,
  );
  c.w.service.contracts.setUserWorkKind(c.wf.id, "file-edit");
  assert.notEqual(
    c.w.service.recovery.view(task.id).decision?.session,
    "resume",
  );
});

test("generic Start keeps the accepted contract and a failed send is retriable without a duplicate message", async (t) => {
  const c = await prepared(t);
  c.w.service.transitionTask(c.parent.id, {
    status: "completed",
    result: "Preparation only.",
  });
  const session = c.w.service.session(c.planner.id);
  const message = c.w.service.message(session.id, { text: request });
  message.status = "delivered";
  c.w.store.put("message", message);
  const wf = c.w.store.get<any>("workflow", c.wf.id);
  c.w.store.put("workflow", { ...wf, kind: "conversation" });
  const contract = c.w.service.contracts.project(c.wf.id)!;
  c.w.store.put("execution-contract", {
    ...contract,
    origin: { sessionId: session.id, messageId: message.id },
  });
  c.w.service.contracts.setUserWorkKind(c.wf.id, "response-only");
  c.w.service.contracts.setRequirements(c.wf.id, {
    expectedFiles: ["pi.py"],
    checks: [{ type: "output-matches", pattern: "^confirmed$" }],
    maxCorrectionRounds: 4,
  });
  let sends = 0;
  const execution = {
    enabled: () => true,
    start: async () => {
      sends++;
      if (sends === 1) throw new Error("Temporary queue failure");
      return { status: "queued" };
    },
  };
  await assert.rejects(
    c.w.service.setups.startConversation(c.wf.id, execution),
    /Temporary queue failure/,
  );
  assert.equal(c.w.service.setups.record(c.wf.id)?.startedAt, undefined);
  const count = c.w.messages(session.id).length;
  await c.w.service.setups.startConversation(c.wf.id, execution);
  assert.equal(c.w.messages(session.id).length, count);
  const binding = c.w.store.get<{ workflowId: string }>(
    "prepared-chat",
    session.id,
  );
  assert.equal(binding.workflowId, c.wf.id);
  const saved = c.w.service.contracts.project(c.wf.id)!;
  assert.equal(saved.workKind, "response-only");
  assert.equal(saved.projectFolder, c.folder);
  assert.equal(saved.maxCorrectionRounds, 4);
  assert.deepEqual(saved.expectedFiles, ["pi.py"]);
  assert.equal(saved.requiredChecks.length, 1);
});

test("direct task creation inherits project checks, and the API rolls invalid contract proposals back completely", async (t) => {
  const { createApi } = await import("../src/http.ts");
  const c = await prepared(t);
  c.w.service.contracts.setRequirements(c.wf.id, {
    expectedFiles: ["pi.py"],
    checks: [{ type: "output-matches", pattern: "^confirmed$" }],
  });
  const server = createApi(c.w.service, "a-fix-token", c.w.runs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  let autoCalls = 0;
  c.w.service.pipelines.worktrees!.autoForTask = async () => {
    autoCalls++;
    return null;
  };
  const port = (server.address() as { port: number }).port;
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: {
        authorization: "Bearer a-fix-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const accepted = await post({
    workflowId: c.wf.id,
    agentId: c.worker.id,
    title: "Write and run pi.py",
    completionCriteria: "Done",
  });
  assert.equal(accepted.status, 201);
  assert.equal(autoCalls, 1);
  assert.equal(accepted.body.contract.requiredChecks.length, 1);
  assert.ok(
    accepted.body.completionChecks.some(
      (x: any) => x.type === "artifact-exists" && x.path === "pi.py",
    ),
  );
  const before = c.w.tasks().length,
    events = c.w.store.history(0, 100000).length;
  const refused = await post({
    workflowId: c.wf.id,
    agentId: c.worker.id,
    title: "Write and run other.py",
    completionCriteria: "Done",
    contract: { expectedFiles: ["../escape.py"] },
  });
  assert.equal(refused.status, 400);
  assert.equal(c.w.tasks().length, before);
  assert.equal(c.w.store.history(0, 100000).length, events);
  assert.equal(
    autoCalls,
    1,
    "malformed proposals never attempt worktree creation",
  );
  const outside = await c.w.folder("api-outside");
  await c.w.service.saveAgent(
    {
      name: c.worker.name,
      environment: "claude",
      roleType: "implementer",
      tools: ["read", "write", "shell"],
      workspaces: [
        { path: c.folder, access: "write", active: true },
        { path: outside, access: "write", active: false },
      ],
    },
    c.worker.id,
  );
  const scopedEvents = c.w.store.history(0, 100000).length;
  const scoped = await post({
    workflowId: c.wf.id,
    agentId: c.worker.id,
    title: "Write and run other.py",
    completionCriteria: "Done",
    resourcePaths: [outside],
  });
  assert.equal(scoped.status, 403);
  assert.equal(scoped.body.error, "scope_outside_contract");
  assert.equal(c.w.tasks().length, before);
  assert.equal(c.w.store.history(0, 100000).length, scopedEvents);
  assert.equal(
    autoCalls,
    1,
    "invalid authorized scopes are rejected before automatic worktree side effects",
  );
});

test("only the participating team supplies configured literal grounding, including full-length references", async (t) => {
  const { independentPi } = await import("../src/execution-verification.ts");
  const c = await prepared(t);
  const reference = independentPi(500, "significant");
  await c.w.service.saveAgent(
    {
      name: c.worker.name,
      environment: "claude",
      roleType: "implementer",
      tools: ["read", "write", "shell"],
      instructions: `User-configured reference: ${reference}`,
      workspaces: [{ path: c.folder, access: "write", active: true }],
    },
    c.worker.id,
  );
  const pattern = "^" + reference.replaceAll(".", "\\.") + "\\s*$";
  const first = c.invoke({
    completionChecks: [{ type: "output-matches", pattern }],
  });
  assert.equal(
    c.w.service.contracts.unresolved({ id: first.childTaskId }).length,
    0,
  );
  const check = c.w.store
    .get<Task>("task", first.childTaskId)
    .completionChecks!.find((x) => x.type === "output-matches")!;
  assert.equal(
    new RegExp((check as { pattern: string }).pattern).test(reference),
    true,
  );
  assert.equal(
    new RegExp((check as { pattern: string }).pattern).test(
      reference.slice(0, -1) + "2",
    ),
    false,
  );
  assert.equal(
    new RegExp((check as { pattern: string }).pattern).test(
      reference.slice(0, 490),
    ),
    false,
  );
  const otherTeam = c.w.service.teamSpaces.create({ name: "Unrelated" });
  await c.w.service.saveAgent({
    name: "Unrelated agent",
    environment: "claude",
    teamId: otherTeam.id,
    instructions: "MODEL_ONLY_REFERENCE",
  });
  const modelOnly = c.invoke({
    title: "Write other.py",
    completionChecks: [
      { type: "output-matches", pattern: "^MODEL_ONLY_REFERENCE$" },
    ],
  });
  assert.equal(
    c.w.service.contracts.unresolved({ id: modelOnly.childTaskId }).length,
    1,
  );
});

test("too many proposed deliverables fail with a typed error before creating a task or invocation", async (t) => {
  const c = await prepared(t);
  const before = c.w.tasks().length;
  assert.throws(
    () =>
      c.invoke({
        contract: {
          expectedFiles: Array.from({ length: 21 }, (_, i) => `part${i}.txt`),
        },
      }),
    { code: "too_many_requirements" },
  );
  assert.equal(c.w.tasks().length, before);
  assert.equal(c.w.store.list("invocation").length, 0);
});

test("a canonical-scope blocker remains stable across readiness sweeps and scheduler ticks", async (t) => {
  const { rename } = await import("node:fs/promises");
  const c = await prepared(t);
  const child = c.invoke({
    title: "Write and run pi.py",
    instructions: request,
  });
  c.w.service.transitionTask(c.parent.id, { status: "interrupted" });
  const outside = await c.w.folder("foreign");
  await rename(c.folder, c.folder + "-original");
  await symlink(
    outside,
    c.folder,
    process.platform === "win32" ? "junction" : "dir",
  );
  await c.w.scheduler.tick();
  assert.equal(
    c.w.store.get<Task>("task", child.childTaskId).status,
    "blocked",
  );
  const events = c.w.store.history(0, 100000).length,
    checkpoints = c.w.service.recovery.checkpoints(child.childTaskId).length;
  for (let i = 0; i < 4; i++) {
    c.w.service.launchReadiness.requeueWaiting();
    await c.w.scheduler.tick();
  }
  assert.equal(c.w.store.history(0, 100000).length, events);
  assert.equal(
    c.w.service.recovery.checkpoints(child.childTaskId).length,
    checkpoints,
  );
  assert.equal(c.w.service.recovery.state(child.childTaskId).resumes, 0);
});
