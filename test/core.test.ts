import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  rm,
  stat,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import {
  commandFor,
  decodeEvent,
  RunManager,
  executeCommand,
} from "../src/runtime.ts";
import {
  AppError,
  type Task,
  type Agent,
  type Session,
  type Message,
} from "../src/model.ts";
function fixture(t: any) {
  const store = new Store(":memory:"),
    skills = new SkillCatalog([]),
    service = new TeamService(store, skills);
  t.after(() => store.close());
  return { store, skills, service };
}
const agent = (name: string, environment = "codex") => ({ name, environment });
const code = (expected: string) => (e: unknown) =>
  e instanceof AppError && e.code === expected;
test("agent configurations persist across a restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "db");
  const store = new Store(path),
    service = new TeamService(store, new SkillCatalog([]));
  const a = await service.saveAgent({
    ...agent("Builder"),
    nickname: "Pi Builder",
    avatar:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    instructions: "Always explain changes",
    effort: "high",
  });
  store.close();
  const second = new Store(path);
  assert.equal(
    second.get<Agent>("agent", a.id).instructions,
    "Always explain changes",
  );
  assert.equal(second.get<Agent>("agent", a.id).effort, "high");
  assert.equal(second.get<Agent>("agent", a.id).nickname, "Pi Builder");
  assert.equal(second.get<Agent>("agent", a.id).avatar, a.avatar);
  assert.equal(second.get<Agent>("agent", a.id).name, "Builder");
  assert.equal(second.get<Agent>("agent", a.id).id, a.id);
  second.close();
});

