import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { TeamService } from "../src/service.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamTemplates } from "../src/teams.ts";
import { pipelineTeamTemplate } from "../src/pipeline.ts";
import {
  assignProject,
  projectInfo,
  SIMPLE_TASK_PROJECT,
} from "../src/projects.ts";
import { verifySampleModels, type WorkflowSetup } from "../src/samples.ts";
import { commandFor } from "../src/runtime.ts";
import { assertProviderCapabilities } from "../src/provider-capabilities.ts";
import { defaults } from "../src/discovery.ts";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import { simpleTaskSupport } from "../src/simple-task-capabilities.ts";
import type { Agent, Task, Workflow } from "../src/model.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-simple-")),
  );
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  t.after(async () => {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });
  return { workspace, store, service };
}

test("a pipeline team can start independent simple file tasks without pipeline stages or unrelated model gates", async (t) => {
  const w = await fixture(t);
  const inserted = new TeamTemplates(w.service).insertTemplate(
    pipelineTeamTemplate({ implementationWorkers: 1, fixWorkers: 1 }),
  );
  const profileBefore = JSON.stringify(w.store.list("team-profile"));
  const writers = inserted.agents
    .filter((a) => a.roleType === "implementer")
    .slice(0, 2);
  const workflow = await assignProject(w.service, inserted.teamId, {
    mode: "simple",
    goal: "Say hi",
    workspace: w.workspace,
    tasks: writers.map((agent) => ({
      agentId: agent.id,
      title: "Say hi",
      instructions: "Write your greeting.",
    })),
  });
  const setup = w.store.get<Workflow & { setup: WorkflowSetup }>(
    "workflow",
    workflow.id,
  ).setup;
  assert.equal(setup.sample, SIMPLE_TASK_PROJECT);
  assert.equal(setup.executionMode, "file-only");
  assert.equal(setup.requiresPreflight, undefined);
  assert.equal(workflow.tasks.length, 2);
  assert.ok(
    workflow.tasks.every(
      (task) => task.executionMode === "file-only" && !task.dependsOn.length,
    ),
  );
  assert.ok(
    workflow.tasks.every((task) => task.resourcePaths?.[0] === w.workspace),
  );
  assert.equal(w.store.list("pipeline").length, 0);
  assert.equal(w.store.list("worktree").length, 0);
  assert.equal(JSON.stringify(w.store.list("team-profile")), profileBefore);
  assert.deepEqual(
    Object.keys(setup.expectations ?? {}).sort(),
    writers.map((a) => a.id).sort(),
  );
  for (const agent of inserted.agents.filter(
    (a) => !writers.some((writer) => writer.id === a.id),
  ))
    assert.deepEqual(w.store.get<Agent>("agent", agent.id).workspaces, []);
  const runtimes = structuredClone(defaults).map((runtime) => ({
    ...runtime,
    installed: runtime.id === "claude",
    authenticated: true,
    models: writers
      .filter((a) => a.environment === runtime.id)
      .map((a) => ({
        id: a.model,
        name: a.model,
        efforts: a.effort ? [a.effort] : [],
      })),
  }));
  const check = verifySampleModels(w.service, workflow.id, runtimes);
  assert.equal(check.verified, true, check.issues.join("; "));
  assert.equal(
    check.resolved.length,
    2,
    "the unused lead and reviewers do not block a simple task",
  );
  w.service.pauseWorkflow(workflow.id, false);
  for (const task of workflow.tasks) {
    const plan = await w.service.launchPlan(task.agentId, task.id);
    assert.ok(!plan.tools.includes("shell"));
    const command = commandFor(plan, null, "Write the greeting", w.workspace);
    assert.doesNotThrow(() =>
      assertProviderCapabilities(command, plan.environment, "win32"),
    );
    assert.ok(
      !command.args[command.args.indexOf("--tools") + 1]
        .split(",")
        .includes("Bash"),
    );
    assert.ok(
      w.store.get<Agent>("agent", task.agentId).tools.includes("shell"),
      "permanent agent grants are preserved",
    );
  }
});

