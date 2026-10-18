import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";
import { TeamTemplates, TEAM_TEMPLATE_SCHEMA_VERSION } from "../src/teams.ts";
import type { Agent, Edge, Rule } from "../src/model.ts";

async function setup(t: any) {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    teams = new TeamTemplates(service);
  const dir = await mkdtemp(join(tmpdir(), "agentteam-teams-"));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ws = join(dir, "project");
  await mkdir(ws);
  const lead = await service.saveAgent({
    name: "Lead",
    environment: "codex",
    instructions: "Coordinate",
    effort: "high",
    schedulingPriority: 80,
    workspaces: [{ path: ws, access: "write", active: true }],
  });
  const dev = await service.saveAgent({
    name: "Dev",
    environment: "claude",
    parentId: lead.id,
  });
  const outside = await service.saveAgent({
    name: "Outsider",
    environment: "codex",
  });
  service.saveEdge({ from: lead.id, to: dev.id, kind: "delegate" });
  service.saveEdge({ from: dev.id, to: lead.id, kind: "review" });
  service.saveEdge({ from: outside.id, to: dev.id, kind: "consult" });
  service.saveRule({
    agentId: lead.id,
    scope: "action",
    targetId: dev.id,
    priority: 5,
    match: { textIncludes: ["code"] },
  });
  service.saveRule({
    agentId: lead.id,
    scope: "action",
    targetId: outside.id,
    priority: 6,
    match: { catchAll: true },
  });
  return { store, service, teams, lead, dev, outside, ws, dir };
}
const counts = (store: Store) => ({
  a: store.list("agent").length,
  e: store.list("edge").length,
  r: store.list("rule").length,
});

test("save, export and import round-trip into a fresh insertion with remapped ids", async (t) => {
  const { store, teams, lead, dev, ws } = await setup(t);
  const saved = teams.create({
    name: "Pair",
    agentIds: [lead.id, dev.id],
    positions: { [lead.id]: { x: 500, y: 400 }, [dev.id]: { x: 800, y: 700 } },
  });
  assert.deepEqual(
    saved.agents.map((a) => a.position),
    [
      { x: 0, y: 0 },
      { x: 300, y: 300 },
    ],
  );
  const envelope = JSON.parse(JSON.stringify(teams.export(saved.id)));
  assert.equal(envelope.schemaVersion, TEAM_TEMPLATE_SCHEMA_VERSION);
  const imported = teams.import(envelope);
  const before = counts(store);
  const result = await teams.insert({
    templateId: imported.id,
    workspaces: { "a1/w1": ws },
    offset: { x: 10, y: 20 },
  });
  assert.equal(result.agents.length, 2);
  assert.equal(result.edges.length, 2);
  assert.equal(result.rules.length, 1);
  const after = counts(store);
  assert.deepEqual(after, {
    a: before.a + 2,
    e: before.e + 2,
    r: before.r + 1,
  });
  const newIds = new Set(result.agents.map((a) => a.id));
  assert.ok(![lead.id, dev.id].some((id) => newIds.has(id)));
  const [nl, nd] = result.agents;
  assert.equal(nl.name, "Lead");
  assert.equal(nl.effort, "high");
  assert.equal(nl.schedulingPriority, 80);
  assert.equal(nd.parentId, nl.id);
  for (const e of result.edges as Edge[])
    assert.ok(newIds.has(e.from) && newIds.has(e.to));
  const rule = result.rules[0] as Rule;
  assert.equal(rule.agentId, nl.id);
  assert.equal(rule.targetId, nd.id);
  assert.deepEqual(result.layout[nl.id], { x: 10, y: 20 });
  assert.deepEqual(result.layout[nd.id], { x: 310, y: 320 });
  assert.equal(nl.workspaces[0].path.endsWith("project"), true);
  assert.equal(store.get<Agent>("agent", nd.id).control, "team");
});

test("external edges, rules and parents are flagged and never inserted", async (t) => {
  const { teams, dev, lead, outside } = await setup(t);
  const tpl = teams.build({ name: "Dev only", agentIds: [dev.id] });
  assert.equal(tpl.edges.length, 0);
  assert.equal(tpl.rules.length, 0);
  assert.equal(tpl.agents[0].parentKey, null);
  const ext = tpl.externalDependencies;
  assert.ok(ext.some((d) => d.type === "parent" && d.externalName === "Lead"));
  assert.ok(
    ext.some(
      (d) =>
        d.type === "edge" &&
        d.direction === "incoming" &&
        d.externalName === "Outsider",
    ),
  );
  assert.ok(
    ext.some(
      (d) =>
        d.type === "edge" &&
        d.direction === "outgoing" &&
        d.externalName === "Lead",
    ),
  );
  assert.ok(ext.some((d) => d.type === "rule" && d.direction === "incoming"));
  const lonely = teams.build({ name: "x", agentIds: [lead.id, outside.id] });
  assert.equal(lonely.edges.length, 0);
});

