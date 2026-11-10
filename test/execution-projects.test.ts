import "./fixtures/temp-data-dir.ts";
// C coordinator fixtures deliberately mock B's execution boundary. They test routing, exact
// review identity/provenance and durable rounds; real confinement is covered separately by B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { world, type World } from "./fixtures/execution-world.ts";
import { controlFolders } from "./fixtures/folder-probe.ts";
import { executionProjectRoute } from "../src/execution-project-routes.ts";
import { AppError, type Task } from "../src/model.ts";
import type { ExecutionVerificationRecord } from "../src/execution-verification.ts";
import type { ExecutionVerificationSpec } from "../src/limits-schema.ts";
import type { ExecutionProject } from "../src/execution-projects.ts";

const original =
  "have the developers make a program that computes pi to 500 digits without using any external libraries using the languages they are experts in, then have the reviewers pass it back to the developers until they are happy with the final result";
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
type Verdict = "approve" | "request-changes" | "inconclusive";
type Script = {
  verdict?: (round: number, index: number) => Verdict;
  wrongSubject?: boolean;
  waitAtReview?: boolean;
};
function mockVerification(w: World) {
  const latest = (id: string) =>
    w.store
      .list<ExecutionVerificationRecord>("fixture-verification")
      .filter((r) => r.taskId === id)
      .at(-1) ?? null;
  const current = (task: Task) => {
    const record = latest(task.id);
    if (
      !record?.passed ||
      record.sourceFiles.some(
        (s) => hash(readFileSync(join(record.sourceRoot, s.path))) !== s.sha256,
      )
    )
      throw new AppError(
        409,
        "execution_verification_stale",
        "Fixture source changed",
      );
    return record;
  };
  w.service.verification.latest = latest;
  w.service.verification.require = async (task) => current(task);
  w.service.verification.requireCurrent = (task) => current(task);
  w.service.verification.verify = async (taskId, input) => {
    const task = w.store.get<Task>("task", taskId),
      spec = input as ExecutionVerificationSpec,
      root = task.resourcePaths![0];
    const files = await Promise.all(
      spec.sourceFiles.map(async (path) => {
        const text = await readFile(join(root, path));
        return { path, sha256: hash(text), bytes: text.length };
      }),
    );
    const previous = latest(taskId);
    if (
      previous &&
      JSON.stringify(previous.sourceFiles) === JSON.stringify(files)
    )
      return previous;
    const snapshot = join(w.base, "Fixture evidence", randomUUID());
    for (const file of files) {
      const target = join(snapshot, "Source", file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(root, file.path)));
    }
    const reference = w.store.get<{ hash: string; stdout: string }>(
        "verification-reference",
        spec.referenceId,
      ),
      now = new Date().toISOString();
    const record: ExecutionVerificationRecord = {
      id: randomUUID(),
      taskId,
      workflowId: task.workflowId,
      spec,
      requestHash: hash(JSON.stringify({ spec, files })),
      sourceRoot: root,
      sourceFiles: files,
      snapshotHash: hash(JSON.stringify(files)),
      snapshotDirectory: snapshot,
      referenceId: spec.referenceId,
      referenceHash: reference.hash,
      passed: true,
      status: "passed",
      reason: "Controlled coordinator fixture; no process executed",
      stdout: reference.stdout,
      stderr: "",
      commands: [],
      binaryHash: null,
      toolchain: { executable: "fixture", version: "1" },
      startedAt: now,
      finishedAt: now,
    };
    w.store.put("fixture-verification", record);
    return record;
  };
}
function providers(w: World, id: string, script: Script = {}) {
  w.setProvider(async (command, _environment, emit) => {
    assert.ok(command.teammateTools, "fixture task has a run token");
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools.token),
      task = w.store.get<Task>("task", ctx.taskId!);
    const record = w.service.executionProjects.get(id)!;
    const output = record.outputs.find((o) => o.taskId === task.id);
    if (output) {
      const target = join(record.folder, output.entry);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        `# fixture round ${record.round}\nprint('fixture source')\n`,
      );
      emit({
        type: "text",
        data: "Created the actual source; independent execution evidence is supplied by the controlled B fixture.",
      });
      return;
    }
    const review = record.reviews.find((r) => r.taskId === task.id);
    assert.ok(review, "only configured implementation/review tasks run");
    if (script.waitAtReview) return;
    const index = record.reviewerIds.indexOf(task.agentId),
      verdict = script.verdict?.(record.round, index) ?? "approve";
    emit({
      type: "text",
      data: JSON.stringify({
        verdict,
        findings:
          verdict === "request-changes"
            ? [
                {
                  file: record.outputs[0].entry,
                  reason: "Controlled correction request",
                },
              ]
            : [],
        evidence:
          "Inspected the current immutable source and observed execution record",
        subjectId: script.wrongSubject ? "wrong-subject" : review.identity,
      }),
    });
  });
}
async function fixture(
  t: Parameters<typeof world>[0],
  options: {
    rounds?: number;
    storePath?: string;
    script?: Script;
    /** One implementation worker per language (default: Python only). */
    languages?: ("python" | "cpp" | "typescript")[];
    /** The chat request (default: the original ordinary-chat request). */
    goal?: string;
  } = {},
) {
  const goal = options.goal ?? original;
  const w = await world(t, { storePath: options.storePath });
  mockVerification(w);
  const folder = await w.folder();
  const planner = await w.service.saveAgent({
    name: "Planner",
    environment: "claude",
    roleType: "coordinator",
    tools: ["read"],
  });
  const languages = options.languages ?? ["python"];
  const workers = await Promise.all(
    languages.map((language) =>
      w.service.saveAgent({
        name: {
          python: "Python developer",
          cpp: "C++ developer",
          typescript: "TypeScript developer",
        }[language],
        environment: "claude",
        roleType: "implementer",
        tools: ["read", "write", "shell"],
        workspaces: [{ path: folder, access: "write", active: true }],
      }),
    ),
  );
  const worker = workers[0];
  const reviewers = await Promise.all(
    ["Correctness reviewer", "Clarity reviewer"].map((name) =>
      w.service.saveAgent({
        name,
        environment: "codex",
        roleType: "reviewer",
        tools: ["read"],
        workspaces: [{ path: folder, access: "read", active: true }],
      }),
    ),
  );
  for (const target of [...workers, ...reviewers])
    w.service.saveEdge({ from: planner.id, to: target.id, kind: "delegate" });
  const session = w.service.session(planner.id),
    message = w.service.message(session.id, { text: goal });
  message.status = "delivered";
  w.store.put("message", message);
  const workflow = w.service.workflow({
    name: "Original chat assignment",
    goal,
    ownerId: planner.id,
    kind: "conversation",
    completionCriteria: "Implement and review the requested programs",
  });
  w.service.contracts.prepareConversation({
    workflowId: workflow.id,
    agent: planner,
    text: goal,
    origin: { sessionId: session.id, messageId: message.id },
  });
  w.service.contracts.authorizeFolder(workflow.id, folder);
  w.service.executionProjects.configure(workflow.id, {
    languages,
    maxCorrectionRounds: options.rounds ?? 1,
  });
  providers(w, workflow.id, options.script);
  return {
    w,
    id: workflow.id,
    folder,
    reviewers,
    worker,
    workers,
    sessionId: session.id,
  };
}
test("the original ordinary-chat request prepares one verified implementation and two attributed approvals", async (t) => {
  const c = await fixture(t);
  assert.equal(c.w.service.contracts.project(c.id)!.workKind, "file-edit");
  assert.equal(c.w.service.executionProjects.canStart(c.id), true);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
  const record = c.w.service.executionProjects.get(c.id)!;
  assert.equal(record.outputs.length, 1);
  assert.equal(record.reviews.length, 2);
  assert.deepEqual(
    new Set(record.reviews.map((r) => r.reviewerId)),
    new Set(c.reviewers.map((r) => r.id)),
  );
  assert.equal(record.round, 0);
  assert.equal(record.rounds[0].outcome, "approved");
  assert.equal(new Set(record.reviews.map((r) => r.identity)).size, 1);
  for (const review of record.reviews) {
    assert.equal(
      c.w.store.get<Task>("task", review.taskId).agentId,
      review.reviewerId,
    );
    assert.ok(
      review.evidenceIds.includes(
        c.w.service.verification.latest(record.outputs[0].taskId)!.id,
      ),
    );
  }
});
test("a change request creates bounded correction work, new execution identity and fresh reviews", async (t) => {
  const c = await fixture(t, {
    script: {
      verdict: (round, index) =>
        round === 0 && index === 0 ? "request-changes" : "approve",
    },
  });
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
  const record = c.w.service.executionProjects.get(c.id)!;
  assert.equal(record.round, 1);
  assert.equal(record.rounds.length, 2);
  assert.equal(record.rounds[0].outcome, "request-changes");
  assert.equal(record.rounds[1].outcome, "approved");
  assert.notDeepEqual(
    record.rounds[0].implementationTaskIds,
    record.rounds[1].implementationTaskIds,
  );
  assert.notDeepEqual(
    record.rounds[0].reviewTaskIds,
    record.rounds[1].reviewTaskIds,
  );
  assert.notDeepEqual(
    record.rounds[0].evidenceIds,
    record.rounds[1].evidenceIds,
  );
});
test("exhausted rounds remain needs-attention and never become an approved project", async (t) => {
  const c = await fixture(t, {
    rounds: 1,
    script: { verdict: () => "request-changes" },
  });
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "needs-attention",
  );
  const record = c.w.service.executionProjects.get(c.id)!;
  assert.equal(record.round, 1);
  assert.match(record.message ?? "", /correction rounds/);
  assert.equal(
    record.rounds.some((r) => r.outcome === "approved"),
    false,
  );
  assert.throws(() => c.w.service.executionProjects.retry(c.id), {
    code: "correction_limit",
  });
});
for (const mode of ["inconclusive", "wrong-subject"] as const)
  test(`${mode} required reviews cannot approve the result`, async (t) => {
    const c = await fixture(t, {
      script:
        mode === "inconclusive"
          ? { verdict: () => "inconclusive" }
          : { wrongSubject: true },
    });
    await c.w.service.executionProjects.startPrepared(c.id);
    await c.w.until(
      () =>
        c.w.service.executionProjects.get(c.id)?.phase === "needs-attention",
    );
    assert.match(
      c.w.service.executionProjects.get(c.id)!.message ?? "",
      /missing|invalid|inconclusive/,
    );
  });
