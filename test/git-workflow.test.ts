import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { chmod, access } from "node:fs/promises";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import {
  GitWorkflow,
  SAFE_GIT_CONFIG,
  gitEnvironment,
} from "../src/git-workflow.ts";
import {
  classifyGitFailure,
  compareUrl,
  parseConflictMarkers,
  parseRemoteUrl,
} from "../src/git-remote.ts";

// Isolate from the developer's global Git configuration (credential helpers, signing, hooks).
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL =
  "test@example.invalid";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const codeOf = (code: string) => (e: any) => e.code === code;

/** A work repository cloned from a local bare "origin", plus a second clone to make upstream changes. */
async function fixture(t: any, opts: { remote?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-gw-")));
  const bare = join(base, "origin.git"),
    root = join(base, "project"),
    other = join(base, "other");
  await mkdir(root);
  if (opts.remote !== false) {
    sh(base, "init", "-q", "--bare", "-b", "main", bare);
    sh(base, "clone", "-q", bare, other);
    await writeFile(join(other, "a.txt"), "one\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "first");
    sh(other, "push", "-q", "origin", "HEAD:main");
    sh(base, "clone", "-q", bare, root);
  } else sh(root, "init", "-q", "-b", "main");
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    ws = new WorkspaceService(store);
  const agent = await team.saveAgent({
    name: "Builder",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const opened: string[] = [];
  const gw = new GitWorkflow(store, ws, {
    openUrl: async (url) => void opened.push(url),
  });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, bare, root, other, store, agent, ws, gw, opened };
}
const w = (root: string) => ({ workspace: root });

test("remote URLs parse without credentials and build compare links", () => {
  const gh = parseRemoteUrl("git@github.com:owner/repo.git")!;
  assert.deepEqual(
    [gh.host, gh.path, gh.provider],
    ["github.com", "owner/repo", "github"],
  );
  assert.equal(
    compareUrl(gh, "feature/x y", "main"),
    "https://github.com/owner/repo/compare/main...feature/x%20y?expand=1",
  );
  const https = parseRemoteUrl("https://user:secret@github.com/o/r.git")!;
  assert.ok(
    !https.display.includes("secret") && !https.display.includes("user"),
  );
  const gl = parseRemoteUrl(
    "ssh://git@gitlab.example.com:2222/grp/sub/proj.git",
  )!;
  assert.equal(gl.provider, "gitlab");
  assert.equal(
    compareUrl(gl, "f", "main"),
    "https://gitlab.example.com/grp/sub/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=f&merge_request%5Btarget_branch%5D=main",
  );
  const bb = parseRemoteUrl("https://bitbucket.org/team/repo")!;
  assert.equal(
    compareUrl(bb, "f", "main"),
    "https://bitbucket.org/team/repo/pull-requests/new?source=f&dest=main",
  );
  assert.equal(
    compareUrl(parseRemoteUrl("https://git.example.org/a/b")!, "f", "m"),
    null,
  );
  for (const local of [
    "/srv/git/repo.git",
    "../repo",
    "C:\\repo",
    "file:///tmp/x.git",
    "",
  ])
    assert.equal(parseRemoteUrl(local), null, local);
});
test("Git failures are classified into stable, actionable kinds", () => {
  const kind = (s: string) => classifyGitFailure(s).kind;
  assert.equal(
    kind(
      "fatal: could not read Username for 'https://x': terminal prompts disabled",
    ),
    "auth_failed",
  );
  assert.equal(kind("git@host: Permission denied (publickey)."), "auth_failed");
  assert.equal(
    kind("! [rejected] main -> main (non-fast-forward)"),
    "non_fast_forward",
  );
  assert.equal(
    kind("fatal: The current branch x has no upstream branch."),
    "no_upstream",
  );
  assert.equal(
    kind("fatal: Not possible to fast-forward, aborting."),
    "not_fast_forward_possible",
  );
  assert.equal(kind("CONFLICT (content): Merge conflict in a.txt"), "conflict");
  assert.equal(
    kind("fatal: unable to access 'https://x/': Could not resolve host: x"),
    "network",
  );
  assert.equal(
    kind(
      "error: Your local changes to the following files would be overwritten",
    ),
    "local_changes",
  );
  assert.equal(kind("weird"), "unknown");
});
test("conflict marker parsing finds bounded sections incl. diff3 base", () => {
  const text = [
    "top",
    "<<<<<<< HEAD",
    "ours 1",
    "||||||| base",
    "orig",
    "=======",
    "theirs 1",
    ">>>>>>> feature",
    "mid",
    "<<<<<<< HEAD",
    "ours 2",
    "=======",
    "theirs 2",
    ">>>>>>> feature",
  ].join("\n");
  const p = parseConflictMarkers(text);
  assert.equal(p.sectionCount, 2);
  assert.deepEqual(p.sections[0].base, ["orig"]);
  assert.deepEqual([p.sections[0].startLine, p.sections[0].endLine], [2, 8]);
  assert.equal(p.sections[1].theirs[0], "theirs 2");
  assert.equal(p.sections[1].theirsLabel, "feature");
  assert.equal(parseConflictMarkers("plain\n").hasMarkers, false);
  assert.equal(parseConflictMarkers("<<<<<<< x\nfoo\n").malformed, true);
});

test("reading Git state never rewrites the index (no optional index.lock while the user runs Git)", async (t) => {
  const { root, agent, gw } = await fixture(t);
  // A stat-dirty tracked file: plain `git status` would refresh and rewrite .git/index under
  // index.lock, racing the user's own `git switch`/`commit` in the same repository.
  const { utimes, stat } = await import("node:fs/promises");
  const later = new Date(Date.now() + 60_000);
  await utimes(join(root, "a.txt"), later, later);
  const index = join(root, ".git", "index");
  const before = (await stat(index)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await gw.state(agent.id, w(root));
  assert.equal((await stat(index)).mtimeMs, before);
});

test("fetch, pull (ff-only) and push work against a local bare remote", async (t) => {
  const { root, other, bare, agent, gw } = await fixture(t);
  const st = await gw.state(agent.id, w(root));
  assert.equal(st.branch, "main");
  assert.equal(st.upstream, "origin/main");
  assert.deepEqual([st.ahead, st.behind], [0, 0]);
  assert.equal(st.remotes[0].name, "origin");

  // Upstream moves; fetch reports it, pull fast-forwards.
  await writeFile(join(other, "b.txt"), "remote\n");
  sh(other, "add", ".");
  sh(other, "commit", "-qm", "remote work");
  sh(other, "push", "-q", "origin", "HEAD:main");
  const fetched = await gw.fetch(agent.id, w(root));
  assert.equal(fetched.ok, true);
  assert.equal((fetched.state as any).behind, 1);
  const pulled = await gw.pull(agent.id, w(root));
  assert.equal(pulled.ok, true, JSON.stringify(pulled));
  assert.equal(pulled.mode, "ff-only");
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "remote\n");
  assert.match((await gw.pull(agent.id, w(root))).summary, /up to date/i);

  // Local commit, then push.
  await writeFile(join(root, "c.txt"), "local\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "local work");
  const pushed = await gw.push(agent.id, w(root));
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(
    sh(bare, "log", "--format=%s", "-1", "main").trim(),
    "local work",
  );
});
test("push without upstream needs explicit set-upstream; branch is published to the remote", async (t) => {
  const { root, bare, agent, gw } = await fixture(t);
  await gw.switchBranch(agent.id, {
    ...w(root),
    branch: "feature/x",
    create: true,
  });
  const first = await gw.push(agent.id, w(root));
  assert.equal(first.ok, false);
  assert.equal(first.failure!.kind, "no_upstream");
  const done = await gw.push(agent.id, { ...w(root), setUpstream: true });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((done.state as any).upstream, "origin/feature/x");
  assert.ok(sh(bare, "branch", "--list", "feature/x").includes("feature/x"));
});
test("push rejection is reported, never forced; diverged ff-only pull is refused", async (t) => {
  const { root, other, bare, agent, gw } = await fixture(t);
  await writeFile(join(other, "r.txt"), "remote\n");
  sh(other, "add", ".");
  sh(other, "commit", "-qm", "remote side");
  sh(other, "push", "-q", "origin", "HEAD:main");
  await writeFile(join(root, "l.txt"), "local\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "local side");
  const remoteBefore = sh(bare, "rev-parse", "main");
  const rejected = await gw.push(agent.id, w(root));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failure!.kind, "non_fast_forward");
  assert.match(rejected.failure!.message, /force push is not offered/);
  assert.equal(sh(bare, "rev-parse", "main"), remoteBefore);
  await gw.fetch(agent.id, w(root));
  const pull = await gw.pull(agent.id, w(root));
  assert.equal(pull.ok, false);
  assert.equal(pull.failure!.kind, "not_fast_forward_possible");
  // Merge/rebase must be chosen and confirmed deliberately.
  await assert.rejects(
    gw.pull(agent.id, { ...w(root), mode: "merge" }),
    codeOf("mode_confirmation_required"),
  );
  const merged = await gw.pull(agent.id, {
    ...w(root),
    mode: "merge",
    confirmMode: true,
  });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal((await gw.push(agent.id, w(root))).ok, true);
});
test("unreachable remotes fail with a clear kind and never prompt", async (t) => {
  const { root, base, agent, gw } = await fixture(t);
  // A missing local repository: no network, no ssh.
  sh(
    root,
    "remote",
    "set-url",
    "origin",
    pathToFileURL(join(base, "missing", "nope.git")).href,
  );
  const r = await gw.fetch(agent.id, w(root));
  assert.equal(r.ok, false);
  assert.ok(
    ["network", "no_remote", "auth_failed", "not_found"].includes(
      r.failure!.kind,
    ),
    r.failure!.kind + ": " + r.failure!.raw,
  );
  const none = await fixture(t, { remote: false });
  const nr = await none.gw.fetch(none.agent.id, w(none.root));
  assert.equal(nr.failure!.kind, "no_remote");
});

test("branch switching requires confirmation for dirty trees and active runs", async (t) => {
  const { root, agent, gw, store } = await fixture(t);
  sh(root, "branch", "other");
  const branches = await gw.branches(agent.id, w(root));
  assert.deepEqual(branches.local.map((b) => b.name).sort(), ["main", "other"]);
  assert.equal(branches.current, "main");
  assert.equal(branches.defaultBase, "origin/main");
  assert.ok(branches.remote.some((b) => b.name === "origin/main"));

  await writeFile(join(root, "a.txt"), "dirty\n");
  await assert.rejects(
    gw.switchBranch(agent.id, { ...w(root), branch: "other" }),
    codeOf("dirty_tree"),
  );
  assert.equal(sh(root, "branch", "--show-current").trim(), "main");
  store.put("session", {
    id: "s1",
    agentId: agent.id,
    providerSessionId: null,
    state: "running",
  });
  await assert.rejects(
    gw.switchBranch(agent.id, {
      ...w(root),
      branch: "other",
      confirmDirty: true,
    }),
    codeOf("run_active"),
  );
  assert.equal(sh(root, "branch", "--show-current").trim(), "main");
  const ok = await gw.switchBranch(agent.id, {
    ...w(root),
    branch: "other",
    confirmDirty: true,
    confirmActiveRun: true,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(sh(root, "branch", "--show-current").trim(), "other");
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "dirty\n"); // carried, never discarded
  store.put("session", {
    id: "s1",
    agentId: agent.id,
    providerSessionId: null,
    state: "idle",
  });
  // Invalid and option-like names are rejected before Git sees them.
  await assert.rejects(
    gw.switchBranch(agent.id, { ...w(root), branch: "--force" }),
  );
  await assert.rejects(
    gw.switchBranch(agent.id, {
      ...w(root),
      branch: "nope",
      confirmDirty: true,
    }),
    codeOf("branch_not_found"),
  );
});
test("switching creates branches from a chosen base and tracks remote branches", async (t) => {
  const { root, other, agent, gw } = await fixture(t);
  sh(other, "checkout", "-qb", "remote-only");
  await writeFile(join(other, "ro.txt"), "x\n");
  sh(other, "add", ".");
  sh(other, "commit", "-qm", "remote branch");
  sh(other, "push", "-q", "origin", "remote-only");
  await gw.fetch(agent.id, w(root));
  const tracked = await gw.switchBranch(agent.id, {
    ...w(root),
    branch: "remote-only",
  });
  assert.equal(tracked.ok, true, JSON.stringify(tracked));
  assert.equal((tracked.state as any).upstream, "origin/remote-only");
  const made = await gw.switchBranch(agent.id, {
    ...w(root),
    branch: "from-main",
    create: true,
    base: "main",
  });
  assert.equal(made.created, true);
  assert.equal(
    sh(root, "rev-parse", "HEAD").trim(),
    sh(root, "rev-parse", "main").trim(),
  );
  await assert.rejects(
    gw.switchBranch(agent.id, {
      ...w(root),
      branch: "from-main",
      create: true,
    }),
    codeOf("branch_exists"),
  );
  await assert.rejects(
    gw.switchBranch(agent.id, {
      ...w(root),
      branch: "bad",
      create: true,
      base: "--evil",
    }),
    codeOf("invalid_revision"),
  );
});

test("commit history pages are bounded and path-filterable", async (t) => {
  const { root, agent, gw } = await fixture(t, { remote: false });
  assert.equal((await gw.log(agent.id, w(root))).empty, true);
  for (let i = 0; i < 5; i++) {
    await writeFile(join(root, i % 2 ? "odd.txt" : "even.txt"), `v${i}\n`);
    sh(root, "add", ".");
    sh(root, "commit", "-qm", `commit ${i}`);
  }
  const p1 = await gw.log(agent.id, { ...w(root), limit: 2 });
  assert.deepEqual(
    p1.commits.map((c) => c.subject),
    ["commit 4", "commit 3"],
  );
  assert.equal(p1.hasMore, true);
  const p3 = await gw.log(agent.id, {
    ...w(root),
    limit: 2,
    skip: p1.nextSkip! * 2,
  });
  assert.deepEqual(
    p3.commits.map((c) => c.subject),
    ["commit 0"],
  );
  assert.equal(p3.hasMore, false);
  await assert.rejects(gw.log(agent.id, { ...w(root), limit: 101 }));
  const odd = await gw.log(agent.id, { ...w(root), path: "odd.txt" });
  assert.deepEqual(
    odd.commits.map((c) => c.subject),
    ["commit 3", "commit 1"],
  );
  await assert.rejects(
    gw.log(agent.id, { ...w(root), path: ".git/config" }),
    codeOf("git_internal"),
  );
  await assert.rejects(
    gw.log(agent.id, { ...w(root), ref: "--output=/tmp/x" }),
    codeOf("invalid_revision"),
  );
  const info = await gw.commit(agent.id, {
    ...w(root),
    sha: p1.commits[0].sha,
  });
  assert.equal(info.message, "commit 4");
  assert.deepEqual(info.files, [{ status: "M", path: "even.txt" }]);
});

test("pull request links come from the remote URL, open as a user action, and link tasks/reviews", async (t) => {
  const { root, agent, gw, store, opened } = await fixture(t);
  // Local-path remote: no web link, explained.
  let pr = await gw.pullRequest(agent.id, w(root));
  assert.equal(pr.url, null);
  assert.match(pr.notes.join(" "), /local path/);
  sh(
    root,
    "remote",
    "set-url",
    "origin",
    "https://tok:secret@github.com/acme/widgets.git",
  );
  await gw.switchBranch(agent.id, {
    ...w(root),
    branch: "feature/pr",
    create: true,
  });
  store.put("worktree", {
    id: "wt1",
    repo: root,
    branch: "feature/pr",
    taskId: "task-1",
    path: root,
    status: "attached",
  });
  store.put("task", {
    id: "task-1",
    title: "Build widgets",
    status: "running",
    agentId: agent.id,
  });
  store.put("review-decision", {
    id: "rd",
    agentId: agent.id,
    workspace: root,
    staged: false,
    compare: "",
    decision: "approved",
    at: new Date().toISOString(),
  });
  pr = await gw.pullRequest(agent.id, { ...w(root), base: "origin/main" });
  assert.equal(
    pr.url,
    "https://github.com/acme/widgets/compare/main...feature/pr?expand=1",
  );
  assert.ok(!JSON.stringify(pr).includes("secret"));
  assert.match(pr.notes.join(" "), /not on the remote/);
  assert.deepEqual(
    pr.links.tasks.map((x) => x.title),
    ["Build widgets"],
  );
  assert.equal(pr.links.reviews[0].decision, "approved");
  assert.equal(pr.statusSource, "manual");
  const opening = await gw.openPullRequest(agent.id, {
    ...w(root),
    base: "main",
  });
  assert.equal(opening.opened, true);
  assert.deepEqual(opened, [pr.url]);
  await assert.rejects(
    gw.recordPullRequest(agent.id, {
      ...w(root),
      url: "https://evil.example/acme/widgets/pull/1",
    }),
    codeOf("url_host_mismatch"),
  );
  await assert.rejects(
    gw.recordPullRequest(agent.id, { ...w(root), url: "javascript:alert(1)" }),
    codeOf("invalid_url"),
  );
  await gw.recordPullRequest(agent.id, {
    ...w(root),
    url: "https://github.com/acme/widgets/pull/7",
    number: 7,
    status: "open",
  });
  pr = await gw.pullRequest(agent.id, w(root));
  assert.equal(pr.links.pullRequests[0].number, 7);
  // Unknown provider: no compare link, no open.
  sh(root, "remote", "set-url", "origin", "https://git.example.org/a/b.git");
  await assert.rejects(
    gw.openPullRequest(agent.id, w(root)),
    codeOf("no_pr_url"),
  );
});

/** Two branches editing the same line; leaves `main` mid-merge (or mid-rebase). */
async function conflictRepo(t: any) {
  const f = await fixture(t, { remote: false });
  const { root } = f;
  await writeFile(join(root, "f.txt"), "base\nshared\n");
  await writeFile(join(root, "gone.txt"), "keep\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "base");
  sh(root, "checkout", "-qb", "feature");
  await writeFile(join(root, "f.txt"), "base\nfeature side\n");
  await writeFile(join(root, "gone.txt"), "changed on feature\n");
  sh(root, "commit", "-qam", "feature change");
  sh(root, "checkout", "-q", "main");
  await writeFile(join(root, "f.txt"), "base\nmain side\n");
  sh(root, "rm", "-q", "gone.txt");
  sh(root, "commit", "-qam", "main change");
  return f;
}
test("merge conflicts are listed with marker sections; resolution is deliberate", async (t) => {
  const { root, agent, gw } = await conflictRepo(t);
  try {
    sh(root, "merge", "feature");
  } catch {
    /* conflicts expected */
  }
  const c = await gw.conflicts(agent.id, w(root));
  assert.equal(c.operation, "merge");
  assert.deepEqual(c.files.map((f) => [f.path, f.code]).sort(), [
    ["f.txt", "UU"],
    ["gone.txt", "DU"],
  ]);
  assert.match(c.next, /Resolve 2/);
  const detail = await gw.conflictFile(agent.id, { ...w(root), path: "f.txt" });
  assert.equal(detail.sectionCount, 1);
  assert.deepEqual(detail.sections[0].ours, ["main side"]);
  assert.deepEqual(detail.sections[0].theirs, ["feature side"]);
  assert.equal(detail.stages.base, true);
  const del = await gw.conflictFile(agent.id, { ...w(root), path: "gone.txt" });
  assert.equal(del.stages.theirs, true);
  await assert.rejects(
    gw.conflictFile(agent.id, { ...w(root), path: "a.txt" }),
    codeOf("not_conflicted"),
  );

  // Cannot continue, cannot mark resolved while markers remain, cannot switch.
  await assert.rejects(
    gw.continue(agent.id, { ...w(root), confirm: true }),
    codeOf("conflicts_remaining"),
  );
  await assert.rejects(
    gw.resolveConflicts(agent.id, { ...w(root), paths: ["f.txt"] }),
    codeOf("markers_present"),
  );
  await assert.rejects(
    gw.switchBranch(agent.id, {
      ...w(root),
      branch: "feature",
      confirmDirty: true,
    }),
    codeOf("operation_in_progress"),
  );
  await assert.rejects(
    gw.abort(agent.id, w(root)),
    codeOf("confirmation_required"),
  );

  await writeFile(join(root, "f.txt"), "base\nmain side and feature side\n");
  await gw.resolveConflicts(agent.id, { ...w(root), paths: ["f.txt"] });
  // Deleted-by-us: staging the deletion accepts it.
  const after = await gw.resolveConflicts(agent.id, {
    ...w(root),
    paths: ["gone.txt"],
  });
  assert.equal((after as any).conflicts.files.length, 0);
  const cont = await gw.continue(agent.id, { ...w(root), confirm: true });
  assert.equal(cont.ok, true, JSON.stringify(cont));
  assert.equal((await gw.conflicts(agent.id, w(root))).operation, "none");
  assert.equal(
    sh(root, "log", "--format=%P", "-1").trim().split(" ").length,
    2,
  );
  assert.equal(
    await readFile(join(root, "f.txt"), "utf8"),
    "base\nmain side and feature side\n",
  );
});
test("aborting a merge restores the pre-merge state; acknowledged markers can be staged", async (t) => {
  const { root, agent, gw } = await conflictRepo(t);
  const head = sh(root, "rev-parse", "HEAD");
  try {
    sh(root, "merge", "feature");
  } catch {
    /* conflicts expected */
  }
  const ack = await gw.resolveConflicts(agent.id, {
    ...w(root),
    paths: ["f.txt"],
    acknowledgeMarkers: true,
  });
  assert.equal(ack.ok, true);
  const aborted = await gw.abort(agent.id, { ...w(root), confirm: true });
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(sh(root, "rev-parse", "HEAD"), head);
  assert.equal(
    await readFile(join(root, "f.txt"), "utf8"),
    "base\nmain side\n",
  );
  await assert.rejects(
    gw.abort(agent.id, { ...w(root), confirm: true }),
    codeOf("no_operation"),
  );
});
test("a pull that conflicts reports it in-band; rebase can be continued after resolving", async (t) => {
  const { root, other, agent, gw } = await fixture(t);
  await writeFile(join(other, "a.txt"), "remote edit\n");
  sh(other, "commit", "-qam", "remote edit");
  sh(other, "push", "-q", "origin", "HEAD:main");
  await writeFile(join(root, "a.txt"), "local edit\n");
  sh(root, "commit", "-qam", "local edit");
  await gw.fetch(agent.id, w(root));
  const pull = await gw.pull(agent.id, {
    ...w(root),
    mode: "rebase",
    confirmMode: true,
  });
  assert.equal(pull.ok, false);
  assert.equal(pull.failure!.kind, "conflict");
  const c = await gw.conflicts(agent.id, w(root));
  assert.equal(c.operation, "rebase");
  assert.deepEqual(
    c.files.map((f) => f.path),
    ["a.txt"],
  );
  await writeFile(join(root, "a.txt"), "both edits\n");
  await gw.resolveConflicts(agent.id, { ...w(root), paths: ["a.txt"] });
  const cont = await gw.continue(agent.id, { ...w(root), confirm: true });
  assert.equal(cont.ok, true, JSON.stringify(cont));
  assert.equal((await gw.conflicts(agent.id, w(root))).operation, "none");
  assert.equal(
    sh(root, "log", "--format=%s", "-2").trim().split("\n")[1],
    "remote edit",
  );
});

test("staging handles deleted files, nested deleted directories, renames and unborn repositories", async (t) => {
  const { root, agent, ws } = await fixture(t, { remote: false });
  const status = async () =>
    sh(root, "status", "--porcelain=v1", "--untracked-files=all")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .sort();
  await mkdir(join(root, "src/deep/er"), { recursive: true });
  await writeFile(join(root, "src/deep/er/x.txt"), "x\n");
  await writeFile(join(root, "src/deep/y.txt"), "y\n");
  await writeFile(
    join(root, "old name.txt"),
    "rename me\nwith some content\nto keep similarity\n",
  );
  await writeFile(join(root, "gone.txt"), "g\n");

  // Unborn repository: stage, unstage (no HEAD to restore from), stage again, commit.
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: ["src", "gone.txt", "old name.txt"],
  });
  assert.ok((await status()).every((l) => l.startsWith("A ")));
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "unstage",
    paths: ["gone.txt"],
  });
  assert.ok((await status()).includes("?? gone.txt"));
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: ["gone.txt"],
  });
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "commit",
    message: "initial",
  });

  // Nested deleted directory: neither the directory nor its parents exist any more.
  await rm(join(root, "src"), { recursive: true });
  await rm(join(root, "gone.txt"));
  assert.deepEqual(await status(), [
    " D gone.txt",
    " D src/deep/er/x.txt",
    " D src/deep/y.txt",
  ]);
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: ["src/deep/er"],
  });
  assert.deepEqual(await status(), [
    " D gone.txt",
    " D src/deep/y.txt",
    "D  src/deep/er/x.txt",
  ]);
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: ["src", "gone.txt"],
  });
  assert.ok((await status()).every((l) => l.startsWith("D ")));
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "unstage",
    paths: ["src/deep"],
  });
  assert.deepEqual(await status(), [
    " D src/deep/er/x.txt",
    " D src/deep/y.txt",
    "D  gone.txt",
  ]);
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "unstage",
    paths: ["gone.txt"],
  });
  sh(root, "checkout", "--", ".");

  // Renames: both sides move together; unstaging the new name also restores the old.
  await rename(join(root, "old name.txt"), join(root, "new name.txt"));
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "stage",
    paths: [],
    renames: [{ from: "old name.txt", to: "new name.txt" }],
  });
  assert.deepEqual(await status(), ['R  "old name.txt" -> "new name.txt"']);
  await ws.mutateGit(agent.id, {
    workspace: root,
    action: "unstage",
    paths: ["new name.txt"],
  });
  assert.deepEqual(await status(), [' D "old name.txt"', '?? "new name.txt"']);
});
test("staging stays inside the folder: traversal, .git and symlink escapes are refused", async (t) => {
  const { base, root, agent, ws } = await fixture(t, { remote: false });
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "outside", "secret.txt"), "s\n");
  await symlink(join(base, "outside"), join(root, "link"));
  for (const bad of [
    "../outside/secret.txt",
    "/etc/passwd",
    ".git/config",
    "a/../../x",
    "link/secret.txt",
  ])
    await assert.rejects(
      ws.mutateGit(agent.id, {
        workspace: root,
        action: "stage",
        paths: [bad],
      }),
      (e: any) =>
        ["invalid_path", "path_escape", "git_internal"].includes(e.code),
      bad,
    );
  assert.equal(sh(root, "status", "--porcelain").includes("secret"), false);
});
test("git init is offered for plain folders and refused inside repositories", async (t) => {
  const { base, store, agent, ws, gw } = await fixture(t, { remote: false });
  const plain = join(base, "plain");
  await mkdir(plain);
  const team = new TeamService(store, new SkillCatalog([]));
  const a2 = await team.saveAgent({
    name: "Plain",
    environment: "codex",
    workspaces: [{ path: plain, access: "write", active: true }],
  });
  const before = await gw.state(a2.id, w(plain));
  assert.deepEqual([before.repository, before.canInit], [null, true]);
  const made = await gw.init(a2.id, w(plain));
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal((made.state as any).branch, "main");
  assert.equal((made.state as any).unborn, true);
  await assert.rejects(gw.init(a2.id, w(plain)), codeOf("already_repository"));
  void agent;
  void ws;
});
import { rename } from "node:fs/promises";

