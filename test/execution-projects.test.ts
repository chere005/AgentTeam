// C coordinator fixtures deliberately mock B's execution boundary. They test routing, exact
// review identity/provenance and durable rounds; real confinement is covered separately by B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { world, type World } from "./fixtures/execution-world.ts";
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
  options: { rounds?: number; storePath?: string; script?: Script } = {},
) {
  const w = await world(t, { storePath: options.storePath });
  mockVerification(w);
  const folder = await w.folder();
  const planner = await w.service.saveAgent({
    name: "Planner",
    environment: "claude",
    roleType: "coordinator",
    tools: ["read"],
  });
  const worker = await w.service.saveAgent({
    name: "Python developer",
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: folder, access: "write", active: true }],
  });
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
  for (const target of [worker, ...reviewers])
    w.service.saveEdge({ from: planner.id, to: target.id, kind: "delegate" });
  const session = w.service.session(planner.id),
    message = w.service.message(session.id, { text: original });
  message.status = "delivered";
  w.store.put("message", message);
  const workflow = w.service.workflow({
    name: "Original chat assignment",
    goal: original,
    ownerId: planner.id,
    kind: "conversation",
    completionCriteria: "Implement and review the requested programs",
  });
  w.service.contracts.prepareConversation({
    workflowId: workflow.id,
    agent: planner,
    text: original,
    origin: { sessionId: session.id, messageId: message.id },
  });
  w.service.contracts.authorizeFolder(workflow.id, folder);
  w.service.executionProjects.configure(workflow.id, {
    languages: ["python"],
    maxCorrectionRounds: options.rounds ?? 1,
  });
  providers(w, workflow.id, options.script);
  return { w, id: workflow.id, folder, reviewers, worker };
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