test("agent identity rejects unsafe avatars and oversized or control-character nicknames", async (t) => {
  const { service } = fixture(t);
  await assert.rejects(
    service.saveAgent({
      ...agent("Unsafe avatar"),
      avatar: "https://example.test/a.png",
    }),
  );
  await assert.rejects(
    service.saveAgent({
      ...agent("SVG avatar"),
      avatar: "data:image/svg+xml;base64,PHN2Zz4=",
    }),
  );
  await assert.rejects(
    service.saveAgent({
      ...agent("Oversized nickname"),
      nickname: "x".repeat(41),
    }),
  );
  await assert.rejects(
    service.saveAgent({ ...agent("Control nickname"), nickname: "name\nrole" }),
  );
});
test("transactions roll back entities AND audit events", (t) => {
  const { store } = fixture(t);
  let emitted = 0;
  store.events.on("event", () => emitted++);
  assert.throws(() =>
    store.transaction(() => {
      store.put("test", { id: "a" });
      store.emit("created", "a");
      throw new Error("rollback");
    }),
  );
  assert.equal(store.list("test").length, 0);
  assert.equal(store.history().length, 0);
  assert.equal(emitted, 0);
});
test("routing honors priority, graph permissions and explicit recipients", async (t) => {
  const { service } = fixture(t);
  const a = await service.saveAgent(agent("Lead")),
    b = await service.saveAgent(agent("Python")),
    c = await service.saveAgent(agent("Review"));
  service.saveEdge({ from: a.id, to: b.id, kind: "delegate" });
  service.saveRule({
    agentId: b.id,
    scope: "intake",
    priority: 10,
    match: { textIncludes: ["python"] },
  });
  service.saveRule({
    agentId: c.id,
    scope: "intake",
    priority: 99,
    match: { textIncludes: ["python"] },
  });
  assert.equal(
    service.route({ text: "python task", fromAgentId: a.id }).agentId,
    b.id,
  );
  assert.equal(service.route({ text: "python task" }).agentId, c.id);
  assert.throws(
    () => service.route({ text: "x", fromAgentId: a.id, targetId: c.id }),
    code("connection_denied"),
  );
  assert.equal(service.route({ text: "x", targetId: b.id }).agentId, b.id);
});
test("action rules compete with intake rules; equal priority is surfaced", async (t) => {
  const { service } = fixture(t);
  const a = await service.saveAgent(agent("Lead")),
    b = await service.saveAgent(agent("Builder")),
    c = await service.saveAgent(agent("Other"));
  for (const target of [b, c])
    service.saveEdge({ from: a.id, to: target.id, kind: "delegate" });
  service.saveRule({
    agentId: b.id,
    scope: "intake",
    priority: 50,
    match: { catchAll: true },
  });
  service.saveRule({
    agentId: a.id,
    targetId: c.id,
    scope: "action",
    priority: 50,
    match: { catchAll: true },
  });
  assert.equal(
    service.route({ text: "work", fromAgentId: a.id }).status,
    "ambiguous",
  );
});
test("one-way and bidirectional edges respect communication kind", async (t) => {
  const { service } = fixture(t);
  const a = await service.saveAgent(agent("A")),
    b = await service.saveAgent(agent("B"));
  service.saveEdge({
    from: a.id,
    to: b.id,
    kind: "review",
    bidirectional: true,
  });
  assert.equal(service.permitted(b.id, a.id, "review"), true);
  assert.equal(service.permitted(b.id, a.id, "delegate"), false);
});
test("hierarchy rejects indirect cycles and duplicated team assistants", async (t) => {
  const { service } = fixture(t);
  const a = await service.saveAgent(agent("A"));
  const b = await service.saveAgent({ ...agent("B"), parentId: a.id });
  await assert.rejects(
    service.saveAgent({ ...agent("A"), parentId: b.id }, a.id),
    code("parent_cycle"),
  );
  await service.saveAgent({
    ...agent("Team Assistant"),
    kind: "team-assistant",
  });
  await assert.rejects(
    service.saveAgent({ ...agent("Duplicate"), kind: "team-assistant" }),
    code("duplicate_assistant"),
  );
});
test("workflow dependencies, pause and human control gate task claims", async (t) => {
  const { service } = fixture(t);
  const a = await service.saveAgent(agent("Builder"));
  const wf = service.workflow({
    name: "Build",
    goal: "Ship",
    ownerId: a.id,
    completionCriteria: "Review accepted",
  });
  const first = service.task({
    workflowId: wf.id,
    agentId: a.id,
    title: "Build",
    completionCriteria: "Tests pass",
  });
  const second = service.task({
    workflowId: wf.id,
    agentId: a.id,
    title: "Review",
    completionCriteria: "Reviewed",
    dependsOn: [first.id],
  });
  assert.throws(
    () => service.transitionTask(second.id, { status: "running" }),
    code("dependency_pending"),
  );
  service.control(a.id, "human");
  assert.equal(service.taskState(first.id).waitReason, "human-control");
  assert.throws(
    () => service.transitionTask(first.id, { status: "running" }),
    code("human_control"),
  );
  service.control(a.id, "team");
  service.pauseWorkflow(wf.id, true);
  assert.throws(
    () => service.transitionTask(first.id, { status: "running" }),
    code("workflow_paused"),
  );
  service.pauseWorkflow(wf.id, false);
  service.transitionTask(first.id, { status: "running" });
  assert.throws(() => service.control(a.id, "human"), code("agent_busy"));
  assert.throws(
    () => service.transitionTask(first.id, { status: "completed" }),
    code("result_required"),
  );
  service.transitionTask(first.id, {
    status: "completed",
    result: "Tests pass",
  });
  service.transitionTask(second.id, { status: "running" });
  service.transitionTask(second.id, {
    status: "completed",
    result: "Reviewed",
  });
  assert.equal(service.workflowStatus(wf.id).status, "completed");
  assert.throws(
    () => service.transitionTask(first.id, { status: "running" }),
    code("invalid_transition"),
  );
});
test("sessions are persistent per agent and queues stay separate", async (t) => {
  const { service, store } = fixture(t);
  const a = await service.saveAgent(agent("A")),
    b = await service.saveAgent(agent("B"));
  const sa = service.session(a.id),
    sb = service.session(b.id);
  assert.equal(service.session(a.id).id, sa.id);
  service.message(sa.id, { text: "Only A" });
  assert.equal(
    store.list<Message>("message").filter((m) => m.sessionId === sb.id).length,
    0,
  );
  const run = new RunManager(service, false, process.cwd());
  await assert.rejects(run.start(sa.id), code("live_disabled"));
});
test("restart recovers interrupted sessions without resending work", async (t) => {
  const { service, store } = fixture(t);
  const a = await service.saveAgent(agent("A"));
  const s = service.session(a.id);
  s.state = "running";
  store.put("session", s);
  const m = service.message(s.id, { text: "Do once" });
  m.status = "processing";
  store.put("message", m);
  new RunManager(service, false, process.cwd()).recover();
  assert.equal(store.get<Session>("session", s.id).state, "idle");
  assert.equal(store.get<Message>("message", m.id).status, "failed");
});
test("skill discovery handles provenance, duplicate names, bad YAML and symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-skills-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["a", "b", "bad"]) await mkdir(join(dir, name));
  const text =
    "---\nname: python\ndescription: Python specialist\n---\nUse pathlib.";
  await writeFile(join(dir, "a/SKILL.md"), text);
  await writeFile(join(dir, "b/SKILL.md"), text);
  await writeFile(join(dir, "bad/SKILL.md"), "not yaml");
  await symlink(
    join(dir, "a"),
    join(dir, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const cat = new SkillCatalog([
    { path: dir, environment: "claude", label: "Claude" },
  ]);
  await cat.scan();
  assert.equal(cat.items.size, 2);
  assert.equal(cat.warnings.length, 1);
  assert.equal(cat.grouped().groups.claude.length, 2);
  assert.equal(cat.grouped().groups.codex.length, 0);
  assert.equal([...cat.items.values()][0].compatibility, "source-inferred");
});
test("assigned skill bodies are preloaded, unassigned content is absent, and updates are rehashed", async (t) => {
  const { service, skills } = fixture(t);
  const dir = await mkdtemp(join(tmpdir(), "agentteam-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["chosen", "other"]) {
    await mkdir(join(dir, name));
    await writeFile(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test skill\n---\n${name} procedure`,
    );
  }
  skills.roots = [{ path: dir, environment: "codex" }];
  await skills.scan();
  const skill = [...skills.items.values()].find((s) => s.name === "chosen")!;
  const a = await service.saveAgent({
    ...agent("A"),
    instructions: "Always check tests",
    skills: [{ id: skill.id, mode: "always" }],
  });
  const plan = await service.launchPlan(a.id);
  assert.match(plan.instructions, /chosen procedure/);
  assert.doesNotMatch(plan.instructions, /other procedure/);
  await writeFile(
    skill.path,
    (await readFile(skill.path, "utf8")) + "\nChanged",
  );
  assert.notEqual(
    (await service.launchPlan(a.id)).skills[0].hash,
    plan.skills[0].hash,
  );
  await assert.rejects(
    service.saveAgent({
      ...agent("Wrong", "claude"),
      skills: [{ id: skill.id }],
    }),
    code("incompatible_skill"),
  );
});
test("runtime command arguments preserve prompts without shell interpretation", async (t) => {
  const { service } = fixture(t);
  const a = await service.saveAgent({
    ...agent("A"),
    model: "some-model",
    effort: "high",
  });
  const plan = await service.launchPlan(a.id);
  const command = commandFor(
    plan,
    "session-id",
    "$(touch /tmp/never)",
    process.cwd(),
  );
  assert.equal(command.executable, "codex");
  assert(command.args.includes("resume"));
  assert(command.stdin.includes("$(touch /tmp/never)"));
  assert(command.args.includes('sandbox_mode="read-only"'));
  assert.equal(command.args.at(-1), "-");
});
test("provider file tools are limited to the attached workspace and assigned access", async (t) => {
  const { service } = fixture(t);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-tools-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeBuilder = await service.saveAgent({
    name: "Claude Builder",
    environment: "claude",
    model: "sonnet",
    roleType: "implementer",
    tools: ["read", "grep", "glob", "edit", "write"],
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const claudePlan = await service.launchPlan(claudeBuilder.id);
  const claude = commandFor(claudePlan, null, "Create a file", process.cwd());
  assert.ok(claude.args.includes("--restricted"));
  assert.ok(!claude.args.includes("--safe-mode"));
  assert.equal(
    claude.args[claude.args.indexOf("--tools") + 1],
    "Read,Glob,Grep,Edit,Write",
  );
  assert.equal(
    claude.args[claude.args.indexOf("--permission-mode") + 1],
    "acceptEdits",
  );
  assert.equal(claude.cwd, root);
  assert.equal(claude.allowedTools, undefined);

  const claudeShellBuilder = await service.saveAgent({
    name: "Claude Shell Builder",
    environment: "claude",
    model: "sonnet",
    roleType: "implementer",
    tools: ["read", "grep", "glob", "edit", "write", "shell"],
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const claudeShell = commandFor(
    await service.launchPlan(claudeShellBuilder.id),
    null,
    "Build and run a program",
    process.cwd(),
  );
  assert.equal(
    claudeShell.args[claudeShell.args.indexOf("--tools") + 1],
    "Read,Glob,Grep,Edit,Write,Bash",
  );
  const claudeSettings = JSON.parse(
    claudeShell.args[claudeShell.args.indexOf("--settings") + 1],
  );
  assert.deepEqual(claudeSettings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
  });
  assert.equal(
    claudeSettings.permissions.blockReadsOutsideWorkingDirectories,
    true,
  );
  assert.deepEqual(claudeShell.allowedTools, ["Bash"]);

  const noWorkspace = await service.saveAgent({
    name: "Claude Without Workspace",
    environment: "claude",
    model: "sonnet",
    roleType: "implementer",
    tools: ["read", "grep", "glob", "edit", "write", "shell"],
  });
  const noWorkspaceCommand = commandFor(
    await service.launchPlan(noWorkspace.id),
    null,
    "Build and run a program",
    process.cwd(),
  );
  assert.deepEqual(noWorkspaceCommand.allowedTools, undefined);
  assert.equal(
    noWorkspaceCommand.args[noWorkspaceCommand.args.indexOf("--tools") + 1],
    "",
  );

  const shellReviewer = await service.saveAgent({
    name: "Read-only reviewer with shell grant",
    environment: "claude",
    roleType: "reviewer",
    tools: ["read", "grep", "glob", "shell"],
    workspaces: [{ path: root, access: "read", active: true }],
  });
  const shellReviewerCommand = commandFor(
    await service.launchPlan(shellReviewer.id),
    null,
    "Review",
    process.cwd(),
  );
  assert.equal(shellReviewerCommand.allowedTools, undefined);
  assert.equal(
    shellReviewerCommand.args[shellReviewerCommand.args.indexOf("--tools") + 1],
    "Read,Glob,Grep",
  );

  const codexBuilder = await service.saveAgent({
    name: "Codex Builder",
    environment: "codex",
    model: "default",
    roleType: "implementer",
    tools: ["read", "edit", "write"],
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const codex = commandFor(
    await service.launchPlan(codexBuilder.id),
    null,
    "Create a file",
    process.cwd(),
  );
  assert.ok(codex.args.includes('sandbox_mode="workspace-write"'));

  const reviewer = await service.saveAgent({
    name: "Read-only reviewer",
    environment: "codex",
    roleType: "reviewer",
    tools: ["read", "grep", "glob"],
    workspaces: [{ path: root, access: "read", active: true }],
  });
  const readOnly = commandFor(
    await service.launchPlan(reviewer.id),
    null,
    "Review",
    process.cwd(),
  );
  assert.ok(readOnly.args.includes('sandbox_mode="read-only"'));

  const secondRoot = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-tools-second-")),
  );
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  const multiRootBuilder = await service.saveAgent({
    name: "Multi-root builder",
    environment: "codex",
    roleType: "implementer",
    tools: ["read", "edit", "write"],
    workspaces: [
      { path: root, access: "write", active: true },
      { path: secondRoot, access: "write", active: false },
    ],
  });
  const workflow = service.workflow({
    name: "Scoped task",
    goal: "Use only declared resource folders",
    ownerId: multiRootBuilder.id,
    completionCriteria: "done",
  });
  const task = service.task({
    workflowId: workflow.id,
    agentId: multiRootBuilder.id,
    title: "Write to two resources",
    completionCriteria: "done",
    resourcePaths: [root, secondRoot],
  });
  const scopedPlan = await service.launchPlan(multiRootBuilder.id, task.id);
  assert.equal(scopedPlan.cwd, root);
  assert.deepEqual(
    scopedPlan.providerRoots.map((r) => r.path),
    [root, secondRoot],
  );
  const scopedCommand = commandFor(scopedPlan, null, "Write", process.cwd());
  const scopedGrants = scopedCommand.args.find((arg) =>
    arg.startsWith("permissions.agentteam-task.filesystem="),
  )!;
  assert.ok(scopedGrants.includes(`${JSON.stringify(root)}="write"`));
  assert.ok(scopedGrants.includes(`${JSON.stringify(secondRoot)}="write"`));
  assert.equal(scopedCommand.args.includes("--add-dir"), false);

  const mixed = await service.saveAgent({
    name: "Mixed access builder",
    environment: "codex",
    roleType: "implementer",
    tools: ["read", "edit", "write"],
    workspaces: [
      { path: root, access: "write", active: true },
      { path: secondRoot, access: "read", active: false },
    ],
  });
  const mixedTask = service.task({
    workflowId: workflow.id,
    agentId: mixed.id,
    title: "Mixed permissions",
    completionCriteria: "done",
    resourcePaths: [root, secondRoot],
  });
  const mixedPlan = await service.launchPlan(mixed.id, mixedTask.id);
  const mixedCommand = commandFor(mixedPlan, null, "Review", process.cwd());
  const mixedGrants = mixedCommand.args.find((arg) =>
    arg.startsWith("permissions.agentteam-task.filesystem="),
  )!;
  assert.ok(mixedGrants.includes(`${JSON.stringify(root)}="write"`));
  assert.ok(mixedGrants.includes(`${JSON.stringify(secondRoot)}="read"`));

  const restricted = await service.saveAgent({
    name: "Rule-restricted builder",
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "grep", "glob", "edit", "write"],
    workspaces: [
      {
        path: root,
        access: "write",
        active: true,
        rules: [{ path: "private", access: "none" }],
      },
    ],
  });
  const restrictedCommand = commandFor(
    await service.launchPlan(restricted.id),
    null,
    "Build",
    process.cwd(),
  );
  assert.equal(
    restrictedCommand.args[restrictedCommand.args.indexOf("--tools") + 1],
    "",
    "file tools are disabled when the provider cannot enforce per-file rules",
  );
});
test("direct CLI MCP configuration is scoped to the run token and cleaned up", async (t) => {
  const { service } = fixture(t);
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentteam-mcp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixturePath = join(root, "provider-fixture.mjs");
  await writeFile(
    fixturePath,
    `#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
const args = process.argv.slice(2);
const configIndex = args.indexOf("--mcp-config");
const configPath = configIndex < 0 ? null : args[configIndex + 1];
const payload = {
  args,
  configPath,
  config: configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null,
  configMode: configPath ? (statSync(configPath).mode & 0o777).toString(8) : null,
  token: process.env.AGENTTEAM_TOOL_TOKEN ?? null,
};
const out = (type, event) => console.log(JSON.stringify(event));
if (args.includes("--json")) {
  payload.config = args.filter((x) => x.startsWith("mcp_servers.agentteam."));
  out("codex", { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } });
} else {
  out("claude", { type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
  out("claude-result", { type: "result", subtype: "success" });
}
`,
  );
  await chmod(fixturePath, 0o700);
  const manager = await service.saveAgent({
    name: "Manager",
    environment: "claude",
    model: "opus",
    roleType: "coordinator",
    tools: ["read", "grep", "glob"],
    workspaces: [{ path: root, access: "read", active: true }],
  });
  const plan = await service.launchPlan(manager.id);
  const command = commandFor(plan, null, "Delegate a task", root);
  command.executable = process.execPath;
  command.args.unshift(fixturePath);
  command.teammateTools = {
    url: "http://127.0.0.1:4317/mcp",
    token: "run-scoped-test-token",
  };
  command.allowedTools = ["Bash"];
  let output = "";
  await executeCommand(
    command,
    "claude",
    (event) => {
      if (event.type === "text") output = String(event.data);
    },
    new AbortController().signal,
  );
  const payload = JSON.parse(output);
  assert.equal(payload.token, "run-scoped-test-token");
  if (process.platform !== "win32") assert.equal(payload.configMode, "600");
  assert.deepEqual(payload.config.mcpServers.agentteam.headers, {
    Authorization: "Bearer ${AGENTTEAM_TOOL_TOKEN}",
  });
  assert.deepEqual(
    payload.config.mcpServers.agentteam.url,
    command.teammateTools.url,
  );
  assert.ok(payload.args.includes("--restricted"));
  assert.ok(payload.args.includes("mcp__agentteam__invoke_teammate"));
  assert.ok(!payload.args.includes(command.teammateTools.token));
  const allowedIndex = payload.args.indexOf("--allowedTools");
  assert.deepEqual(payload.args.slice(allowedIndex + 1), [
    "Bash",
    "mcp__agentteam__invoke_teammate",
    "mcp__agentteam__teammate_result",
  ]);
  await assert.rejects(stat(payload.configPath), { code: "ENOENT" });

  const builder = await service.saveAgent({
    name: "Codex Builder",
    environment: "codex",
    roleType: "implementer",
    tools: ["read", "grep", "glob", "edit", "write"],
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const codexCommand = commandFor(
    await service.launchPlan(builder.id),
    null,
    "Write a file",
    root,
  );
  codexCommand.executable = process.execPath;
  codexCommand.args.unshift(fixturePath);
  codexCommand.teammateTools = {
    url: "http://127.0.0.1:4317/mcp",
    token: "codex-run-token",
  };
  output = "";
  await executeCommand(
    codexCommand,
    "codex",
    (event) => {
      if (event.type === "text") output = String(event.data);
    },
    new AbortController().signal,
  );
  const codexPayload = JSON.parse(output);
  assert.equal(codexPayload.token, "codex-run-token");
  assert.ok(
    codexPayload.config.includes(
      'mcp_servers.agentteam.url="http://127.0.0.1:4317/mcp"',
    ),
  );
  assert.ok(
    codexPayload.config.includes(
      'mcp_servers.agentteam.bearer_token_env_var="AGENTTEAM_TOOL_TOKEN"',
    ),
  );
  assert.ok(codexPayload.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(!codexPayload.args.includes(codexCommand.teammateTools.token));
});
test("provider events decode results and surface failures", () => {
  assert.deepEqual(
    decodeEvent("codex", { type: "thread.started", thread_id: "t" }),
    [{ type: "session", data: "t" }],
  );
  assert.deepEqual(
    decodeEvent("claude", {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    }),
    [{ type: "text", data: "hello" }],
  );
  assert.throws(
    () =>
      decodeEvent("claude", {
        type: "result",
        is_error: true,
        subtype: "error_max_turns",
      }),
    code("provider_error"),
  );
  assert.throws(
    () =>
      decodeEvent("claude", {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Failed to authenticate: OAuth session expired and could not be refreshed",
            },
          ],
        },
      }),
    (error: any) =>
      error.code === "authentication_required" &&
      /claude auth login/.test(error.message),
  );
});
test("process adapter parses streamed JSON and reports nonzero exits", async () => {
  const events: unknown[] = [];
  await executeCommand(
    {
      executable: process.execPath,
      args: [
        "-e",
        'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"ok"}})+"\\n")',
      ],
      stdin: "",
      cwd: process.cwd(),
    },
    "codex",
    (e) => events.push(e),
    new AbortController().signal,
  );
  assert.deepEqual(events, [{ type: "text", data: "ok" }]);
  await assert.rejects(
    executeCommand(
      {
        executable: process.execPath,
        args: ["-e", "process.exit(2)"],
        stdin: "",
        cwd: process.cwd(),
      },
      "codex",
      () => {},
      new AbortController().signal,
    ),
    code("runtime_exit"),
  );
});
test("invocation limits default to unlimited and release slots when children finish", async (t) => {
  const { service } = fixture(t);
  const parent = await service.saveAgent({
    ...agent("Lead"),
    maxConcurrentInvocations: 3,
  });
  const wf = service.workflow({
    name: "Parallel",
    goal: "Build",
    ownerId: parent.id,
    completionCriteria: "All done",
  });
  const tasks: Task[] = [];
  for (let i = 0; i < 4; i++) {
    const child = await service.saveAgent(agent("Child " + i));
    assert.equal(child.maxConcurrentInvocations, null);
    service.saveEdge({ from: parent.id, to: child.id, kind: "delegate" });
    tasks.push(
      service.task({
        workflowId: wf.id,
        agentId: child.id,
        invokedBy: parent.id,
        title: "Work " + i,
        completionCriteria: "Done",
      }),
    );
  }
  for (const task of tasks.slice(0, 3))
    service.transitionTask(task.id, { status: "running" });
  assert.equal(service.capacity(parent.id).running, 3);
  assert.equal(service.taskState(tasks[3].id).waitReason, "invocation-limit");
  assert.throws(
    () => service.transitionTask(tasks[3].id, { status: "running" }),
    code("invocation_limit"),
  );
  service.transitionTask(tasks[0].id, {
    status: "completed",
    result: "Finished",
  });
  service.transitionTask(tasks[3].id, { status: "running" });
  assert.equal(service.capacity(parent.id).running, 3);
});
test("lowering invocation limit never interrupts already running work", async (t) => {
  const { service } = fixture(t);
  const parent = await service.saveAgent(agent("Lead"));
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: parent.id,
    completionCriteria: "D",
  });
  for (let i = 0; i < 2; i++) {
    const child = await service.saveAgent(agent("Child " + i));
    service.saveEdge({ from: parent.id, to: child.id, kind: "delegate" });
    const task = service.task({
      workflowId: wf.id,
      agentId: child.id,
      invokedBy: parent.id,
      title: "T",
      completionCriteria: "D",
    });
    service.transitionTask(task.id, { status: "running" });
  }
  await service.saveAgent(
    { ...agent("Lead"), maxConcurrentInvocations: 1 },
    parent.id,
  );
  assert.equal(service.capacity(parent.id).running, 2);
  assert.equal(service.capacity(parent.id).available, false);
});
test("activity follows task lifecycle and transfers carry actual direction", async (t) => {
  const { service, store } = fixture(t);
  const lead = await service.saveAgent(agent("Lead")),
    worker = await service.saveAgent(agent("Worker"));
  const edge = service.saveEdge({
    from: lead.id,
    to: worker.id,
    kind: "delegate",
  });
  const wf = service.workflow({
    name: "Flow",
    goal: "Work",
    ownerId: lead.id,
    completionCriteria: "Done",
  });
  const task = service.task({
    workflowId: wf.id,
    agentId: worker.id,
    invokedBy: lead.id,
    title: "Work",
    completionCriteria: "Done",
  });
  assert.equal(service.activity(worker.id).state, "waiting");
  service.transitionTask(task.id, { status: "running" });
  assert.equal(service.activity(worker.id).state, "processing");
  service.transitionTask(task.id, { status: "completed", result: "Done" });
  assert.equal(service.activity(worker.id).state, "idle");
  const flows = store
    .history()
    .filter((e) => e.type === "flow.transferred")
    .map((e) => e.data as any);
  assert.deepEqual(
    flows.map((f) => [f.fromAgentId, f.toAgentId, f.kind]),
    [
      [lead.id, worker.id, "request"],
      [worker.id, lead.id, "result"],
    ],
  );
  assert.ok(flows.every((f) => f.edgeId === edge.id && f.taskId === task.id));
});
