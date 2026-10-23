import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { FilesystemPolicy } from "../src/filesystem-policy.ts";
import { TeamService } from "../src/service.ts";
import { SkillCatalog } from "../src/skills.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import { EditorService } from "../src/editors.ts";
import { GitWorkflow } from "../src/git-workflow.ts";
import { Approvals } from "../src/approvals.ts";
import { explainWaiting } from "../src/inspector.ts";
import { AssistantProposals } from "../src/assistant.ts";

async function world(t: any) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-global-fs-")),
  );
  const allowed = join(root, "allowed"),
    blocked = join(root, "blocked");
  await mkdir(allowed);
  await mkdir(blocked);
  await writeFile(join(allowed, "note.txt"), "allowed");
  await writeFile(join(blocked, "note.txt"), "private");
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    policy = new FilesystemPolicy(store);
  const agent = await service.saveAgent({
    name: "Writer",
    environment: "codex",
    tools: ["read", "write"],
    workspaces: [
      { path: allowed, access: "write", active: true },
      { path: blocked, access: "write" },
    ],
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    allowed,
    blocked,
    store,
    service,
    policy,
    agent,
    ws: new WorkspaceService(store),
  };
}

test("global denials override writable attachments, hash-valid saves, confirmations and provider launch", async (t) => {
  const w = await world(t);
  const loaded = await w.ws.readText(w.agent.id, {
    workspace: w.blocked,
    path: "note.txt",
  });
  const workflow = w.service.workflow({
    name: "Policy fixture",
    goal: "Test blocked execution",
    ownerId: w.agent.id,
    completionCriteria: "done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: w.agent.id,
    title: "Read allowed folder",
    completionCriteria: "done",
    resourcePaths: [w.allowed],
  });
  w.policy.add({ paths: [w.blocked], acknowledgePermanent: true });
  assert.equal(
    w.service.taskState(task.id).waitReason,
    "global-filesystem-block",
  );
  assert.ok(
    explainWaiting(
      w.service,
      { liveEnabled: () => true },
      { taskId: task.id },
    ).reasons.some(
      (reason) => reason.code === "global-filesystem-block" && reason.blocking,
    ),
  );
  for (const operation of [
    () => w.ws.readText(w.agent.id, { workspace: w.blocked, path: "note.txt" }),
    () =>
      w.ws.saveText(w.agent.id, {
        workspace: w.blocked,
        path: "note.txt",
        content: "overwrite",
        expectedHash: loaded.hash,
      }),
    () =>
      w.ws.createText(w.agent.id, {
        workspace: w.blocked,
        path: "new.txt",
        content: "no",
      }),
    () =>
      w.service.saveAgent(
        {
          name: "Writer",
          environment: "codex",
          workspaces: [{ path: w.blocked, access: "write", active: true }],
        },
        w.agent.id,
      ),
  ])
    await assert.rejects(
      async () => {
        await operation();
      },
      { code: "filesystem_blocked" },
    );
  await assert.rejects(w.service.launchPlan(w.agent.id), {
    code: "filesystem_sandbox_required",
  });
  assert.equal(await readFile(join(w.blocked, "note.txt"), "utf8"), "private");
  const safe = await w.ws.readText(w.agent.id, {
    workspace: w.allowed,
    path: "note.txt",
  });
  await w.ws.saveText(w.agent.id, {
    workspace: w.allowed,
    path: "note.txt",
    content: "edited",
    expectedHash: safe.hash,
  });
  assert.equal(await readFile(join(w.allowed, "note.txt"), "utf8"), "edited");
});

test("blocks are additive and immutable, cover ancestors/case/junction aliases, and survive reopening", async (t) => {
  const w = await world(t);
  w.policy.add({ paths: [w.blocked], acknowledgePermanent: true });
  assert.throws(() => w.policy.assertPath(w.blocked.toUpperCase()), {
    code: "filesystem_blocked",
  });
  assert.throws(() => w.policy.assertPath(w.root), {
    code: "filesystem_blocked",
  });
  w.policy.assertPath(w.blocked + "-different");
  const alias = join(w.root, "alias");
  await symlink(
    w.blocked,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => w.policy.assertPath(join(alias, "not-created.txt")), {
    code: "filesystem_blocked",
  });
  assert.throws(
    () => w.store.db.exec("DELETE FROM entities WHERE kind='filesystem-block'"),
    /permanent/,
  );
  assert.throws(
    () =>
      w.store.put("filesystem-block", {
        ...w.policy.blocks()[0],
        path: w.allowed,
      }),
    /permanent/,
  );
  assert.throws(() => w.policy.add({ paths: [], acknowledgePermanent: true }));
  assert.throws(() =>
    w.policy.add({
      paths: [w.allowed],
      acknowledgePermanent: true,
      override: true,
    }),
  );
  assert.equal(new FilesystemPolicy(w.store).blocks().length, 1);
});

test("external launch and live/restored approvals have no override when global blocks exist", async (t) => {
  const w = await world(t);
  const approvals = new Approvals(w.store);
  const request: any = {
    sessionId: "fixture",
    toolCall: {
      toolCallId: "tool",
      title: "Read file",
      kind: "read",
      locations: [{ path: join(w.blocked, "note.txt") }],
    },
    options: [
      { optionId: "allow", name: "Allow always", kind: "allow_always" },
    ],
  };
  const pending = approvals.request(
    w.agent.id,
    request,
    new AbortController().signal,
    "task",
  );
  const id = approvals.list()[0].id;
  w.policy.add({ paths: [w.blocked], acknowledgePermanent: true });
  assert.throws(() => approvals.respond(id, "allow"), {
    code: "filesystem_sandbox_required",
  });
  assert.throws(() => new Approvals(w.store).respond(id, "allow"), {
    code: "filesystem_sandbox_required",
  });
  approvals.respond(id, null);
  await pending;
  assert.deepEqual(
    await approvals.request(w.agent.id, request, new AbortController().signal),
    { outcome: { outcome: "cancelled" } },
  );
  await assert.rejects(
    new EditorService(w.store, w.ws).open(
      w.agent.id,
      { workspace: w.allowed, path: "note.txt", action: "file" },
      true,
    ),
    { code: "filesystem_sandbox_required" },
  );
  await assert.rejects(
    new GitWorkflow(w.store, w.ws).state(w.agent.id, { workspace: w.allowed }),
    { code: "filesystem_sandbox_required" },
  );
});

test("assistant previews preserve the live catalog guard and cannot approve a globally blocked attachment", async (t) => {
  const w = await world(t);
  const proposals = new AssistantProposals(w.service);
  const actor = { type: "user" } as const;
  await proposals.create(
    {
      title: "Rename worker",
      ops: [
        { op: "agent.update", id: w.agent.id, changes: { name: "Renamed" } },
      ],
    },
    actor,
  );
  // The preview store is closed now; live access must still use the live profile's policy.
  w.service.skills.assertPath!(w.allowed);
  w.policy.add({ paths: [w.blocked], acknowledgePermanent: true });
  await assert.rejects(
    proposals.create(
      {
        title: "Approve denied folder",
        ops: [
          {
            op: "agent.update",
            id: w.agent.id,
            changes: {
              workspaces: [{ path: w.blocked, access: "write", active: true }],
            },
          },
        ],
      },
      actor,
    ),
    /filesystem_blocked/,
  );
  assert.throws(() => w.service.skills.assertPath!(w.blocked), {
    code: "filesystem_blocked",
  });
});
