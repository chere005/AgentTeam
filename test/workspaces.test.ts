import { test } from "node:test";
import "./fixtures/git-config.ts";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorkspaceService, parseStatus } from "../src/workspaces.ts";
async function fixture(t: any) {
  const base = await realpath(
      await mkdtemp(join(tmpdir(), "agentteam-files-")),
    ),
    root = join(base, "project");
  await mkdir(root);
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  const agent = await team.saveAgent({
    name: "Builder",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, store, team, agent, ws: new WorkspaceService(store) };
}
test("file previews are bounded; binary files are identified", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await writeFile(join(root, "file.txt"), "hello");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "big.txt"), "a".repeat(300000));
  assert.equal(
    (await ws.preview(agent.id, { workspace: root, path: "file.txt" })).content,
    "hello",
  );
  assert.equal(
    (await ws.preview(agent.id, { workspace: root, path: "binary.bin" }))
      .binary,
    true,
  );
  assert.equal(
    (await ws.preview(agent.id, { workspace: root, path: "big.txt" }))
      .truncated,
    true,
  );
  assert.equal(
    (await ws.browse(agent.id, { workspace: root })).entries.length,
    3,
  );
});
test("in-app text editing checks folder access and refuses stale saves", async (t) => {
  const { root, team, agent, ws } = await fixture(t);
  const path = join(root, "readme.md");
  await writeFile(path, "# Original\n");
  const opened = await ws.readText(agent.id, {
    workspace: root,
    path: "readme.md",
  });
  assert.equal(opened.content, "# Original\n");
  const saved = await ws.saveText(agent.id, {
    workspace: root,
    path: "readme.md",
    content: "# Updated\n",
    expectedHash: opened.hash,
  });
  assert.equal(
    (await ws.readText(agent.id, { workspace: root, path: "readme.md" }))
      .content,
    "# Updated\n",
  );
  await writeFile(path, "# External edit\n");
  await assert.rejects(
    ws.saveText(agent.id, {
      workspace: root,
      path: "readme.md",
      content: "# Overwrite\n",
      expectedHash: saved.hash,
    }),
    /changed since it was opened/i,
  );
  const reader = await team.saveAgent({
    name: "Reader",
    environment: "codex",
    workspaces: [{ path: root, access: "read", active: true }],
  });
  const readOnly = await ws.readText(reader.id, {
    workspace: root,
    path: "readme.md",
  });
  assert.equal(readOnly.access, "read");
  await assert.rejects(
    ws.saveText(reader.id, {
      workspace: root,
      path: "readme.md",
      content: "no write",
      expectedHash: readOnly.hash,
    }),
    /read.only/i,
  );
});
test("new text files can be created only in writable workspace paths", async (t) => {
  const { root, team, agent, ws } = await fixture(t);
  await mkdir(join(root, "src"));
  const created = await ws.createText(agent.id, {
    workspace: root,
    path: "src/hello.ts",
    content: "export const hello = 'world';\n",
  });
  assert.equal(created.path, "src/hello.ts");
  assert.equal(
    (await ws.readText(agent.id, { workspace: root, path: created.path }))
      .content,
    "export const hello = 'world';\n",
  );
  await assert.rejects(
    ws.createText(agent.id, {
      workspace: root,
      path: "src/hello.ts",
      content: "overwrite",
    }),
    /already exists/i,
  );
  await assert.rejects(
    ws.createText(agent.id, {
      workspace: root,
      path: "../outside.ts",
      content: "no",
    }),
    /escapes/i,
  );
  const reader = await team.saveAgent({
    name: "Reader",
    environment: "codex",
    workspaces: [{ path: root, access: "read" }],
  });
  await assert.rejects(
    ws.createText(reader.id, {
      workspace: root,
      path: "nope.txt",
      content: "no",
    }),
    /read.only/i,
  );
});
test("paths cannot escape through traversal, symlinks or Git internals", async (t) => {
  const { base, root, agent, ws } = await fixture(t);
  await writeFile(join(base, "secret"), "outside");
  await symlink(join(base, "secret"), join(root, "link"));
  await mkdir(join(root, ".git"));
  await assert.rejects(
    ws.preview(agent.id, { workspace: root, path: "../secret" }),
    /escapes/,
  );
  await assert.rejects(
    ws.preview(agent.id, { workspace: root, path: "link" }),
    /escapes/,
  );
  await assert.rejects(
    ws.browse(agent.id, { workspace: root, path: ".git" }),
    /Git internals/,
  );
});
test("Sublime defaults and directory launch plans do not execute applications", async (t) => {
  const { root, agent, ws } = await fixture(t);
  assert.equal(ws.settings().defaultEditor, "sublime");
  if (process.platform === "darwin") {
    const plan = await ws.openExternal(agent.id, { workspace: root });
    assert.deepEqual(plan.args, ["-a", "Sublime Text", "--", root]);
    assert.equal(plan.executed, false);
  }
  ws.setEditor({ defaultEditor: "vscode" });
  assert.equal(ws.settings().defaultEditor, "vscode");
});
test("Git status, diffs, staging and commit work in an isolated fixture", async (t) => {
  const { root, agent, ws } = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "AgentTeam Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "hello.txt"), "hello\n");
  const status = await ws.gitInfo(agent.id, { workspace: root });
  assert.equal(status.status[0].path, "hello.txt");
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: ["hello.txt"],
  });
  assert.match(
    (await ws.diff(agent.id, { workspace: root, staged: true })).diff,
    /hello/,
  );
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "commit",
    message: "Initial fixture",
  });
  await writeFile(join(root, "hello.txt"), "changed\n");
  assert.match(
    (await ws.diff(agent.id, { workspace: root, path: "hello.txt" })).diff,
    /changed/,
  );
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: ["hello.txt"],
  });
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "unstage",
    paths: ["hello.txt"],
  });
  assert.equal(
    (await ws.diff(agent.id, { workspace: root, staged: true })).diff,
    "",
  );
});
test("plain folders reject Git operations but still expose pending changes", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await assert.rejects(ws.gitInfo(agent.id, { workspace: root }), {
    code: "not_git_repository",
    message:
      "This folder is not inside a Git repository. Choose a repository folder or initialize Git from the Git view.",
  });
  const review = await ws.review(agent.id, { workspace: root });
  assert.equal(review.source, "folder");
  assert.equal(review.branch, "Folder baseline");
  await writeFile(join(root, "draft.txt"), "pending\n");
  await writeFile(join(root, "second.txt"), "also pending\n");
  const changed = await ws.review(agent.id, { workspace: root });
  assert.deepEqual(
    changed.files.map((file) => file.path),
    ["draft.txt", "second.txt"],
  );
  const fileDiff = await ws.review(agent.id, {
    workspace: root,
    path: "draft.txt",
  });
  assert.deepEqual(
    fileDiff.files.map((file) => file.path),
    ["draft.txt", "second.txt"],
  );
  assert.match(fileDiff.diff, /pending/);
});
test("read-only workspaces cannot stage files", async (t) => {
  const { root, team, ws } = await fixture(t);
  const reader = await team.saveAgent({
    name: "Reader",
    environment: "claude",
    workspaces: [{ path: root, access: "read" }],
  });
  await assert.rejects(
    ws.mutateGit(reader.id, {
      workspace: root,
      action: "stage",
      paths: ["anything"],
    }),
    /read-only/,
  );
});
test("Git porcelain parser preserves spaces, newlines and rename origins", () => {
  assert.deepEqual(parseStatus("R  new name\0old name\0?? new\nfile\0"), [
    { status: "R ", path: "new name", from: "old name" },
    { status: "??", path: "new\nfile" },
  ]);
});

