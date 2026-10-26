import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { assignProject } from "../src/projects.ts";
import { defaults } from "../src/discovery.ts";
import { resumeProject } from "../src/readiness.ts";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import type { Agent, Task, Workflow } from "../src/model.ts";

test("simple Start waits for selected runtime installation and sign-in, then starts the same saved project", async (t) => {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-simple-start-")),
  );
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(folder, { recursive: true, force: true });
  });
  const service = new TeamService(store, new SkillCatalog([]));
  const owner = await service.saveAgent({
    name: "Unused lead",
    environment: "codex",
  });
  const worker = await service.saveAgent({
    name: "Greeting writer",
    environment: "claude",
    model: "default",
    roleType: "implementer",
  });
  const project = await assignProject(service, "main", {
    mode: "simple",
    goal: "Hi",
    workspace: folder,
    ownerId: owner.id,
    tasks: [{ agentId: worker.id, title: "Hi" }],
  });
  const discovery = {
    settled: false,
    runtimes: structuredClone(defaults).map((runtime) => ({
      ...runtime,
      installed: true,
      authenticated: true,
    })),
  };
  await assert.rejects(resumeProject(service, discovery, project.id), {
    code: "runtime_resolving",
  });
  discovery.settled = true;
  const claude = discovery.runtimes.find((runtime) => runtime.id === "claude")!;
  claude.installed = false;
  await assert.rejects(resumeProject(service, discovery, project.id), {
    code: "runtime_unavailable",
  });
  claude.installed = true;
  claude.authenticated = false;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      resumeProject(service, discovery, project.id),
      (error) =>
        (error as { code: string }).code === "runtime_unavailable" &&
        /Greeting writer.*Sign in/.test((error as Error).message),
    );
  }
  assert.equal(store.get<Workflow>("workflow", project.id).paused, true);
  assert.equal(store.list("workflow").length, 1);
  assert.equal(store.list("effect").length, 0);
  assert.ok(store.list<Task>("task").every((task) => task.status === "queued"));
  assert.equal(service.recovery.checkpoints(project.tasks[0].id).length, 0);
  // An unused lead's sign-in does not gate direct work assigned to another agent.
  discovery.runtimes.find((runtime) => runtime.id === "codex")!.authenticated =
    false;
  claude.authenticated = true;
  const started = await resumeProject(service, discovery, project.id);
  assert.equal(started.paused, false);
  assert.equal(store.list("workflow").length, 1);
  assert.equal(store.list("task").length, 1);
});