test("invalid templates fail atomically and leave no partial insert", async (t) => {
  const { store, teams, lead, dev, ws } = await setup(t);
  const saved = teams.create({ name: "Pair", agentIds: [lead.id, dev.id] });
  // Make the second agent reference a missing skill: whole insert must fail.
  const bad = JSON.parse(JSON.stringify(teams.export(saved.id)));
  bad.template.agents[1].skills = [{ id: "does-not-exist" }];
  const before = counts(store);
  const events = store.history().length;
  await assert.rejects(
    teams.insert({ envelope: bad, workspaces: { "a1/w1": ws } }),
    (e: any) => e.code === "template_invalid" && /skill/.test(e.message),
  );
  assert.deepEqual(counts(store), before);
  assert.equal(store.history().length, events);
  // Missing workspace mapping is required.
  const preview = await teams.preview({ templateId: saved.id });
  assert.equal(preview.ok, false);
  assert.ok(preview.issues.some((i) => i.code === "workspace_unmapped"));
  await assert.rejects(
    teams.insert({ templateId: saved.id }),
    (e: any) => e.code === "template_invalid",
  );
  await assert.rejects(
    teams.insert({
      templateId: saved.id,
      workspaces: { "a1/w1": join(ws, "missing") },
    }),
    (e: any) => e.code === "template_invalid",
  );
  assert.deepEqual(counts(store), before);
  // A failure mid-write (after validation) also rolls everything back.
  const original = store.put.bind(store);
  let n = 0;
  store.put = ((kind: string, v: any) => {
    if (kind === "edge" && ++n === 2) throw new Error("disk full");
    return original(kind, v);
  }) as any;
  await assert.rejects(
    teams.insert({ templateId: saved.id, workspaces: { "a1/w1": ws } }),
    /disk full/,
  );
  store.put = original;
  assert.deepEqual(counts(store), before);
});

test("events are published only after commit", async (t) => {
  const { store, teams, lead, ws } = await setup(t);
  const saved = teams.create({ name: "Solo", agentIds: [lead.id] });
  const seen: any[] = [];
  store.events.on("event", (e: any) => seen.push(e.type));
  await assert.rejects(teams.insert({ templateId: saved.id }));
  assert.equal(seen.length, 0);
  await teams.insert({ templateId: saved.id, workspaces: { "a1/w1": ws } });
  assert.ok(seen.includes("agent.created") && seen.includes("team.inserted"));
});

test("compatibility checks reject newer or malformed templates", async (t) => {
  const { teams, lead } = await setup(t);
  const saved = teams.create({ name: "Solo", agentIds: [lead.id] });
  const env = JSON.parse(JSON.stringify(teams.export(saved.id)));
  assert.throws(
    () => teams.import({ ...env, schemaVersion: 99 }),
    (e: any) => e.code === "template_too_new",
  );
  assert.throws(
    () => teams.import({ ...env, format: "other" }),
    (e: any) => e.code === "invalid_template",
  );
  assert.throws(() =>
    teams.import({ ...env, template: { ...env.template, sessions: [] } }),
  );
  env.template.agents[0].parentKey = "a9";
  assert.throws(() => teams.import(env));
});

test("templates carry no secrets, sessions, leases, ids or absolute paths by default", async (t) => {
  const { service, teams, lead, dev, ws, dir } = await setup(t);
  service.session(lead.id);
  const saved = teams.create({ name: "Pair", agentIds: [lead.id, dev.id] });
  const json = JSON.stringify(teams.export(saved.id));
  assert.ok(!json.includes(dir));
  assert.ok(!json.includes(lead.id) && !json.includes(dev.id));
  assert.ok(
    !/session|lease|token|createdAt":"20.*providerSessionId/i.test(
      JSON.stringify(saved.agents),
    ),
  );
  assert.equal(saved.includesAbsolutePaths, false);
  const explicit = teams.build({
    name: "P",
    agentIds: [lead.id],
    includeAbsolutePaths: true,
  });
  assert.equal(
    explicit.agents[0].workspaces[0].path,
    await (await import("node:fs/promises")).realpath(ws),
  );
  // Embedded paths are only used when insertion explicitly opts in.
  const stored = teams.create({
    name: "P",
    agentIds: [lead.id],
    includeAbsolutePaths: true,
  });
  assert.equal((await teams.preview({ templateId: stored.id })).ok, false);
  assert.equal(
    (await teams.preview({ templateId: stored.id, useEmbeddedPaths: true })).ok,
    true,
  );
});

