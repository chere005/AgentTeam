import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { commandFor, RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { codexTaskPermissions } from "../src/provider-filesystem.ts";
import type { Agent } from "../src/model.ts";

async function world(t: any, environment = "codex") {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-task-fs-")),
  );
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const root = join(base, "attached"),
    a = join(root, "a"),
    b = join(root, "b"),
    other = join(base, "other");
  for (const path of [a, b, other]) await mkdir(path, { recursive: true });
  const service = new TeamService(store, new SkillCatalog([]));
  const agent = await service.saveAgent({
    name: "Builder",
    environment,
    tools: ["read", "edit", "write"],
    workspaces: [
      { path: other, access: "write", active: true },
      { path: root, access: "write" },
    ],
  });
  const workflow = service.workflow({
    name: "Project A",
    goal: "Build A",
    ownerId: agent.id,
    completionCriteria: "done",
  });
  const task = (paths: string[]) =>
    service.task({
      workflowId: workflow.id,
      agentId: agent.id,
      title: "Build",
      completionCriteria: "done",
      resourcePaths: paths,
    });
  return { base, root, a, b, other, store, service, agent, task };
}

test("task roots replace enclosing and other-project attachments, including every secondary root", async (t) => {
  const w = await world(t);
  const task = w.task([w.a, w.other]);
  const plan = await w.service.launchPlan(w.agent.id, task.id);
  assert.equal(plan.cwd, w.a);
  assert.deepEqual(plan.workspaces, [
    { path: w.a, access: "write", active: true },
    { path: w.other, access: "write", active: false },
  ]);
  assert.ok(
    !plan.workspaces.some((ws) => ws.path === w.root || ws.path === w.b),
  );
  const command = commandFor(
    plan,
    "old-session-with-broader-access",
    "build",
    w.base,
  );
  assert.ok(!command.args.includes("resume"));
  assert.ok(command.args.includes("--strict-config"));
  assert.ok(!command.args.some((s) => s.startsWith("sandbox_mode=")));
  const settings = command.args.filter((s) =>
    s.startsWith("permissions.agentteam-task.filesystem="),
  )[0];
  assert.ok(settings.includes(`${JSON.stringify(w.a)}="write"`));
  assert.ok(settings.includes(`${JSON.stringify(w.other)}="write"`));
  assert.ok(!settings.includes(`${JSON.stringify(w.root)}=`));
  assert.ok(!settings.includes('":root"'));
  assert.ok(
    command.args.includes("permissions.agentteam-task.network.enabled=false"),
  );
  assert.equal((await w.service.launchPlan(w.agent.id)).cwd, w.other);
});

test("mixed read/write roots retain exact Codex grants; Claude refuses rather than broadening them", async (t) => {
  const w = await world(t, "claude");
  const both = w.task([w.a, w.other]);
  const supported = commandFor(
    await w.service.launchPlan(w.agent.id, both.id),
    "old",
    "build",
    w.base,
  );
  assert.equal(
    supported.args[supported.args.indexOf("--add-dir") + 1],
    w.other,
  );
  assert.ok(!supported.args.includes("--resume"));
  assert.ok(supported.args.includes("--restricted"));
  const current = w.store.get<Agent>("agent", w.agent.id);
  w.store.put("agent", {
    ...current,
    workspaces: current.workspaces.map((ws) =>
      ws.path === w.other ? { ...ws, access: "read" } : ws,
    ),
  });
  const plan = await w.service.launchPlan(w.agent.id, both.id);
  assert.throws(() => commandFor(plan, null, "build", w.base), {
    code: "provider_access_unsupported",
  });
  const settings = codexTaskPermissions(plan.workspaces, plan.tools);
  assert.ok(settings[1].includes(`${JSON.stringify(w.other)}="read"`));
  assert.ok(settings[1].includes(`${JSON.stringify(w.a)}="write"`));
  assert.ok(
    codexTaskPermissions(plan.workspaces, [], "linux")[1].includes(
      '":minimal"="read"',
    ),
  );
  assert.ok(
    !codexTaskPermissions(plan.workspaces, [], "linux")[1].includes(
      JSON.stringify(w.a),
    ),
  );
});

test("launch revalidates all directories, ownership, detached attachments, rules and symlink swaps", async (t) => {
  const w = await world(t);
  const task = w.task([w.a, w.b]);
  const otherAgent = await w.service.saveAgent({
    name: "Other",
    environment: "codex",
  });
  await assert.rejects(w.service.launchPlan(otherAgent.id, task.id), {
    code: "task_agent",
  });
  const current = w.store.get<Agent>("agent", w.agent.id);
  w.store.put("agent", {
    ...current,
    workspaces: [{ path: w.other, access: "write", active: true }],
  });
  await assert.rejects(w.service.launchPlan(w.agent.id, task.id), {
    code: "resource_path_detached",
  });
  w.store.put("agent", {
    ...current,
    workspaces: current.workspaces.map((ws) =>
      ws.path === w.root
        ? { ...ws, rules: [{ path: "b/private", access: "none" }] }
        : ws,
    ),
  });
  await assert.rejects(w.service.launchPlan(w.agent.id, task.id), {
    code: "provider_access_unsupported",
  });
  w.store.put("agent", current);
  await rename(w.b, join(w.root, "original-b"));
  await symlink(
    w.other,
    w.b,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(w.service.launchPlan(w.agent.id, task.id), {
    code: "workspace_changed",
  });
  const file = join(w.a, "file.txt");
  await writeFile(file, "test");
  await assert.rejects(w.service.launchPlan(w.agent.id, w.task([file]).id), {
    code: "resource_path_not_directory",
  });
});

test("unsupported scoped providers fail before executing or leaving an uncertain provider effect", async (t) => {
  const w = await world(t, "wolfram");
  const task = w.task([w.a]);
  const plan = await w.service.launchPlan(w.agent.id, task.id);
  assert.throws(() => commandFor(plan, null, "run", w.base), {
    code: "provider_access_unsupported",
  });
  assert.throws(
    () =>
      commandFor(
        {
          ...plan,
          connection: { transport: "acp", executable: "unused", args: [] },
        },
        null,
        "run",
        w.base,
      ),
    { code: "provider_access_unsupported" },
  );
  const runs = new RunManager(w.service, true, w.base);
  let executed = false;
  const scheduler = new Scheduler(w.service, runs, async () => {
    executed = true;
  });
  w.service.transitionTask(task.id, { status: "running" });
  await scheduler.execute(task, plan, new AbortController());
  assert.equal(executed, false);
  assert.deepEqual(w.store.list("effect"), []);
  assert.equal(w.store.get<any>("task", task.id).status, "failed");
});