test("review separates staged changes, includes untracked previews and deleted directories", async (t) => {
  const { root, agent, ws } = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await mkdir(join(root, "old"));
  await writeFile(join(root, "old", "gone.txt"), "original\n");
  await writeFile(join(root, "both.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  await rm(join(root, "old"), { recursive: true });
  await writeFile(join(root, "both.txt"), "staged\n");
  git("add", "both.txt");
  await writeFile(join(root, "both.txt"), "unstaged\n");
  await writeFile(join(root, "new.txt"), "new content\n");
  assert.match(
    (await ws.review(agent.id, { workspace: root, path: "old/gone.txt" })).diff,
    /-original/,
  );
  assert.match(
    (
      await ws.review(agent.id, {
        workspace: root,
        path: "both.txt",
        staged: true,
      })
    ).diff,
    /\+staged/,
  );
  assert.match(
    (await ws.review(agent.id, { workspace: root, path: "both.txt" })).diff,
    /\+unstaged/,
  );
  assert.match(
    (await ws.review(agent.id, { workspace: root, path: "new.txt" })).diff,
    /\+new content/,
  );
  await assert.rejects(
    ws.review(agent.id, { workspace: root, path: "../outside" }),
    /no longer/,
  );
});

test("development worktrees attach a fresh branch without copying dirty files", async (t) => {
  const { root, agent, team } = await fixture(t);
  const { DevelopmentService } = await import("../src/development.ts");
  const development = new DevelopmentService(team);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "file.txt"), "committed\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  await writeFile(join(root, "file.txt"), "dirty\n");
  const result = await development.worktree(agent.id, {
    workspace: root,
    branch: "agentteam/test",
  });
  assert.equal(result.agent.workspaces.length, 1);
  assert.equal(result.agent.workspaces[0].path, result.path);
  assert.equal(result.agent.workspaces[0].active, true);
  assert.equal(
    execFileSync("git", ["-C", result.path, "branch", "--show-current"], {
      encoding: "utf8",
    }).trim(),
    "agentteam/test",
  );
  assert.equal(
    (
      await new WorkspaceService(team.store).preview(agent.id, {
        workspace: result.path,
        path: "file.txt",
      })
    ).content,
    "committed\n",
  );
});

test("inline feedback rejects stale snapshots and delivers only once", async (t) => {
  const { root, agent, team, store, ws } = await fixture(t);
  const { DevelopmentService } = await import("../src/development.ts");
  const { createHash, randomUUID } = await import("node:crypto");
  const development = new DevelopmentService(team);
  execFileSync("git", ["-C", root, "init", "-q"]);
  await writeFile(join(root, "new.txt"), "review this\n");
  const review = await ws.review(agent.id, {
    workspace: root,
    path: "new.txt",
  });
  const request = {
    workspace: root,
    path: "new.txt",
    staged: false,
    targetId: agent.id,
    text: "Improve this line",
    row: 1,
    diffHash: createHash("sha256").update(review.diff).digest("hex"),
    requestId: randomUUID(),
  };
  await development.feedback(agent.id, request);
  await development.feedback(agent.id, request);
  assert.equal(store.list("review-feedback").length, 1);
  assert.equal(store.list("message").length, 1);
  assert.match(store.list<any>("message")[0].text, /new line 1/);
  await writeFile(join(root, "new.txt"), "changed\n");
  await assert.rejects(
    development.feedback(agent.id, { ...request, requestId: randomUUID() }),
    /diff changed/,
  );
});
