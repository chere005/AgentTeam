import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import {
  ensureWorkspaceBaseline,
  workspaceChanges,
} from "../src/workspace-changes.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-folder-diff-")),
  );
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const agent = await service.saveAgent({
    name: "Writer",
    environment: "claude",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, agent };
}

test("a saved folder path cannot reveal Git internals after its parent becomes a symlink", async (t) => {
  const { root, store, agent } = await fixture(t);
  const alias = join(root, "alias");
  await mkdir(alias);
  await mkdir(join(root, ".git"));
  await writeFile(join(alias, "secret.txt"), "ordinary allowed file\n");
  await writeFile(join(root, ".git", "secret.txt"), "GIT INTERNAL SECRET\n");
  store.remove("workspace-baseline", `${agent.id}::${root}`);
  await ensureWorkspaceBaseline(store, agent, root);
  await rm(alias, { recursive: true });
  try {
    await symlink(
      join(root, ".git"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      ["EPERM", "EACCES", "ENOTSUP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      t.skip("Directory symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const review = await workspaceChanges(store, agent, root, "alias/secret.txt");
  assert.ok(review.files.every((file) => file.path !== "alias/secret.txt"));
  assert.equal(review.diff, "");
  assert.equal(review.currentContent, undefined);
  assert.doesNotMatch(JSON.stringify(review), /GIT INTERNAL SECRET/);
});

test("broad folder review prioritizes duty files and never fabricates deletions when the scan limit shifts", async (t) => {
  const { root, store, agent } = await fixture(t);
  const project = join(root, "a-large-project");
  await mkdir(project);
  for (let start = 0; start < 2000; start += 50)
    await Promise.all(
      Array.from({ length: 50 }, (_, offset) =>
        writeFile(join(project, `source-${start + offset}.txt`), "existing\n"),
      ),
    );
  // Reproduce an old full-budget snapshot without the coverage/version metadata introduced here.
  store.remove("workspace-baseline", `${agent.id}::${root}`);
  await ensureWorkspaceBaseline(store, agent, root);
  const baseline = store.get<{
    id: string;
    scanVersion?: number;
    accessFingerprint?: string;
    truncated: boolean;
    files: Record<string, unknown>;
  }>("workspace-baseline", `${agent.id}::${root}`);
  assert.equal(Object.keys(baseline.files).length, 2000);
  delete baseline.scanVersion;
  delete baseline.accessFingerprint;
  baseline.truncated = false;
  store.put("workspace-baseline", baseline);
  const saved = JSON.stringify(baseline);
  await writeFile(
    join(root, "Pipeline Planner.txt"),
    "I am Pipeline Planner, reporting for duty.\n",
  );
  await writeFile(join(project, "source-1999.txt"), "modified known file\n");
  const review = await workspaceChanges(
    store,
    agent,
    root,
    "Pipeline Planner.txt",
  );
  assert.equal(review.scanIncomplete, true);
  assert.equal(review.filesTruncated, true);
  assert.equal(review.baselineIncomplete, true);
  assert.deepEqual(
    review.files.find((file) => file.path === "Pipeline Planner.txt"),
    { path: "Pipeline Planner.txt", status: "??" },
  );
  assert.equal(
    review.files.find((file) => file.path === "a-large-project/source-1999.txt")
      ?.status,
    "M ",
  );
  assert.ok(review.files.every((file) => file.status !== "D "));
  assert.equal(
    review.currentContent,
    "I am Pipeline Planner, reporting for duty.\n",
  );
  assert.match(review.comparisonNote ?? "", /earlier contents are unavailable/);
  assert.equal(review.diff, "");
  assert.equal(review.meta, null);
  assert.equal(
    JSON.stringify(store.get("workspace-baseline", baseline.id)),
    saved,
    "Review never resets or rewrites the user's old baseline",
  );
});

test("complete folder baselines retain real additions/modifications/deletions while revoked and nested-denied files stay private", async (t) => {
  const { root, store, agent } = await fixture(t);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "known.txt"), "old text\n");
  await writeFile(join(root, "removed.txt"), "removed content\n");
  await writeFile(join(root, "secret.txt"), "SECRET OLD CONTENT\n");
  await writeFile(join(root, "nested", "secret.txt"), "NESTED OLD SECRET\n");
  store.remove("workspace-baseline", `${agent.id}::${root}`);
  await ensureWorkspaceBaseline(store, agent, root);
  await writeFile(join(root, "known.txt"), "new text\n");
  await writeFile(join(root, "new.txt"), "new file\n");
  await rm(join(root, "removed.txt"));
  const normal = await workspaceChanges(store, agent, root, "new.txt");
  assert.equal(normal.scanIncomplete, false);
  assert.equal(normal.baselineIncomplete, false);
  assert.equal(
    normal.files.find((file) => file.path === "new.txt")?.status,
    "A ",
  );
  assert.match(normal.diff, /\+new file/);
  const restricted = {
    ...agent,
    workspaces: [
      {
        ...agent.workspaces[0],
        rules: [{ path: "secret.txt", access: "none" as const }],
      },
      {
        path: join(root, "nested"),
        access: "read" as const,
        active: false,
        explicitOnly: true,
      },
    ],
  };
  const review = await workspaceChanges(store, restricted, root, "secret.txt");
  assert.equal(
    review.files.find((file) => file.path === "known.txt")?.status,
    "M ",
  );
  assert.equal(
    review.files.find((file) => file.path === "removed.txt")?.status,
    "D ",
  );
  assert.ok(review.files.every((file) => !file.path.includes("secret")));
  assert.equal(review.diff, "");
  assert.equal(review.currentContent, undefined);
  assert.doesNotMatch(
    JSON.stringify(review),
    /SECRET OLD CONTENT|NESTED OLD SECRET/,
  );
  const known = await workspaceChanges(store, restricted, root, "known.txt");
  assert.match(known.diff, /-old text/);
  assert.match(known.diff, /\+new text/);
  assert.equal(
    await readFile(join(root, "secret.txt"), "utf8"),
    "SECRET OLD CONTENT\n",
  );
});
