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
  // The Inspector lists it as an error, naming the route, as the UI asks for it: with the active
  // team's filter (the UI always sends `teamId`).
  const { activeTeamId } = (await (await request("/snapshot")).json()) as any;
  const timeline = (await (
    await request(
      `/inspector/timeline?type=backend.error&teamId=${encodeURIComponent(activeTeamId)}`,
    )
  ).json()) as any;
  assert.equal(timeline.entries.length, 1);
  assert.equal(timeline.entries[0].severity, "error");
  assert.equal(timeline.entries[0].agentName, "System");
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

// ---- backend errors: visible in every team's Inspector, redacted, bounded (reviewer-2 M1, M3, L2, L3) -

test("a backend error is listed in every team's Inspector view as System, however the team filter is set (reviewer fixture F8d)", async (t) => {
  const { request, team } = await fixture(t);
  const second = (await (
    await request("/team-spaces", {
      method: "POST",
      body: JSON.stringify({ name: "Second team" }),
    })
  ).json()) as any;
  team.approvals.list = () => {
    throw new Error("boom for the inspector");
  };
  assert.equal((await request("/approvals")).status, 500);
  const { activeTeamId } = (await (await request("/snapshot")).json()) as any;
  const count = async (query: string) =>
    (
      (await (
        await request(`/inspector/timeline?minSeverity=info&limit=400${query}`)
      ).json()) as any
    ).entries.filter((e: any) => /Backend error/.test(e.summary)).length;
  assert.equal(await count(""), 1);
  assert.equal(await count(`&teamId=${encodeURIComponent(activeTeamId)}`), 1);
  assert.equal(await count(`&teamId=${encodeURIComponent(second.id)}`), 1);
  // The live event feed filtered to a team carries it too.
  const events = (await (
    await request(`/events?teamId=${encodeURIComponent(second.id)}`)
  ).json()) as any[];
  assert.equal(events.filter((e) => e.type === "backend.error").length, 1);
});

test("the API token, secret-looking environment values and credential shapes never reach the event, /events, the Inspector or the 500 body", async (t) => {
  const { request, store, team } = await fixture(t);
  const secret = "fake-secret-value-abcdef123456";
  process.env.FAKE_PROVIDER_API_KEY = secret;
  t.after(() => delete process.env.FAKE_PROVIDER_API_KEY);
  team.approvals.list = () => {
    const error = new Error(
      `upstream refused: Authorization: Bearer test-token key=${secret} sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA prompt="make a program"`,
    );
    error.stack = `Error: ${error.message}\n    at upstream (/Users/someone/project/client.ts:1:1)\n    token=test-token ${secret}`;
    throw error;
  };
  const response = await request("/approvals");
  assert.equal(response.status, 500);
  const body = await response.text();
  const event = store.history(0, 1000).find((e) => e.type === "backend.error")!;
  const events = JSON.stringify(await (await request("/events")).json());
  const timeline = JSON.stringify(
    await (await request("/inspector/timeline?type=backend.error")).json(),
  );
  for (const [where, text] of [
    ["the 500 body", body],
    ["the stored event", JSON.stringify(event)],
    ["/events", events],
    ["the Inspector", timeline],
  ] as const) {
    assert.ok(!text.includes("test-token"), `the API token is in ${where}`);
    assert.ok(!text.includes(secret), `the environment secret is in ${where}`);
    assert.ok(
      !text.includes("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"),
      `the API key is in ${where}`,
    );
  }
  // Still useful: the route and the shape of the failure remain.
  const data = event.data as any;
  assert.equal(data.method, "GET");
  assert.equal(data.path, "/approvals");
  assert.match(data.message, /upstream refused/);
  assert.match(data.message, /\[REDACTED\]/);
  assert.ok(data.stack.length <= 4096);
});

test("an unexpected error after the response started (the event stream) is recorded best effort as after-headers", async (t) => {
  const { url, store } = await fixture(t);
  const original = store.history.bind(store);
  (store as any).history = () => {
    throw new Error("history exploded in the stream");
  };
  const controller = new AbortController();
  const response = await fetch(url + "/events/stream", {
    headers: { authorization: "Bearer test-token" },
    signal: controller.signal,
  });
  await response.text().catch(() => "");
  (store as any).history = original;
  controller.abort();
  const recorded = store
    .history(0, 1000)
    .filter((e) => e.type === "backend.error");
  assert.equal(recorded.length, 1);
  const data = recorded[0].data as any;
  assert.equal(data.phase, "after-headers");
  assert.equal(data.path, "/events/stream");
  assert.match(data.message, /history exploded in the stream/);
});

test("a steadily failing poll adds one event per route and message per minute; the next record says how many were left out", async () => {
  const { recordBackendError, REPEAT_WINDOW_MS } =
    await import("../src/backend-errors.ts");
  const store = new Store(":memory:");
  try {
    const fail = (now: number, message = "poll keeps failing") =>
      recordBackendError(store, {
        method: "GET",
        path: "/approvals",
        error: new Error(message),
        now,
      });
    const events = () =>
      store.history(0, 100).filter((e) => e.type === "backend.error");
    const t0 = 1_000_000;
    // A poll every 2 s for 59 seconds: one event.
    for (let at = 0; at < REPEAT_WINDOW_MS; at += 2000) fail(t0 + at);
    assert.equal(events().length, 1);
    assert.equal((events()[0].data as any).repeats, undefined);
    // The minute is over: the next failure is recorded and says 29 were left out.
    fail(t0 + REPEAT_WINDOW_MS + 100);
    assert.equal(events().length, 2);
    assert.equal((events()[1].data as any).repeats, 29);
    // A different message on the same route is its own failure.
    fail(t0 + REPEAT_WINDOW_MS + 200, "a different problem");
    assert.equal(events().length, 3);
    // And an hour of failures is a bounded number of events (one per minute), not one per poll.
    for (let at = 0; at < 3_600_000; at += 2000) fail(t0 + 200_000 + at);
    assert.ok(
      events().length <= 3 + 61,
      `${events().length} events for an hour`,
    );
  } finally {
    store.close();
  }
});

test("folder access answers are system events: listed in every team's Inspector view, a refusal as a warning", async (t) => {
  const { request, store } = await fixture(t);
  store.emit("folder.access_refused", "/Users/someone/Desktop/pi", {
    path: "/Users/someone/Desktop/pi",
    write: true,
    ok: false,
    code: "folder-denied",
    errno: "EPERM",
    operation: "readdir",
    source: "scheduler",
  });
  store.emit("folder.access_allowed", "/Users/someone/Desktop/pi", {
    path: "/Users/someone/Desktop/pi",
    write: true,
    ok: true,
    source: "recheck",
  });
  const { activeTeamId } = (await (await request("/snapshot")).json()) as any;
  const timeline = (await (
    await request(
      `/inspector/timeline?type=folder.&minSeverity=info&teamId=${encodeURIComponent(activeTeamId)}`,
    )
  ).json()) as any;
  assert.deepEqual(
    timeline.entries.map((e: any) => [e.type, e.severity, e.agentName]),
    [
      ["folder.access_refused", "warn", "System"],
      ["folder.access_allowed", "info", "System"],
    ],
  );
  assert.match(
    timeline.entries[0].summary,
    /The system refused access to .*pi \(EPERM on readdir\)/,
  );
});
