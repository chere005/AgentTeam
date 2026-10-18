import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import { ReviewService, parseDiffLines } from "../src/reviews.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
async function fixture(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-rev-"))),
    root = join(base, "project");
  await mkdir(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
  await writeFile(join(root, "b.txt"), "x\ny\n");
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
  return { root, store, team, agent, reviews: new ReviewService(team, ws) };
}
const s = (root: string) => ({ workspace: root, staged: false });

test("comments persist with anchor, delivery and resolve state", async (t) => {
  const { root, store, agent, reviews } = await fixture(t);
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  const c = await reviews.comment(agent.id, {
    ...s(root),
    path: "a.txt",
    side: "new",
    line: 2,
    targetId: agent.id,
    text: "why uppercase?",
    requestId: randomUUID(),
  });
  assert.equal(c.lineText, "+TWO");
  assert.equal(c.delivery, "queued");
  const st = await reviews.state(agent.id, s(root));
  assert.equal(st.comments.length, 1);
  assert.equal(st.comments[0].outdated, false);
  assert.equal(st.summary.unresolved, 1);
  // survives a new service instance over the same store
  const again = store.list("review-comment");
  assert.equal(again.length, 1);
  assert.equal(store.list("message").length, 1);
  reviews.resolve(agent.id, { id: c.id, resolved: true });
  assert.equal((await reviews.state(agent.id, s(root))).summary.resolved, 1);
  // idempotent by requestId
  const dup = await reviews.comment(agent.id, {
    ...s(root),
    path: "a.txt",
    side: "new",
    line: 2,
    targetId: agent.id,
    text: "again",
    requestId: c.id,
  });
  assert.equal(dup.id, c.id);
  assert.equal(store.list("review-comment").length, 1);
  await assert.rejects(
    reviews.comment(agent.id, {
      ...s(root),
      path: "a.txt",
      side: "new",
      line: 99,
      targetId: agent.id,
      text: "x",
      requestId: randomUUID(),
    }),
    { code: "invalid_line" },
  );
});

test("comment against a stale diff snapshot is rejected and sends nothing", async (t) => {
  const { root, store, agent, reviews } = await fixture(t);
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  await assert.rejects(
    reviews.comment(agent.id, {
      ...s(root),
      path: "a.txt",
      side: "new",
      line: 2,
      diffHash: "0".repeat(64),
      targetId: agent.id,
      text: "q",
      requestId: randomUUID(),
    }),
    { code: "review_changed" },
  );
  assert.equal(store.list("review-comment").length, 0);
  assert.equal(store.list("message").length, 0);
});

test("comment becomes outdated when the diff no longer contains its anchor", async (t) => {
  const { root, agent, reviews } = await fixture(t);
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  await reviews.comment(agent.id, {
    ...s(root),
    path: "a.txt",
    side: "new",
    line: 2,
    targetId: agent.id,
    text: "q",
    requestId: randomUUID(),
  });
  await writeFile(join(root, "a.txt"), "one\nTwo!\nthree\nfour\n");
  assert.equal(
    (await reviews.state(agent.id, s(root))).comments[0].outdated,
    true,
  );
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  assert.equal(
    (await reviews.state(agent.id, s(root))).comments[0].outdated,
    false,
  );
  git(root, "checkout", "--", "a.txt");
  const st = await reviews.state(agent.id, s(root));
  assert.equal(st.comments[0].outdated, true);
  assert.equal(st.summary.unresolved, 0);
});

test("reviewed markers are invalidated when file content changes", async (t) => {
  const { root, agent, reviews } = await fixture(t);
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  await writeFile(join(root, "b.txt"), "x\nY\n");
  await reviews.setReviewed(agent.id, {
    ...s(root),
    path: "a.txt",
    reviewed: true,
  });
  let st = await reviews.state(agent.id, s(root));
  assert.deepEqual(st.reviewed, { "a.txt": true, "b.txt": false });
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nFOUR\n");
  st = await reviews.state(agent.id, s(root));
  assert.equal(st.reviewed["a.txt"], false);
  await reviews.setReviewed(agent.id, {
    ...s(root),
    path: "a.txt",
    reviewed: true,
  });
  await reviews.setReviewed(agent.id, {
    ...s(root),
    path: "a.txt",
    reviewed: false,
  });
  assert.equal(
    (await reviews.state(agent.id, s(root))).reviewed["a.txt"],
    false,
  );
});

test("approve records a decision without touching git; request changes messages the recipient", async (t) => {
  const { root, store, agent, reviews } = await fixture(t);
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
  const headBefore = git(root, "rev-parse", "HEAD");
  const statusBefore = git(root, "status", "--porcelain");
  const c = await reviews.comment(agent.id, {
    ...s(root),
    path: "a.txt",
    side: "new",
    line: 2,
    targetId: agent.id,
    text: "fix",
    requestId: randomUUID(),
  });
  await assert.rejects(
    reviews.decide(agent.id, { ...s(root), decision: "approved" }),
    { code: "unresolved_comments" },
  );
  await assert.rejects(
    reviews.decide(agent.id, { ...s(root), decision: "changes_requested" }),
    { code: "recipient_required" },
  );
  const rc = await reviews.decide(agent.id, {
    ...s(root),
    decision: "changes_requested",
    targetId: agent.id,
    note: "please revise",
  });
  assert.ok(rc.messageId);
  assert.equal(store.list("message").length, 2);
  reviews.resolve(agent.id, { id: c.id, resolved: true });
  await reviews.decide(agent.id, { ...s(root), decision: "approved" });
  let st = await reviews.state(agent.id, s(root));
  assert.equal(st.decision?.decision, "approved");
  assert.equal(st.decision?.stale, false);
  assert.equal(git(root, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(root, "status", "--porcelain"), statusBefore);
  assert.equal(git(root, "rev-list", "--count", "HEAD").trim(), "1");
  await writeFile(join(root, "a.txt"), "one\nTWO\nthree\nFOUR\n");
  st = await reviews.state(agent.id, s(root));
  assert.equal(st.decision?.stale, true);
});

test("paths outside the workspace, git internals and foreign workspaces are rejected", async (t) => {
  const { root, agent, reviews } = await fixture(t);
  for (const path of [
    "../outside.txt",
    "/etc/passwd",
    ".git/config",
    "a/../../x",
  ])
    await assert.rejects(
      reviews.comment(agent.id, {
        ...s(root),
        path,
        side: "new",
        line: 1,
        targetId: agent.id,
        text: "x",
        requestId: randomUUID(),
      }),
    );
  await assert.rejects(
    reviews.setReviewed(agent.id, { ...s(root), path: "../x", reviewed: true }),
    { code: "path_escape" },
  );
  await assert.rejects(
    reviews.setReviewed(agent.id, {
      ...s(root),
      path: "a.txt",
      reviewed: true,
    }),
    { code: "change_missing" },
  );
  await assert.rejects(
    reviews.state(agent.id, { workspace: tmpdir(), staged: false }),
    {
      code: "workspace_denied",
    },
  );
});

test("parseDiffLines numbers old and new sides", () => {
  const lines = parseDiffLines(
    "diff --git a/f b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n",
  );
  assert.deepEqual(
    lines.map((l) => `${l.side}${l.line}${l.text}`),
    ["new1 a", "old1 a", "old2-b", "new2+c"],
  );
});
