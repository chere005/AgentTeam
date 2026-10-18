import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";
import { defaults, type DetectedRuntime } from "../src/discovery.ts";
import type { TeamProfile } from "../src/team-profiles.ts";
import type { Agent, Edge, Task } from "../src/model.ts";

// Team settings (src/team-settings.ts): the profile view, worker counts that add/remove worker
// agents following the role preset and org tree, refusal cases, model check, and the effect on
// paused pipeline projects' verification. Temp store and folders; no provider or runtime scan.

const installed = (): DetectedRuntime[] =>
  structuredClone(defaults).map((r) => ({ ...r, installed: true }));

async function world(t: any) {
  const store = new Store(":memory:");
  const catalog = new SkillCatalog([
    {
      path: join(process.cwd(), "assets", "skills"),
      origin: "bundled",
      label: "bundled",
    },
  ]);
  await catalog.scan();
  const service = new TeamService(store, catalog);
  const server = createApi(
    service,
    "test-token",
    new RunManager(service, false, process.cwd()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-ts-")));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(base, { recursive: true, force: true });
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
  const repo = join(base, "repo");
  await mkdir(join(repo, "a"), { recursive: true });
  await writeFile(join(repo, "a", "x.txt"), "x");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a]);
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  git("add", ".");
  git("commit", "-qm", "init");
  const insert = async (id: string, options: object = {}) => {
    const r = await call("POST", `/teams/examples/${id}/insert`, {
      options,
      acceptUnverifiedModels: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.teamId as string;
  };
  const profile = (teamId: string) =>
    store.get<TeamProfile>("team-profile", teamId);
  const agent = (id: string) => store.get<Agent>("agent", id);
  return { store, service, call, repo, base, insert, profile, agent };
}

test("team settings show the profile; growing a worker role copies the role preset into the org tree", async (t) => {
  const w = await world(t);
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  const view = (await w.call("GET", `/team-spaces/${teamId}/settings`)).body;
  assert.equal(view.projectType, "pipeline");
  assert.equal(view.lead.name, "Pipeline Planner (Opus 5.5)");
  const impl = view.roles.find((r: any) => r.role === "implement");
  assert.equal(impl.count, 2);
  assert.deepEqual(impl.countable, {
    label: "Implementation workers",
    min: 1,
    max: 5,
    setting: "implementationWorkers",
  });
  assert.ok(!view.roles.find((r: any) => r.role === "planner").countable);
  assert.equal(view.workspaceAccess.derived, false);
  assert.equal(
    view.workspaceAccess.agents.find((a: any) =>
      a.name.startsWith("Review: Codex"),
    ).access,
    "read",
  );
  assert.ok(view.expectations.length >= 10);

  const before = w.profile(teamId);
  const integrator = before.roles.integrator[0];
  const r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 4, fix: 2 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added.length, 3);
  const p = w.profile(teamId);
  assert.equal(p.roles.implement.length, 4);
  assert.equal(p.roles.fix.length, 2);
  assert.equal(p.settings.implementationWorkers, 4);
  assert.equal(p.settings.fixWorkers, 2);
  const template = w.agent(before.roles.implement[1]);
  const added = w.agent(p.roles.implement[3]);
  assert.equal(added.name, "Implementation Worker 4 (Sonnet 5.5)");
  assert.equal(w.agent(p.roles.fix[1]).name, "Fix Worker 2 (Sonnet 5.5)");
  // role preset: same role type, runtime, model, effort, tools, instructions, parent; no folders
  for (const k of [
    "roleType",
    "environment",
    "model",
    "effort",
    "instructions",
    "parentId",
    "maxConcurrentInvocations",
  ] as const)
    assert.deepEqual(added[k], template[k], k);
  assert.deepEqual(added.tools, template.tools);
  assert.equal(added.parentId, integrator);
  assert.deepEqual(added.workspaces, []);
  assert.equal((added as Agent & { teamId?: string }).teamId, teamId);
  // connections re-pointed: the integrator delegates to the new worker
  assert.ok(
    w.store
      .list<Edge>("edge")
      .some(
        (e) =>
          e.from === integrator && e.to === added.id && e.kind === "delegate",
      ),
  );
  assert.deepEqual(p.expectations[added.id], p.expectations[template.id]);
  assert.equal(p.workspace!.access[added.id], "write");
  // projects assigned later use the new counts
  const info = (await w.call("GET", `/team-spaces/${teamId}/projects`)).body;
  assert.equal(info.defaults.implementationWorkers, 4);
  assert.equal(info.defaults.fixWorkers, 2);
  const proj = await w.call("POST", `/team-spaces/${teamId}/projects`, {
    goal: "Use all four implementation workers",
    workspace: w.repo,
  });
  assert.equal(proj.status, 201, JSON.stringify(proj.body));
  assert.equal(
    proj.body.tasks.filter((x: Task) => x.title.startsWith("Stage 2")).length,
    4,
  );
  // bounds and roles that are not worker roles
  for (const [body, code] of [
    [{ counts: { implement: 6 } }, "invalid_count"],
    [{ counts: { implement: 0 } }, "invalid_count"],
    [{ counts: { planner: 2 } }, "role_not_countable"],
    [{ counts: { implement: 3 }, remove: [integrator] }, "invalid_removal"],
  ] as const) {
    const bad = await w.call(
      "PUT",
      `/team-spaces/${teamId}/settings/workers`,
      body,
    );
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, code);
  }

  // Wolfram team: 1-2 validators; product team (free-form) has no worker roles to resize
  const wolfram = await w.insert("wolfram-validated-team", {
    wolframAgents: 1,
  });
  const grown = await w.call(
    "PUT",
    `/team-spaces/${wolfram}/settings/workers`,
    {
      counts: { validators: 2 },
    },
  );
  assert.equal(grown.status, 200, JSON.stringify(grown.body));
  assert.equal(w.profile(wolfram).roles.validators.length, 2);
  assert.equal(w.profile(wolfram).settings.wolframAgents, 2);
  assert.equal(
    (
      await w.call("PUT", `/team-spaces/${wolfram}/settings/workers`, {
        counts: { validators: 3 },
      })
    ).body.error,
    "invalid_count",
  );
  const product = await w.insert("product-feature-team");
  const pv = (await w.call("GET", `/team-spaces/${product}/settings`)).body;
  assert.equal(pv.projectType, "free-form");
  assert.ok(pv.roles.every((r: any) => !r.countable));
  assert.equal(
    (
      await w.call("PUT", `/team-spaces/${product}/settings/workers`, {
        counts: { implement: 3 },
      })
    ).body.error,
    "role_not_countable",
  );
  // a team without a profile (Main) shows derived workspace access and has nothing to resize
  const main = (await w.call("GET", `/team-spaces/main/settings`)).body;
  assert.equal(main.hasProfile, false);
  assert.equal(
    (
      await w.call("PUT", `/team-spaces/main/settings/workers`, {
        counts: { implement: 2 },
      })
    ).body.error,
    "no_profile",
  );
});

