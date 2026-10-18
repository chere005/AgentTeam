import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  chmod,
  access,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import { GitWorkflow } from "../src/git-workflow.ts";

process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL =
  "test@example.invalid";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const codeOf = (code: string) => (e: any) => e.code === code;
const w = (workspace: string) => ({ workspace });

/** main and feature diverge: a.txt (clean) and f.txt (conflicting) change on both. */
async function repo(t: any, opts: { conflict?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-gi-")));
  const root = join(base, "project");
  await mkdir(root);
  sh(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "f.txt"), "base\n");
  await writeFile(join(root, "a.txt"), "a\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "base");
  sh(root, "checkout", "-qb", "feature");
  await writeFile(join(root, "f.txt"), "base\nfeature side\n");
  sh(root, "commit", "-qam", "feature change");
  sh(root, "checkout", "-q", "main");
  if (opts.conflict) await writeFile(join(root, "f.txt"), "base\nmain side\n");
  else await writeFile(join(root, "a.txt"), "a\nmain\n");
  sh(root, "commit", "-qam", "main change");
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    ws = new WorkspaceService(store);
  const agent = await team.saveAgent({
    name: "Builder",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const gw = new GitWorkflow(store, ws, { openUrl: async () => {} });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, agent, gw, store };
}

test("merge and rebase need explicit confirmation, a clean tree and a real other branch", async (t) => {
  const { root, agent, gw } = await repo(t);
  await assert.rejects(
    gw.integrate(agent.id, { ...w(root), mode: "merge", source: "feature" }),
    codeOf("mode_confirmation_required"),
  );
  const head = sh(root, "rev-parse", "HEAD");
  const go = (extra: object) =>
    gw.integrate(agent.id, {
      ...w(root),
      mode: "merge",
      source: "feature",
      confirmMode: true,
      ...extra,
    });
  await assert.rejects(go({ source: "nope" }), codeOf("branch_not_found"));
  await assert.rejects(go({ source: "main" }), codeOf("same_branch"));
  await assert.rejects(
    go({ source: "--upload-pack=x" }),
    (e: any) => e.name === "ZodError",
  );
  await assert.rejects(go({ force: true }), (e: any) => e.name === "ZodError");
  await writeFile(join(root, "a.txt"), "dirty\n");
  await assert.rejects(go({}), codeOf("dirty_tree"));
  sh(root, "checkout", "--", "a.txt");
  assert.equal(sh(root, "rev-parse", "HEAD"), head, "nothing changed");
});

test("a clean merge creates a merge commit; hooks never run", async (t) => {
  const { root, agent, gw } = await repo(t);
  for (const hook of ["pre-merge-commit", "post-merge", "commit-msg"]) {
    const p = join(root, ".git", "hooks", hook);
    await writeFile(p, `#!/bin/sh\ntouch "${join(root, "HOOK-RAN")}"\n`);
    await chmod(p, 0o755);
  }
  const r = await gw.integrate(agent.id, {
    ...w(root),
    mode: "merge",
    source: "feature",
    confirmMode: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.summary, /Merged feature into main/);
  assert.equal(
    sh(root, "rev-list", "--parents", "-1", "HEAD").split(" ").length,
    3,
  );
  await assert.rejects(access(join(root, "HOOK-RAN")));
  const again = await gw.integrate(agent.id, {
    ...w(root),
    mode: "merge",
    source: "feature",
    confirmMode: true,
  });
  assert.match(again.summary, /Already up to date/);
});

test("a conflicting merge is reported in-band, feeds the conflict workflow, and can be aborted", async (t) => {
  const { root, agent, gw } = await repo(t, { conflict: true });
  const head = sh(root, "rev-parse", "HEAD");
  const r = await gw.integrate(agent.id, {
    ...w(root),
    mode: "merge",
    source: "feature",
    confirmMode: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.failure!.kind, "conflict");
  assert.equal((r.conflicts as any).operation, "merge");
  assert.deepEqual(
    (r.conflicts as any).files.map((f: any) => f.path),
    ["f.txt"],
  );
  assert.equal((await gw.state(agent.id, w(root))).operation, "merge");
  // A second integration cannot start on top of the first.
  await assert.rejects(
    gw.integrate(agent.id, {
      ...w(root),
      mode: "rebase",
      source: "feature",
      confirmMode: true,
    }),
    codeOf("operation_in_progress"),
  );
  const aborted = await gw.abort(agent.id, { ...w(root), confirm: true });
  assert.equal(aborted.ok, true);
  assert.equal(sh(root, "rev-parse", "HEAD"), head);
  assert.equal(
    await readFile(join(root, "f.txt"), "utf8"),
    "base\nmain side\n",
  );
});

test("rebase onto a branch: clean, conflicting then continued, and rewrite confirmation for pushed commits", async (t) => {
  const { root, agent, gw } = await repo(t);
  const clean = await gw.integrate(agent.id, {
    ...w(root),
    mode: "rebase",
    source: "feature",
    confirmMode: true,
  });
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(
    sh(root, "log", "--format=%s", "-2").trim().split("\n")[1],
    "feature change",
  );

  const c = await repo(t, { conflict: true });
  const r = await c.gw.integrate(c.agent.id, {
    ...w(c.root),
    mode: "rebase",
    source: "feature",
    confirmMode: true,
  });
  assert.equal(r.ok, false);
  assert.equal((r.conflicts as any).operation, "rebase");
  await writeFile(join(c.root, "f.txt"), "resolved\n");
  await c.gw.resolveConflicts(c.agent.id, { ...w(c.root), paths: ["f.txt"] });
  const done = await c.gw.continue(c.agent.id, { ...w(c.root), confirm: true });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await c.gw.conflicts(c.agent.id, w(c.root))).operation, "none");
});

test("rebasing commits that are already on the upstream needs a separate rewrite confirmation", async (t) => {
  const { base, root, agent, gw } = await repo(t);
  const bare = join(base, "origin.git");
  sh(base, "init", "-q", "--bare", "-b", "main", bare);
  sh(root, "remote", "add", "origin", bare);
  sh(root, "push", "-q", "-u", "origin", "main", "feature");
  const head = sh(root, "rev-parse", "HEAD");
  // main's commit "main change" is pushed and is not in feature: rebasing replays a pushed commit.
  const args = {
    ...w(root),
    mode: "rebase" as const,
    source: "origin/feature",
    confirmMode: true,
  };
  await assert.rejects(
    gw.integrate(agent.id, args),
    codeOf("rewrite_confirmation_required"),
  );
  assert.equal(sh(root, "rev-parse", "HEAD"), head);
  const ok = await gw.integrate(agent.id, { ...args, confirmRewrite: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.notEqual(sh(root, "rev-parse", "HEAD"), head);
  // No force-push is offered: the diverged branch cannot be pushed by the workflow.
  const push = await gw.push(agent.id, w(root));
  assert.equal(push.ok, false);
});
