import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { world } from "./fixtures/execution-world.ts";
import { effectiveInstructions } from "../src/effective-instructions.ts";
import type { Task } from "../src/model.ts";

const entities = (w: Awaited<ReturnType<typeof world>>) =>
  JSON.stringify(
    w.store.db
      .prepare(
        "SELECT kind, count(*) AS n FROM entities GROUP BY kind ORDER BY kind",
      )
      .all(),
  );

test("the model is told what its run really has: tools, folders, shell and reachable teammates", async (t) => {
  const w = await world(t);
  const folder = await w.folder("area");
  const writer = await w.service.saveAgent({
    name: "Writer",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const folderless = await w.service.saveAgent({
    name: "Folderless",
    environment: "claude",
    roleType: "implementer",
  });
  const lead = await w.service.saveAgent({
    name: "Lead",
    environment: "claude",
    roleType: "coordinator",
  });
  w.service.saveEdge({ from: lead.id, to: writer.id, kind: "delegate" });
  w.service.saveEdge({ from: lead.id, to: folderless.id, kind: "delegate" });

  const ready = (await w.service.launchPlan(writer.id)).instructions;
  assert.match(
    ready,
    new RegExp(
      `Tools in this run: Read, Glob, Grep, Edit, Write, Bash\\. Folders: ${folder.replace(/[\\/]/g, ".")} \\(write\\)\\. Shell: yes \\(sandboxed\\)\\. Reachable teammates: none\\.`,
    ),
  );
  const none = (await w.service.launchPlan(folderless.id)).instructions;
  assert.match(
    none,
    /Tools in this run: none \(No folder is attached, so the provider receives no file tools\.\)\. Folders: none\. Shell: no \(.*\)\. Reachable teammates: none\./,
  );
  // A coordinator hears which teammates cannot do file work yet, and why.
  const manager = (await w.service.launchPlan(lead.id)).instructions;
  assert.match(
    manager,
    /Reachable teammates: Writer, Folderless \(not ready: no folder attached\)\./,
  );
  // Leaf workers are never told they can delegate.
  assert.doesNotMatch(ready, /Reachable teammates: [A-Z]/);
});

test("the instructions preview is the launch, for an agent and for a task, and writes nothing", async (t) => {
  const w = await world(t);
  const folder = await w.folder("area");
  const sub = join(folder, "slice");
  await mkdir(sub);
  const agent = await w.service.saveAgent({
    name: "Writer",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const workflow = w.service.workflow({
    name: "Slice",
    goal: "Write a file",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Write notes.txt",
    completionCriteria: "Done",
    executionMode: "file-only",
    resourcePaths: [sub],
  });
  const before = entities(w);
  const events = w.store.history(0, 100_000).length;

  const forAgent = await effectiveInstructions(w.service, agent.id);
  const forTask = await effectiveInstructions(w.service, agent.id, {
    taskId: task.id,
  });
  assert.equal(entities(w), before, "the preview created or changed nothing");
  assert.equal(
    w.store.history(0, 100_000).length,
    events,
    "and published nothing",
  );

  assert.equal(
    forAgent.text,
    (await w.service.launchPlan(agent.id)).instructions,
  );
  assert.equal(
    forTask.text,
    (await w.service.launchPlan(agent.id, task.id)).instructions,
  );
  // The task's run is narrower: no shell, and its own task folder.
  assert.match(
    forTask.capabilities.line,
    /Shell: no \(A simple \(file-only\) assignment withholds the shell/,
  );
  assert.equal(forTask.capabilities.taskRoot, sub);
  assert.deepEqual(forTask.capabilities.folders, [
    { path: sub, access: "write" },
  ]);
  assert.equal(forTask.capabilities.available.shell, false);
  assert.equal(forTask.capabilities.gaps.shell?.code, "shell-withheld");
  assert.equal(forTask.task?.id, task.id);
  assert.match(forAgent.capabilities.line, /Shell: yes \(sandboxed\)/);
  // Another agent's task is refused.
  const other = await w.service.saveAgent({
    name: "Other",
    environment: "claude",
  });
  await assert.rejects(
    effectiveInstructions(w.service, other.id, { taskId: task.id }),
    {
      code: "task_agent",
    },
  );
});

test("a launch records a redacted manifest beside the task.settings event", async (t) => {
  process.env.AGENTTEAM_TEST_SECRET = "s3cr3t-value-that-must-not-leak";
  t.after(() => {
    delete process.env.AGENTTEAM_TEST_SECRET;
  });
  const w = await world(t);
  w.runs.runtimeVersion = (environment) =>
    environment === "claude" ? "2.1.308" : null;
  const folder = await w.folder("area");
  const agent = await w.service.saveAgent({
    name: "Writer",
    environment: "claude",
    model: "sonnet",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const workflow = w.service.workflow({
    name: "Manifest",
    goal: "Write",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Write notes.txt",
    instructions: "PRIVATE INSTRUCTION TEXT",
    completionCriteria: "Done",
  });
  let token = "";
  w.setProvider(async (command, _e, emit) => {
    token = command.teammateTools?.token ?? "";
    emit({ type: "text", data: "done" });
  });
  await w.until(
    () => w.store.get<Task>("task", task.id).status === "completed",
  );
  const history = w.store.history(0, 100_000);
  const settings = history.find(
    (e) => e.type === "task.settings" && e.entityId === task.id,
  )!;
  const manifest = history.find(
    (e) => e.type === "task.launch_manifest" && e.entityId === task.id,
  )!;
  assert.equal(manifest.seq, settings.seq + 1, "recorded beside task.settings");
  assert.equal(
    history.filter(
      (e) => e.type === "task.launch_manifest" && e.entityId === task.id,
    ).length,
    1,
  );
  const data = manifest.data as any;
  assert.deepEqual(data.adapter, {
    id: "claude",
    transport: "direct",
    environment: "claude",
    version: "2.1.308",
  });
  assert.equal(data.model, "sonnet");
  assert.equal(data.executionMode, "standard");
  assert.equal(data.taskRoot, folder);
  assert.deepEqual(data.allowedRoots, [{ path: folder, access: "write" }]);
  assert.deepEqual(
    data.toolNames,
    [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash",
      "mcp__agentteam__invoke_teammate",
      "mcp__agentteam__teammate_result",
    ],
    "tool names come from the grants the run really got, plus the teammate tools",
  );
  assert.equal(data.sandbox, "claude-sandbox-required");
  assert.deepEqual(data.readiness, {
    ready: true,
    basis: "grants",
    required: ["read", "write", "shell"],
    issues: [],
  });
  assert.equal(data.contract, null);
  // Nothing secret or bulky is recorded.
  const text = JSON.stringify(data);
  assert.ok(token.length > 20, "the run did get a token");
  for (const secret of [
    token,
    "AGENTTEAM_TOOL_TOKEN",
    "s3cr3t-value-that-must-not-leak",
    "PRIVATE INSTRUCTION TEXT",
  ])
    assert.ok(!text.includes(secret), `manifest leaks ${secret}`);
  assert.ok(text.length < 2000);
});

test("a chat run's root task records its manifest too, with the teammate tools it was given", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  w.setProvider(async (_c, _e, emit) => emit({ type: "text", data: "ok" }));
  await w.chat(team.planner.id, "Hello");
  const manifests = w.events("task.launch_manifest");
  assert.equal(manifests.length, 1);
  const data = manifests[0].data as any;
  assert.ok(data.toolNames.includes("mcp__agentteam__invoke_teammate"));
  assert.equal(
    data.readiness.ready,
    true,
    "the planner needs nothing from a folder",
  );
  assert.equal(data.taskRoot, null);
});