test("an edit after approval invalidates the completed execution and its approvals", async (t) => {
  const c = await fixture(t);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
  const record = c.w.service.executionProjects.get(c.id)!;
  await writeFile(
    join(c.folder, record.outputs[0].entry),
    "# changed after approval\n",
  );
  await c.w.service.executionProjects.sweep();
  assert.equal(
    c.w.service.executionProjects.get(c.id)?.phase,
    "needs-attention",
  );
  assert.match(
    c.w.service.executionProjects.get(c.id)!.message ?? "",
    /stale|Source.*changed/,
  );
});
test("Start is idempotent and cancellation preserves history without creating review work", async (t) => {
  const c = await fixture(t);
  await c.w.service.executionProjects.startPrepared(c.id);
  const tasks = c.w.tasks().length;
  await c.w.service.executionProjects.startPrepared(c.id);
  assert.equal(c.w.tasks().length, tasks);
  c.w.service.executionProjects.cancel(c.id);
  await c.w.service.executionProjects.sweep();
  const record = c.w.service.executionProjects.get(c.id)!;
  assert.equal(record.phase, "cancelled");
  assert.equal(record.reviews.length, 0);
  assert.equal(
    c.w.tasks().every((task) => task.status === "cancelled"),
    true,
  );
});
test("a restored coordinator continues the persisted round without duplicate tasks or lost evidence", async (t) => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-c-restart-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const c = await fixture(t, { storePath: join(base, "fixture.sqlite") });
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.scheduler.tick();
  for (let i = 0; c.w.runs.active.size && i < 200; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(c.w.runs.active.size, 0);
  await c.w.service.executionProjects.sweep();
  assert.equal(c.w.service.executionProjects.get(c.id)?.phase, "reviewing");
  const before = c.w.tasks().length,
    round = c.w.service.executionProjects.get(c.id)!.round;
  c.w.store.close();
  const restored = await world(t, {
    storePath: join(base, "fixture.sqlite"),
    base: c.w.base,
  });
  mockVerification(restored);
  providers(restored, c.id);
  await restored.service.executionProjects.startPrepared(c.id);
  assert.equal(restored.tasks().length, before);
  await restored.until(
    () => restored.service.executionProjects.get(c.id)?.phase === "completed",
  );
  assert.equal(restored.service.executionProjects.get(c.id)!.round, round);
  assert.equal(restored.tasks().length, before);
  // Close the reopened database before the earlier directory cleanup hook (Windows locks files).
  restored.scheduler.stop();
  restored.store.close();
});