test("full pipeline mode remains explicit and unchanged", async (t) => {
  const w = await fixture(t);
  const inserted = new TeamTemplates(w.service).insertTemplate(
    pipelineTeamTemplate({ implementationWorkers: 1, fixWorkers: 1 }),
  );
  await mkdir(join(w.workspace, "worker"));
  const workflow = await assignProject(w.service, inserted.teamId, {
    mode: "team",
    goal: "Implement a meaningful feature",
    workspace: w.workspace,
    implementationWorkers: 1,
    fixWorkers: 1,
    isolation: "paths",
    paths: [join(w.workspace, "worker")],
  });
  assert.equal(w.store.list("pipeline").length, 1);
  assert.ok(workflow.tasks.length > 5);
  assert.ok(workflow.tasks.every((task) => task.executionMode === undefined));
  assert.ok(
    w.store.get<Workflow & { setup: WorkflowSetup }>("workflow", workflow.id)
      .setup.requiresPreflight,
  );
});

test("file-only narrowing survives delegation and disables Codex command tools without changing agent grants", async (t) => {
  const w = await fixture(t);
  const manager = await w.service.saveAgent({
    name: "Manager",
    environment: "claude",
    roleType: "coordinator",
  });
  const writer = await w.service.saveAgent({
    name: "Writer",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: w.workspace, access: "write", active: true }],
  });
  w.service.saveEdge({ from: manager.id, to: writer.id, kind: "delegate" });
  const workflow = w.service.workflow({
    name: "Simple",
    goal: "Reply",
    ownerId: manager.id,
    completionCriteria: "Done",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Reply",
    completionCriteria: "Done",
    executionMode: "file-only",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  const delegated = w.service.orchestration.invokeTeammate(
    { agentId: manager.id, taskId: parent.id },
    {
      recipient: writer.id,
      title: "Write a greeting",
      executionMode: "standard",
      resourcePaths: [w.workspace],
    },
  );
  const child = w.store.get<Task>("task", delegated.childTaskId);
  assert.equal(
    child.executionMode,
    "file-only",
    "a child cannot widen its parent's capabilities",
  );
  const plan = await w.service.launchPlan(writer.id, child.id);
  const claudeCommand = commandFor(plan, null, "Write hello.txt", w.workspace);
  assert.ok(
    !claudeCommand.args[claudeCommand.args.indexOf("--tools") + 1]
      .split(",")
      .includes("Bash"),
  );
  // A synthetic supported-host plan verifies the Codex argv contract without launching it.
  const command = commandFor(
    { ...plan, environment: "codex" },
    null,
    "Write hello.txt",
    w.workspace,
  );
  assert.ok(command.args.includes("features.shell_tool=false"));
  assert.ok(
    command.args.some((arg) =>
      arg.startsWith("permissions.agentteam-task.filesystem="),
    ),
  );
  assert.ok(plan.tools.includes("write"));
  assert.ok(!plan.tools.includes("shell"));
  assert.ok(w.store.get<Agent>("agent", writer.id).tools.includes("shell"));
  if (process.platform === "win32") {
    const unsupported = await w.service.saveAgent({
      name: "Unavailable Codex",
      environment: "codex",
      roleType: "implementer",
      workspaces: [{ path: w.workspace, access: "write", active: true }],
    });
    w.service.saveEdge({
      from: manager.id,
      to: unsupported.id,
      kind: "delegate",
    });
    const before = w.store.list("task").length;
    assert.throws(
      () =>
        w.service.orchestration.invokeTeammate(
          { agentId: manager.id, taskId: parent.id },
          {
            recipient: unsupported.id,
            title: "Write more",
            executionMode: "standard",
            resourcePaths: [w.workspace],
          },
        ),
      { code: "simple_task_unsupported" },
    );
    assert.equal(
      w.store.list("task").length,
      before,
      "explicit standard cannot bypass inherited file-only compatibility",
    );
    await w.service.saveAgent(
      {
        name: writer.name,
        environment: "codex",
        roleType: "implementer",
        workspaces: writer.workspaces,
      },
      writer.id,
    );
    await assert.rejects(w.service.launchPlan(writer.id, child.id), {
      code: "simple_task_unsupported",
    });
    assert.equal(
      w.store.list("effect").length,
      0,
      "a changed provider is refused before any execution",
    );
  }
});

