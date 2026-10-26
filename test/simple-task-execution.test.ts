import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { TeamService } from "../src/service.ts";
import { SkillCatalog } from "../src/skills.ts";
import { assignProject } from "../src/projects.ts";
import { verifySampleModels } from "../src/samples.ts";
import { defaults } from "../src/discovery.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { resumeProject } from "../src/readiness.ts";
import type { Agent, Task } from "../src/model.ts";

test("fourteen compatible agents each write their own verified file without delegation edges or role changes", async (t) => {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-fourteen-writers-")),
  );
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  let scheduler: Scheduler | undefined;
  t.after(async () => {
    scheduler?.stop();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const agents: Agent[] = [];
  for (let i = 0; i < 14; i++) {
    const roleType = (
      ["coordinator", "implementer", "reviewer", "adjudicator"] as const
    )[i % 4];
    agents.push(
      await service.saveAgent({
        name: `Agent ${i + 1}`,
        environment: "claude",
        model: "default",
        roleType,
        role:
          roleType === "implementer"
            ? "Write assigned files"
            : "Read-only planning and review",
        instructions:
          roleType === "implementer"
            ? "Follow the assignment"
            : "You are read-only: never modify files.",
        tools: ["read", "write", "shell"],
        workspaces: [{ path: workspace, access: "write", active: true }],
      }),
    );
  }
  const savedAgents = JSON.stringify(store.list("agent"));
  const project = await assignProject(service, "main", {
    mode: "simple",
    goal: "Each agent identifies itself in its own file",
    workspace,
    tasks: agents.map((agent) => ({
      agentId: agent.id,
      title: `Duty file: ${agent.name}`,
      instructions: `Write ${agent.name}.txt with I am ${agent.name}, reporting for duty.`,
      completionChecks: [
        {
          type: "artifact-matches",
          path: `${agent.name}.txt`,
          pattern: `^I am ${agent.name}, reporting for duty\\.$`,
        },
      ],
    })),
  });
  const discovery = {
    settled: true,
    runtimes: structuredClone(defaults).map((runtime) => ({
      ...runtime,
      installed: true,
      authenticated: true,
    })),
  };
  await resumeProject(service, discovery, project.id);
  const runs = new RunManager(service, true, workspace);
  runs.runtimePlatform = "win32";
  runs.readiness = () => ({ state: "ready" });
  const writers: string[] = [];
  scheduler = new Scheduler(
    service,
    runs,
    async (command, environment, emit) => {
      assert.equal(environment, "claude");
      assert.equal(command.cwd, workspace);
      assert.ok(
        !command.args[command.args.indexOf("--tools") + 1]
          .split(",")
          .includes("Bash"),
      );
      const instructions =
        command.args[command.args.indexOf("--append-system-prompt") + 1];
      assert.match(instructions, /CURRENT USER ASSIGNMENT/);
      assert.match(instructions, /Do not delegate your own file/);
      const name = /^Duty file: (Agent \d+)/.exec(command.stdin)?.[1];
      assert.ok(name);
      assert.ok(!writers.includes(name), "each agent executes exactly once");
      writers.push(name);
      await writeFile(
        join(workspace, `${name}.txt`),
        `I am ${name}, reporting for duty.`,
      );
      emit({ type: "text", data: `Wrote and read ${name}.txt.` });
    },
  );
  for (let i = 0; i < 1000; i++) {
    await scheduler.tick();
    if (writers.length === 14 && !runs.active.size) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(writers.length, 14);
  for (const agent of agents)
    assert.equal(
      await readFile(join(workspace, `${agent.name}.txt`), "utf8"),
      `I am ${agent.name}, reporting for duty.`,
    );
  const tasks = store.list<Task>("task");
  assert.equal(tasks.length, 14);
  assert.ok(
    tasks.every(
      (task) =>
        task.status === "completed" &&
        !task.parentTaskId &&
        !task.dependsOn.length,
    ),
  );
  assert.equal(service.workflowStatus(project.id).status, "completed");
  assert.equal(store.list("edge").length, 0);
  assert.equal(store.list("invocation").length, 0);
  assert.equal(store.list("runtime-wait").length, 0);
  assert.equal(store.list("lease").length, 0);
  assert.equal(
    JSON.stringify(store.list("agent")),
    savedAgents,
    "task instructions never rewrite persistent roles or grants",
  );
});

test("ordinary read-only roles keep their instructions without a direct writable file assignment", async (t) => {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  t.after(() => store.close());
  const agent = await service.saveAgent({
    name: "Reviewer",
    environment: "claude",
    roleType: "reviewer",
    instructions: "You are read-only: never modify files.",
    tools: ["read"],
  });
  const plan = await service.launchPlan(agent.id);
  assert.match(plan.instructions, /You are read-only: never modify files/);
  assert.doesNotMatch(plan.instructions, /CURRENT USER ASSIGNMENT/);
  assert.deepEqual(plan.tools, ["read"]);
});

for (const wrongFirstFile of [false, true]) {
  test(
    wrongFirstFile
      ? "simple scheduler rejects wrong file content while another independent writer still completes"
      : "simple scheduler runs scoped Claude file writers on Windows without shell or checkpoint retries",
    async (t) => {
      const workspace = await realpath(
        await mkdtemp(join(tmpdir(), "agentteam-simple-run-")),
      );
      const store = new Store(":memory:");
      const service = new TeamService(store, new SkillCatalog([]));
      let scheduler: Scheduler | undefined;
      t.after(async () => {
        scheduler?.stop();
        store.close();
        await rm(workspace, { recursive: true, force: true });
      });
      const agents: Agent[] = [];
      for (const name of ["First", "Second"])
        agents.push(
          await service.saveAgent({
            name,
            environment: "claude",
            model: "sonnet",
            roleType: "implementer",
          }),
        );
      const project = await assignProject(service, "main", {
        mode: "simple",
        goal: "Write a roll-call file for each selected agent",
        workspace,
        tasks: agents.map((agent) => ({
          agentId: agent.id,
          title: `${agent.name} roll call`,
          instructions: `Write ${agent.name.toLowerCase()}.txt with exactly ${agent.name} reporting for duty.`,
          completionChecks: [
            {
              type: "artifact-matches",
              path: `${agent.name.toLowerCase()}.txt`,
              pattern: `^${agent.name} reporting for duty\\.$`,
            },
          ],
        })),
      });
      const runtimes = structuredClone(defaults).map((runtime) => ({
        ...runtime,
        installed: true,
        authenticated: true,
      }));
      assert.equal(
        verifySampleModels(service, project.id, runtimes).verified,
        true,
      );
      service.pauseWorkflow(project.id, false);
      const runs = new RunManager(service, true, workspace);
      runs.runtimePlatform = "win32";
      runs.readiness = () => ({ state: "ready" });
      let providerCalls = 0;
      let writing = false;
      scheduler = new Scheduler(
        service,
        runs,
        async (command, environment, emit) => {
          providerCalls++;
          assert.equal(environment, "claude");
          assert.equal(command.cwd, workspace);
          const tools =
            command.args[command.args.indexOf("--tools") + 1].split(",");
          assert.ok(tools.includes("Write"));
          assert.ok(
            !tools.includes("Bash"),
            "the permanent shell grant is narrowed for this run",
          );
          assert.equal(
            writing,
            false,
            "normal file leases serialize the shared folder",
          );
          writing = true;
          const first = command.stdin.startsWith("First roll call");
          const name = first ? "First" : "Second";
          await writeFile(
            join(workspace, `${name.toLowerCase()}.txt`),
            wrongFirstFile && first
              ? "wrong identity"
              : `${name} reporting for duty.`,
          );
          writing = false;
          emit({ type: "text", data: `Created ${name.toLowerCase()}.txt.` });
        },
      );
      for (let i = 0; i < 500; i++) {
        await scheduler.tick();
        const tasks = store
          .list<Task>("task")
          .filter((task) => task.workflowId === project.id);
        if (
          tasks.every((task) =>
            ["completed", "failed"].includes(task.status),
          ) &&
          !runs.active.size
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const tasks = project.tasks.map((task) =>
        store.get<Task>("task", task.id),
      );
      assert.equal(providerCalls, 2, "one provider turn per assignment");
      assert.equal(tasks[0].status, wrongFirstFile ? "failed" : "completed");
      assert.equal(tasks[1].status, "completed");
      assert.ok(tasks.every((task) => !task.dependsOn.length));
      assert.equal(
        await readFile(join(workspace, "second.txt"), "utf8"),
        "Second reporting for duty.",
      );
      assert.equal(
        service.workflowStatus(project.id).status,
        wrongFirstFile ? "needs-attention" : "completed",
      );
      assert.equal(store.list("runtime-wait").length, 0);
      assert.equal(store.list("lease").length, 0);
      assert.ok(
        tasks.every((task) => service.recovery.state(task.id).attempt === 1),
      );
      assert.ok(
        agents.every((agent) =>
          store.get<Agent>("agent", agent.id).tools.includes("shell"),
        ),
        "permanent tools stay unchanged",
      );
      if (wrongFirstFile) assert.match(tasks[0].result ?? "", /does not match/);
    },
  );
}
