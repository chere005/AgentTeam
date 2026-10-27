import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import type { Task } from "../src/model.ts";

async function setup() {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const manager = await service.saveAgent({
    name: "Manager",
    environment: "codex",
  });
  const worker = await service.saveAgent({
    name: "Worker",
    environment: "codex",
  });
  const edge = service.saveEdge({
    from: manager.id,
    to: worker.id,
    kind: "delegate",
  });
  const workflow = service.workflow({
    name: "Delegation safety",
    ownerId: manager.id,
    goal: "Finish delegated work safely",
    completionCriteria: "Required work and checks passed",
  });
  const parent = service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Coordinate work",
    completionCriteria: "Required work finished",
  });
  service.transitionTask(parent.id, { status: "running" });
  const child = (extra: object = {}) =>
    service.orchestration.invokeTeammate(
      { agentId: manager.id, taskId: parent.id },
      { recipient: worker.id, title: "Do the assigned work", ...extra },
    ).childTaskId;
  const finish = async (id: string, result = "Done") => {
    if (store.get<Task>("task", id).status === "queued")
      service.transitionTask(id, { status: "running" });
    const current = store.get<Task>("task", id);
    await service.limits.evaluate(current, result, process.cwd());
    service.transitionTask(id, { status: "completed", result });
  };
  const waitFor = (id: string) => {
    assert.equal(
      service.delegations.defer(
        store.get<Task>("task", parent.id),
        `Waiting for ${id}`,
        process.cwd(),
      ),
      true,
    );
  };
  const ready = async () => {
    const id = child();
    waitFor(id);
    await finish(id);
    return id;
  };
  return {
    store,
    service,
    manager,
    worker,
    edge,
    workflow,
    parent,
    child,
    finish,
    waitFor,
    ready,
  };
}

const APPROVE = JSON.stringify({
  verdict: "approve",
  findings: ["none"],
  evidence: ["independent check passed"],
});

test("required review holds a parent until approved and uses the exact current evidence contract", async () => {
  const t = await setup();
  try {
    const reviewer = await t.service.saveAgent({
      name: "Reviewer",
      environment: "codex",
      roleType: "reviewer",
    });
    t.service.saveEdge({ from: t.worker.id, to: reviewer.id, kind: "review" });
    t.service.saveRule({
      agentId: reviewer.id,
      scope: "intake",
      priority: 10,
      mode: "mandatory",
      kind: "review",
      specialty: "safety",
      match: { changedFilesAny: ["**/migrations/**"] },
    });
    const childId = t.child({ changedFiles: ["db/migrations/001.sql"] });
    t.waitFor(childId);
    await t.finish(childId, "Migration implemented");
    await t.service.delegations.sweep();
    assert.equal(t.store.get<Task>("task", t.parent.id).status, "blocked");
    assert.equal(t.service.recovery.state(t.parent.id).continuation ?? 0, 0);
    const trigger = t.service.orchestration.triggers(childId)[0];
    const reviewId = trigger.reviews.at(-1)!.taskId;
    await t.finish(reviewId, APPROVE);
    const review = t.store.get<Task>("task", reviewId);
    const meta = t.service.limits.meta(reviewId);
    assert.ok(meta.checks);
    delete meta.checks.checksHash; // Original persisted evidence retained every ordered check.
    t.store.put("task-meta", meta);
    t.service.limits.assertCompletion(review, APPROVE);
    assert.equal(
      t.service.orchestration.gate(t.store.get<Task>("task", childId)).open,
      true,
    );

    const validResults = meta.checks.results;
    meta.checks.results = [
      {
        ...validResults[0],
        check: { type: "output-fields", fields: ["verdict"] },
      },
    ];
    t.store.put("task-meta", meta);
    const invalid = t.service.orchestration.gate(
      t.store.get<Task>("task", childId),
    );
    assert.equal(invalid.open, false);
    assert.equal(invalid.requirements[0].state, "evidence-missing");
    await t.service.delegations.sweep();
    assert.equal(t.store.get<Task>("task", t.parent.id).status, "blocked");
    meta.checks.results = validResults;
    t.store.put("task-meta", meta);
    await t.service.delegations.sweep();
    assert.equal(t.store.get<Task>("task", t.parent.id).status, "queued");
    assert.equal(t.service.recovery.state(t.parent.id).continuation, 1);
  } finally {
    t.store.close();
  }
});

test("revoking a delegation edge blocks resumption and never exposes results in a continuation prompt", async () => {
  const t = await setup();
  try {
    await t.ready();
    const setEnabled = (enabled: boolean) =>
      t.service.saveEdge(
        {
          from: t.manager.id,
          to: t.worker.id,
          kind: "delegate",
          enabled,
        },
        t.edge.id,
      );
    setEnabled(false);
    await t.service.delegations.sweep();
    assert.equal(t.store.get<Task>("task", t.parent.id).status, "blocked");
    assert.match(
      t.service.delegations.view(t.parent.id)!.message,
      /permission was revoked/,
    );
    assert.equal(t.service.delegations.continuationNote(t.parent), "");
    setEnabled(true);
    await t.service.delegations.sweep();
    assert.equal(t.store.get<Task>("task", t.parent.id).status, "queued");
    setEnabled(false); // Revocation after queueing still prevents prompt construction.
    assert.throws(() => t.service.delegations.continuationNote(t.parent), {
      code: "delegated_work_pending",
    });
  } finally {
    t.store.close();
  }
});

