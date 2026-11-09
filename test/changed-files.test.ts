import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import type { ChangedFilesEvidence } from "../src/changed-files.ts";
import type { Task } from "../src/model.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args],
    { stdio: "ignore" },
  );

async function fixture(useGit: boolean) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agentteam-cf-")));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "README.md"), "hello\n");
  await writeFile(join(dir, "dirty.txt"), "before\n");
  if (useGit) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    // Already modified before the task starts: not the task's change.
    await writeFile(join(dir, "dirty.txt"), "edited earlier\n");
  }
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const dev = await service.saveAgent({
    name: "Dev",
    environment: "codex",
    workspaces: [{ path: dir, access: "write", active: true }],
  });
  const dba = await service.saveAgent({
    name: "DBA",
    environment: "codex",
    roleType: "reviewer",
  });
  service.saveEdge({ from: dev.id, to: dba.id, kind: "review" });
  // A files-only mandatory rule: no text, tag or catch-all fallback.
  service.saveRule({
    agentId: dba.id,
    scope: "intake",
    priority: 10,
    mode: "mandatory",
    specialty: "database",
    kind: "review",
    match: { changedFilesAny: ["**/migrations/**"] },
  });
  const workflow = service.workflow({
    name: "W",
    goal: "G",
    ownerId: dev.id,
    completionCriteria: "D",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: dev.id,
    title: "Add column",
    completionCriteria: "D",
  });
  service.transitionTask(task.id, { status: "running" });
  return { dir, store, service, task };
}
const complete = (f: Awaited<ReturnType<typeof fixture>>, result: string) =>
  f.service.transitionTask(f.task.id, { status: "completed", result });
const reviews = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.store
    .list<Task>("task")
    .filter((t) => /Required database review/.test(t.title));

test("a task that omits changedFiles still triggers a files-only rule when Git measured the change", async () => {
  const f = await fixture(true);
  await writeFile(join(f.dir, "db", "migrations", "002.sql"), "alter;\n");
  complete(f, "done, no file list reported");
  assert.equal(reviews(f).length, 1, "required review created from Git");
  const evidence = f.store.get<ChangedFilesEvidence>(
    "task-changed-files",
    f.task.id,
  );
  assert.equal(evidence.source, "git");
  assert.deepEqual(evidence.measured, ["db/migrations/002.sql"]);
  assert.deepEqual(evidence.declared, []);
  f.store.close();
});

test("a tracked file edited by the task is measured; files dirty before the task started are not", async () => {
  const f = await fixture(true);
  await writeFile(join(f.dir, "README.md"), "changed\n");
  complete(f, "done");
  const evidence = f.store.get<ChangedFilesEvidence>(
    "task-changed-files",
    f.task.id,
  );
  assert.deepEqual(evidence.measured, ["README.md"]);
  assert.equal(reviews(f).length, 0, "no migration changed");
  f.store.close();
});

test("measured and declared files are unioned", async () => {
  const f = await fixture(true);
  await writeFile(join(f.dir, "README.md"), "changed\n");
  complete(
    f,
    JSON.stringify({ summary: "s", changedFiles: ["db/migrations/9.sql"] }),
  );
  const evidence = f.store.get<ChangedFilesEvidence>(
    "task-changed-files",
    f.task.id,
  );
  assert.deepEqual(evidence.files.sort(), ["README.md", "db/migrations/9.sql"]);
  assert.equal(reviews(f).length, 1);
  f.store.close();
});

test("outside Git the declared files are used and the evidence says declared", async () => {
  const f = await fixture(false);
  await writeFile(join(f.dir, "db", "migrations", "002.sql"), "alter;\n");
  complete(f, "done, no file list reported");
  assert.equal(reviews(f).length, 0, "nothing measurable, nothing declared");
  const evidence = f.store.get<ChangedFilesEvidence>(
    "task-changed-files",
    f.task.id,
  );
  assert.equal(evidence.source, "declared");
  assert.deepEqual(evidence.measured, []);
  f.store.close();
});

test("outside Git a declared file still routes", async () => {
  const f = await fixture(false);
  complete(
    f,
    JSON.stringify({ summary: "s", changedFiles: ["db/migrations/3.sql"] }),
  );
  assert.equal(reviews(f).length, 1);
  assert.equal(
    f.store.get<ChangedFilesEvidence>("task-changed-files", f.task.id).source,
    "declared",
  );
  f.store.close();
});
