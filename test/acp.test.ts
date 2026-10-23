import { acpSessionPrefix } from "../src/acp.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { executeCommand, commandFor } from "../src/runtime.ts";
import { Store } from "../src/store.ts";
import { Approvals } from "../src/approvals.ts";
import type { Command, RuntimeEvent } from "../src/runtime-types.ts";
function command(mode = "normal", sessionId: string | null = null): Command {
  return {
    executable: process.execPath,
    args: [
      fileURLToPath(new URL("./fixtures/acp-agent.mjs", import.meta.url)),
      mode,
    ],
    cwd: process.cwd(),
    stdin: "",
    acp: { sessionId, prompt: "Test", model: "default", effort: null },
  };
}
test("ACP initialization, prompt chunks and reload avoid duplicate history", async () => {
  for (const session of [null, "fixture"]) {
    const events: RuntimeEvent[] = [];
    await executeCommand(
      command("normal", session),
      "codex",
      (e) => events.push(e),
      new AbortController().signal,
    );
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.data)
        .join(""),
      "Hello world",
    );
    assert.equal(
      events.find((e) => e.type === "session")?.data,
      acpSessionPrefix(command().executable, command().args) + "fixture",
    );
    assert(events.some((e) => e.type === "capabilities"));
  }
});
test("ACP capability checks reject unsupported resume and model settings", async () => {
  await assert.rejects(
    executeCommand(
      command("no-resume", "fixture"),
      "codex",
      () => {},
      new AbortController().signal,
    ),
    /cannot reload/,
  );
  const configured = command();
  configured.acp!.model = "not-advertised";
  await assert.rejects(
    executeCommand(configured, "codex", () => {}, new AbortController().signal),
    /does not offer/,
  );
  configured.acp!.model = "fixture-model";
  await executeCommand(
    configured,
    "codex",
    () => {},
    new AbortController().signal,
  );
});
test("ACP permissions are denied without a handler and routed when supplied", async () => {
  const text: string[] = [];
  await executeCommand(
    command("permission"),
    "claude",
    (e) => {
      if (e.type === "text") text.push(String(e.data));
    },
    new AbortController().signal,
  );
  assert.equal(text.join(""), "denied");
  const store = new Store(":memory:"),
    approvals = new Approvals(store);
  try {
    const run = executeCommand(
      command("permission"),
      "claude",
      () => {},
      new AbortController().signal,
      {
        permission: (request, signal) =>
          approvals.request("agent", request, signal),
      },
    );
    for (let i = 0; i < 100 && !approvals.list().length; i++)
      await new Promise((r) => setTimeout(r, 10));
    const pending = approvals.list()[0];
    assert(pending);
    assert.throws(() => approvals.respond(pending.id, "invalid"), /Unknown/);
    approvals.respond(pending.id, "allow");
    await run;
    assert.equal(approvals.list().length, 0);
  } finally {
    store.close();
  }
});
test("ACP crashes and cancellation settle without leaving an active adapter", async () => {
  await assert.rejects(
    executeCommand(
      command("crash"),
      "codex",
      () => {},
      new AbortController().signal,
    ),
  );
  const controller = new AbortController();
  const run = executeCommand(
    command("hang"),
    "codex",
    (e) => {
      if (e.type === "session") controller.abort();
    },
    controller.signal,
  );
  await assert.rejects(run);
});
test("connection changes never reuse session IDs from another transport", () => {
  const plan: any = {
    environment: "codex",
    model: "default",
    effort: null,
    instructions: "",
    skills: [],
    connection: { transport: "acp", executable: "adapter", args: [] },
  };
  assert.throws(
    () =>
      commandFor(
        {
          ...plan,
          taskScoped: true,
          providerRoots: [
            {
              path: process.cwd(),
              access: "write",
              active: false,
              restricted: false,
            },
          ],
        },
        null,
        "task",
        process.cwd(),
      ),
    /Task resource folders require a direct Claude or Codex CLI run/,
  );
  assert.throws(
    () => commandFor(plan, "direct-session", "hello", process.cwd()),
    /different adapter/,
  );
  assert.equal(
    commandFor(
      plan,
      acpSessionPrefix("adapter", []) + "fixture",
      "hello",
      process.cwd(),
    ).acp?.sessionId,
    "fixture",
  );
  plan.connection.transport = "direct";
  assert.throws(
    () =>
      commandFor(
        plan,
        acpSessionPrefix("adapter", []) + "fixture",
        "hello",
        process.cwd(),
      ),
    /belongs to ACP/,
  );
});
