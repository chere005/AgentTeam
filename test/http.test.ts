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
  return { request, url, store };
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
