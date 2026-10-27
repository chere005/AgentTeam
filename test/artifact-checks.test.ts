import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { type Agent, type Task } from "../src/model.ts";
import {
  completionCheckSchema,
  type CompletionCheck,
} from "../src/limits-schema.ts";
import { MAX_CHECK_ARTIFACT_BYTES } from "../src/limits.ts";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import { explicitlyReportsNoWork } from "../src/task-results.ts";

async function setup() {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-artifact-checks-")),
  );
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const agent = await service.saveAgent({
    name: "Writer",
    environment: "codex",
    tools: ["read", "write"],
    instructions:
      "Roll call uses this identity: I am Writer, reporting for duty.",
    workspaces: [{ path: workspace, access: "write", active: true }],
  });
  const workflow = service.workflow({
    name: "File deliverables",
    goal: "Write the required file",
    ownerId: agent.id,
    completionCriteria: "File and content verified",
  });
  const create = (checks: CompletionCheck[], extra: object = {}) =>
    service.task({
      workflowId: workflow.id,
      agentId: agent.id,
      title: "Write a roll-call file",
      completionCriteria:
        "The named file contains the agent's identity and reporting for duty",
      completionChecks: checks,
      ...extra,
    });
  const evaluate = (task: Task, cwd = workspace) =>
    service.limits.evaluate(store.get<Task>("task", task.id), "Done", cwd);
  const close = async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  };
  return {
    dir,
    workspace,
    store,
    service,
    agent,
    workflow,
    create,
    evaluate,
    close,
  };
}

test("delegated file checks reject missing and wrong content, then accept the actual file", async () => {
  const t = await setup();
  try {
    const manager = await t.service.saveAgent({
      name: "Manager",
      environment: "codex",
    });
    t.service.saveEdge({ from: manager.id, to: t.agent.id, kind: "delegate" });
    const parent = t.service.task({
      workflowId: t.workflow.id,
      agentId: manager.id,
      title: "Coordinate roll call",
      completionCriteria: "Every required file verified",
    });
    t.service.transitionTask(parent.id, { status: "running" });
    const checks: CompletionCheck[] = [
      { type: "artifact-exists", path: "Writer.txt" },
      {
        type: "artifact-matches",
        path: "Writer.txt",
        pattern: "^I am Writer, reporting for duty\\.\\r?\\n?$",
        flags: "",
      },
    ];
    const invocation = t.service.orchestration.invokeTeammate(
      { agentId: manager.id, taskId: parent.id },
      {
        recipient: t.agent.id,
        title: "Write Writer.txt",
        completionChecks: checks,
      },
    );
    const child = t.store.get<Task>("task", invocation.childTaskId);
    assert.deepEqual(child.completionChecks, checks);
    assert.deepEqual(
      t.store.get<{ request: { completionChecks: CompletionCheck[] } }>(
        "invocation",
        child.id,
      ).request.completionChecks,
      checks,
    );
    t.service.transitionTask(child.id, { status: "running" });
    assert.equal((await t.evaluate(child))?.passed, false);
    assert.throws(
      () =>
        t.service.transitionTask(child.id, {
          status: "completed",
          result: "Done",
        }),
      { code: "completion_checks_failed" },
    );
    await writeFile(
      join(t.workspace, "Writer.txt"),
      "The file exists, but it belongs to another agent.",
    );
    const wrong = await t.evaluate(child);
    assert.equal(wrong?.results[0].passed, true);
    assert.equal(wrong?.results[1].passed, false);
    assert.throws(
      () =>
        t.service.transitionTask(child.id, {
          status: "completed",
          result: "Done",
        }),
      { code: "completion_checks_failed" },
    );
    await writeFile(
      join(t.workspace, "Writer.txt"),
      "I am Writer, reporting for duty.\n",
    );
    const passed = await t.evaluate(child);
    assert.equal(passed?.passed, true);
    assert.equal(passed?.cwd, t.workspace);
    assert.equal(
      t.service.transitionTask(child.id, {
        status: "completed",
        result: "Done",
      }).status,
      "completed",
    );
    await writeFile(
      join(t.workspace, "Writer.txt"),
      "Wrong content after completion.",
    );
    await t.evaluate(child);
    const invalid = t.service.orchestration.teammateResult(
      { agentId: manager.id, taskId: parent.id },
      { taskId: child.id },
    );
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.result, null);
    assert.match(invalid.error!, /does not match the required content/);
    assert.equal(invalid.partialResult, "Done");

    const old = t.service.orchestration.invokeTeammate(
      { agentId: manager.id, taskId: parent.id },
      { recipient: t.agent.id, title: "Earlier failed attempt" },
    );
    t.service.transitionTask(old.childTaskId, { status: "running" });
    t.service.transitionTask(old.childTaskId, {
      status: "failed",
      result: "Earlier failure",
    });
    await writeFile(
      join(t.workspace, "Writer.txt"),
      "I am Writer, reporting for duty.\n",
    );
    await t.evaluate(child);
    t.service.supersedeTask(old.childTaskId, child.id);
    const superseded = t.service.orchestration.teammateResult(
      { agentId: manager.id, taskId: parent.id },
      { taskId: old.childTaskId },
    );
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.result, null);
    assert.equal(superseded.supersededBy, child.id);
  } finally {
    await t.close();
  }
});

