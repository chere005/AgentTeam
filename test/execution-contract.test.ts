import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { world } from "./fixtures/execution-world.ts";
import {
  classifyRequest,
  executionContractSchema,
  groundedLiteral,
  literalRuns,
} from "../src/execution-contract.ts";
import type { Task } from "../src/model.ts";
import type { RuntimeWait } from "../src/runtime-waits.ts";

const REQUEST =
  "Have the developers make a Python program that computes pi to 500 digits and run it.";
const INVENTED = {
  type: "output-matches" as const,
  pattern: "3\\.14159265358979323846\\d{458}2164201989",
};

test("the application reads a request itself: coding, file work or discussion, with the words that led to it", () => {
  const kind = (text: string) => classifyRequest(text).workKind;
  assert.equal(kind(REQUEST), "executable-implementation");
  assert.equal(
    kind("Write a Python script that parses these logs"),
    "executable-implementation",
  );
  assert.equal(
    kind("Compile the C++ client and run it"),
    "executable-implementation",
  );
  assert.equal(
    kind("Create a file named notes.txt containing the meeting summary"),
    "file-edit",
  );
  assert.equal(kind("Update the README and save it"), "file-edit");
  // Discussion stays discussion, even when it mentions code.
  assert.equal(
    kind("Explain how a Python program could compute pi"),
    "response-only",
  );
  assert.equal(
    kind("What is the difference between a mutex and a semaphore?"),
    "response-only",
  );
  assert.equal(kind("Summarize our options"), "response-only");
  assert.equal(
    kind(
      "Explain the options, then write a Python script that implements the best one",
    ),
    "executable-implementation",
  );
  assert.ok(
    classifyRequest(REQUEST).signals.some((s) => s.startsWith("verb:")),
  );
  assert.deepEqual(classifyRequest("Hello there").signals, []);
});

test("literal expectations are told apart from words the user gave", () => {
  assert.deepEqual(literalRuns("^Worker reporting for duty\\.$"), [
    "Worker reporting for duty.",
  ]);
  assert.deepEqual(literalRuns("3\\.14159265358979323846\\d{458}2164201989"), [
    "3.14159265358979323846",
    "2164201989",
  ]);
  const corpus =
    "Have the worker write its roll call: Worker reporting for duty. Agent 1 Agent 2";
  assert.ok(groundedLiteral("^Worker reporting for duty\\.$", corpus));
  assert.ok(
    groundedLiteral(
      "^I am Agent 1, reporting for duty\\.$",
      "I am X, reporting for duty. Agent 1",
    ),
  );
  assert.equal(
    groundedLiteral(INVENTED.pattern, "compute pi to 500 digits"),
    false,
  );
  assert.ok(
    groundedLiteral("^\\d+$", "anything"),
    "a pattern with no literal claims is generic",
  );
});

test("the contract is validated: relative files, scopes inside the folder, read-only reviewers", () => {
  const base = {
    id: "project:w",
    scope: "project",
    workflowId: "w",
    workKind: "executable-implementation",
    workKindSource: "request",
    createdAt: "t",
    updatedAt: "t",
  };
  assert.ok(
    executionContractSchema.parse({ ...base, expectedFiles: ["out/pi.txt"] }),
  );
  for (const bad of [
    { expectedFiles: ["/etc/passwd"] },
    { expectedFiles: ["../escape"] },
    { expectedFiles: [".git/config"] },
    { projectFolder: "/work/a", scopes: ["/work/b"] },
    { roles: [{ role: "reviewer", capabilities: ["write"] }] },
    { maxCorrectionRounds: 11 },
    {
      workKind: "response-only",
      roles: [{ role: "implementer", capabilities: ["write"] }],
    },
    { unknownField: true },
  ])
    assert.throws(
      () => executionContractSchema.parse({ ...base, ...bad }),
      JSON.stringify(bad),
    );
  assert.throws(() =>
    executionContractSchema.parse({
      ...base,
      requiredChecks: [
        {
          slot: "output-matches",
          check: INVENTED,
          literal: true,
          origin: "model",
          confirmation: "unconfirmed",
          enforcement: "enforced",
          at: "t",
        },
      ],
    }),
  );
});