test("hand-completed approval prose without an attributed provider run never approves the prepared project", async (t) => {
  const c = await fixture(t);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.scheduler.tick();
  for (let i = 0; c.w.runs.active.size && i < 200; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(c.w.runs.active.size, 0);
  await c.w.service.executionProjects.sweep();
  const record = c.w.service.executionProjects.get(c.id)!;
  assert.equal(record.phase, "reviewing");
  for (const review of record.reviews) {
    const task = c.w.store.get<Task>("task", review.taskId),
      result = JSON.stringify({
        verdict: "approve",
        findings: [],
        evidence: "Hand-entered claim",
        subjectId: review.identity,
      });
    c.w.service.transitionTask(task.id, { status: "running" });
    await c.w.service.limits.evaluate(task, result, c.folder);
    c.w.service.transitionTask(task.id, { status: "completed", result });
    assert.equal(
      c.w.service.recovery.ledger
        .list(task.id)
        .some((e) => e.kind === "provider-run"),
      false,
    );
  }
  await c.w.service.executionProjects.sweep();
  assert.equal(
    c.w.service.executionProjects.get(c.id)?.phase,
    "needs-attention",
  );
});

for (const pending of ["uncertain-effect", "approval"] as const)
  test(`prepared Start preserves unresolved ${pending} instead of superseding it`, async (t) => {
    const c = await fixture(t);
    const old = c.w.service.task({
      workflowId: c.id,
      agentId: c.worker.id,
      title: "Previously interrupted implementation",
      completionCriteria: "Finish safely",
    });
    let cleanup = async () => {};
    if (pending === "uncertain-effect") {
      const effect = c.w.service.recovery.ledger.begin({
        taskId: old.id,
        key: "old-write",
        kind: "write",
        description: "Possibly applied old file write",
        mutating: true,
      });
      c.w.service.recovery.ledger.markUncertain(
        effect.effect.id,
        "Connection ended before the outcome was known",
      );
    } else {
      const controller = new AbortController();
      const answer = c.w.service.approvals.request(
        c.worker.id,
        {
          sessionId: "old-session",
          toolCall: {
            toolCallId: "old-write",
            title: "Write source file",
            kind: "edit",
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
          ],
        } as never,
        controller.signal,
        old.id,
      );
      cleanup = async () => {
        controller.abort();
        await answer;
      };
    }
    try {
      const count = c.w.tasks().length;
      await assert.rejects(c.w.service.executionProjects.startPrepared(c.id), {
        code: "execution_effect_unsettled",
      });
      assert.equal(c.w.tasks().length, count);
      assert.equal(c.w.store.get<Task>("task", old.id).status, "queued");
      assert.equal(c.w.service.executionProjects.get(c.id), null);
    } finally {
      await cleanup();
    }
  });

test("production chat preparation spends no planner call and waits for explicit Start even after folder repair", async (t) => {
  const c = await fixture(t);
  c.w.runs.prepareExecutableChats = true;
  let calls = 0;
  c.w.setProvider(async () => {
    calls++;
  });
  const session = await c.w.chat(
    c.w.store.get<{ ownerId: string }>("workflow", c.id).ownerId,
    original,
  );
  const workflow = c.w
    .workflows()
    .filter((w) => w.kind === "conversation" && w.id !== c.id)
    .at(-1)!;
  const root = c.w.tasks().find((task) => task.workflowId === workflow.id)!;
  assert.equal(calls, 0);
  assert.equal(root.status, "blocked");
  assert.equal(
    c.w.store.get<{ reason: string }>("runtime-wait", `task:${root.id}`).reason,
    "assignment-preparation",
  );
  assert.equal(c.w.service.recovery.ledger.list(root.id).length, 0);
  assert.equal(c.w.service.recovery.state(root.id).attempt, 1);
  assert.equal(
    c.w.service.recovery.view(root.id).decision?.providerCall,
    false,
  );
  await c.w.service.setups.apply(workflow.id, { folder: c.folder });
  // "the languages they are experts in" names none: the planner's question, answered here.
  c.w.service.executionProjects.configure(workflow.id, {
    languages: ["python"],
  });
  c.w.service.launchReadiness.requeueWaiting();
  await c.w.scheduler.tick();
  assert.equal(calls, 0);
  assert.equal(c.w.store.get<Task>("task", root.id).status, "blocked");
  const userMessagesBeforeStart = c.w
    .messages(session.id)
    .filter((m) => m.role === "user").length;
  providers(c.w, workflow.id);
  await c.w.service.setups.startConversation(workflow.id, {
    enabled: () => true,
    start: async () => {
      throw new Error("Prepared execution must not resend to a planner");
    },
  });
  await c.w.until(
    () => c.w.service.executionProjects.get(workflow.id)?.phase === "completed",
  );
  assert.equal(
    c.w.messages(session.id).filter((m) => m.role === "user").length,
    userMessagesBeforeStart,
  );
  assert.equal(c.w.store.get<Task>("task", root.id).status, "cancelled");
});

test("a program request sent to the Team Assistant is prepared on the active team's lead: workers, reviewers and the folder question are all there", async (t) => {
  const w = await world(t);
  w.runs.prepareExecutableChats = true;
  let calls = 0;
  w.setProvider(async () => {
    calls++;
  });
  const team = w.insertPipeline({ implementationWorkers: 3, fixWorkers: 1 });
  const assistant = await w.service.saveAgent({
    name: "Team Assistant",
    kind: "team-assistant",
    environment: "codex",
  });
  const request =
    "make a program in python, c++, and typescript that computes pi to 500 significant digits without using any libraries";
  const session = await w.chat(assistant.id, request);
  const workflow = w.workflows().find((wf) => wf.kind === "conversation")!;
  assert.equal(calls, 0);
  // The team's lead owns it (the assistant has no team, so its own project had no workers).
  assert.equal(workflow.ownerId, team.planner.id);
  assert.equal(workflow.teamId, team.teamId);
  const plan = w.service.executionProjects.plan(workflow.id);
  assert.deepEqual(
    plan.outputs.map((o) => [o.language, o.agentId]),
    [
      ["python", team.workers[0].id],
      ["cpp", team.workers[1].id],
      ["typescript", team.workers[2].id],
    ],
  );
  assert.equal(plan.reviewers.length, 2);
  assert.deepEqual(plan.issues, ["Choose the project folder before starting."]);
  // The setup card has a folder to ask for and the roles to grant it to.
  const proposal = w.service.setups.proposal(workflow.id);
  assert.ok(
    team.workers.every((worker) =>
      proposal.participants.some((p) => p.agentId === worker.id),
    ),
  );
  // The conversation (and so the setup card) stays in the assistant's chat.
  const root = w.tasks().find((task) => task.workflowId === workflow.id)!;
  assert.equal(root.agentId, assistant.id);
  assert.equal(root.status, "blocked");
  assert.ok(
    w
      .messages(session.id)
      .some((m) => m.role === "assistant" && /choose Start/.test(m.text)),
  );
  await w.service.setups.apply(workflow.id, { folder: await w.folder() });
  assert.deepEqual(w.service.executionProjects.plan(workflow.id).issues, []);
});

test("a Team Assistant request that is not a program stays the assistant's own conversation", async (t) => {
  const w = await world(t);
  w.runs.prepareExecutableChats = true;
  w.insertPipeline();
  const assistant = await w.service.saveAgent({
    name: "Team Assistant",
    kind: "team-assistant",
    environment: "codex",
  });
  await w.chat(assistant.id, "Which agents on this team review code?");
  for (const workflow of w
    .workflows()
    .filter((wf) => wf.kind === "conversation"))
    assert.equal(workflow.ownerId, assistant.id);
});

// ---- one failure wave is announced once (fix F7) -----------------------------------------------

/** Chat messages the coordinator posted about a failure. */
const attentionMessages = (c: Awaited<ReturnType<typeof fixture>>) =>
  c.w
    .messages(c.sessionId)
    .filter(
      (m) =>
        m.text.startsWith("**AgentTeam execution**") &&
        /implementation or its independent verification failed/.test(m.text),
    );
const attentionEvents = (c: Awaited<ReturnType<typeof fixture>>) =>
  c.w.events("execution.needs_attention").filter((e) => e.entityId === c.id);

test("three outputs, one fails while two are still in flight: 20 sweeps announce one wave, once, and save nothing", async (t) => {
  const c = await fixture(t, { languages: ["python", "cpp", "typescript"] });
  const projects = c.w.service.executionProjects;
  await projects.startPrepared(c.id);
  const [failed, second, third] = projects
    .get(c.id)!
    .outputs.map((o) => o.taskId);
  c.w.service.transitionTask(failed, { status: "running" });
  c.w.service.transitionTask(failed, {
    status: "failed",
    result: "Operation not permitted",
  });
  // The siblings are queued/running: the case that used to flip the phase back every tick.
  assert.deepEqual(
    [second, third].map((id) => c.w.store.get<Task>("task", id).status),
    ["queued", "queued"],
  );
  await projects.sweep();
  const first = projects.get(c.id)!;
  assert.equal(first.phase, "needs-attention");
  for (let i = 0; i < 20; i++) await projects.sweep();
  assert.equal(attentionEvents(c).length, 1, "one event for the wave");
  assert.equal(attentionMessages(c).length, 1, "one chat message for the wave");
  const after = projects.get(c.id)!;
  assert.equal(after.phase, "needs-attention");
  assert.equal(
    after.updatedAt,
    first.updatedAt,
    "an unchanged record is not saved again on every tick",
  );
  assert.equal(c.w.store.get<Task>("task", failed).status, "failed");
  // A second output failing later belongs to the same wave: the person was told, the failure
  // stands, and nothing is announced again (decision: one wave = one event + one message).
  c.w.service.transitionTask(second, { status: "running" });
  c.w.service.transitionTask(second, {
    status: "failed",
    result: "Operation not permitted",
  });
  for (let i = 0; i < 5; i++) await projects.sweep();
  assert.equal(attentionEvents(c).length, 1);
  assert.equal(attentionMessages(c).length, 1);
  assert.equal(projects.get(c.id)!.updatedAt, first.updatedAt);
});

test("coordination resumes only when every failed output has been dealt with; a failure after that is a new wave", async (t) => {
  const c = await fixture(t, { languages: ["python", "cpp", "typescript"] });
  const projects = c.w.service.executionProjects;
  await projects.startPrepared(c.id);
  const [a, b, rest] = projects.get(c.id)!.outputs.map((o) => o.taskId);
  const fail = (id: string) => {
    c.w.service.transitionTask(id, { status: "running" });
    c.w.service.transitionTask(id, { status: "failed", result: "failed" });
  };
  fail(a);
  fail(b);
  await projects.sweep();
  assert.equal(projects.get(c.id)!.phase, "needs-attention");
  // Retrying one of two failed outputs from Recovery leaves a failure standing.
  c.w.service.recovery.requeue(a);
  for (let i = 0; i < 5; i++) await projects.sweep();
  assert.equal(projects.get(c.id)!.phase, "needs-attention");
  assert.equal(attentionEvents(c).length, 1);
  // Once nothing is failed and work is in flight, coordination resumes without announcing anything.
  c.w.service.recovery.requeue(b);
  await projects.sweep();
  assert.equal(projects.get(c.id)!.phase, "fixing");
  assert.equal(attentionEvents(c).length, 1);
  assert.equal(
    c.w.store.get<Task>("task", rest).status,
    "queued",
    "the third output never ran",
  );
  // The retried output fails again: that is a new failure wave, announced once.
  c.w.service.transitionTask(a, { status: "running" });
  c.w.service.transitionTask(a, { status: "failed", result: "failed again" });
  for (let i = 0; i < 10; i++) await projects.sweep();
  assert.equal(projects.get(c.id)!.phase, "needs-attention");
  assert.equal(attentionEvents(c).length, 2);
  assert.equal(attentionMessages(c).length, 2);
});

test("a stale approval is announced once however long it stands", async (t) => {
  const c = await fixture(t);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
  const record = c.w.service.executionProjects.get(c.id)!;
  await writeFile(join(c.folder, record.outputs[0].entry), "# changed\n");
  for (let i = 0; i < 20; i++) await c.w.service.executionProjects.sweep();
  assert.equal(attentionEvents(c).length, 1);
  assert.equal(
    c.w
      .messages(c.sessionId)
      .filter((m) =>
        /Source, reviewer permissions or approvals changed/.test(m.text),
      ).length,
    1,
  );
});

// ---- Start asks the system about the folder (fix F2) -------------------------------------------

test("Start asks the system about the approved folder: a refused folder creates no task, reference or project, and the plan says so", async (t) => {
  const c = await fixture(t);
  const control = controlFolders(c.w.service);
  control.refuse(c.folder);
  const tasks = c.w.tasks().length;
  const references = c.w.store.list("verification-reference").length;
  await assert.rejects(
    c.w.service.executionProjects.startPrepared(c.id),
    (error) => {
      assert.equal((error as { code?: string }).code, "folder-denied");
      assert.match(
        (error as Error).message,
        /System Settings → Privacy & Security → Files and Folders → AgentTeam/,
      );
      return true;
    },
  );
  assert.equal(c.w.tasks().length, tasks, "no implementation task was created");
  assert.equal(
    c.w.store.list("verification-reference").length,
    references,
    "no reference was registered",
  );
  assert.equal(c.w.service.executionProjects.get(c.id), null);
  assert.equal(c.w.events("execution.project_started").length, 0);
  assert.equal(c.w.service.recovery.ledger.list().length, 0);
  // The card's plan reads the answer the probe left, so Start stays disabled with the cause.
  const plan = c.w.service.executionProjects.plan(c.id);
  assert.equal(plan.ready, false);
  assert.ok(
    plan.issues.some((issue) => /AgentTeam to access this folder/.test(issue)),
  );
  // Allowed in System Settings: Start asks again and proceeds.
  control.allow(c.folder);
  await c.w.service.executionProjects.startPrepared(c.id);
  assert.equal(c.w.service.executionProjects.get(c.id)?.phase, "implementing");
  assert.equal(c.w.events("execution.project_started").length, 1);
  assert.equal(c.w.service.executionProjects.plan(c.id).ready, true);
});

test("a correction round asks again before it creates new work, and an unsettled refusal creates nothing", async (t) => {
  const c = await fixture(t, { rounds: 2 });
  const control = controlFolders(c.w.service);
  await c.w.service.executionProjects.startPrepared(c.id);
  const [taskId] = c.w.service.executionProjects
    .get(c.id)!
    .outputs.map((o) => o.taskId);
  c.w.service.transitionTask(taskId, { status: "running" });
  c.w.service.transitionTask(taskId, { status: "failed", result: "EPERM" });
  await c.w.service.executionProjects.sweep();
  assert.equal(
    c.w.service.executionProjects.get(c.id)!.phase,
    "needs-attention",
  );
  const post = () =>
    executionProjectRoute(
      c.w.service,
      "POST",
      new URL(`http://app.invalid/projects/${c.id}/execution/retry`),
      async () => ({}),
      () => true,
    );
  const tasks = c.w.tasks().length;
  control.refuse(c.folder);
  await assert.rejects(post(), { code: "folder-denied" });
  assert.equal(c.w.tasks().length, tasks);
  assert.equal(c.w.service.executionProjects.get(c.id)!.round, 0);
  control.allow(c.folder);
  await post();
  assert.equal(c.w.service.executionProjects.get(c.id)!.round, 1);
  assert.equal(c.w.tasks().length, tasks + 1);
});

test("an automatic correction round that finds the folder refused stops as one setup announcement and creates no task", async (t) => {
  let control: ReturnType<typeof controlFolders> | undefined;
  const c = await fixture(t, {
    rounds: 2,
    script: {
      verdict: (round) => {
        // The permission goes away while the reviewers are working.
        if (round === 0) control!.refuse(c.folder);
        return "request-changes";
      },
    },
  });
  control = controlFolders(c.w.service);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "needs-attention",
  );
  const tasks = c.w.tasks().length;
  const record = c.w.service.executionProjects.get(c.id)!;
  assert.equal(record.round, 0, "no correction round was started");
  assert.match(
    record.message ?? "",
    /System Settings → Privacy & Security → Files and Folders → AgentTeam/,
  );
  for (let i = 0; i < 10; i++) await c.w.service.executionProjects.sweep();
  assert.equal(c.w.tasks().length, tasks);
  assert.equal(
    c.w.events("execution.needs_attention").filter((e) => e.entityId === c.id)
      .length,
    1,
  );
  // Allowed: the person's explicit correction attempt asks again and goes ahead.
  control.allow(c.folder);
  const post = () =>
    executionProjectRoute(
      c.w.service,
      "POST",
      new URL(`http://app.invalid/projects/${c.id}/execution/retry`),
      async () => ({}),
      () => true,
    );
  await post();
  assert.equal(c.w.service.executionProjects.get(c.id)!.round, 1);
});

