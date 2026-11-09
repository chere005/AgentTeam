import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./fixtures/execution-world.ts";
import { createInspector } from "../src/inspector-routes.ts";
import { launchRecord } from "../src/launch-record.ts";
import type { Task } from "../src/model.ts";

const SECRET = "sk-abcdefghijklmnop1234567890";

test("each provider run records a redacted effective launch; the inspector route returns it", async (t) => {
  process.env.AGENTTEAM_TEST_LAUNCH_KEY = "env-secret-value-0123456";
  t.after(() => {
    delete process.env.AGENTTEAM_TEST_LAUNCH_KEY;
  });
  const w = await world(t);
  const folder = await w.folder("area");
  const agent = await w.service.saveAgent({
    name: "Writer",
    environment: "codex",
    model: "gpt-x",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const workflow = w.service.workflow({
    name: "Launch",
    goal: "Write",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Write notes.txt",
    instructions: "PRIVATE INSTRUCTION TEXT",
    completionCriteria: "Done",
  });
  let token = "";
  w.setProvider(async (command, _e, emit) => {
    token = command.teammateTools?.token ?? "";
    emit({ type: "text", data: "done" });
  });
  await w.until(
    () => w.store.get<Task>("task", task.id).status === "completed",
  );
  const launches = w.events("task.launch");
  assert.equal(launches.length, 1);
  const record = launches[0].data as ReturnType<typeof launchRecord>;
  assert.equal(record.environment, "codex");
  assert.equal(record.model, "gpt-x");
  assert.ok(record.args.includes("exec"));
  assert.equal(record.cwd, folder.replace(process.env.HOME ?? "\0", "~"));
  assert.ok(record.writeRoots.length >= 1);
  assert.deepEqual(record.envNames.set, token ? ["AGENTTEAM_TOOL_TOKEN"] : []);
  const text = JSON.stringify(launches[0].data);
  assert.ok(!text.includes("PRIVATE INSTRUCTION TEXT"), "stdin never recorded");
  assert.ok(!text.includes(token || "\0"), "token never recorded");
  // Through the inspector route and the timeline.
  const inspector = createInspector(w.service, {
    token: "api-token-1234567",
    context: {
      liveEnabled: () => true,
      readiness: () => ({ state: "ready" }),
    } as any,
  });
  const url = new URL(`http://x/inspector/tasks/${task.id}/launch`);
  const routed = await inspector.route("GET", url, async () => ({}));
  const rows = routed!.data as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].executable, record.executable);
  const line = await inspector.route(
    "GET",
    new URL(`http://x/inspector/timeline?taskId=${task.id}`),
    async () => ({}),
  );
  assert.ok(
    (line!.data as any).entries.some((e: any) => e.type === "task.launch"),
  );
  await assert.rejects(
    inspector.route(
      "GET",
      new URL("http://x/inspector/tasks/nope/launch"),
      async () => ({}),
    ),
    { code: "not_found" },
  );
});

test("a chat run records a session launch with the resumed provider session id", async (t) => {
  const w = await world(t);
  const agent = await w.service.saveAgent({
    name: "Chatty",
    environment: "codex",
  });
  w.setProvider(async (_c, _e, emit) => {
    emit({ type: "session", data: "thread-abc-123" });
    emit({ type: "text", data: "hi" });
  });
  const session = await w.chat(agent.id, "hello");
  await w.chat(agent.id, "again");
  const launches = w
    .events("session.launch")
    .filter((e) => e.entityId === session.id);
  assert.equal(launches.length, 2);
  assert.equal((launches[0].data as any).providerSessionId, null);
  assert.equal((launches[1].data as any).providerSessionId, "thread-abc-123");
  assert.ok((launches[1].data as any).args.includes("resume"));
});

test("secret-looking args, long args and env values are masked; only env names are kept", () => {
  const home = process.env.HOME ?? "/Users/x";
  const record = launchRecord(
    {
      executable: `${home}/bin/codex`,
      args: [
        "exec",
        "-c",
        `mcp_servers.x.bearer_token=${SECRET}`,
        "--api-key",
        `Bearer ${SECRET}`,
        "--append-system-prompt",
        "p".repeat(5000),
      ],
      stdin: "prompt body",
      cwd: `${home}/work`,
      teammateTools: {
        url: "http://127.0.0.1:9/mcp",
        token: "tok-live-0123456789",
      },
      limitations: [],
    } as any,
    {
      environment: "codex",
      workspaces: [{ path: `${home}/work`, access: "write", active: true }],
    } as any,
  );
  const text = JSON.stringify(record);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes("tok-live-0123456789"));
  assert.ok(!text.includes("p".repeat(100)));
  assert.ok(text.includes("5000 chars sha256:"));
  assert.ok(!text.includes(home) || home.length <= 2);
  assert.deepEqual(record.envNames, {
    set: ["AGENTTEAM_TOOL_TOKEN"],
    inherited: true,
  });
  assert.equal(record.stdin?.chars, 11);
});
