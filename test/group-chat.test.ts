import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { GroupChats } from "../src/group-chat.ts";
import { mayShareExcerpt } from "../src/resource-sharing.ts";

function setup() {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const agent = (name: string, extra: object = {}) =>
    service.saveAgent({ name, environment: "codex", ...extra });
  return { store, service, agent };
}

test("invocation group chat fans human comments to participants and records replies", async () => {
  const { store, service, agent } = setup();
  const manager = await agent("Manager");
  const builder = await agent("Builder");
  const reviewer = await agent("Reviewer");
  service.saveEdge({ from: manager.id, to: builder.id, kind: "delegate" });
  service.saveEdge({ from: manager.id, to: reviewer.id, kind: "review" });
  const workflow = service.workflow({
    name: "Demo",
    goal: "Demo",
    ownerId: manager.id,
    completionCriteria: "Done",
  });
  const parent = service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Coordinate demo",
    completionCriteria: "Done",
  });
  service.transitionTask(parent.id, { status: "running" });
  const handoff = service.orchestration.invokeTeammate(
    { agentId: manager.id, taskId: parent.id },
    { recipient: builder.id, title: "Build it" },
  );
  const groupChats = new GroupChats(service);
  const chat = groupChats.create(handoff.childTaskId);
  assert.equal(groupChats.list(workflow.teamId).length, 1);
  const started: string[] = [];
  const result = await groupChats.comment(
    chat.id,
    { text: "Please explain the design choice." },
    async (sessionId) => started.push(sessionId),
  );
  assert.equal(result.participants, 2);
  assert.equal(started.length, 2);
  assert.equal(
    groupChats.get(chat.id).messages[0].text,
    "Please explain the design choice.",
  );
  const hiddenMessages = store
    .list<any>("message")
    .filter((message) => message.groupChatId === chat.id);
  assert.equal(hiddenMessages.length, 2);
  assert.ok(
    hiddenMessages.every((message) =>
      message.text.includes("shared AgentTeam conversation"),
    ),
  );

  const invited = await groupChats.invite(
    chat.id,
    { agentId: reviewer.id },
    async (sessionId) => started.push(sessionId),
  );
  assert.ok(invited.chat.participantIds.includes(reviewer.id));
  assert.equal(started.length, 3);
  groupChats.recordReply(chat.id, builder.id, "Use exact arithmetic.");
  assert.equal(
    groupChats.get(chat.id).messages.at(-1)?.senderAgentId,
    builder.id,
  );
});