test("artifact checks enforce attached access rules, task scope, symlink boundary and permanent denials", async () => {
  const t = await setup();
  try {
    await mkdir(join(t.workspace, "allowed"));
    await mkdir(join(t.workspace, "other"));
    await writeFile(join(t.workspace, "allowed", "file.txt"), "ready");
    await writeFile(join(t.workspace, "other", "file.txt"), "ready");
    const check = (path: string): CompletionCheck => ({
      type: "artifact-matches",
      path,
      pattern: "ready",
      flags: "",
    });
    const scoped = t.create([check("file.txt")], {
      resourcePaths: [join(t.workspace, "allowed")],
    });
    assert.equal(
      (await t.evaluate(scoped, join(t.workspace, "allowed")))?.passed,
      true,
    );
    assert.match(
      (await t.evaluate(scoped, join(t.workspace, "other")))!.results[0].detail,
      /declared directories/,
    );

    const restricted: Agent = {
      ...t.agent,
      workspaces: [
        {
          ...t.agent.workspaces[0],
          rules: [{ path: "other", access: "none" }],
        },
      ],
    };
    t.store.put("agent", restricted);
    const denied = t.create([check("other/file.txt")]);
    assert.match(
      (await t.evaluate(denied))!.results[0].detail,
      /access denied/i,
    );
    await symlink(
      join(t.workspace, "other"),
      join(t.workspace, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const alias = t.create([check("alias/file.txt")]);
    assert.match(
      (await t.evaluate(alias))!.results[0].detail,
      /access denied/i,
    );
    t.store.put("agent", t.agent);

    const detachedAgent = await t.service.saveAgent({
      name: "Detached",
      environment: "codex",
    });
    const detached = t.create([check("allowed/file.txt")], {
      agentId: detachedAgent.id,
    });
    assert.match(
      (await t.evaluate(detached))!.results[0].detail,
      /readable attached workspace/,
    );

    const outside = join(t.dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "ready");
    await symlink(
      outside,
      join(t.workspace, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const escape = t.create([check("linked/secret.txt")]);
    assert.match(
      (await t.evaluate(escape))!.results[0].detail,
      /outside the workspace/,
    );

    filesystemPolicy(t.store).add({
      paths: [join(t.workspace, "allowed")],
      acknowledgePermanent: true,
    });
    assert.match(
      (await t.evaluate(scoped, join(t.workspace, "allowed")))!.results[0]
        .detail,
      /permanently blocked/,
    );
  } finally {
    await t.close();
  }
});

test("artifact content checks reject large, binary and invalid UTF-8 files, and stale acceptance evidence", async () => {
  const t = await setup();
  try {
    const task = t.create([
      {
        type: "artifact-matches",
        path: "file.txt",
        pattern: "ready",
        flags: "",
      },
    ]);
    await writeFile(
      join(t.workspace, "file.txt"),
      Buffer.alloc(MAX_CHECK_ARTIFACT_BYTES + 1, 97),
    );
    assert.match((await t.evaluate(task))!.results[0].detail, /at most/);
    await writeFile(join(t.workspace, "file.txt"), Buffer.from([0, 97]));
    assert.match((await t.evaluate(task))!.results[0].detail, /UTF-8 text/);
    await writeFile(join(t.workspace, "file.txt"), Buffer.from([0xff]));
    assert.equal((await t.evaluate(task))?.passed, false);
    await writeFile(join(t.workspace, "file.txt"), "ready");
    assert.equal((await t.evaluate(task))?.passed, true);
    t.service.limits.setChecks(task.id, [
      {
        type: "artifact-matches",
        path: "file.txt",
        pattern: "(a+)+$",
        flags: "",
      },
    ]);
    await writeFile(join(t.workspace, "file.txt"), "a".repeat(40) + "b");
    assert.match((await t.evaluate(task))!.results[0].detail, /was stopped/);
    t.service.limits.setChecks(task.id, [
      {
        type: "artifact-matches",
        path: "file.txt",
        pattern: "different",
        flags: "",
      },
    ]);
    t.service.transitionTask(task.id, { status: "running" });
    assert.throws(
      () =>
        t.service.transitionTask(task.id, {
          status: "completed",
          result: "Done",
        }),
      { code: "completion_checks_failed" },
    );
    assert.equal(
      completionCheckSchema.safeParse({
        type: "artifact-matches",
        path: "file.txt",
        pattern: "(",
      }).success,
      false,
    );
  } finally {
    await t.close();
  }
});

test("no-work reporting catches the screenshot without treating partial successful work as failure", () => {
  assert.equal(
    explicitlyReportsNoWork(
      "None of the roll-call files exist yet. All three tasks are queued, but nothing has run.",
    ),
    true,
  );
  assert.equal(
    explicitlyReportsNoWork(
      "All three tasks are queued. I wrote Manager.txt, reporting for duty.",
    ),
    false,
  );
  assert.equal(
    explicitlyReportsNoWork(
      "None of the optional files exist yet, but I completed the requested report.",
    ),
    false,
  );
});