test("the same provider tool-call id records distinct effects across continuations", async () => {
  const t = await setup();
  try {
    const event = {
      type: "tool",
      data: {
        toolCallId: "item_0",
        kind: "edit",
        status: "completed",
        title: "Write output",
      },
    };
    t.service.recovery.observe(t.parent, event);
    await t.ready();
    await t.service.delegations.sweep();
    t.service.transitionTask(t.parent.id, { status: "running" });
    t.service.recovery.observe(t.parent, event);
    const effects = t.service.recovery.ledger
      .list(t.parent.id)
      .filter((effect) => effect.kind === "tool:edit");
    assert.equal(effects.length, 2);
    assert.equal(new Set(effects.map((effect) => effect.key)).size, 2);
    assert.ok(effects.every((effect) => effect.state === "completed"));
    assert.ok(effects.some((effect) => effect.key.endsWith(":1:item_0")));
    assert.ok(
      effects.some((effect) => effect.key.includes(":continuation:1:item_0")),
    );
  } finally {
    t.store.close();
  }
});

for (const blocker of ["pause", "human", "uncertain"] as const) {
  test(`${blocker} keeps a finished delegation stopped until the block is resolved`, async () => {
    const t = await setup();
    try {
      await t.ready();
      let resolveBlock: () => void;
      if (blocker === "pause") {
        t.service.pauseWorkflow(t.workflow.id, true);
        resolveBlock = () => {
          t.service.pauseWorkflow(t.workflow.id, false);
        };
      } else if (blocker === "human") {
        t.service.control(t.manager.id, "human");
        resolveBlock = () => {
          t.service.control(t.manager.id, "team");
        };
      } else {
        const { effect } = t.service.recovery.ledger.begin({
          taskId: t.parent.id,
          key: "test:uncertain",
          kind: "tool:edit",
          description: "Possible write",
          mutating: true,
        });
        t.service.recovery.ledger.markUncertain(effect.id, "Outcome unknown");
        resolveBlock = () => {
          t.service.recovery.ledger.decide(effect.id, {
            decision: "completed",
            note: "Verified the write",
          });
        };
      }
      await t.service.delegations.sweep();
      assert.equal(t.store.get<Task>("task", t.parent.id).status, "blocked");
      assert.equal(t.service.recovery.state(t.parent.id).continuation ?? 0, 0);
      resolveBlock();
      await t.service.delegations.sweep();
      assert.equal(t.store.get<Task>("task", t.parent.id).status, "queued");
      assert.equal(t.service.recovery.state(t.parent.id).continuation, 1);
      await t.service.delegations.sweep();
      assert.equal(t.service.recovery.state(t.parent.id).continuation, 1);
    } finally {
      t.store.close();
    }
  });
}

test("automatic parent continuations stop at three and retain the waiting assignment", async () => {
  const t = await setup();
  try {
    for (let continuation = 1; continuation <= 4; continuation++) {
      const childId = t.child();
      t.waitFor(childId);
      await t.finish(childId);
      await t.service.delegations.sweep();
      assert.equal(
        t.service.recovery.state(t.parent.id).continuation ?? 0,
        Math.min(continuation, 3),
      );
      if (continuation <= 3) {
        assert.equal(t.store.get<Task>("task", t.parent.id).status, "queued");
        t.service.transitionTask(t.parent.id, { status: "running" });
      }
    }
    assert.equal(t.store.get<Task>("task", t.parent.id).status, "blocked");
    assert.match(
      t.service.delegations.view(t.parent.id)!.message,
      /continuation limit reached/,
    );
    assert.throws(() => t.service.recovery.continueDelegation(t.parent.id), {
      code: "delegation_continuation_limit",
    });
  } finally {
    t.store.close();
  }
});

test("historical completion evidence is accepted only for its exact full ordered contract", async () => {
  const t = await setup();
  try {
    const id = t.child({
      completionChecks: [
        { type: "output-matches", pattern: "^Done", flags: "" },
        { type: "output-matches", pattern: "Done$", flags: "" },
      ],
    });
    // The short literals are intentionally explicit user-approved gates, not inferred model truth.
    for (const check of t.service.contracts.unresolved({ id }))
      t.service.contracts.confirmCheck(`task:${id}`, check.slot, {
        note: "User confirms the exact Done output for this ordered-evidence test.",
      });
    await t.finish(id);
    const task = t.store.get<Task>("task", id);
    const meta = t.service.limits.meta(id);
    assert.ok(meta.checks);
    delete meta.checks.checksHash;
    t.store.put("task-meta", meta);
    assert.doesNotThrow(() => t.service.limits.assertCompletion(task, "Done"));
    const full = meta.checks.results;
    for (const results of [
      [],
      full.slice(0, 1),
      [...full].reverse(),
      [{ ...full[0], passed: false }, full[1]],
    ]) {
      meta.checks.results = results;
      t.store.put("task-meta", meta);
      assert.throws(() => t.service.limits.assertCompletion(task, "Done"), {
        code: "completion_checks_failed",
      });
    }
  } finally {
    t.store.close();
  }
});