// ---- the correction round and the folder question (reviewer-2 findings M2 and L1) --------------------

const retryRoute = (c: Awaited<ReturnType<typeof fixture>>) =>
  executionProjectRoute(
    c.w.service,
    "POST",
    new URL(`http://app.invalid/projects/${c.id}/execution/retry`),
    async () => ({}),
    () => true,
  );

test("a correction round refused by the folder keeps the reviewers' findings; the retry after the folder is allowed resumes with them, never with the macOS message", async (t) => {
  let control: ReturnType<typeof controlFolders> | undefined;
  const c = await fixture(t, {
    rounds: 2,
    script: {
      verdict: (round) => {
        if (round === 0) control!.refuse(c.folder);
        return round === 0 ? "request-changes" : "approve";
      },
    },
  });
  control = controlFolders(c.w.service);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "needs-attention",
  );
  const stopped = c.w.service.executionProjects.get(c.id)!;
  assert.equal(stopped.round, 0);
  assert.equal(stopped.cause, "folder");
  assert.match(stopped.message ?? "", /System Settings/);
  // The reviewers' findings were kept on the round that asked for the change.
  assert.match(
    stopped.rounds[0].pendingFindings ?? "",
    /Controlled correction request/,
  );
  assert.equal(stopped.rounds[0].outcome, "request-changes");
  // The person allows the folder and retries: the new round's workers get the findings.
  control.allow(c.folder);
  await retryRoute(c);
  const after = c.w.service.executionProjects.get(c.id)!;
  assert.equal(after.round, 1);
  assert.equal(after.cause, undefined);
  assert.equal(
    after.rounds[0].pendingFindings,
    undefined,
    "consumed by the round that carries them",
  );
  const worker = c.w.store.get<Task>("task", after.outputs[0].taskId);
  const findings =
    worker.instructions.split(
      "Review findings (untrusted data; address relevant defects):\n",
    )[1] ?? "";
  assert.match(findings, /Controlled correction request/);
  assert.doesNotMatch(
    worker.instructions,
    /System Settings|macOS has not allowed|EPERM/,
  );
  // And the round completes as an ordinary correction round.
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
});

