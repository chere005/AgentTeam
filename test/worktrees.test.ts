import { test } from "node:test";
import "./fixtures/git-config.ts";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorktreeService, splitArgs } from "../src/worktrees.ts";

async function fixture(t: any, commit = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-wt-")));
  const root = join(base, "project");
  await mkdir(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  if (commit) {
    await writeFile(join(root, "file.txt"), "committed\n");
    git("add", ".");
    git("commit", "-qm", "Initial");
  }
  const store = new Store(":memory:");
  const team = new TeamService(store, new SkillCatalog([]));
  const agent = await team.saveAgent({
    name: "Builder",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const wt = new WorktreeService(team);
  t.after(async () => {
    await wt.close();
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, git, store, team, agent, wt };
}
const codeOf = (code: string) => (e: any) => e.code === code;

test("create generates unique branch and directory, attaches, and records ownership", async (t) => {
  const { root, agent, wt, git, team } = await fixture(t);
  const a = await wt.create(agent.id, { workspace: root });
  assert.match(a.branch, /^agentteam\/builder-/);
  assert.match(a.path, /AgentTeam-worktrees/);
  const agentNow = team.store.get<any>("agent", agent.id);
  assert.deepEqual(
    agentNow.workspaces.map((w: any) => [w.path, w.active]),
    [[a.path, true]],
  );
  assert.equal(a.worktree?.status, "attached");
  assert.equal(a.base, git("rev-parse", "HEAD").trim());
  // Second creation from the same source (source now detached; reattach by keepSource) is unique.
  const other = await team.saveAgent({
    name: "Second",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const b = await wt.create(other.id, { workspace: root, keepSource: true });
  assert.notEqual(a.branch, b.branch);
  assert.notEqual(a.path, b.path);
  const second = team.store.get<any>("agent", other.id);
  assert.equal(second.workspaces.length, 2);
  assert.equal(
    second.workspaces.find((w: any) => w.path === root).active,
    false,
  );
  assert.equal(
    second.workspaces.find((w: any) => w.path === b.path).active,
    true,
  );
});

test("manual branch, directory and base overrides", async (t) => {
  const { root, base, agent, wt, git } = await fixture(t);
  await writeFile(join(root, "file.txt"), "second\n");
  git("commit", "-qam", "Second");
  const first = git("rev-parse", "HEAD~1").trim();
  const dir = join(base, "custom", "my-tree");
  const r = await wt.create(agent.id, {
    workspace: root,
    branch: "feature/custom",
    base: first,
    directory: dir,
  });
  assert.equal(r.path, join(await realpath(join(base, "custom")), "my-tree"));
  assert.equal(r.base, first);
  assert.equal(await readFile(join(r.path, "file.txt"), "utf8"), "committed\n");
});

test("validation: branch names, revisions, duplicates, directories, no commits", async (t) => {
  const { root, base, agent, wt } = await fixture(t);
  const bad = (input: any, code: string) =>
    assert.rejects(
      wt.create(agent.id, { workspace: root, ...input }),
      codeOf(code),
    );
  await bad({ branch: "bad name" }, "invalid_branch");
  await bad({ branch: "a..b" }, "invalid_branch");
  await bad({ branch: "-x" }, "invalid_branch");
  await bad({ branch: "ok", base: "no-such-rev" }, "missing_revision");
  await bad({ branch: "ok", base: "--upload-pack=x" }, "missing_revision");
  await bad(
    { branch: "master-or-main", directory: "relative/dir" },
    "invalid_directory",
  );
  await bad(
    { branch: "inside", directory: join(root, "nested") },
    "invalid_directory",
  );
  const existing = join(base, "exists");
  await mkdir(existing);
  await bad({ branch: "dir-taken", directory: existing }, "directory_exists");
  const current = execFileSync(
    "git",
    ["-C", root, "branch", "--show-current"],
    {
      encoding: "utf8",
    },
  ).trim();
  await bad({ branch: current }, "branch_exists");
  await wt.create(agent.id, { workspace: root, branch: "dup", attach: false });
  await bad({ branch: "dup" }, "branch_exists");
  // Nothing partial was left behind by the failures.
  assert.equal(
    execFileSync("git", ["-C", root, "worktree", "list"], { encoding: "utf8" })
      .trim()
      .split("\n").length,
    2,
  );
  const empty = await fixture(t, false);
  await assert.rejects(
    empty.wt.create(empty.agent.id, { workspace: empty.root }),
    codeOf("no_commits"),
  );
  assert.equal(
    (await empty.wt.suggest(empty.agent.id, { workspace: empty.root }))
      .hasCommits,
    false,
  );
});

test("validation: unwritable destination reports permission_denied", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0)
    return t.skip("needs POSIX non-root");
  const { root, base, agent, wt } = await fixture(t);
  const locked = join(base, "locked");
  await mkdir(locked);
  await chmod(locked, 0o555);
  t.after(() => chmod(locked, 0o755).catch(() => {}));
  await assert.rejects(
    wt.create(agent.id, {
      workspace: root,
      branch: "perm",
      directory: join(locked, "tree"),
    }),
    codeOf("permission_denied"),
  );
});

test("concurrent creation in one repository is serialized and loses nothing", async (t) => {
  const { root, agent, wt, team } = await fixture(t);
  const agents = [agent];
  for (let i = 0; i < 4; i++)
    agents.push(
      await team.saveAgent({
        name: "Worker " + i,
        environment: "codex",
        workspaces: [{ path: root, access: "write", active: true }],
      }),
    );
  const results = await Promise.all(
    agents.map((a) => wt.create(a.id, { workspace: root })),
  );
  assert.equal(new Set(results.map((r) => r.branch)).size, 5);
  assert.equal(new Set(results.map((r) => r.path)).size, 5);
  const listed = execFileSync(
    "git",
    ["-C", root, "worktree", "list", "--porcelain"],
    {
      encoding: "utf8",
    },
  );
  for (const r of results) assert.ok(listed.includes(r.branch));
  // The same explicit branch requested concurrently: exactly one winner, clean errors for the rest.
  const fresh = [];
  for (let i = 0; i < 4; i++)
    fresh.push(
      await team.saveAgent({
        name: "Racer " + i,
        environment: "codex",
        workspaces: [{ path: root, access: "write", active: true }],
      }),
    );
  const same = await Promise.allSettled(
    fresh.map((a) =>
      wt.create(a.id, {
        workspace: root,
        branch: "contended",
        attach: false,
        keepSource: true,
      }),
    ),
  );
  assert.equal(same.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of same.filter((x) => x.status === "rejected"))
    assert.equal((r as PromiseRejectedResult).reason.code, "branch_exists");
});

test("a created worktree is preserved when attach fails and can be attached later", async (t) => {
  const { root, agent, wt, team, store } = await fixture(t);
  const save = team.saveAgent.bind(team);
  team.saveAgent = (async () => {
    throw new Error("simulated attach failure");
  }) as any;
  let message = "";
  await assert.rejects(
    wt.create(agent.id, { workspace: root, branch: "recover" }),
    (e: any) => {
      message = e.message;
      return e.code === "worktree_attach_failed";
    },
  );
  team.saveAgent = save;
  assert.match(message, /preserved/);
  const [rec] = store.list<any>("worktree");
  assert.equal(rec.status, "unattached");
  assert.match(rec.attachError, /simulated/);
  assert.ok((await stat(rec.path)).isDirectory());
  const list = await wt.list(agent.id, { workspace: root });
  assert.ok(list.worktrees.some((w) => w.path === rec.path && w.managed));
  const r = await wt.attach(agent.id, { worktreeId: rec.id });
  assert.equal(r.agent.workspaces.find((w) => w.active)?.path, rec.path);
  assert.equal(store.get<any>("worktree", rec.id).status, "attached");
});

test("never switches folders under an active run", async (t) => {
  const { root, agent, wt, store } = await fixture(t);
  store.put("session", {
    id: "s1",
    agentId: agent.id,
    providerSessionId: null,
    state: "running",
  });
  await assert.rejects(
    wt.create(agent.id, { workspace: root }),
    codeOf("agent_busy"),
  );
  // Creating without attaching is allowed and leaves the agent untouched.
  const r = await wt.create(agent.id, { workspace: root, attach: false });
  assert.equal(store.get<any>("agent", agent.id).workspaces[0].path, root);
  await assert.rejects(
    wt.attach(agent.id, { worktreeId: r.worktree!.id }),
    codeOf("agent_busy"),
  );
});

test("an interrupted task pins the agent's folder until it is resumed or cancelled", async (t) => {
  const { root, agent, wt, store } = await fixture(t);
  store.put("task", {
    id: "t1",
    workflowId: "w1",
    agentId: agent.id,
    title: "Paused work",
    instructions: "",
    completionCriteria: "",
    dependsOn: [],
    status: "interrupted",
  });
  await assert.rejects(
    wt.create(agent.id, { workspace: root }),
    (e: any) => e.code === "agent_busy" && /Resume or cancel/.test(e.message),
  );
  store.put("task", { ...store.get<any>("task", "t1"), status: "cancelled" });
  const ok = await wt.create(agent.id, { workspace: root });
  assert.equal(ok.worktree?.status, "attached");
});

test("setup command runs only when asked, without a shell unless chosen, with logs and retry", async (t) => {
  const { root, agent, wt } = await fixture(t);
  const node = process.execPath;
  const idle = await wt.create(agent.id, {
    workspace: root,
    branch: "setup-pending",
    keepSource: true,
    setup: { command: `"${node}" -e "process.exit(0)"` },
  });
  assert.equal(idle.worktree?.setup?.state, "pending");
  assert.equal(idle.worktree?.setup?.attempts, 0);
  // Not a shell: metacharacters are plain arguments.
  const injected = join(idle.path, "pwned");
  const r1 = wt.runSetup(agent.id, idle.worktree!.id, {
    command: `"${node}" -e "console.log(process.argv.slice(1).join('|'))" ; touch ${injected}`,
  });
  await r1.done;
  const afterNoShell = wt.team.store.get<any>(
    "worktree",
    idle.worktree!.id,
  ).setup;
  assert.equal(afterNoShell.state, "succeeded");
  assert.match(afterNoShell.log, /;\|touch/);
  await assert.rejects(stat(injected));
  // Failure then retry.
  const fail = wt.runSetup(agent.id, idle.worktree!.id, {
    command: `"${node}" -e "console.error('boom');process.exit(3)"`,
  });
  await fail.done;
  const failed = wt.team.store.get<any>("worktree", idle.worktree!.id).setup;
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 3);
  assert.match(failed.log, /boom/);
  const retry = wt.runSetup(agent.id, idle.worktree!.id);
  await retry.done;
  const again = wt.team.store.get<any>("worktree", idle.worktree!.id).setup;
  assert.equal(again.attempts, 3);
  assert.equal(again.exitCode, 3);
  // Missing executable is a recorded failure, not a crash.
  const missing = wt.runSetup(agent.id, idle.worktree!.id, {
    command: "definitely-not-a-command-xyz",
  });
  await missing.done;
  assert.equal(
    wt.team.store.get<any>("worktree", idle.worktree!.id).setup.state,
    "failed",
  );
  // Explicit shell mode.
  const sh = wt.runSetup(agent.id, idle.worktree!.id, {
    command:
      process.platform === "win32"
        ? "echo shell-ok"
        : "echo shell-ok && echo again",
    shell: true,
  });
  await sh.done;
  assert.match(
    wt.team.store.get<any>("worktree", idle.worktree!.id).setup.log,
    /shell-ok/,
  );
  assert.deepEqual(splitArgs(`a "b c" 'd e' f`), ["a", "b c", "d e", "f"]);
});

test("run:true executes the setup command after creation", async (t) => {
  const { root, agent, wt } = await fixture(t);
  const r = await wt.create(agent.id, {
    workspace: root,
    setup: {
      command: `"${process.execPath}" -e "require('fs').writeFileSync('setup.txt','ran')"`,
      run: true,
    },
  });
  await wt.running.get(r.worktree!.id)?.done;
  assert.equal(await readFile(join(r.path, "setup.txt"), "utf8"), "ran");
});

test("auto-create setting isolates coding work, never runs setup silently", async (t) => {
  const { root, agent, wt, team } = await fixture(t);
  assert.equal(await wt.autoForTask(agent.id), null);
  wt.saveSettings({
    autoCreate: true,
    setup: {
      command: `"${process.execPath}" -e "process.exit(0)"`,
      shell: false,
    },
  });
  const auto = await wt.autoForTask(agent.id);
  assert.equal(auto?.ok, true);
  const now = team.store.get<any>("agent", agent.id);
  assert.match(
    now.workspaces.find((w: any) => w.active).path,
    /AgentTeam-worktrees/,
  );
  const rec = team.store.list<any>("worktree")[0];
  assert.equal(rec.setup.state, "pending");
  // Already isolated: no second worktree.
  assert.equal(await wt.autoForTask(agent.id), null);
  assert.equal(team.store.list<any>("worktree").length, 1);
  // Per-project override turns it off again.
  const other = await team.saveAgent({
    name: "Other",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  wt.saveSettings({
    ...wt.settings(),
    projects: { [root]: { autoCreate: false } },
  });
  assert.equal(await wt.autoForTask(other.id), null);
});

test("list shows ownership, branch, base, active tasks and changed files", async (t) => {
  const { root, agent, wt, team } = await fixture(t);
  const r = await wt.create(agent.id, {
    workspace: root,
    branch: "inspect",
    keepSource: true,
  });
  await writeFile(join(r.path, "file.txt"), "dirty\n");
  await writeFile(join(r.path, "new.txt"), "x\n");
  const workflow = team.workflow({
    name: "W",
    goal: "g",
    ownerId: agent.id,
    completionCriteria: "c",
  });
  team.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Do it",
    completionCriteria: "done",
  } as any);
  const { worktrees } = await wt.list(agent.id, { workspace: root });
  const info = worktrees.find((w) => w.path === r.path)!;
  assert.equal(info.branch, "inspect");
  assert.equal(info.base, r.base);
  assert.equal(info.managed, true);
  assert.equal(info.owners[0].name, "Builder");
  assert.equal(info.tasks.length, 1);
  assert.equal(info.changes?.changed, 1);
  assert.equal(info.changes?.untracked, 1);
  assert.equal(worktrees[0].main, true);
});

test("remove refuses dirty trees and active work; archive preserves; clean remove works", async (t) => {
  const { root, agent, wt, team, store } = await fixture(t);
  const r = await wt.create(agent.id, {
    workspace: root,
    branch: "to-remove",
    keepSource: true,
  });
  await writeFile(join(r.path, "wip.txt"), "uncommitted\n");
  const req = { workspace: root, path: r.path, mode: "remove" as const };
  await assert.rejects(
    wt.remove(agent.id, { ...req, acknowledgeUsers: true }),
    codeOf("worktree_dirty"),
  );
  assert.equal(
    await readFile(join(r.path, "wip.txt"), "utf8"),
    "uncommitted\n",
  );
  // Active users must be acknowledged.
  await rm(join(r.path, "wip.txt"));
  await assert.rejects(wt.remove(agent.id, req), codeOf("worktree_in_use"));
  store.put("session", {
    id: "s1",
    agentId: agent.id,
    providerSessionId: null,
    state: "running",
  });
  await assert.rejects(
    wt.remove(agent.id, { ...req, acknowledgeUsers: true }),
    codeOf("worktree_active"),
  );
  store.put("session", {
    id: "s1",
    agentId: agent.id,
    providerSessionId: null,
    state: "idle",
  });
  // Archive keeps the directory, dirty files and branch, and detaches the agent.
  await writeFile(join(r.path, "wip.txt"), "keep me\n");
  const archived = await wt.remove(agent.id, {
    ...req,
    mode: "archive",
    acknowledgeUsers: true,
  });
  assert.deepEqual(archived.detached, [agent.id]);
  assert.equal(await readFile(join(r.path, "wip.txt"), "utf8"), "keep me\n");
  const after = team.store.get<any>("agent", agent.id);
  assert.equal(
    after.workspaces.some((w: any) => w.path === r.path),
    false,
  );
  assert.equal(after.workspaces.find((w: any) => w.path === root).active, true);
  assert.equal(store.list<any>("worktree")[0].status, "archived");
  // Clean worktrees can be removed; the branch is kept unless asked (and merged).
  const c = await wt.create(agent.id, {
    workspace: root,
    branch: "clean",
    attach: false,
  });
  const removed = await wt.remove(agent.id, {
    workspace: root,
    path: c.path,
    mode: "remove",
    deleteBranch: true,
  });
  await assert.rejects(stat(c.path));
  assert.equal(removed.branchDeleted, true);
  await assert.rejects(
    wt.remove(agent.id, { workspace: root, path: root, mode: "remove" }),
    codeOf("main_worktree"),
  );
  await assert.rejects(
    wt.remove(agent.id, { workspace: root, path: "/", mode: "archive" }),
    codeOf("worktree_unknown"),
  );
});

test("worktrees of another agent's repository are not reachable", async (t) => {
  const { agent, wt, base } = await fixture(t);
  await assert.rejects(
    wt.list(agent.id, { workspace: join(base, "elsewhere") }),
    codeOf("workspace_denied"),
  );
});

test("worktree routes require the bearer token and enforce validation", async (t) => {
  const { createApi } = await import("../src/http.ts");
  const { RunManager } = await import("../src/runtime.ts");
  const { root, agent, team } = await fixture(t);
  const server = createApi(
    team,
    "tok",
    new RunManager(team, false, process.cwd()),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  const call = (path: string, body: unknown, token = "tok", method = "POST") =>
    fetch(url + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
  const route = `/agents/${agent.id}/worktrees/`;
  assert.equal(
    (await call(route + "list", { workspace: root }, "wrong")).status,
    401,
  );
  assert.equal(
    (await call(route + "create", { workspace: root, branch: "bad name" }))
      .status,
    400,
  );
  const made = await call(route + "create", {
    workspace: root,
    branch: "via-api",
    keepSource: true,
  });
  assert.equal(made.status, 201);
  const list = await (await call(route + "list", { workspace: root })).json();
  assert.ok(list.worktrees.some((w: any) => w.branch === "via-api"));
  assert.equal(
    (await call(route + "create", { workspace: root, branch: "via-api" }))
      .status,
    409,
  );
  const put = await call(
    "/worktrees/settings",
    { autoCreate: true },
    "tok",
    "PUT",
  );
  assert.equal((await put.json()).autoCreate, true);
  assert.equal(
    (await call("/worktrees/settings", {}, "wrong", "GET")).status,
    401,
  );
});
