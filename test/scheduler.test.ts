import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { Task } from "../src/model.ts";
import {
  explicitlyReportsIncompleteExecution,
  explicitlyReportsNoWork,
  explicitlyReportsUnapprovedReview,
} from "../src/task-results.ts";

test("explicit provider refusals are failures, not completed work", async () => {
  const refusal =
    "I couldn't do this task. I have no way to write files or run commands. Nothing was created, built, or run.";
  assert.equal(explicitlyReportsNoWork(refusal), true);
  assert.equal(
    explicitlyReportsNoWork(
      "I could not run the optional integration test, but I wrote the code.",
    ),
    false,
  );

  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd());
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
    roleType: "implementer",
  });
  const workflow = service.workflow({
    name: "W",
    goal: "G",
    ownerId: agent.id,
    completionCriteria: "Do the work",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build it",
    completionCriteria: "Create and run a file",
  });
  const scheduler = new Scheduler(service, runs, async (_cmd, _env, emit) => {
    emit({ type: "text", data: refusal });
  });
  try {
    await scheduler.tick();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        ["failed", "completed"].includes(
          store.get<Task>("task", task.id).status,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = store.get<Task>("task", task.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.result?.trim(), refusal);
    assert.equal(service.workflowStatus(workflow.id).status, "needs-attention");
  } finally {
    scheduler.stop();
    store.close();
  }
});

test("execution-required tasks fail when the agent says it did not run the command", async () => {
  const result =
    "I wrote the file, but I haven't run it. The Bash tool is disabled, so I have no stdout.";
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd());
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
    roleType: "implementer",
  });
  const workflow = service.workflow({
    name: "Run required",
    goal: "Build and run a program",
    ownerId: agent.id,
    completionCriteria: "Program ran successfully",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build and run the program",
    completionCriteria: "Actually run it and report stdout",
  });
  assert.equal(explicitlyReportsIncompleteExecution(task, result), true);
  assert.equal(
    explicitlyReportsIncompleteExecution(
      task,
      "I wrote the file, but I haven't compiled or run it. I have no shell tool in this session.",
    ),
    true,
  );
  assert.equal(
    explicitlyReportsIncompleteExecution(
      task,
      "Nothing has been built or run yet. All three builder tasks are still queued and haven't started.",
    ),
    true,
  );
  assert.equal(
    explicitlyReportsIncompleteExecution(
      {
        ...task,
        title: "Implement the program",
        completionCriteria: "Write clean code",
      },
      result,
    ),
    false,
  );
  assert.equal(
    explicitlyReportsIncompleteExecution(
      task,
      "I didn't run the optional tests. The command exited with status 0 and the literal stdout was captured.",
    ),
    false,
  );
  assert.equal(
    explicitlyReportsIncompleteExecution(
      {
        ...task,
        title: "Plan and coordinate",
        instructions:
          "Goal: builders compile or run the program. Restate acceptance criteria, then plan and delegate the work.",
      },
      "Nothing has been built or run yet. I delegated the tasks and produced the plan.",
    ),
    false,
  );
  const scheduler = new Scheduler(service, runs, async (_cmd, _env, emit) => {
    emit({ type: "text", data: result });
  });
  try {
    await scheduler.tick();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        ["failed", "completed"].includes(
          store.get<Task>("task", task.id).status,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = store.get<Task>("task", task.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.result?.trim(), result);
    assert.equal(service.workflowStatus(workflow.id).status, "needs-attention");
  } finally {
    scheduler.stop();
    store.close();
  }
});