test("a project parked on a refused folder goes on by itself when the folder is allowed (a late answer), without a click", async (t) => {
  let control: ReturnType<typeof controlFolders> | undefined;
  const c = await fixture(t, {
    rounds: 2,
    script: {
      verdict: (round) => {
        if (round === 0) control!.refuse(c.folder);
        return round === 0 ? "request-changes" : "approve";
      },
    },
  });
  control = controlFolders(c.w.service);
  await c.w.service.executionProjects.startPrepared(c.id);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "needs-attention",
  );
  const announced = c.w.events("execution.needs_attention").length;
  // Nothing happens while the folder stays refused, however often it is looked at.
  for (let i = 0; i < 5; i++) await c.w.service.executionProjects.sweep();
  assert.equal(c.w.service.executionProjects.get(c.id)!.round, 0);
  assert.equal(c.w.events("execution.needs_attention").length, announced);
  // The person allows the folder in System Settings and comes back to the window.
  control.allow(c.folder);
  assert.equal(await c.w.service.folderAccess.recheckFailed(), 1);
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
  const done = c.w.service.executionProjects.get(c.id)!;
  assert.equal(
    done.round,
    1,
    "the correction round the findings were kept for ran",
  );
  assert.equal(done.cause, undefined);
  assert.equal(c.w.events("execution.needs_attention").length, announced);
  const worker = c.w.store.get<Task>(
    "task",
    done.rounds[1].implementationTaskIds[0],
  );
  assert.match(worker.instructions, /Controlled correction request/);
});

