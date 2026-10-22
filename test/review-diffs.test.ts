import { test } from "node:test";
import "./fixtures/git-config.ts";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  chmod,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import { ReviewService } from "../src/reviews.ts";
import {
  parseDiffMeta,
  parseNameStatus,
  revisionProblem,
  unquoteGitPath,
  DIFF_MAX_LINES,
} from "../src/diff.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
async function fixture(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-rd-"))),
    root = join(base, "project");
  await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(root, "keep.txt"), "keep\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
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
  const ws = new WorkspaceService(store);
  return {
    base,
    root,
    store,
    team,
    agent,
    ws,
    reviews: new ReviewService(team, ws),
  };
}
const unstaged = (root: string, path?: string) => ({
  workspace: root,
  staged: false,
  ...(path ? { path } : {}),
});
const commitAll = (root: string, msg: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-qm", msg);
};

test("pure helpers: revision validation, header metadata, name-status and quoting", () => {
  assert.equal(revisionProblem("main"), null);
  assert.equal(revisionProblem("origin/feature-x~2"), null);
  assert.ok(revisionProblem("--output=/tmp/x"));
  assert.ok(revisionProblem("a b"));
  assert.ok(revisionProblem("a..b"));
  assert.ok(revisionProblem("HEAD@{1}"));
  assert.ok(revisionProblem(""));
  assert.equal(unquoteGitPath('"a\\tb\\303\\251"'), "a\tbé");
  assert.deepEqual(parseNameStatus("M\0a b\0R097\0old\0new\n\0D\0gone\0"), [
    { status: "M ", path: "a b" },
    { status: "R ", path: "new\n", from: "old", similarity: 97 },
    { status: "D ", path: "gone" },
  ]);
  const m = parseDiffMeta(
    "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n",
  );
  assert.equal(m.kind, "mode");
  assert.equal(m.noHunks, true);
});

test("staged rename keeps its origin, similarity and edited hunks", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await rename(join(root, "a.txt"), join(root, "renamed a.txt"));
  await writeFile(join(root, "renamed a.txt"), "one\ntwo\nthree\nFOUR\n");
  git(root, "add", "-A");
  const list = await ws.review(agent.id, { workspace: root, staged: true });
  const f = list.files.find((x) => x.path === "renamed a.txt");
  assert.equal(f?.from, "a.txt");
  const r = await ws.review(agent.id, {
    workspace: root,
    staged: true,
    path: "renamed a.txt",
  });
  assert.equal(r.meta?.kind, "renamed");
  assert.equal(r.meta?.renameFrom, "a.txt");
  assert.ok((r.meta?.similarity ?? 0) > 50);
  assert.match(r.diff, /\+FOUR/);
  assert.doesNotMatch(r.diff, /^\+one$/m, "not shown as a whole-file add");
});

test("pure rename and file-mode change have no hunks but explicit metadata", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await rename(join(root, "keep.txt"), join(root, "kept.txt"));
  await chmod(join(root, "a.txt"), 0o755);
  git(root, "add", "-A");
  const r = await ws.review(agent.id, {
    workspace: root,
    staged: true,
    path: "kept.txt",
  });
  assert.equal(r.meta?.kind, "renamed");
  assert.equal(r.meta?.similarity, 100);
  assert.equal(r.meta?.noHunks, true);
  if (process.platform !== "win32") {
    const m = await ws.review(agent.id, {
      workspace: root,
      staged: true,
      path: "a.txt",
    });
    assert.equal(m.meta?.kind, "mode");
    assert.equal(m.meta?.oldMode, "100644");
    assert.equal(m.meta?.newMode, "100755");
  }
});

test("binary files are flagged for tracked and untracked changes", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await writeFile(join(root, "img.bin"), Buffer.from([0, 1, 2, 3]));
  commitAll(root, "bin");
  await writeFile(join(root, "img.bin"), Buffer.from([0, 9, 9, 9, 9]));
  await writeFile(join(root, "new.bin"), Buffer.from([0, 1]));
  const tracked = await ws.review(agent.id, unstaged(root, "img.bin"));
  assert.equal(tracked.binary, true);
  assert.equal(tracked.meta?.binary, true);
  const fresh = await ws.review(agent.id, unstaged(root, "new.bin"));
  assert.equal(fresh.binary, true);
});