test("simple mode preserves access denials, output checks and declared folder defaults", async (t) => {
  const w = await fixture(t);
  const agent = await w.service.saveAgent({
    name: "Reader",
    environment: "claude",
    roleType: "reviewer",
    workspaces: [{ path: w.workspace, access: "read", active: true }],
  });
  const workflow = await assignProject(w.service, "main", {
    mode: "simple",
    goal: "Hi",
    workspace: w.workspace,
    tasks: [
      {
        agentId: agent.id,
        title: "Say hi",
        completionChecks: [
          { type: "artifact-matches", path: "hi.txt", pattern: "hello" },
        ],
      },
    ],
  });
  const task = workflow.tasks[0];
  assert.equal(task.completionChecks?.[0].type, "artifact-matches");
  const plan = await w.service.launchPlan(agent.id, task.id);
  const command = commandFor(plan, null, "Write hello", w.workspace);
  const tools = command.args[command.args.indexOf("--tools") + 1].split(",");
  assert.ok(
    !tools.includes("Write") &&
      !tools.includes("Edit") &&
      !tools.includes("Bash"),
  );
  assert.equal(
    w.store.get<Agent>("agent", agent.id).workspaces[0].access,
    "read",
  );
  assert.equal(projectInfo(w.service, "main").defaults.workspace, w.workspace);
  assert.equal(
    (await w.service.limits.evaluate(task, "I created it", w.workspace))
      ?.passed,
    false,
  );
  const before = w.store.list("workflow").length;
  await assert.rejects(
    assignProject(w.service, "main", {
      mode: "simple",
      goal: "No",
      workspace: w.workspace,
      tasks: [{ agentId: "not-a-team-agent", title: "No" }],
    }),
    { code: "not_in_team" },
  );
  assert.equal(w.store.list("workflow").length, before);
  w.store.put("settings", {
    id: "connections",
    providers: {
      claude: { transport: "acp", executable: "fixture", args: [] },
    },
  });
  await assert.rejects(
    assignProject(w.service, "main", {
      mode: "simple",
      goal: "No",
      workspace: w.workspace,
    }),
    { code: "simple_task_unsupported" },
  );
  assert.equal(w.store.list("workflow").length, before);
  assert.equal(filesystemPolicy(w.store).blocks().length, 0);
});

test("native Windows Codex limitations are shown before a simple project or child is recorded", async (t) => {
  const w = await fixture(t);
  const agent = await w.service.saveAgent({
    name: "Codex writer",
    environment: "codex",
    roleType: "implementer",
  });
  assert.equal(
    simpleTaskSupport(w.service, agent, {
      platform: "win32",
      release: "10.0.19045",
    }).available,
    false,
  );
  assert.match(
    simpleTaskSupport(w.service, agent, {
      platform: "win32",
      release: "10.0.19045",
    }).reason!,
    /Windows 10/,
  );
  assert.equal(
    simpleTaskSupport(w.service, agent, {
      platform: "win32",
      release: "10.0.26100",
    }).available,
    false,
  );
  assert.match(
    simpleTaskSupport(w.service, agent, {
      platform: "win32",
      release: "10.0.26100",
    }).reason!,
    /not been verified/,
  );
  assert.equal(
    simpleTaskSupport(w.service, agent, { platform: "linux", release: "6.8" })
      .available,
    true,
  );
  if (process.platform !== "win32") return;
  const before = w.store.list("workflow").length;
  await assert.rejects(
    assignProject(w.service, "main", {
      mode: "simple",
      goal: "Hi",
      workspace: w.workspace,
      tasks: [{ agentId: agent.id, title: "Hi" }],
    }),
    { code: "simple_task_unsupported" },
  );
  assert.equal(w.store.list("workflow").length, before);
  assert.equal(w.store.list("task").length, 0);
  assert.equal(projectInfo(w.service, "main").agents[0].simpleAvailable, false);
  const manager = await w.service.saveAgent({
    name: "Claude manager",
    environment: "claude",
    roleType: "coordinator",
  });
  w.service.saveEdge({ from: manager.id, to: agent.id, kind: "delegate" });
  const project = await assignProject(w.service, "main", {
    mode: "simple",
    goal: "Hi",
    workspace: w.workspace,
    ownerId: manager.id,
    tasks: [{ agentId: manager.id, title: "Coordinate a greeting" }],
  });
  const parent = project.tasks[0];
  const stored = w.store.get<Workflow>("workflow", project.id);
  w.store.put("workflow", { ...stored, paused: false });
  w.service.transitionTask(parent.id, { status: "running" });
  const tasksBefore = w.store.list("task").length;
  assert.throws(
    () =>
      w.service.orchestration.invokeTeammate(
        { agentId: manager.id, taskId: parent.id },
        { recipient: agent.id, title: "Write hello" },
      ),
    { code: "simple_task_unsupported" },
  );
  assert.equal(
    w.store.list("task").length,
    tasksBefore,
    "unsupported delegation never enters recovery",
  );
});