async function fileTaskFixture(t: {
  after: (fn: () => Promise<void>) => void;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-file-start-")),
  );
  const folder = join(root, "output");
  const elsewhere = join(root, "elsewhere");
  await mkdir(folder);
  await mkdir(elsewhere);
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new TeamService(store, new SkillCatalog([]));
  const writer = await service.saveAgent({
    name: "Duty writer",
    environment: "claude",
    roleType: "implementer",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const project = await assignProject(service, "main", {
    mode: "simple",
    goal: "Write your duty file",
    workspace: folder,
    tasks: [
      {
        agentId: writer.id,
        title: "Write Duty writer.txt",
        instructions: "Write your duty file using file tools.",
        completionChecks: [
          { type: "artifact-exists", path: "Duty writer.txt" },
        ],
      },
    ],
  });
  const discovery = {
    settled: true,
    runtimes: structuredClone(defaults).map((runtime) => ({
      ...runtime,
      installed: true,
      authenticated: true,
    })),
  };
  const unchanged = () => {
    assert.equal(store.get<Workflow>("workflow", project.id).paused, true);
    assert.equal(store.list("workflow").length, 1);
    assert.equal(store.list("task").length, 1);
    assert.equal(store.get<Task>("task", project.tasks[0].id).status, "queued");
    assert.equal(store.list("effect").length, 0);
    assert.equal(service.recovery.checkpoints(project.tasks[0].id).length, 0);
  };
  return {
    root,
    folder,
    elsewhere,
    store,
    service,
    writer,
    project,
    discovery,
    unchanged,
  };
}

test("simple Start checks the selected output folder, not an unrelated writable attachment", async (t) => {
  const w = await fileTaskFixture(t);
  const configured = w.store.get<Agent>("agent", w.writer.id);
  w.store.put("agent", {
    ...configured,
    workspaces: [
      { path: w.folder, access: "read", active: false },
      { path: w.elsewhere, access: "write", active: true },
    ],
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      resumeProject(w.service, w.discovery, w.project.id),
      (error) =>
        (error as { code: string }).code === "simple_task_write_required" &&
        /Duty writer:.*task's folder/.test((error as Error).message),
    );
  w.unchanged();
  assert.equal(
    w.store.get<Agent>("agent", w.writer.id).workspaces[0].access,
    "read",
    "setup never widens an existing attachment",
  );
  w.store.put("agent", configured);
  assert.equal(
    (await resumeProject(w.service, w.discovery, w.project.id)).paused,
    false,
  );
  assert.equal(w.store.list("workflow").length, 1);
  assert.equal(w.store.list("effect").length, 0);
});

test("simple Start refuses a declared file output without write tools before an attempt starts", async (t) => {
  const w = await fileTaskFixture(t);
  const agent = w.store.get<Agent>("agent", w.writer.id);
  w.store.put("agent", {
    ...agent,
    tools: agent.tools.filter((tool) => !["write", "edit"].includes(tool)),
  });
  await assert.rejects(resumeProject(w.service, w.discovery, w.project.id), {
    code: "simple_task_write_required",
  });
  w.unchanged();
});

test("simple Start rechecks changed adapters, folder restrictions and permanent denials", async (t) => {
  for (const scenario of ["adapter", "rules", "detached", "global-denial"])
    await t.test(scenario, async (t) => {
      const w = await fileTaskFixture(t);
      const agent = w.store.get<Agent>("agent", w.writer.id);
      const expected = {
        adapter: "simple_task_unsupported",
        rules: "provider_access_unsupported",
        detached: "resource_path_detached",
        "global-denial": "filesystem_sandbox_required",
      }[scenario];
      if (scenario === "adapter")
        w.store.put("settings", {
          id: "connections",
          providers: {
            claude: { transport: "acp", executable: "fixture", args: [] },
          },
        });
      else if (scenario === "global-denial")
        filesystemPolicy(w.store).add({
          paths: [w.elsewhere],
          acknowledgePermanent: true,
        });
      else
        w.store.put("agent", {
          ...agent,
          workspaces:
            scenario === "detached"
              ? []
              : agent.workspaces.map((folder) => ({
                  ...folder,
                  rules: [{ path: "private", access: "none" }],
                })),
        });
      await assert.rejects(
        resumeProject(w.service, w.discovery, w.project.id),
        (error) =>
          (error as { code: string }).code === expected &&
          /Duty writer:.*saved and paused/.test((error as Error).message),
      );
      w.unchanged();
    });
});

test("simple Start rejects output path escapes before launching, including an existing symlink parent", async (t) => {
  for (const path of ["../outside.txt", ".git/config", "linked/duty.txt"])
    await t.test(path, async (t) => {
      const w = await fileTaskFixture(t);
      const task = w.store.get<Task>("task", w.project.tasks[0].id);
      if (path.startsWith("linked/"))
        await symlink(
          w.elsewhere,
          join(w.folder, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
      w.store.put("task", {
        ...task,
        completionChecks: [{ type: "artifact-exists", path }],
      });
      await assert.rejects(
        resumeProject(w.service, w.discovery, w.project.id),
        {
          code: path.startsWith("linked/")
            ? "artifact_path_escape"
            : "invalid_rule",
        },
      );
      w.unchanged();
    });
});