test("large diffs are bounded with an explicit truncation reason", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await writeFile(join(root, "big.txt"), "x\n");
  commitAll(root, "big");
  const rows = Array.from({ length: DIFF_MAX_LINES + 500 }, (_, i) => `l${i}`);
  await writeFile(join(root, "big.txt"), rows.join("\n") + "\n");
  const r = await ws.review(agent.id, unstaged(root, "big.txt"));
  assert.equal(r.truncated, true);
  assert.match(r.truncatedReason ?? "", /exceeds/);
  assert.ok(r.diff.split("\n").length <= DIFF_MAX_LINES + 1);
  // a multi-megabyte diff is cut off without a git_error
  await writeFile(join(root, "huge.txt"), "y".repeat(50) + "\n");
  commitAll(root, "huge");
  await writeFile(
    join(root, "huge.txt"),
    Array.from({ length: 200_000 }, (_, i) => "line number " + i).join("\n"),
  );
  const h = await ws.review(agent.id, unstaged(root, "huge.txt"));
  assert.equal(h.truncated, true);
  // minified single lines are shortened
  await writeFile(join(root, "min.js"), "a\n");
  commitAll(root, "min");
  await writeFile(join(root, "min.js"), "b".repeat(20_000) + "\n");
  const m = await ws.review(agent.id, unstaged(root, "min.js"));
  assert.equal(m.truncated, true);
  assert.match(m.diff, /line truncated/);
});

test("deleted directory trees list every file; untracked trees are expanded", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await mkdir(join(root, "old", "deep"), { recursive: true });
  await writeFile(join(root, "old", "one.txt"), "1\n");
  await writeFile(join(root, "old", "deep", "two.txt"), "2\n");
  commitAll(root, "tree");
  await rm(join(root, "old"), { recursive: true });
  await mkdir(join(root, "fresh", "sub"), { recursive: true });
  await writeFile(join(root, "fresh", "sub", "f.txt"), "f\n");
  const r = await ws.review(agent.id, unstaged(root));
  const paths = r.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "fresh/sub/f.txt",
    "old/deep/two.txt",
    "old/one.txt",
  ]);
  const d = await ws.review(agent.id, unstaged(root, "old/deep/two.txt"));
  assert.equal(d.meta?.kind, "deleted");
  assert.match(d.diff, /-2/);
  const u = await ws.review(agent.id, unstaged(root, "fresh/sub/f.txt"));
  assert.match(u.diff, /\+f/);
});

test("unusual file names (spaces, quotes, unicode, leading dash, newline) review correctly", async (t) => {
  const { root, agent, ws } = await fixture(t);
  const names = ["sp ace.txt", "ünï-ço∂e.txt", "-dash.txt", "[glob]*.txt"];
  if (process.platform !== "win32") names.push('quo"te.txt');
  if (process.platform !== "win32") names.push("new\nline.txt");
  for (const n of names) await writeFile(join(root, n), "v1\n");
  commitAll(root, "names");
  for (const n of names) await writeFile(join(root, n), "v2\n");
  const list = await ws.review(agent.id, unstaged(root));
  assert.deepEqual(list.files.map((f) => f.path).sort(), [...names].sort());
  for (const n of names) {
    const r = await ws.review(agent.id, unstaged(root, n));
    assert.match(r.diff, /-v1/, n);
    assert.match(r.diff, /\+v2/, n);
  }
  git(root, "add", "-A");
  const compare = await ws.review(agent.id, {
    workspace: root,
    base: "HEAD~1",
    head: "HEAD",
    mergeBase: false,
  });
  assert.equal(compare.files.length, names.length);
});

test("branch comparison: merge base versus direct, validated revisions", async (t) => {
  const { root, agent, ws } = await fixture(t);
  git(root, "checkout", "-qb", "feature");
  await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nFEATURE\n");
  commitAll(root, "feature work");
  git(root, "checkout", "-q", "main");
  await writeFile(join(root, "main-only.txt"), "m\n");
  commitAll(root, "main moves on");
  git(root, "checkout", "-q", "feature");
  const mb = await ws.review(agent.id, {
    workspace: root,
    base: "main",
    mergeBase: true,
  });
  assert.deepEqual(
    mb.files.map((f) => f.path),
    ["a.txt"],
  );
  assert.equal(
    mb.compare?.mergeBaseSha,
    git(root, "merge-base", "main", "feature").trim(),
  );
  const direct = await ws.review(agent.id, {
    workspace: root,
    base: "main",
    mergeBase: false,
  });
  assert.deepEqual(direct.files.map((f) => f.path).sort(), [
    "a.txt",
    "main-only.txt",
  ]);
  const one = await ws.review(agent.id, {
    workspace: root,
    base: "main",
    path: "a.txt",
  });
  assert.match(one.diff, /\+FEATURE/);
  assert.ok(mb.refs?.includes("main"));
  assert.equal(mb.defaultBase, "main");
  // working-tree edits do not leak into a branch comparison
  await writeFile(join(root, "keep.txt"), "dirty\n");
  assert.deepEqual(
    (await ws.review(agent.id, { workspace: root, base: "main" })).files.map(
      (f) => f.path,
    ),
    ["a.txt"],
  );
  for (const bad of ["--output=/tmp/pwn", "nope-branch", "a..b", "x y", ""]) {
    await assert.rejects(
      ws.review(agent.id, { workspace: root, base: bad || " " }),
      (e: any) => e.code === "invalid_revision",
      bad,
    );
  }
  await assert.rejects(
    ws.review(agent.id, { workspace: root, base: "main", head: "ghost" }),
    { code: "invalid_revision" },
  );
  await assert.rejects(
    ws.review(agent.id, { workspace: root, base: "main", staged: true }),
    { code: "invalid_scope" },
  );
});

