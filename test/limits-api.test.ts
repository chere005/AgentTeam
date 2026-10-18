import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";

test("limits API: auth, validation, trip, rejected resume, extension resume and completion checks", async (t) => {
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    server = createApi(team, "tok", new RunManager(team, false, process.cwd()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const agent = async (name: string) =>
    (await call("/agents", "POST", { name, environment: "codex" })).json;
  const a = await agent("A"),
    b = await agent("B");
  const wf = (
    await call("/workflows", "POST", {
      name: "W",
      goal: "G",
      ownerId: a.id,
      completionCriteria: "D",
    })
  ).json;
  const lim = `/workflows/${wf.id}/limits`;
  assert.equal((await fetch(base + lim)).status, 401);
  assert.equal((await call(lim, "PUT", { maxAgentTurns: 0 })).status, 400);
  assert.equal((await call(lim, "PUT", { bogus: 1 })).status, 400);
  const set = await call(lim, "PUT", {
    maxAgentTurns: 1,
    maxDelegationDepth: 3,
  });
  assert.equal(set.json.limits.maxAgentTurns, 1);
  assert.equal(set.json.usage.state, "unavailable");
  const t1 = (
    await call("/tasks", "POST", {
      workflowId: wf.id,
      agentId: a.id,
      title: "1",
      completionCriteria: "D",
    })
  ).json;
  const t2 = (
    await call("/tasks", "POST", {
      workflowId: wf.id,
      agentId: b.id,
      title: "2",
      completionCriteria: "D",
    })
  ).json;
  assert.equal(
    (await call(`/tasks/${t1.id}/status`, "POST", { status: "running" }))
      .status,
    200,
  );
  const blocked = await call(`/tasks/${t2.id}/status`, "POST", {
    status: "running",
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, "limit_exceeded");
  const status = (await call(lim)).json;
  assert.equal(status.trip.kind, "turns");
  assert.equal((await call(lim + "/resume", "POST", {})).status, 409);
  const ok = await call(lim + "/resume", "POST", {
    limits: { maxAgentTurns: 3 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.trip, null);
  // Completion checks via API: text alone is rejected, matching text passes.
  assert.equal(
    (
      await call(`/tasks/${t2.id}/completion-checks`, "PUT", {
        checks: [{ type: "output-matches", pattern: "^VERIFIED" }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/tasks/${t2.id}/completion-checks`, "PUT", {
        checks: [{ type: "bogus" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(`/tasks/${t2.id}/status`, "POST", { status: "running" }))
      .status,
    200,
  );
  const rejected = await call(`/tasks/${t2.id}/status`, "POST", {
    status: "completed",
    result: "all good",
  });
  assert.equal(rejected.status, 409);
  const passed = await call(`/tasks/${t2.id}/status`, "POST", {
    status: "completed",
    result: "VERIFIED: yes",
  });
  assert.equal(passed.status, 200);
  assert.equal(passed.json.status, "completed");
});