test("an actionable chat gets its contract from the user's words before any child; discussion gets none", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  w.setProvider(async (_c, _e, emit) => emit({ type: "text", data: "ok" }));
  await w.chat(team.planner.id, REQUEST);
  const [contract] = w.store.list<any>("execution-contract");
  assert.equal(contract.scope, "project");
  assert.equal(contract.workKind, "executable-implementation");
  assert.equal(contract.workKindSource, "request");
  assert.equal(contract.userIntent, REQUEST, "the original intent is retained");
  assert.equal(contract.maxCorrectionRounds, 2);
  assert.ok(
    contract.roles.some(
      (r: any) => r.role === "implementer" && r.capabilities.includes("shell"),
    ),
  );
  await w.chat(team.reporter.id, "How are you today?");
  assert.equal(w.store.list("execution-contract").length, 1);
});

test("a model that omits or understates the contract cannot lower what the request established", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  const folder = await w.folder("pi");
  const outcome: Record<string, unknown> = {};
  w.setProvider(async (command, _e, emit) => {
    if (!command.teammateTools) return;
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools.token);
    const workflowId = w.store.get<Task>("task", ctx.taskId!).workflowId;
    const call = (args: object) =>
      w.service.orchestration.invokeTeammate(ctx, args);
    // Misclassification: the model calls the coding task "response-only".
    assert.throws(
      () =>
        call({
          recipient: team.integrator.id,
          title: "Develop the program",
          instructions: "Write and run pi.py",
          contract: { workKind: "response-only" },
        }),
      { code: "capability_missing" },
    );
    await w.service.setups.apply(workflowId, { folder });
    // The retry names files and a folder scope but still calls the work response-only.
    const first = call({
      recipient: team.integrator.id,
      title: "Develop the program",
      instructions: "Write and run pi.py",
      contract: { workKind: "response-only", expectedFiles: ["pi.py"] },
      resourcePaths: [folder],
    }) as { childTaskId: string };
    outcome.first = first.childTaskId;
    emit({ type: "text", data: "delegated" });
  });
  await w.chat(team.planner.id, REQUEST);
  const child = w.store.get<Task>("task", outcome.first as string);
  const contract = w.service.contracts.task(child.id)!;
  assert.equal(
    contract.workKind,
    "executable-implementation",
    "the kind only rises",
  );
  assert.deepEqual(contract.expectedFiles, ["pi.py"]);
  assert.deepEqual(contract.scopes, [folder]);
  assert.equal(contract.projectFolder, folder);
  assert.ok(
    (child.completionChecks ?? []).some(
      (c) => c.type === "artifact-exists" && c.path === "pi.py",
    ),
    "the expected file became a check the model never wrote",
  );
});

test("a delegated scope may narrow the authorized folder but never leave it", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  const folder = await w.folder("authorized");
  const other = await w.folder("other");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(folder, "src"));
  let accepted: string | undefined;
  w.setProvider(async (command, _e, emit) => {
    if (!command.teammateTools) return;
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools.token);
    await w.service.setups.apply(
      w.store.get<Task>("task", ctx.taskId!).workflowId,
      {
        folder,
      },
    );
    assert.throws(
      () =>
        w.service.orchestration.invokeTeammate(ctx, {
          recipient: team.integrator.id,
          title: "Develop",
          instructions: "Write and run it",
          resourcePaths: [other],
        }),
      { code: "scope_outside_contract" },
    );
    accepted = (
      w.service.orchestration.invokeTeammate(ctx, {
        recipient: team.integrator.id,
        title: "Develop",
        instructions: "Write and run it",
        resourcePaths: [join(folder, "src")],
      }) as { childTaskId: string }
    ).childTaskId;
    emit({ type: "text", data: "ok" });
  });
  await w.chat(team.planner.id, REQUEST);
  assert.ok(accepted);
  assert.deepEqual(w.service.contracts.task(accepted!)!.scopes, [
    join(folder, "src"),
  ]);
});