test("comments, reviewed marks and decisions are scoped per compare mode and anchor to base-compare lines", async (t) => {
  const { root, store, agent, reviews } = await fixture(t);
  git(root, "checkout", "-qb", "feature");
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  commitAll(root, "feature");
  const cmp = { workspace: root, staged: false, base: "main" };
  const c = await reviews.comment(agent.id, {
    ...cmp,
    path: "a.txt",
    side: "new",
    line: 2,
    targetId: agent.id,
    text: "why?",
    requestId: randomUUID(),
  });
  assert.equal(c.lineText, "+TWO");
  const old = await reviews.comment(agent.id, {
    ...cmp,
    path: "a.txt",
    side: "old",
    line: 2,
    targetId: agent.id,
    text: "old side",
    requestId: randomUUID(),
  });
  assert.equal(old.lineText, "-two");
  assert.match(
    String(store.list<any>("message").at(-1)?.text),
    /compare HEAD against main/,
  );
  const st = await reviews.state(agent.id, cmp);
  assert.equal(st.comments.length, 2);
  assert.ok(st.comments.every((x) => !x.outdated));
  // other scopes do not see these comments
  assert.equal(
    (await reviews.state(agent.id, { workspace: root, staged: false })).comments
      .length,
    0,
  );
  assert.equal(
    (await reviews.state(agent.id, { ...cmp, mergeBase: false })).comments
      .length,
    0,
  );
  await reviews.setReviewed(agent.id, {
    ...cmp,
    path: "a.txt",
    reviewed: true,
  });
  assert.equal((await reviews.state(agent.id, cmp)).reviewed["a.txt"], true);
  assert.equal(
    (await reviews.state(agent.id, { ...cmp, mergeBase: false })).reviewed[
      "a.txt"
    ],
    false,
  );
  // the anchor goes outdated when the compared commit changes
  await writeFile(join(root, "a.txt"), "one\nTWO!\nthree\nfour\n");
  commitAll(root, "amend content");
  const after = await reviews.state(agent.id, cmp);
  assert.ok(after.comments.every((x) => x.outdated));
  assert.equal(after.reviewed["a.txt"], false);
  // a diff hash from another scope is rejected
  await assert.rejects(
    reviews.comment(agent.id, {
      ...cmp,
      path: "a.txt",
      side: "new",
      line: 2,
      diffHash: "0".repeat(64),
      targetId: agent.id,
      text: "x",
      requestId: randomUUID(),
    }),
    { code: "review_changed" },
  );
});

test("attribution distinguishes an agent-only linked worktree from a shared checkout", async (t) => {
  const { root, base, team, agent, ws } = await fixture(t);
  const main = await ws.review(agent.id, unstaged(root));
  assert.equal(main.attribution.kind, "shared");
  const wt = join(base, "wt");
  git(root, "worktree", "add", "-q", "-b", "wt-branch", wt);
  const solo = await team.saveAgent({
    name: "Solo",
    environment: "codex",
    workspaces: [{ path: await realpath(wt), access: "write", active: true }],
  });
  const iso = await ws.review(solo.id, unstaged(await realpath(wt)));
  assert.equal(iso.attribution.kind, "worktree");
  const other = await team.saveAgent({
    name: "Other",
    environment: "codex",
    workspaces: [{ path: await realpath(wt), access: "write", active: true }],
  });
  const shared = await ws.review(solo.id, unstaged(await realpath(wt)));
  assert.equal(shared.attribution.kind, "shared");
  assert.deepEqual(shared.attribution.others, [other.name]);
});

test("side-by-side rows pair removals with additions and keep review anchors", async () => {
  const { diffRows, splitRows } = await import("../ui/components/diffRows.ts");
  const { parseDiffLines } = await import("../src/reviews.ts");
  const diff =
    "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,5 @@\n keep\n-old1\n-old2\n+new1\n+new2\n+new3\n tail\n";
  const rows = diffRows(diff);
  const split = splitRows(rows);
  const pairs = split.filter((r) => r.type === "pair") as any[];
  assert.equal(pairs.length, 5); // keep, 2 paired, 1 add-only, tail
  assert.equal(pairs[1].left.row.line, "-old1");
  assert.equal(pairs[1].right.row.line, "+new1");
  assert.equal(pairs[3].left, null);
  const anchors = parseDiffLines(diff);
  for (const p of pairs)
    for (const c of [p.left, p.right].filter(Boolean)) {
      const a = anchors.find((l) => l.side === c.side && l.line === c.no);
      assert.ok(a, `${c.side} ${c.no}`);
      assert.equal(a!.text, c.row.line);
    }
  // unified and split agree on numbering for every non-meta row
  assert.equal(rows.filter((r) => r.kind === "added").length, 3);
});