test("removing workers refuses unfinished work, uncertain effects, running chats and leads, as a whole; finished history retires and is reinstated", async (t) => {
  const w = await world(t);
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 3,
    fixWorkers: 1,
  });
  const p0 = w.profile(teamId);
  const [w1, w2, w3] = p0.roles.implement;
  const agents = () => w.store.list<Agent>("agent").length;
  const n0 = agents();
  // a project using workers 1-2 only: worker 3 is free and is deleted outright
  const proj = await w.call("POST", `/team-spaces/${teamId}/projects`, {
    goal: "A project on two of the three workers",
    workspace: w.repo,
    implementationWorkers: 2,
  });
  assert.equal(proj.status, 201);
  let r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted, [w3]);
  assert.equal(agents(), n0 - 1);
  assert.ok(!w.store.list<Edge>("edge").some((e) => e.to === w3));
  // workers 1-2 have queued tasks of the paused project: refused, nothing changes
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 1 },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "agent_in_use");
  assert.match(r.body.message, /unfinished task/);
  assert.deepEqual(w.profile(teamId).roles.implement, [w1, w2]);
  // choosing worker 1 explicitly is refused for the same reason
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 1 },
    remove: [w1],
  });
  assert.equal(r.status, 409);

  // grow again (a new worker 3), then give it finished history in an ordinary workflow
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 3 },
  });
  const nw3 = r.body.added[0];
  assert.ok(nw3 && nw3 !== w3);
  const wf = w.service.workflow({
    name: "history",
    goal: "history for worker 3",
    ownerId: p0.leadId,
    completionCriteria: "done",
    teamId,
  });
  const task = w.service.task({
    workflowId: wf.id,
    agentId: nw3,
    title: "One finished task",
    instructions: "x",
    completionCriteria: "done",
  });
  // queued -> refused; running -> refused
  for (const status of ["queued", "running"]) {
    if (status === "running")
      w.service.transitionTask(task.id, { status: "running" });
    r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
      counts: { implement: 2 },
    });
    assert.equal(r.status, 409, status);
  }
  w.service.transitionTask(task.id, { status: "completed", result: "ok" });
  // an uncertain external effect still refuses
  const now = new Date().toISOString();
  w.store.put("effect", {
    id: "e-test",
    taskId: task.id,
    key: "k",
    kind: "provider-run",
    description: "push",
    mutating: true,
    state: "uncertain",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    history: [],
  });
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2 },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /uncertain/);
  w.store.remove("effect", "e-test");
  // a running conversation refuses
  w.store.put("session", {
    id: "s-test",
    agentId: nw3,
    state: "running",
    createdAt: now,
  });
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2 },
  });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /running conversation/);
  w.store.put("session", {
    id: "s-test",
    agentId: nw3,
    state: "idle",
    createdAt: now,
  });
  // finished history only: retired (kept, out of the role), then reinstated first when growing
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.retired, [nw3]);
  assert.ok(w.agent(nw3));
  assert.deepEqual(w.profile(teamId).roles.implement, [w1, w2]);
  assert.equal(w.profile(teamId).retired![0].agentId, nw3);
  assert.equal(w.service.taskState(task.id).status, "completed");
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 3 },
  });
  assert.deepEqual(r.body.reinstated, [nw3]);
  assert.deepEqual(r.body.added, []);
  assert.deepEqual(w.profile(teamId).retired, []);
  // a role's last agents that lead other agents are refused (the integrator is not a worker role,
  // so check the "agents report to it" rule on a worker given a child)
  w.store.put("agent", { ...w.agent(nw3), parentId: w1 });
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2 },
    remove: [w1],
  });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /report to it|unfinished/);
});