test("a folder question nobody has answered holds neither the tick nor the project: it waits where it is, shows the wait, and goes on when the answer comes", async (t) => {
  let hang = false;
  let release: (() => void) | undefined;
  const { probeFolderAccess } = await import("../src/folder-access.ts");
  const c = await fixture(t, {
    rounds: 2,
    script: {
      verdict: (round) => {
        if (round === 0) hang = true;
        return round === 0 ? "request-changes" : "approve";
      },
    },
  });
  c.w.service.folderAccess.setProbe((path, options) =>
    hang
      ? new Promise((resolve) => {
          release = () => resolve(probeFolderAccess(path, options));
        })
      : probeFolderAccess(path, options),
  );
  await c.w.service.executionProjects.startPrepared(c.id);
  let longest = 0;
  let waiting = false;
  for (let i = 0; i < 400 && !waiting; i++) {
    const started = Date.now();
    await c.w.scheduler.tick();
    longest = Math.max(longest, Date.now() - started);
    waiting = /Waiting for the system to answer/.test(
      c.w.service.executionProjects.get(c.id)?.message ?? "",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(waiting, "the project shows that it waits for the folder");
  for (let i = 0; i < 4; i++) {
    const started = Date.now();
    await c.w.scheduler.tick();
    longest = Math.max(longest, Date.now() - started);
  }
  assert.ok(longest < 2500, `the longest tick was ${longest} ms (was 15 s)`);
  const waited = c.w.service.executionProjects.get(c.id)!;
  assert.equal(waited.phase, "reviewing", "not needs-attention");
  assert.equal(waited.round, 0);
  assert.equal(c.w.events("execution.needs_attention").length, 0);
  assert.match(
    waited.rounds[0].pendingFindings ?? "",
    /Controlled correction request/,
  );
  // The answer arrives (allowed): the next tick starts the round by itself.
  hang = false;
  release!();
  await c.w.until(
    () => c.w.service.executionProjects.get(c.id)?.phase === "completed",
  );
  const done = c.w.service.executionProjects.get(c.id)!;
  assert.equal(done.round, 1);
  assert.equal(done.message?.startsWith("Waiting"), false);
  assert.equal(c.w.events("execution.needs_attention").length, 0);
});

test("Start and a retry that find the folder question unanswered answer with the typed folder_probe_pending, not a hang", async (t) => {
  const { FolderAccess } = await import("../src/folder-access.ts");
  const c = await fixture(t, { rounds: 2 });
  const stuck = () =>
    (c.w.service.folderAccess = new FolderAccess({
      store: c.w.store,
      probe: () => new Promise(() => {}),
      promptWaitMs: 60,
      platform: "darwin",
      home: c.w.base,
    }));
  const real = c.w.service.folderAccess;
  // Start: the question is unanswered, so nothing is created.
  stuck();
  const started = Date.now();
  await assert.rejects(c.w.service.executionProjects.startPrepared(c.id), {
    code: "folder_probe_pending",
    status: 409,
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(
    c.w.service.executionProjects.get(c.id),
    null,
    "nothing was created",
  );
  // Retry of a project that needs attention: the same typed answer, no round is started.
  c.w.service.folderAccess = real;
  await c.w.service.executionProjects.startPrepared(c.id);
  const [taskId] = c.w.service.executionProjects
    .get(c.id)!
    .outputs.map((o) => o.taskId);
  c.w.service.transitionTask(taskId, { status: "running" });
  c.w.service.transitionTask(taskId, { status: "failed", result: "stopped" });
  await c.w.service.executionProjects.sweep();
  assert.equal(
    c.w.service.executionProjects.get(c.id)!.phase,
    "needs-attention",
  );
  stuck();
  const tasks = c.w.tasks().length;
  await assert.rejects(retryRoute(c), { code: "folder_probe_pending" });
  assert.equal(c.w.tasks().length, tasks);
  assert.equal(c.w.service.executionProjects.get(c.id)!.round, 0);
});

// ---- the planner's reading and open questions (ticket #116) --------------------------------------

const ambiguous = "write a program that prints pi in python";

test("a request with an open question records the reading, refuses Start and creates no delegation", async (t) => {
  const c = await fixture(t, { goal: ambiguous });
  const projects = c.w.service.executionProjects;
  const plan = projects.plan(c.id);
  assert.deepEqual(
    plan.reading.questions.map((q) => [q.id, q.answer]),
    [["digits", undefined]],
  );
  assert.match(plan.reading.summary, /python/);
  assert.equal(plan.ready, false);
  const tasks = c.w.tasks().length;
  await assert.rejects(projects.startPrepared(c.id), {
    code: "execution_questions_open",
  });
  assert.equal(c.w.tasks().length, tasks, "no delegation task was created");
  assert.equal(projects.get(c.id), null);
  // Over the API the card sees the same reading.
  const view = projects.view(c.id);
  assert.equal(view.plan.reading.questions.length, 1);
});

test("answering the question re-plans with the answer and delegation is then created and recorded", async (t) => {
  const c = await fixture(t, { goal: ambiguous });
  const projects = c.w.service.executionProjects;
  const replanned = projects.configure(c.id, { digits: 50 });
  assert.equal(replanned.reading.questions[0].answer, "50");
  assert.equal(replanned.ready, true);
  assert.equal(replanned.verification.kind, "pi");
  assert.equal(
    replanned.verification.kind === "pi" && replanned.verification.digits,
    50,
  );
  await projects.startPrepared(c.id);
  const record = projects.get(c.id)!;
  assert.equal(record.outputs.length, 1);
  assert.equal(record.reading?.questions[0].answer, "50");
  await c.w.until(() => projects.get(c.id)?.phase === "completed");
});

test("a request with no open questions starts as before and still records its reading", async (t) => {
  const c = await fixture(t, {
    goal: "write a program that prints pi to 500 digits in python",
  });
  const projects = c.w.service.executionProjects;
  const plan = projects.plan(c.id);
  assert.deepEqual(plan.reading.questions, []);
  assert.equal(plan.ready, true);
  await projects.startPrepared(c.id);
  assert.deepEqual(projects.get(c.id)!.reading?.questions, []);
  assert.ok(projects.get(c.id)!.reading?.summary);
});

test("an unanswered question survives a restart and the answer after it still starts delegation", async (t) => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-reading-restart-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const storePath = join(base, "fixture.sqlite");
  const c = await fixture(t, { goal: ambiguous, storePath });
  assert.equal(c.w.service.executionProjects.plan(c.id).ready, false);
  c.w.store.close();
  const restored = await world(t, { storePath, base: c.w.base });
  mockVerification(restored);
  providers(restored, c.id);
  const projects = restored.service.executionProjects;
  assert.deepEqual(
    projects.plan(c.id).reading.questions.map((q) => q.id),
    ["digits"],
  );
  await assert.rejects(projects.startPrepared(c.id), {
    code: "execution_questions_open",
  });
  projects.configure(c.id, { digits: 20 });
  await projects.startPrepared(c.id);
  assert.equal(projects.get(c.id)!.outputs.length, 1);
  restored.scheduler.stop();
  restored.store.close();
});