test("a false completed label is surfaced and its task can be retried", async () => {
  const refusal =
    "I wrote the file, but I haven't run it. The Bash tool is disabled, so I have no stdout.";
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([]));
  const agent = await service.saveAgent({
    name: "Builder",
    environment: "codex",
    roleType: "implementer",
  });
  const workflow = service.workflow({
    name: "Retry incomplete execution",
    goal: "Run the program and verify its output",
    ownerId: agent.id,
    completionCriteria: "Program ran successfully",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build and run the program",
    completionCriteria: "Actually run it and report stdout",
  });
  store.put("task", { ...task, status: "completed", result: refusal });
  assert.equal(service.workflowStatus(workflow.id).status, "needs-attention");

  const queued = service.transitionTask(task.id, { status: "queued" });
  assert.equal(queued.status, "queued");
  assert.equal(queued.result, undefined);
  assert.equal(service.workflowStatus(workflow.id).status, "queued");
  store.close();
});

test("approval reviews remain incomplete when the reviewer reports an inconclusive verdict", async () => {
  const result =
    "Verdict: Inconclusive — I could not inspect the current source files.";
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd());
  const agent = await service.saveAgent({
    name: "Reviewer",
    environment: "codex",
    roleType: "reviewer",
  });
  const workflow = service.workflow({
    name: "Review required",
    goal: "Approve the implementation",
    ownerId: agent.id,
    completionCriteria: "Reviewer approval required",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Review and approve the result",
    completionCriteria: "Approve only if the evidence passes",
  });
  assert.equal(explicitlyReportsUnapprovedReview(task, result), true);
  const scheduler = new Scheduler(service, runs, async (_cmd, _env, emit) => {
    emit({ type: "text", data: result });
  });
  try {
    await scheduler.tick();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        ["failed", "completed"].includes(
          store.get<Task>("task", task.id).status,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = store.get<Task>("task", task.id);
    assert.equal(finished.status, "failed");
    assert.equal(finished.result?.trim(), result);
    assert.equal(service.workflowStatus(workflow.id).status, "needs-attention");
  } finally {
    scheduler.stop();
    store.close();
  }
});

test("scheduler respects invocation capacity and resumes queued work when capacity returns", async () => {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd());
  const release: (() => void)[] = [];
  const scheduler = new Scheduler(service, runs, async (_cmd, _env, emit) => {
    await new Promise<void>((resolve) => release.push(resolve));
    emit({ type: "text", data: "done" });
  });
  try {
    const lead = await service.saveAgent({
      name: "Lead",
      environment: "codex",
      maxConcurrentInvocations: 1,
    });
    const wf = service.workflow({
      name: "W",
      goal: "G",
      ownerId: lead.id,
      completionCriteria: "D",
    });
    const tasks: Task[] = [];
    for (let i = 0; i < 2; i++) {
      const a = await service.saveAgent({
        name: "Child " + i,
        environment: "codex",
      });
      service.saveEdge({ from: lead.id, to: a.id, kind: "delegate" });
      tasks.push(
        service.task({
          workflowId: wf.id,
          agentId: a.id,
          invokedBy: lead.id,
          title: "T",
          completionCriteria: "D",
        }),
      );
    }
    await scheduler.tick();
    assert.equal(release.length, 1);
    assert.equal(service.taskState(tasks[1].id).waitReason, "invocation-limit");
    release[0]();
    await new Promise((r) => setImmediate(r));
    await scheduler.tick();
    assert.equal(release.length, 2);
    assert.equal(store.get<Task>("task", tasks[0].id).status, "completed");
    release[1]();
    await new Promise((r) => setImmediate(r));
    assert.equal(store.get<Task>("task", tasks[1].id).status, "completed");
  } finally {
    scheduler.stop();
    store.close();
  }
});
test("disabled execution and human control never start automated work", async () => {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, false, process.cwd());
  let calls = 0;
  const scheduler = new Scheduler(service, runs, async () => {
    calls++;
  });
  try {
    const agent = await service.saveAgent({ name: "A", environment: "codex" });
    const wf = service.workflow({
      name: "W",
      goal: "G",
      ownerId: agent.id,
      completionCriteria: "D",
    });
    service.task({
      workflowId: wf.id,
      agentId: agent.id,
      title: "T",
      completionCriteria: "D",
    });
    await scheduler.tick();
    assert.equal(calls, 0);
    runs.enabled = true;
    service.control(agent.id, "human");
    await scheduler.tick();
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