// ---- review fixes: push target, hooks, hardening, pull mode, subfolder scope ---------------
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
/** An executable shell script that records it ran by touching `marker`. */
async function markerScript(path: string, marker: string, exit = 0) {
  await writeFile(path, `#!/bin/sh\ntouch "${marker}"\nexit ${exit}\n`);
  await chmod(path, 0o755);
}
const posixOnly = process.platform === "win32" ? "shell hooks" : false;

test("push refuses a tracked target branch with another name unless that target is confirmed", async (t) => {
  const { root, bare, agent, gw } = await fixture(t);
  // A branch created with `git switch -c feature/x origin/main` (autoSetupMerge) tracks main.
  sh(root, "switch", "-q", "-c", "feature/x", "--track", "origin/main");
  const made = { state: await gw.state(agent.id, w(root)) };
  assert.equal((made.state as any).upstream, "origin/main");
  assert.deepEqual((made.state as any).pushTarget, {
    remote: "origin",
    branch: "main",
    matches: false,
  });
  await writeFile(join(root, "feature.txt"), "feature\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "feature work");
  const mainBefore = sh(bare, "rev-parse", "main");
  await assert.rejects(
    gw.push(agent.id, w(root)),
    (e: any) =>
      e.code === "push_target_confirmation" &&
      /update main on origin/.test(e.message),
  );
  await assert.rejects(
    gw.push(agent.id, { ...w(root), confirmTarget: "feature/x" }),
    codeOf("push_target_confirmation"),
  );
  assert.equal(
    sh(bare, "rev-parse", "main"),
    mainBefore,
    "remote main untouched",
  );
  // Naming the target explicitly is a deliberate choice; the result says where it went.
  const pushed = await gw.push(agent.id, { ...w(root), confirmTarget: "main" });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.equal(pushed.target, "main");
  assert.match(pushed.summary, /Pushed feature\/x to origin\/main/);
  assert.equal(
    sh(bare, "log", "-1", "--format=%s", "main").trim(),
    "feature work",
  );
  // Same-name upstream: no confirmation needed.
  const st = await gw.state(agent.id, w(root));
  await gw.switchBranch(agent.id, { ...w(root), branch: "main" });
  assert.equal((await gw.state(agent.id, w(root))).pushTarget?.matches, true);
  void st;
});

test(
  "fetch, pull, push and status never run repository hooks or fsmonitor",
  { skip: posixOnly },
  async (t) => {
    const { root, other, base, agent, gw } = await fixture(t);
    const marker = join(base, "hook-ran");
    for (const hook of [
      "reference-transaction",
      "pre-auto-gc",
      "post-merge",
      "post-checkout",
      "pre-push",
    ])
      await markerScript(join(root, ".git", "hooks", hook), marker);
    // Also a repo-local fsmonitor command, run by plain `git status` otherwise.
    const fsmMarker = join(base, "fsmonitor-ran");
    await markerScript(join(base, "fsm.sh"), fsmMarker, 1);
    sh(root, "config", "core.fsmonitor", join(base, "fsm.sh"));
    await writeFile(join(other, "n.txt"), "new\n");
    sh(other, "add", ".");
    sh(other, "commit", "-qm", "upstream");
    sh(other, "push", "-q", "origin", "HEAD:main");
    assert.equal((await gw.fetch(agent.id, w(root))).ok, true);
    assert.equal((await gw.pull(agent.id, w(root))).ok, true);
    await writeFile(join(root, "l.txt"), "l\n");
    const quiet = [
      "-c",
      "core.hooksPath=" + devNull,
      "-c",
      "core.fsmonitor=false",
    ];
    sh(root, ...quiet, "add", ".");
    sh(root, ...quiet, "commit", "-qm", "local");
    assert.equal((await gw.push(agent.id, w(root))).ok, true);
    await gw.state(agent.id, w(root));
    assert.equal(await exists(marker), false, "a repository hook ran");
    assert.equal(await exists(fsmMarker), false, "the fsmonitor command ran");
    // Sanity: the same hook does run for a plain git fetch, so the test would catch a regression.
    sh(other, "pull", "-q", "--ff-only");
    sh(other, "commit", "-q", "--allow-empty", "-m", "again");
    sh(other, "push", "-q", "origin", "HEAD:main");
    sh(root, "-c", "core.fsmonitor=false", "fetch", "-q");
    assert.equal(await exists(marker), true);
  },
);

test(
  "Git runs without askpass or interactive credentials and ignores a repository-local sshCommand",
  { skip: posixOnly },
  async (t) => {
    const { root, base, agent, gw } = await fixture(t);
    sh(root, "config", "core.askPass", join(base, "askpass.sh"));
    // The safe prefix overrides repository-local askPass/fsmonitor values.
    const get = (key: string) => {
      try {
        return execFileSync(
          "git",
          ["-C", root, ...SAFE_GIT_CONFIG, "config", "--get", key],
          { encoding: "utf8" },
        ).trim();
      } catch {
        return "";
      }
    };
    assert.equal(get("core.askPass"), "");
    assert.equal(get("core.fsmonitor"), "false");
    assert.equal(get("credential.interactive"), "never");
    assert.equal(get("core.hooksPath"), devNull);
    const env = await gitEnvironment(root, false);
    assert.equal(env.GIT_ASKPASS, "");
    assert.equal(env.SSH_ASKPASS_REQUIRE, "never");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    // Background status refreshes never take the optional index.lock, so the user's own Git
    // commands running at the same moment do not fail with "index.lock: File exists".
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");

    // Repository-local core.sshCommand (e.g. from a cloned repo's setup) is never used.
    const repoMarker = join(base, "repo-ssh-ran"),
      userMarker = join(base, "user-ssh-ran");
    await markerScript(join(base, "repo-ssh.sh"), repoMarker, 1);
    await markerScript(join(base, "user-ssh.sh"), userMarker, 1);
    sh(root, "config", "core.sshCommand", join(base, "repo-ssh.sh"));
    // No real host is contacted: the user's SSH command is a local script that exits 1.
    sh(root, "remote", "set-url", "origin", "ssh://git@example.invalid/x.git");
    const saved = {
      cmd: process.env.GIT_SSH_COMMAND,
      global: process.env.GIT_CONFIG_GLOBAL,
    };
    t.after(() => {
      if (saved.cmd === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = saved.cmd;
      process.env.GIT_CONFIG_GLOBAL = saved.global;
    });
    // 1. The user's environment wins.
    process.env.GIT_SSH_COMMAND = join(base, "user-ssh.sh");
    assert.equal((await gw.fetch(agent.id, w(root))).ok, false);
    assert.equal(await exists(userMarker), true);
    assert.equal(await exists(repoMarker), false);
    await rm(userMarker);
    // 2. The user's global core.sshCommand is kept (legitimate auth setups keep working).
    delete process.env.GIT_SSH_COMMAND;
    const globalConfig = join(base, "global.gitconfig");
    await writeFile(
      globalConfig,
      `[core]\n\tsshCommand = ${join(base, "user-ssh.sh")}\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    assert.equal((await gw.fetch(agent.id, w(root))).ok, false);
    assert.equal(await exists(userMarker), true);
    assert.equal(await exists(repoMarker), false);
    // 3. Nothing configured: plain ssh in BatchMode (checked without running it).
    process.env.GIT_CONFIG_GLOBAL = devNull;
    assert.equal(
      (await gitEnvironment(root, true)).GIT_SSH_COMMAND,
      "ssh -o BatchMode=yes",
    );
  },
);

test("fast-forward pull stays a fast-forward even when pull.rebase is configured", async (t) => {
  const { root, other, bare, agent, gw } = await fixture(t);
  sh(root, "config", "pull.rebase", "true");
  await writeFile(join(other, "r.txt"), "remote\n");
  sh(other, "add", ".");
  sh(other, "commit", "-qm", "remote side");
  sh(other, "push", "-q", "origin", "HEAD:main");
  await writeFile(join(root, "l.txt"), "local\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "local side");
  const localHead = sh(root, "rev-parse", "HEAD");
  const pull = await gw.pull(agent.id, w(root));
  assert.equal(pull.ok, false);
  assert.equal(pull.failure!.kind, "not_fast_forward_possible");
  assert.equal(sh(root, "rev-parse", "HEAD"), localHead, "no rebase happened");
  void bare;
});

test("a subfolder attachment only sees its own status, history, commits and conflicts", async (t) => {
  const f = await fixture(t, { remote: false });
  const { root, store } = f;
  await mkdir(join(root, "sub"));
  await mkdir(join(root, "other"));
  await writeFile(join(root, "sub", "c.txt"), "base\nshared\n");
  await writeFile(join(root, "other", "d.txt"), "base\nshared\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "base both");
  await writeFile(join(root, "other", "secret.txt"), "x\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "OUTSIDE-ONLY history");
  const outsideSha = sh(root, "rev-parse", "HEAD").trim();
  await writeFile(join(root, "sub", "x.txt"), "x\n");
  await writeFile(join(root, "other", "y.txt"), "y\n");
  sh(root, "add", ".");
  sh(root, "commit", "-qm", "touches both");
  const bothSha = sh(root, "rev-parse", "HEAD").trim();
  const team = new TeamService(store, new SkillCatalog([]));
  const sub = join(root, "sub");
  const reader = await team.saveAgent({
    name: "Reader",
    environment: "codex",
    workspaces: [{ path: sub, access: "read", active: true }],
  });
  const gw = f.gw;
  // History: only commits touching sub/, and paths resolve inside the attachment.
  const log = await gw.log(reader.id, w(sub));
  assert.deepEqual(
    log.commits.map((c) => c.subject),
    ["touches both", "base both"],
  );
  const xLog = await gw.log(reader.id, { ...w(sub), path: "x.txt" });
  assert.deepEqual(
    xLog.commits.map((c) => c.subject),
    ["touches both"],
  );
  await assert.rejects(
    gw.log(reader.id, { ...w(sub), path: "../other/y.txt" }),
    codeOf("path_escape"),
  );
  // Commit details: out-of-scope commits are refused, files are limited to the folder.
  await assert.rejects(
    gw.commit(reader.id, { ...w(sub), sha: outsideSha }),
    codeOf("commit_out_of_scope"),
  );
  const both = await gw.commit(reader.id, { ...w(sub), sha: bothSha });
  assert.deepEqual(both.files, [{ status: "A", path: "sub/x.txt" }]);
  // Branch tip subjects are hidden; status counts only the folder.
  const branches = await gw.branches(reader.id, w(sub));
  assert.ok(branches.local.every((b) => b.subject === ""));
  await writeFile(join(root, "other", "d.txt"), "dirty outside\n");
  let st = await gw.state(reader.id, w(sub));
  assert.equal(st.scope, "sub");
  assert.equal(st.tracked, 0);
  assert.equal(st.canMutate, false);
  sh(root, "checkout", "-q", "--", "other/d.txt");
  // Conflicts in and outside the folder.
  sh(root, "checkout", "-qb", "feature");
  await writeFile(join(root, "sub", "c.txt"), "base\nfeature\n");
  await writeFile(join(root, "other", "d.txt"), "base\nfeature\n");
  sh(root, "commit", "-qam", "feature");
  sh(root, "checkout", "-q", "main");
  await writeFile(join(root, "sub", "c.txt"), "base\nmain\n");
  await writeFile(join(root, "other", "d.txt"), "base\nmain\n");
  sh(root, "commit", "-qam", "main");
  try {
    sh(root, "merge", "feature");
  } catch {
    /* conflicts expected */
  }
  const c = await gw.conflicts(reader.id, w(sub));
  assert.deepEqual(
    c.files.map((x) => x.path),
    ["sub/c.txt"],
  );
  const detail = await gw.conflictFile(reader.id, {
    ...w(sub),
    path: "sub/c.txt",
  });
  assert.equal(detail.exists, true, "file is not reported as deleted");
  assert.equal(detail.sectionCount, 1);
  assert.deepEqual(detail.sections[0].ours, ["main"]);
  await assert.rejects(
    gw.conflictFile(reader.id, { ...w(sub), path: "other/d.txt" }),
    codeOf("not_conflicted"),
  );
  st = await gw.state(reader.id, w(sub));
  assert.equal(st.conflicted, 1);
  // Mutations still need the repository root with write access.
  await assert.rejects(
    gw.resolveConflicts(reader.id, { ...w(sub), paths: ["sub/c.txt"] }),
    codeOf("read_only"),
  );
});