test("worker changes keep paused projects' verification (bound to their own agents); a change to a project agent needs re-verify with the reason; completed history is untouched", async (t) => {
  const w = await world(t);
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  const make = async (goal: string) => {
    const r = await w.call("POST", `/team-spaces/${teamId}/projects`, {
      goal,
      workspace: w.repo,
      isolation: "paths",
      paths: ["a", "b"].map((x) => join(w.repo, x)),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  await mkdir(join(w.repo, "b"), { recursive: true });
  const a = await make("First paused project of the pipeline team");
  const pf = await w.service.pipelines.prepare(a, installed());
  assert.equal(pf.verified, true, pf.issues.join("\n"));
  assert.ok(pf.parts, "per-part digests are stored");
  let r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 4, fix: 3 },
  });
  assert.equal(r.status, 200);
  const listed = r.body.settings.pausedPipelines.find((x: any) => x.id === a);
  assert.equal(listed.verification.state, "verified");
  assert.equal(w.service.pauseWorkflow(a, false).paused, false);
  w.service.pauseWorkflow(a, true);
  // shrinking back (the added workers are unused) keeps it verified too
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2, fix: 1 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(w.service.pipelines.verification(a).state, "verified");
  // a change to an agent the project uses is reported with its reason
  const rec = w.service.pipelines.record(a);
  const reviewer = w.agent(rec.agents.codexReview);
  w.store.put("agent", { ...reviewer, instructions: "Approve everything." });
  const v = w.service.pipelines.verification(a);
  assert.equal(v.state, "stale");
  assert.match(v.reasons.join("\n"), /Review: Codex.*instructions changed/);
  assert.throws(
    () => w.service.pauseWorkflow(a, false),
    /instructions changed.*prepare and verify it again/,
  );
  w.store.put("agent", reviewer);
  // a completed project's recorded verification is never rewritten by team changes
  const done = await make("A project that will be marked completed");
  await w.service.pipelines.prepare(done, installed());
  for (const tk of w.store
    .list<Task>("task")
    .filter((x) => x.workflowId === done))
    w.service.transitionTask(tk.id, { status: "cancelled" });
  assert.equal(
    (
      await w.call("POST", `/projects/${done}/lifecycle`, {
        action: "complete",
      })
    ).status,
    200,
  );
  const snapshot = JSON.stringify(
    w.store.get<any>("workflow", done).setup.preflight,
  );
  r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 3 },
  });
  assert.equal(r.status, 200);
  assert.equal(
    JSON.stringify(w.store.get<any>("workflow", done).setup.preflight),
    snapshot,
  );
  assert.ok(!r.body.settings.pausedPipelines.some((x: any) => x.id === done));
});

test("the team model check re-runs against discovered runtimes and is stored on the profile", async (t) => {
  const w = await world(t);
  const teamId = await w.insert("wolfram-validated-team");
  const r = await w.call("POST", `/team-spaces/${teamId}/settings/model-check`);
  assert.equal(r.status, 200);
  // runtimes were never scanned in this test: issues, never a substituted model
  assert.equal(r.body.modelCheck.verified, false);
  assert.match(
    r.body.modelCheck.issues.join("\n"),
    /not been discovered|not installed or detected/,
  );
  assert.equal(
    w.profile(teamId).modelCheck!.checkedAt,
    r.body.modelCheck.checkedAt,
  );
  assert.equal(
    r.body.settings.modelCheck.checkedAt,
    r.body.modelCheck.checkedAt,
  );
  // rename and description go through the team container route
  const renamed = await w.call("PUT", `/team-spaces/${teamId}`, {
    name: "Math team",
    description: "Validated derivations",
  });
  assert.equal(renamed.status, 200);
  const view = (await w.call("GET", `/team-spaces/${teamId}/settings`)).body;
  assert.equal(view.team.name, "Math team");
  assert.equal(view.team.description, "Validated derivations");
});