// ---- finding 8: a required check never disappears ---------------------------------------------------

async function checkWorld(t: Parameters<typeof world>[0], request = REQUEST) {
  const w = await world(t);
  const folder = await w.folder("work");
  const planner = await w.service.saveAgent({
    name: "Planner",
    environment: "claude",
    roleType: "coordinator",
  });
  const worker = await w.service.saveAgent({
    name: "Worker",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  w.service.saveEdge({ from: planner.id, to: worker.id, kind: "delegate" });
  const workflow = w.service.workflow({
    name: "Chat",
    goal: request,
    ownerId: planner.id,
    kind: "conversation",
    completionCriteria: "Reply",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: planner.id,
    title: request,
    instructions: request,
    completionCriteria: "Reply",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  w.service.contracts.prepareConversation({
    workflowId: workflow.id,
    agent: planner,
    text: request,
  });
  const delegate = (args: object) =>
    w.service.orchestration.invokeTeammate(
      { agentId: planner.id, taskId: parent.id },
      {
        recipient: worker.id,
        title: "Write and run pi.py",
        instructions: "Do it.",
        ...args,
      },
    ) as { childTaskId: string; unverifiedChecks?: { slot: string }[] };
  return { w, folder, planner, worker, workflow, parent, delegate };
}

test("an invented literal is not enforced as pass/fail, keeps its slot, and the task cannot complete around it", async (t) => {
  const c = await checkWorld(t);
  const handoff = c.delegate({
    completionChecks: [{ type: "artifact-exists", path: "pi.py" }, INVENTED],
  });
  assert.deepEqual(
    handoff.unverifiedChecks?.map((x) => x.slot),
    ["output-matches"],
  );
  const child = c.w.store.get<Task>("task", handoff.childTaskId);
  assert.deepEqual(
    (child.completionChecks ?? []).map((x) => x.type),
    ["artifact-exists"],
    "the invented literal is not a hard gate",
  );
  const [held] = c.w.service.contracts.unresolved(child);
  assert.equal(held.label, "unverified");
  assert.equal(held.origin, "model");
  assert.equal(held.confirmation, "unconfirmed");

  // Correct work is not failed by the wrong literal ...
  let calls = 0;
  c.w.setProvider(async (_command, _environment, emit) => {
    calls++;
    await writeFile(join(c.folder, "pi.py"), "print('3.14')");
    emit({
      type: "text",
      data: "3.14159265358979323846264338327950288419716939937510",
    });
  });
  await c.w.until(
    () => c.w.store.get<Task>("task", child.id).status === "blocked",
  );
  assert.equal(calls, 1);
  const parked = c.w
    .waits()
    .find((x) => x.id === `task:${child.id}`) as RuntimeWait;
  assert.equal(parked.reason, "check-unconfirmed");
  assert.equal(
    c.w.service.taskState(child.id).runtimeBlocker?.code,
    "check_unconfirmed",
  );
  // ... and no other path completes it around the slot either (a running sibling, by hand).
  const sibling = c.delegate({ title: "Write pi2.py" });
  c.w.service.transitionTask(sibling.childTaskId, { status: "running" });
  await writeFile(join(c.folder, "pi.py"), "print(3.14)");
  await c.w.service.limits.evaluate(
    c.w.store.get<Task>("task", sibling.childTaskId),
    "3.14159",
    c.folder,
  );
  assert.throws(
    () =>
      c.w.service.transitionTask(sibling.childTaskId, {
        status: "completed",
        result: "3.14159",
      }),
    { code: "required_check_unresolved" },
  );
  const view = c.w.service.recovery.view(child.id);
  assert.equal(view.decision?.kind, "setup-repair");
  assert.equal(view.decision?.setup?.then?.kind, "completion-only-replay");
  assert.equal(view.decision?.setup?.then?.providerCall, false);
  assert.throws(() => c.w.service.recovery.requeue(child.id), {
    code: "runtime_capability_blocked",
  });
  // Repeated ticks start nothing.
  for (let i = 0; i < 3; i++) await c.w.scheduler.tick();
  assert.equal(calls, 1);
});

test("confirming the slot enforces it on the saved output with no provider call", async (t) => {
  const c = await checkWorld(t);
  const first = c.delegate({
    completionChecks: [{ type: "artifact-exists", path: "pi.py" }, INVENTED],
  });
  const childId = first.childTaskId;
  let calls = 0;
  c.w.setProvider(async (_command, _environment, emit) => {
    calls++;
    await writeFile(join(c.folder, "pi.py"), "print('3.14')");
    emit({
      type: "text",
      data: "3.14159265358979323846264338327950288419716939937510",
    });
  });
  await c.w.until(
    () => c.w.store.get<Task>("task", childId).status === "blocked",
  );
  // The user confirms the requirement with the literal they actually mean.
  c.w.service.contracts.confirmCheck(`task:${childId}`, "output-matches", {
    pattern: "^3\\.14159265358979323846264338327950288419716939937510\\s*$",
    note: "Reference checked by the user",
  });
  assert.deepEqual(c.w.service.contracts.unresolved({ id: childId }), []);
  const confirmed = c.w.store
    .get<Task>("task", childId)
    .completionChecks!.map((x) => x.type);
  assert.deepEqual(
    confirmed.sort(),
    ["artifact-exists", "output-matches"],
    "now enforced",
  );
  assert.equal(c.w.service.launchReadiness.requeueWaiting().length, 1);
  await c.w.until(
    () => c.w.store.get<Task>("task", childId).status === "completed",
  );
  assert.equal(calls, 1, "the saved output was finalized, not produced again");
  assert.equal(c.w.service.recovery.state(childId).attempt, 1);
});

test("a confirmed literal is a hard gate: wrong output is failed by it", async (t) => {
  const c = await checkWorld(t);
  const { childTaskId } = c.delegate({ completionChecks: [INVENTED] });
  c.w.service.contracts.confirmCheck(`task:${childTaskId}`, "output-matches", {
    pattern: "^3\\.1415926535$",
  });
  c.w.setProvider(async (_c, _e, emit) => {
    await writeFile(join(c.folder, "pi.py"), "x");
    emit({ type: "text", data: "3.1415926536" });
  });
  await c.w.until(
    () => c.w.store.get<Task>("task", childTaskId).status === "failed",
  );
  assert.match(
    c.w.store.get<Task>("task", childTaskId).result ?? "",
    /Completion checks failed/,
  );
});

test("a literal grounded in the user's own words is enforced at once", async (t) => {
  const c = await checkWorld(
    t,
    "Have the worker write pi.py and print exactly: Worker reporting for duty.",
  );
  const handoff = c.delegate({
    completionChecks: [
      { type: "output-matches", pattern: "^Worker reporting for duty\\.$" },
    ],
  });
  assert.equal(handoff.unverifiedChecks, undefined);
  const child = c.w.store.get<Task>("task", handoff.childTaskId);
  assert.deepEqual(
    (child.completionChecks ?? []).map((x) => x.type),
    ["output-matches"],
  );
  assert.deepEqual(c.w.service.contracts.unresolved(child), []);
});

test("delegations no contract governs keep the checks the caller wrote, as before", async (t) => {
  const w = await world(t);
  const planner = await w.service.saveAgent({
    name: "P",
    environment: "claude",
    roleType: "coordinator",
  });
  const worker = await w.service.saveAgent({
    name: "W",
    environment: "claude",
  });
  w.service.saveEdge({ from: planner.id, to: worker.id, kind: "delegate" });
  const workflow = w.service.workflow({
    name: "x",
    goal: "Hello",
    ownerId: planner.id,
    completionCriteria: "d",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: planner.id,
    title: "Hello",
    completionCriteria: "d",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  const handoff = w.service.orchestration.invokeTeammate(
    { agentId: planner.id, taskId: parent.id },
    { recipient: worker.id, title: "Say it", completionChecks: [INVENTED] },
  ) as { childTaskId: string };
  assert.deepEqual(
    w.store.get<Task>("task", handoff.childTaskId).completionChecks,
    [{ ...INVENTED, flags: "" }],
  );
  assert.equal(w.store.list("execution-contract").length, 0);
});

test("the user can correct the reading of the work; that is the only way to lower it", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  w.setProvider(async (_c, _e, emit) => emit({ type: "text", data: "ok" }));
  await w.chat(team.planner.id, REQUEST);
  const workflowId = w.store.list<any>("execution-contract")[0].workflowId;
  const lowered = w.service.contracts.setUserWorkKind(
    workflowId,
    "response-only",
  );
  assert.equal(lowered.workKindSource, "user");
  // A later proposal cannot raise a reading the user set.
  assert.equal(
    w.service.contracts.seedProject({
      workflowId,
      text: REQUEST,
      source: "request",
    })!.workKind,
    "response-only",
  );
  // And the grant floor is waived only for that explicit decision.
  const ready = w.service.launchReadiness.evaluateProspective(team.integrator, {
    contract: lowered,
  });
  assert.equal(ready.ready, true);
  const inferred = w.service.launchReadiness.evaluateProspective(
    team.integrator,
    { contract: { ...lowered, workKindSource: "request" } },
  );
  assert.equal(
    inferred.ready,
    false,
    "an inferred response-only reading does not waive it",
  );
});

test("requirements the user wrote are inherited by every deliverable child; omitting them drops nothing, and analysis stays response-only", async (t) => {
  const c = await checkWorld(t);
  const saved = c.w.service.contracts.setRequirements(c.workflow.id, {
    expectedFiles: ["pi.py"],
    checks: [{ type: "output-matches", pattern: "^3\\.14159\\s*$" }],
    maxCorrectionRounds: 3,
  });
  assert.equal(saved.maxCorrectionRounds, 3);
  const slotted = saved.requiredChecks.find(
    (x) => x.slot === "output-matches",
  )!;
  assert.deepEqual(
    [slotted.origin, slotted.confirmation, slotted.enforcement],
    ["user", "confirmed", "enforced"],
    "a literal the user wrote is a confirmed gate",
  );
  // The model says nothing at all, twice: both deliverables still carry everything.
  for (const title of ["Write and run pi.py", "Write and run pi again"]) {
    const { childTaskId } = c.delegate({ title, instructions: "Do it." });
    const child = c.w.store.get<Task>("task", childTaskId);
    assert.deepEqual(
      (child.completionChecks ?? []).map((x) => x.type).sort(),
      ["artifact-exists", "output-matches"],
      title,
    );
    assert.deepEqual(c.w.service.contracts.unresolved(child), []);
    assert.equal(
      c.w.service.contracts.task(childTaskId)!.maxCorrectionRounds,
      3,
    );
  }
  // An explicit analysis subtask is a response-only child: it keeps its own scope, and the
  // obligations stay on the project for the deliverables.
  const analysis = c.delegate({
    title: "Explain which algorithms compute pi",
    instructions: "Summarize the options in prose.",
    contract: { workKind: "response-only" },
  });
  const analysisTask = c.w.store.get<Task>("task", analysis.childTaskId);
  assert.deepEqual(analysisTask.completionChecks ?? [], []);
  assert.equal(c.w.service.contracts.task(analysis.childTaskId), null);
  assert.equal(
    c.w.service.contracts.project(c.workflow.id)!.requiredChecks.length,
    1,
    "the project's obligations are untouched",
  );
  // The contract only accepts safe requirements.
  assert.throws(
    () =>
      c.w.service.contracts.setRequirements(c.workflow.id, {
        expectedFiles: ["../x"],
      }),
    { code: "invalid_expected_file" },
  );
  assert.throws(
    () =>
      c.w.service.contracts.setRequirements("no-such-workflow", {
        expectedFiles: ["a"],
      }),
    { code: "contract_not_found" },
  );
});