test("file excerpts cross agent conversations only with recipient access or an explicit share grant", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentteam-sharing-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const folder = join(root, "source");
  await mkdir(folder);
  await writeFile(join(folder, "notes.md"), "shared note");
  await writeFile(join(folder, "private.md"), "private note");
  const outside = join(root, "outside.md");
  await writeFile(outside, "outside secret");
  await symlink(outside, join(folder, "escape.md"));
  const { agent } = setup();
  const owner = await agent("Owner", {
    workspaces: [
      {
        path: folder,
        access: "read",
        active: true,
        sharing: { scope: "nobody", agentIds: [] },
        shareRules: [{ path: "private.md", scope: "nobody", agentIds: [] }],
      },
    ],
  });
  const recipient = await agent("Recipient");
  const attachedPath = owner.workspaces[0].path;
  assert.equal(
    mayShareExcerpt(owner, recipient, attachedPath, "notes.md"),
    false,
  );

  owner.workspaces[0].sharing = { scope: "selected", agentIds: [recipient.id] };
  assert.equal(
    mayShareExcerpt(owner, recipient, attachedPath, "notes.md"),
    true,
  );
  assert.equal(
    mayShareExcerpt(owner, recipient, attachedPath, "private.md"),
    false,
  );
  owner.workspaces[0].sharing = { scope: "team", agentIds: [] };
  assert.equal(
    mayShareExcerpt(owner, recipient, attachedPath, "notes.md"),
    true,
  );
  owner.workspaces[0].sharing = { scope: "all", agentIds: [] };
  assert.equal(
    mayShareExcerpt(owner, recipient, attachedPath, "escape.md"),
    false,
    "a shared symlink must not let a recipient read outside its attached folder",
  );

  const sharedReader = await agent("Shared reader", {
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  owner.workspaces[0].sharing = { scope: "nobody", agentIds: [] };
  assert.equal(
    mayShareExcerpt(owner, sharedReader, attachedPath, "private.md"),
    true,
  );
});

test("invoke_teammate rejects file excerpts without shared resource access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentteam-handoff-sharing-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const folder = join(root, "source");
  await mkdir(folder);
  await writeFile(join(folder, "notes.md"), "private source file");
  const { store, service, agent } = setup();
  const owner = await agent("Owner", {
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  const recipient = await agent("Recipient");
  service.saveEdge({ from: owner.id, to: recipient.id, kind: "delegate" });
  const workflow = service.workflow({
    name: "Handoff",
    goal: "Handoff",
    ownerId: owner.id,
    completionCriteria: "Done",
  });
  const parent = service.task({
    workflowId: workflow.id,
    agentId: owner.id,
    title: "Share a resource",
    completionCriteria: "Done",
  });
  service.transitionTask(parent.id, { status: "running" });
  const args = {
    recipient: recipient.id,
    title: "Review excerpt",
    context: {
      resources: [
        {
          workspacePath: owner.workspaces[0].path,
          path: "notes.md",
          content: "short excerpt",
        },
      ],
    },
  };
  assert.throws(
    () =>
      service.orchestration.invokeTeammate(
        { agentId: owner.id, taskId: parent.id },
        args,
      ),
    { code: "resource_share_denied" },
  );
  assert.equal(store.list<any>("invocation").length, 0);

  const updated = {
    ...owner,
    workspaces: [
      {
        ...owner.workspaces[0],
        sharing: { scope: "selected" as const, agentIds: [recipient.id] },
      },
    ],
  };
  store.put("agent", updated);
  const allowed = service.orchestration.invokeTeammate(
    { agentId: owner.id, taskId: parent.id },
    args,
  );
  const child = store.get<any>("task", allowed.childTaskId);
  assert.match(child.instructions, /short excerpt/);
});

test("delegated tasks can reserve disjoint workspace folders without sharing file contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentteam-handoff-paths-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const { store, service, agent } = setup();
  const manager = await agent("Manager");
  const cpp = await agent("C++ Builder", {
    workspaces: [{ path: workspace, access: "write", active: true }],
  });
  const python = await agent("Python Builder", {
    workspaces: [{ path: workspace, access: "write", active: true }],
  });
  service.saveEdge({ from: manager.id, to: cpp.id, kind: "delegate" });
  service.saveEdge({ from: manager.id, to: python.id, kind: "delegate" });
  const workflow = service.workflow({
    name: "Parallel implementations",
    goal: "Write separate files",
    ownerId: manager.id,
    completionCriteria: "Done",
  });
  const parent = service.task({
    workflowId: workflow.id,
    agentId: manager.id,
    title: "Delegate implementations",
    completionCriteria: "Both builders finish",
  });
  service.transitionTask(parent.id, { status: "running" });
  const delegate = (recipient: string, name: string, folder: string) =>
    service.orchestration.invokeTeammate(
      { agentId: manager.id, taskId: parent.id },
      {
        recipient,
        title: `Write ${name}`,
        instructions: `Write only in ${name}`,
        resourcePaths: [join(workspace, folder)],
      },
    );
  const cppTask = delegate(cpp.id, "C++", "cpp");
  const pythonTask = delegate(python.id, "Python", "python");
  const first = store.get<any>("task", cppTask.childTaskId);
  const second = store.get<any>("task", pythonTask.childTaskId);
  assert.deepEqual(first.resourcePaths, [join(canonicalWorkspace, "cpp")]);
  assert.deepEqual(second.resourcePaths, [join(canonicalWorkspace, "python")]);
  service.resources.acquire(first.id, cpp.id, workflow.id);
  assert.deepEqual(
    service.resources.conflicts(python.id, workflow.id, second.id),
    [],
    "a builder's lease must not block another builder's disjoint folder",
  );
  assert.equal(
    store
      .list<any>("message")
      .some((message) => message.text?.includes("resourcePaths")),
    false,
    "path scopes travel as task metadata, never as file contents in chat",
  );
});
