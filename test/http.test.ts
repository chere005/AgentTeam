import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";
async function fixture(t: any) {
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    server = createApi(
      team,
      "test-token",
      new RunManager(team, false, process.cwd()),
    );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const address = server.address() as { port: number };
  const url = "http://127.0.0.1:" + address.port;
  const request = (path: string, options: RequestInit = {}) =>
    fetch(url + path, {
      ...options,
      headers: {
        authorization: "Bearer test-token",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  return { request, url, store, team };
}
test("API authenticates, rejects browser origins and validates inputs", async (t) => {
  const { request, url } = await fixture(t);
  assert.equal((await fetch(url + "/health")).status, 401);
  assert.equal(
    (await request("/health", { headers: { Origin: "https://evil.invalid" } }))
      .status,
    403,
  );
  assert.equal((await request("/health")).status, 200);
  assert.equal(
    (
      await request("/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Bad" }),
      })
    ).status,
    400,
  );
});
test("HTTP agent → session → message flow persists independently", async (t) => {
  const { request } = await fixture(t);
  const agent = (await (
    await request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Builder", environment: "codex" }),
    })
  ).json()) as any;
  assert(agent.id);
  const session = (await (
    await request(`/agents/${agent.id}/session`, { method: "POST" })
  ).json()) as any;
  assert.equal(
    (
      await request(`/sessions/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "Hello" }),
      })
    ).status,
    201,
  );
  const messages = (await (
    await request(`/sessions/${session.id}/messages`)
  ).json()) as any[];
  assert.equal(messages[0].text, "Hello");
  assert.equal(
    (await request(`/sessions/${session.id}/run`, { method: "POST" })).status,
    403,
  );
  const catalog = (await (await request("/skills")).json()) as any;
  assert.equal(catalog.recommended.skills.length, 37);
  assert.equal(catalog.installed.total, 0);
});
test("SSE replays durable events with monotonically increasing IDs", async (t) => {
  const { request, store } = await fixture(t);
  store.emit("first", "a");
  store.emit("second", "a");
  const controller = new AbortController();
  const res = await request("/events/stream?after=1", {
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("event: second")) {
    const next = await reader.read();
    text += new TextDecoder().decode(next.value);
  }
  assert(text.includes("id: 2"));
  assert(!text.includes("event: first"));
  controller.abort();
});

// ---- unexpected backend errors are recorded and named (fix F8) ----------------------------------

test("an unexpected error is recorded as a backend.error event and the 500 names the route and message", async (t) => {
  const { request, store, team } = await fixture(t);
  const boom = new Error("approvals exploded: ENOENT widget.db");
  team.approvals.list = () => {
    throw boom;
  };
  const response = await request("/approvals");
  assert.equal(response.status, 500);
  const body = (await response.json()) as any;
  assert.equal(body.error, "internal_error");
  assert.equal(body.route, "GET /approvals");
  assert.equal(body.message, "approvals exploded: ENOENT widget.db");
  const events = store
    .history(0, 1000)
    .filter((e) => e.type === "backend.error");
  assert.equal(events.length, 1);
  const data = events[0].data as any;
  assert.equal(events[0].entityId, "GET /approvals");
  assert.equal(data.method, "GET");
  assert.equal(data.path, "/approvals");
  assert.equal(data.message, "approvals exploded: ENOENT widget.db");
  assert.match(data.stack, /approvals exploded/);
  assert.match(data.at, /^\d{4}-\d\d-\d\dT/);
  // The Inspector lists it as an error, naming the route.
  const timeline = (await (
    await request("/inspector/timeline?type=backend.error")
  ).json()) as any;
  assert.equal(timeline.entries.length, 1);
  assert.equal(timeline.entries[0].severity, "error");
  assert.match(
    timeline.entries[0].summary,
    /Backend error in GET \/approvals: approvals exploded/,
  );
});

test("the recorded stack and message are bounded, a failing poll is recorded once, and expected errors are not recorded", async (t) => {
  const { request, store, team } = await fixture(t);
  const huge = new Error("x".repeat(5000));
  huge.stack =
    "Error: huge\n" + "    at somewhere (file.ts:1:1)\n".repeat(1000);
  team.approvals.list = () => {
    throw huge;
  };
  const first = (await (await request("/approvals")).json()) as any;
  assert.equal(first.message.length, 500);
  await request("/approvals");
  await request("/approvals");
  const events = store
    .history(0, 1000)
    .filter((e) => e.type === "backend.error");
  assert.equal(
    events.length,
    1,
    "the same failure within seconds is not logged again",
  );
  assert.ok((events[0].data as any).stack.length <= 4096);
  // Validation failures and typed errors are the caller's mistakes, not backend errors.
  assert.equal(
    (
      await request("/agents", {
        method: "POST",
        body: JSON.stringify({ name: "Bad" }),
      })
    ).status,
    400,
  );
  assert.equal((await request("/tasks/does-not-exist/recovery")).status, 404);
  assert.equal(
    store.history(0, 1000).filter((e) => e.type === "backend.error").length,
    1,
  );
});

test("the desktop bridge words a failed response: the route for an unexpected error, the message otherwise", async () => {
  const { apiFailureText } = await import("../src/backend-errors.ts");
  assert.equal(
    apiFailureText({
      error: "internal_error",
      route: "POST /tasks/t1/resume",
      message: "boom",
    }),
    "POST /tasks/t1/resume: boom",
  );
  assert.equal(
    apiFailureText({ error: "internal_error", route: "GET /x" }),
    "GET /x: Unexpected backend error",
  );
  assert.equal(
    apiFailureText({
      error: "folder-denied",
      message: "macOS has not allowed AgentTeam",
    }),
    "macOS has not allowed AgentTeam",
  );
  assert.equal(
    apiFailureText({
      error: "validation_error",
      issues: [{ message: "Required" }, { message: "Too short" }],
    }),
    "Required; Too short",
  );
  assert.equal(apiFailureText({ error: "not_found" }), "not_found");
});
