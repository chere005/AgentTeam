import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createApi } from "../src/http.ts";
import { createWolframSample } from "../src/samples.ts";
import { TEAM_TEMPLATE_FORMAT, TeamTemplates } from "../src/teams.ts";
import { MAIN_TEAM_ID } from "../src/team-spaces.ts";
import { buildTimeline } from "../src/inspector.ts";
import { exportBundle } from "../src/diagnostics.ts";
import type { Agent, Edge, Task, Workflow } from "../src/model.ts";
import {
  eventVisible,
  filterSnapshot,
  itemTeam,
  teamIndex,
  teamKey,
} from "../ui/team-view.ts";

const make = () => {
  const store = new Store(":memory:");
  return { store, service: new TeamService(store, new SkillCatalog([])) };
};
async function api(t: any) {
  const { store, service } = make();
  const server = createApi(
    service,
    "test-token",
    new RunManager(service, false, process.cwd()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: {
        authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { store, service, call, url };
}
const envelope = (name: string) => ({
  format: TEAM_TEMPLATE_FORMAT,
  schemaVersion: 2,
  template: {
    name,
    agents: [
      { key: "lead", name: name + " lead", environment: "codex" },
      { key: "dev", name: name + " dev", environment: "codex" },
    ],
    edges: [{ from: "lead", to: "dev", kind: "delegate" }],
  },
});

test("legacy records without teamId stay readable and belong to the Main team", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-teams-"));
  try {
    const file = join(dir, "db.sqlite");
    // A database written before teams existed: no team-space entities, no teamId fields.
    const old = new Store(file);
    const base = {
      role: "",
      roleType: "custom",
      model: "default",
      effort: null,
      schedulingPriority: 50,
      maxConcurrentInvocations: null,
      instructions: "",
      tools: [],
      skills: [],
      workspaces: [],
      parentId: null,
      control: "team",
      createdAt: new Date().toISOString(),
    };
    old.put("agent", {
      ...base,
      id: "a1",
      name: "Old",
      kind: "agent",
      environment: "codex",
    });
    old.put("agent", {
      ...base,
      id: "as",
      name: "Assistant",
      kind: "team-assistant",
      environment: "claude",
    });
    old.put("workflow", {
      id: "w1",
      name: "W",
      goal: "G",
      ownerId: "a1",
      completionCriteria: "D",
      paused: false,
    });
    old.close();
    const store = new Store(file);
    const service = new TeamService(store, new SkillCatalog([]));
    const spaces = service.teamSpaces;
    assert.deepEqual(
      spaces.list().map((t) => [t.id, t.name]),
      [[MAIN_TEAM_ID, "Main team"]],
    );
    assert.equal(spaces.active(), MAIN_TEAM_ID);
    assert.equal(spaces.teamOfAgent(store.get<Agent>("agent", "a1")), "main");
    assert.equal(spaces.teamOfAgent(store.get<Agent>("agent", "as")), null);
    assert.equal(
      spaces.teamOfWorkflow(store.get<Workflow>("workflow", "w1")),
      "main",
    );
    const [main] = spaces.summaries();
    assert.equal(main.agents, 1); // the assistant is global, not counted in a team
    assert.equal(main.workflows, 1);
    // Nothing was rewritten: the records are read through defaults.
    assert.equal(store.get<any>("agent", "a1").teamId, undefined);
    // Existing policy is untouched: an update keeps the agent in Main and stays valid.
    const { id, createdAt, control, ...input } = store.get<Agent>(
      "agent",
      "a1",
    );
    const saved = await service.saveAgent({ ...input, name: "Old 2" }, id);
    assert.equal(spaces.teamOfAgent(saved), "main");
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creation paths attach new agents and workflows to the right team", async (t) => {
  const { call, store, service } = await api(t);
  const created = await call("POST", "/team-spaces", { name: "Research" });
  assert.equal(created.status, 201);
  const research = created.body.id as string;
  // Name collisions are made unique instead of failing.
  const again = await call("POST", "/team-spaces", { name: "research" });
  assert.equal(again.body.name, "research 2");
  // Explicit team.
  const a = await call("POST", "/agents", {
    name: "A",
    environment: "codex",
    teamId: research,
  });
  assert.equal(a.status, 201);
  assert.equal(a.body.teamId, research);
  // Default: the active team (Main until switched).
  const b = await call("POST", "/agents", { name: "B", environment: "codex" });
  assert.equal(b.body.teamId, MAIN_TEAM_ID);
  assert.equal(
    (await call("PUT", "/team-spaces/active", { teamId: research })).status,
    200,
  );
  const c = await call("POST", "/agents", { name: "C", environment: "codex" });
  assert.equal(c.body.teamId, research);
  // Unknown team refused, bad ids refused.
  assert.equal(
    (
      await call("POST", "/agents", {
        name: "X",
        environment: "codex",
        teamId: "nope",
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("PUT", "/team-spaces/active", { teamId: "Bad_Id" })).status,
    400,
  );
  // An edit (without teamId) keeps the team; the UI's full record (teamId included) is accepted.
  const snap = (await call("GET", "/snapshot")).body;
  const full = snap.agents.find((x: any) => x.id === b.body.id);
  const { id: _i, createdAt: _c, control: _o, ...rest } = full;
  const edited = await call("PUT", "/agents/" + b.body.id, {
    ...rest,
    name: "B2",
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.teamId, MAIN_TEAM_ID);
  // Workflows: explicit team, else the owner's team.
  const w1 = await call("POST", "/workflows", {
    name: "W1",
    goal: "G",
    ownerId: b.body.id,
    completionCriteria: "D",
  });
  assert.equal(w1.body.teamId, MAIN_TEAM_ID);
  const w2 = await call("POST", "/workflows", {
    name: "W2",
    goal: "G",
    ownerId: b.body.id,
    completionCriteria: "D",
    teamId: research,
  });
  assert.equal(w2.body.teamId, research);
  // The Team Assistant is global: no team even when one is asked for.
  const assistant = await call("POST", "/agents", {
    name: "Assistant",
    kind: "team-assistant",
    environment: "claude",
    teamId: research,
  });
  assert.equal(assistant.status, 201);
  assert.equal(assistant.body.teamId, undefined);
  // A workflow owned by the assistant lands in the active team.
  const w3 = await call("POST", "/workflows", {
    name: "W3",
    goal: "G",
    ownerId: assistant.body.id,
    completionCriteria: "D",
  });
  assert.equal(w3.body.teamId, research);
  // Template insert creates its own team named after the template (unique) and activates it.
  const ins1 = await call("POST", "/teams/insert", {
    allowUninstalledEnvironments: true,
    envelope: envelope("Review crew"),
  });
  assert.equal(ins1.status, 201, JSON.stringify(ins1.body));
  assert.equal(ins1.body.teamName, "Review crew");
  const ins2 = await call("POST", "/teams/insert", {
    allowUninstalledEnvironments: true,
    envelope: envelope("Review crew"),
  });
  assert.equal(ins2.body.teamName, "Review crew 2");
  assert.equal(service.teamSpaces.active(), ins2.body.teamId);
  for (const ag of ins2.body.agents) assert.equal(ag.teamId, ins2.body.teamId);
  // ... or inserts into an existing team when asked, without creating one.
  const before = service.teamSpaces.list().length;
  const ins3 = await call("POST", "/teams/insert", {
    allowUninstalledEnvironments: true,
    envelope: envelope("Into research"),
    teamId: research,
  });
  assert.equal(ins3.body.teamId, research);
  assert.equal(service.teamSpaces.list().length, before);
  assert.equal(
    (
      await call("POST", "/teams/insert", {
        allowUninstalledEnvironments: true,
        envelope: envelope("Both"),
        teamId: research,
        teamName: "x",
      })
    ).status,
    400,
  );
  // Wolfram sample: its own team, active, with the workflow and every sample agent.
  const sample = await call("POST", "/samples/wolfram-validated-reasoning", {});
  assert.equal(sample.status, 201);
  const sampleTeam = sample.body.teamId as string;
  assert.ok(sampleTeam && sampleTeam !== research);
  assert.equal(service.teamSpaces.active(), sampleTeam);
  const sampleAgents = store
    .list<Agent>("agent")
    .filter((x) => x.teamId === sampleTeam);
  assert.equal(sampleAgents.length, 3);
  // Saving a selection as a template remembers the team it came from (library only).
  const saved = await call("POST", "/teams", {
    name: "From research",
    agentIds: [a.body.id, c.body.id],
  });
  assert.equal(saved.body.sourceTeam.id, research);
  const exported = await call("GET", `/teams/${saved.body.id}/export`);
  assert.equal(exported.body.template.sourceTeam, undefined);
  assert.equal(exported.body.schemaVersion, 3);
});

test("team delete: Main and busy teams are refused; agents move by default or are deleted explicitly", async (t) => {
  const { call, store, service } = await api(t);
  assert.equal((await call("DELETE", "/team-spaces/main")).status, 409);
  const x = (await call("POST", "/team-spaces", { name: "X" })).body.id;
  const lead = (
    await call("POST", "/agents", {
      name: "L",
      environment: "codex",
      teamId: x,
    })
  ).body;
  const idle = (
    await call("POST", "/agents", {
      name: "I",
      environment: "codex",
      teamId: x,
    })
  ).body;
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  const task = service.task({
    workflowId: wf.id,
    agentId: lead.id,
    title: "T",
    completionCriteria: "D",
  });
  await call("PUT", "/team-spaces/active", { teamId: x });
  service.transitionTask(task.id, { status: "running" });
  const busy = await call("DELETE", "/team-spaces/" + x, {});
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, "team_busy");
  service.transitionTask(task.id, { status: "completed", result: "ok" });
  // Explicit delete refuses as a whole when an agent is in use (tasks, owned workflows).
  const refused = await call("DELETE", "/team-spaces/" + x, {
    agents: "delete",
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "agent_in_use");
  assert.ok(service.teamSpaces.exists(x));
  // Default: everything moves to Main; the active team follows.
  const done = await call("DELETE", "/team-spaces/" + x, {});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.moveTo, MAIN_TEAM_ID);
  assert.equal(service.teamSpaces.exists(x), false);
  assert.equal(service.teamSpaces.active(), MAIN_TEAM_ID);
  assert.equal(store.get<Agent>("agent", lead.id).teamId, MAIN_TEAM_ID);
  assert.equal(store.get<Agent>("agent", idle.id).teamId, MAIN_TEAM_ID);
  assert.equal(store.get<Workflow>("workflow", wf.id).teamId, MAIN_TEAM_ID);
  assert.equal(store.get<Task>("task", task.id).status, "completed");
  // Explicit delete of unused agents (and their edges) works; workflows still move.
  const y = (await call("POST", "/team-spaces", { name: "Y" })).body.id;
  const z = (await call("POST", "/team-spaces", { name: "Z" })).body.id;
  const p = (
    await call("POST", "/agents", {
      name: "P",
      environment: "codex",
      teamId: y,
    })
  ).body;
  const q = (
    await call("POST", "/agents", {
      name: "Q",
      environment: "codex",
      teamId: y,
      parentId: p.id,
    })
  ).body;
  await call("POST", "/edges", { from: p.id, to: q.id, kind: "delegate" });
  const gone = await call("DELETE", "/team-spaces/" + y, {
    agents: "delete",
    moveTo: z,
  });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(
    store.list<Agent>("agent").some((a) => a.id === p.id || a.id === q.id),
    false,
  );
  assert.equal(store.list<Edge>("edge").length, 0);
  // Moving members; the assistant cannot be moved.
  const moved = await call("POST", `/team-spaces/${z}/members`, {
    agentIds: [lead.id],
    workflowIds: [wf.id],
  });
  assert.equal(moved.status, 200);
  assert.equal(store.get<Agent>("agent", lead.id).teamId, z);
  const assistant = (
    await call("POST", "/agents", {
      name: "As",
      kind: "team-assistant",
      environment: "claude",
    })
  ).body;
  assert.equal(
    (
      await call("POST", `/team-spaces/${z}/members`, {
        agentIds: [assistant.id],
      })
    ).status,
    400,
  );
  // Rename keeps names unique.
  const renamed = await call("PUT", "/team-spaces/" + z, { name: "Main team" });
  assert.equal(renamed.body.name, "Main team 2");
  assert.equal((await call("DELETE", "/team-spaces/nope", {})).status, 404);
});

test("cross-team edges need an explicit request; enforcement is unchanged", async () => {
  const { store, service } = make();
  const other = service.teamSpaces.create({ name: "Other" });
  const a = await service.saveAgent({ name: "A", environment: "codex" });
  const b = await service.saveAgent({ name: "B", environment: "codex" });
  const c = await service.saveAgent({
    name: "C",
    environment: "codex",
    teamId: other.id,
  });
  const assistant = await service.saveAgent({
    name: "As",
    kind: "team-assistant",
    environment: "claude",
  });
  // Within a team and to/from the global assistant: ordinary edges.
  service.saveEdge({ from: a.id, to: b.id, kind: "delegate" });
  service.saveEdge({ from: assistant.id, to: c.id, kind: "notify" });
  assert.throws(
    () => service.saveEdge({ from: a.id, to: c.id, kind: "delegate" }),
    { code: "cross_team_edge" },
  );
  // Without an edge the backend denies cross-team delegation exactly as before.
  assert.throws(
    () =>
      service.route({
        text: "x",
        fromAgentId: a.id,
        targetId: c.id,
        kind: "delegate",
      }),
    { code: "connection_denied" },
  );
  const link = service.saveEdge({
    from: a.id,
    to: c.id,
    kind: "delegate",
    crossTeam: true,
  });
  assert.equal(link.crossTeam, true);
  assert.equal(service.permitted(a.id, c.id, "delegate"), true);
  assert.equal(service.permitted(c.id, a.id, "delegate"), false);
  // Editing a link without re-pointing it needs no new confirmation; re-pointing does.
  const { id, crossTeam, ...input } = link;
  void crossTeam;
  assert.equal(
    service.saveEdge({ ...input, bidirectional: true }, id).crossTeam,
    true,
  );
  assert.equal(service.permitted(c.id, a.id, "delegate"), true);
  const d = await service.saveAgent({
    name: "D",
    environment: "codex",
    teamId: other.id,
  });
  assert.throws(() => service.saveEdge({ ...input, to: d.id }, id), {
    code: "cross_team_edge",
  });
  // Moving an agent never deletes or weakens its edges: a former team edge is now cross-team.
  service.teamSpaces.move(other.id, { agentIds: [b.id] });
  assert.equal(service.permitted(a.id, b.id, "delegate"), true);
  assert.equal(store.list<Edge>("edge").length, 3);
});

test("the scheduler runs work of every team; switching the active team never pauses or cancels", async () => {
  const { store, service } = make();
  const runs = new RunManager(service, true, process.cwd());
  const release: (() => void)[] = [];
  const scheduler = new Scheduler(service, runs, async (_c, _e, emit) => {
    await new Promise<void>((r) => release.push(r));
    emit({ type: "text", data: "done" });
  });
  try {
    const other = service.teamSpaces.create({ name: "Other" });
    const tasks: Task[] = [];
    for (const teamId of [MAIN_TEAM_ID, other.id]) {
      const agent = await service.saveAgent({
        name: "Agent " + teamId,
        environment: "codex",
        teamId,
      });
      const wf = service.workflow({
        name: "W",
        goal: "G",
        ownerId: agent.id,
        completionCriteria: "D",
      });
      assert.equal(wf.teamId, teamId);
      tasks.push(
        service.task({
          workflowId: wf.id,
          agentId: agent.id,
          title: "T",
          completionCriteria: "D",
        }),
      );
    }
    service.teamSpaces.setActive({ teamId: other.id });
    await scheduler.tick();
    // Both teams' tasks started although only one team is shown.
    assert.equal(release.length, 2);
    for (const t of tasks)
      assert.equal(store.get<Task>("task", t.id).status, "running");
    // Switching while they run changes nothing about them.
    service.teamSpaces.setActive({ teamId: MAIN_TEAM_ID });
    service.teamSpaces.setActive({ teamId: other.id });
    for (const t of tasks)
      assert.equal(store.get<Task>("task", t.id).status, "running");
    const summary = service.teamSpaces.summaries();
    assert.deepEqual(
      summary.map((s) => [s.id, s.running, s.status]),
      [
        [MAIN_TEAM_ID, 1, "running"],
        [other.id, 1, "running"],
      ],
    );
    for (const r of release) r();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    for (const t of tasks)
      assert.equal(store.get<Task>("task", t.id).status, "completed");
  } finally {
    scheduler.stop();
    store.close();
  }
});

test("snapshot shape is additive; events, timeline and bundle accept a team filter", async (t) => {
  const { call, service } = await api(t);
  const other = (await call("POST", "/team-spaces", { name: "Other" })).body.id;
  const a = (await call("POST", "/agents", { name: "A", environment: "codex" }))
    .body;
  const b = (
    await call("POST", "/agents", {
      name: "B",
      environment: "codex",
      teamId: other,
    })
  ).body;
  const snap = (await call("GET", "/snapshot")).body;
  for (const key of [
    "agents",
    "edges",
    "rules",
    "workflows",
    "sessions",
    "activity",
    "liveExecution",
  ])
    assert.ok(key in snap, key);
  // Every team's data is present (the snapshot is not filtered by the active team).
  assert.equal(snap.agents.length, 2);
  assert.equal(snap.activeTeamId, MAIN_TEAM_ID);
  assert.deepEqual(
    snap.teams.map((x: any) => [x.name, x.agents]),
    [
      ["Main team", 1],
      ["Other", 1],
    ],
  );
  const events = (await call("GET", "/events?teamId=" + other)).body;
  assert.ok(events.some((e: any) => e.entityId === b.id));
  assert.ok(!events.some((e: any) => e.entityId === a.id));
  assert.equal((await call("GET", "/events?teamId=BAD")).status, 400);
  const timeline = buildTimeline(service, { teamId: other });
  assert.ok(timeline.entries.some((e) => e.agentId === b.id));
  assert.ok(!timeline.entries.some((e) => e.agentId === a.id));
  const viaRoute = (await call("GET", "/inspector/timeline?teamId=" + other))
    .body;
  assert.equal(viaRoute.entries.length, timeline.entries.length);
  const bundle = exportBundle(
    service,
    { liveEnabled: () => false, readiness: () => ({ state: "ready" }) },
    { format: "json", redaction: { secretFiles: [], literals: [] } },
  );
  const config = JSON.parse(bundle.data).files["config.json"];
  assert.deepEqual(
    config.teams.map((x: any) => x.name),
    ["Main team", "Other"],
  );
  assert.equal(config.agents.find((x: any) => x.id === b.id).teamId, other);
});

test("UI filter shows one team plus the global assistant and reports cross-team links", () => {
  const data = {
    agents: [
      { id: "a", name: "A", teamId: "main" },
      { id: "b", name: "B", teamId: "t2" },
      { id: "c", name: "C" }, // legacy: Main
      { id: "as", name: "Assistant", teamId: null },
    ],
    edges: [
      { id: "e1", from: "a", to: "c" },
      { id: "e2", from: "a", to: "b" },
      { id: "e3", from: "as", to: "b" },
    ],
    rules: [{ agentId: "a", targetId: "b" }, { agentId: "c" }],
    workflows: [
      { id: "w1", teamId: "main", tasks: [{ id: "t1" }] },
      { id: "w2", teamId: "t2", tasks: [{ id: "t2task" }] },
    ],
    sessions: [
      { id: "s1", agentId: "a" },
      { id: "s2", agentId: "b" },
    ],
    activity: [{ agentId: "a" }, { agentId: "b" }],
    teams: [
      {
        id: "main",
        name: "Main team",
        agents: 2,
        workflows: 1,
        running: 0,
        queued: 0,
        attention: 0,
        status: "idle" as const,
      },
      {
        id: "t2",
        name: "Two",
        agents: 1,
        workflows: 1,
        running: 1,
        queued: 0,
        attention: 0,
        status: "running" as const,
      },
    ],
  };
  const main = filterSnapshot(data, "main");
  assert.deepEqual(
    main.agents.map((a) => a.id),
    ["a", "c", "as"],
  );
  assert.deepEqual(
    main.edges.map((e) => e.id),
    ["e1"],
  );
  assert.deepEqual(
    main.workflows.map((w) => w.id),
    ["w1"],
  );
  assert.deepEqual(
    main.sessions.map((s) => s.id),
    ["s1"],
  );
  assert.equal(main.rules.length, 1);
  assert.deepEqual(
    main.teamView.crossTeam.map((x) => [x.edge.id, x.outsideTeamName]),
    [
      ["e2", "Two"],
      ["e3", "Two"],
    ],
  );
  const two = filterSnapshot(data, "t2");
  assert.deepEqual(
    two.agents.map((a) => a.id),
    ["b", "as"],
  );
  assert.equal(two.teamView.team.name, "Two");
  // An unknown/deleted team falls back to Main.
  assert.equal(filterSnapshot(data, "gone").activeTeamId, "main");
  const index = teamIndex(data);
  assert.equal(itemTeam(index, { agentId: "b" }), "t2");
  assert.equal(itemTeam(index, { agentId: "a", workflowId: "w2" }), "t2");
  assert.equal(itemTeam(index, { agentId: "as" }), null);
  assert.equal(eventVisible(index, "main", { entityId: "t2task" }), false);
  assert.equal(eventVisible(index, "main", { entityId: "settings" }), true);
  assert.equal(
    eventVisible(index, "t2", { entityId: "x", data: { agentId: "b" } }),
    true,
  );
  assert.equal(teamKey("groups", "main"), "groups");
  assert.equal(teamKey("groups", "t2"), "groups.team-t2");
});

test("template insert via the library service also defaults to a new team", async () => {
  const { service } = make();
  const teams = new TeamTemplates(service);
  const r = await teams.insert({
    allowUninstalledEnvironments: true,
    envelope: envelope("Solo"),
  });
  assert.equal(r.teamName, "Solo");
  assert.equal(service.teamSpaces.active(), r.teamId);
  const sample = createWolframSample(service, {});
  assert.notEqual(sample.teamId, r.teamId);
});