test("team assistant is excluded and the global singleton is preserved", async (t) => {
  const { service, teams, lead } = await setup(t);
  const assistant = await service.saveAgent({
    name: "Assistant",
    environment: "codex",
    kind: "team-assistant",
  });
  assert.throws(
    () => teams.build({ name: "x", agentIds: [assistant.id] }),
    (e: any) => e.code === "assistant_not_templatable",
  );
  const saved = teams.create({ name: "Solo", agentIds: [lead.id] });
  const env = JSON.parse(JSON.stringify(teams.export(saved.id)));
  env.template.agents[0].kind = "team-assistant";
  assert.throws(() => teams.import(env));
  const ws = Object.keys(
    (await teams.preview({ templateId: saved.id })).workspaceSlots,
  );
  assert.equal(ws.length, 1);
});

test("unsupported environments and unknown models are rejected unless mapped", async (t) => {
  const { store, service, lead, ws } = await setup(t);
  const runtimes: any[] = [
    {
      id: "codex",
      installed: true,
      models: [
        { id: "default", name: "d", efforts: [] },
        { id: "m1", name: "m1", efforts: ["low"] },
      ],
    },
    { id: "claude", installed: false, models: [] },
    { id: "wolfram", installed: false, models: [] },
  ];
  const teams = new TeamTemplates(service, () => runtimes);
  await service.saveAgent({
    name: "Custom",
    environment: "codex",
    model: "gone",
    effort: "low",
  });
  const saved = teams.create({
    name: "S",
    agentIds: [store.list<Agent>("agent").find((a) => a.name === "Custom")!.id],
  });
  assert.ok(
    (await teams.preview({ templateId: saved.id })).issues.some(
      (i) => i.code === "model_unavailable",
    ),
  );
  assert.equal(
    (
      await teams.preview({
        templateId: saved.id,
        modelMap: { "codex:gone": "m1" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await teams.preview({ templateId: saved.id, allowUnknownModels: true }))
      .ok,
    true,
  );
  const claude = teams.create({
    name: "C",
    agentIds: [store.list<Agent>("agent").find((a) => a.name === "Dev")!.id],
  });
  assert.ok(
    (await teams.preview({ templateId: claude.id })).issues.some(
      (i) => i.code === "environment_unavailable",
    ),
  );
  void lead;
  void ws;
});

test("HTTP API saves, exports, imports, inserts and deletes templates behind auth", async (t) => {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    server = createApi(
      service,
      "tok",
      new RunManager(service, false, process.cwd()),
    );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const call = (p: string, method = "GET", body?: unknown) =>
    fetch(base + p, {
      method,
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await fetch(base + "/teams")).status, 401);
  const a = await service.saveAgent({ name: "A", environment: "codex" });
  const b = await service.saveAgent({ name: "B", environment: "codex" });
  service.saveEdge({ from: a.id, to: b.id, kind: "delegate" });
  const created = await (
    await call("/teams", "POST", { name: "T", agentIds: [a.id, b.id] })
  ).json();
  assert.equal((await (await call("/teams")).json()).length, 1);
  const env = await (await call(`/teams/${created.id}/export`)).json();
  const imp = await call("/teams/import", "POST", env);
  assert.equal(imp.status, 201);
  const ins = await call("/teams/insert", "POST", {
    envelope: env,
    allowUninstalledEnvironments: true,
  });
  assert.equal(ins.status, 201);
  assert.equal(store.list("agent").length, 4);
  const bad = await call("/teams/insert", "POST", {
    envelope: { ...env, schemaVersion: 7 },
  });
  assert.equal(bad.status, 422);
  assert.equal((await call(`/teams/${created.id}`, "DELETE")).status, 200);
  assert.equal((await call(`/teams/${created.id}`)).status, 404);
});
