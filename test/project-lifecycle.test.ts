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
import { planTaskOrder } from "../src/projects.ts";
import type { TeamProfile } from "../src/team-profiles.ts";
import type { Agent, Task, Workflow } from "../src/model.ts";

// Project lifecycle (src/project-lifecycle.ts), detach rules, scoped pipeline verification
// (src/pipeline.ts), free-form task dependencies (src/projects.ts) and worktree isolation of two
// pipeline projects on one team (src/project-worktrees.ts). Temp store, temp Git repositories,
// fixture runtimes only; no provider runs.

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
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-pl-")));
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
  const mkrepo = async (name: string) => {
    const repo = join(base, name);
    await mkdir(join(repo, "a"), { recursive: true });
    await mkdir(join(repo, "b"), { recursive: true });
    await writeFile(join(repo, "a", "x.txt"), "x");
    await writeFile(join(repo, "b", "y.txt"), "y");
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a]);
    git("init", "-q");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.invalid");
    git("add", ".");
    git("commit", "-qm", "init");
    return repo;
  };
  const insert = async (id: string, options: object = {}) => {
    const r = await call("POST", `/teams/examples/${id}/insert`, {
      options,
      acceptUnverifiedModels: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.teamId as string;
  };
  const assign = async (teamId: string, body: object) => {
    const r = await call("POST", `/team-spaces/${teamId}/projects`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as Workflow & { tasks: Task[] };
  };
  const agent = (id: string) => store.get<Agent>("agent", id);
  const folders = (id: string) => agent(id).workspaces.map((w) => w.path);
  const profile = (teamId: string) =>
    store.get<TeamProfile>("team-profile", teamId);
  return {
    store,
    service,
    call,
    base,
    mkrepo,
    insert,
    assign,
    agent,
    folders,
    profile,
  };
}

test("projects can be completed, archived and reopened; archived projects never resume", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const teamId = await w.insert("product-feature-team");
  const p = w.profile(teamId);
  const wf = await w.assign(teamId, {
    goal: "Ship the settings page",
    workspace: repo,
    tasks: [{ title: "Build it", agentId: p.roles.implement[0] }],
  });
  const life = (action: string) =>
    w.call("POST", `/projects/${wf.id}/lifecycle`, { action });
  // not finished: complete is refused (archive is the way to stop an unfinished project)
  let r = await life("complete");
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "project_unfinished");
  r = await life("archive");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project.state, "archived");
  assert.equal(r.body.paused, true);
  // archived: resume refused, assign list shows the state
  r = await w.call("POST", `/workflows/${wf.id}/pause`, { paused: false });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "project_archived");
  const info = (await w.call("GET", `/team-spaces/${teamId}/projects`)).body;
  assert.equal(
    info.projects.find((x: any) => x.id === wf.id).lifecycle,
    "archived",
  );
  assert.equal((await life("archive")).body.error, "project_archived");
  r = await life("reopen");
  assert.equal(r.body.project.state, "active");
  assert.equal(r.body.paused, true, "reopening never resumes by itself");
  assert.equal((await life("reopen")).body.error, "project_active");
  // a running task refuses archiving; once every task finished the project can be completed
  w.store.put("workflow", {
    ...w.store.get<Workflow>("workflow", wf.id),
    paused: false,
  });
  const task = wf.tasks[0];
  w.service.transitionTask(task.id, { status: "running" });
  r = await life("archive");
  assert.equal(r.body.error, "project_running");
  w.service.transitionTask(task.id, { status: "completed", result: "done" });
  r = await life("complete");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project.state, "completed");
  assert.equal(r.body.project.finished, true);
  r = await life("reopen");
  assert.equal(r.body.project.state, "active");
});

test("detach is offered after a project ends and never touches pre-existing folders or folders another active project of the team uses", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const teamId = await w.insert("product-feature-team");
  const p = w.profile(teamId);
  const [frontend, backend] = p.roles.implement;
  const lead = p.leadId;
  // the frontend engineer had the repository before any project (user's own attachment)
  const fe = w.agent(frontend);
  w.store.put("agent", {
    ...fe,
    workspaces: [{ path: repo, access: "write" as const, active: true }],
  });
  const a = await w.assign(teamId, {
    goal: "Project A on the repo",
    workspace: repo,
  });
  const setupA = w.store.get<any>("workflow", a.id).setup;
  assert.ok(
    !setupA.attachments.some((x: any) => x.agentId === frontend),
    "a folder attached before the project is not recorded as the project's",
  );
  assert.ok(setupA.attachments.some((x: any) => x.agentId === backend));
  // a second project on the same folder adds nothing new
  const c = await w.assign(teamId, {
    goal: "Project C on the same repo",
    workspace: repo,
  });
  assert.deepEqual(w.store.get<any>("workflow", c.id).setup.attachments, []);
  // active project: no offer, detaching is refused
  let view = (await w.call("GET", `/projects/${a.id}`)).body;
  assert.equal(view.detach.offer, false);
  let r = await w.call("POST", `/projects/${a.id}/detach`, {});
  assert.equal(r.body.error, "project_active");
  // A archived while C (same folder) is active: nothing is detachable, each with the reason
  await w.call("POST", `/projects/${a.id}/lifecycle`, { action: "archive" });
  view = (await w.call("GET", `/projects/${a.id}`)).body;
  assert.equal(view.detach.offer, false);
  assert.equal(view.detach.candidates.length, 0);
  assert.match(view.detach.kept[0].reason, /Used by active project/);
  r = await w.call("POST", `/projects/${a.id}/detach`, {
    items: [{ agentId: backend, path: repo }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "not_detachable");
  // C archived too: A's own attachments are offered; a busy agent stays attached
  await w.call("POST", `/projects/${c.id}/lifecycle`, { action: "archive" });
  w.store.put("session", {
    id: "s-busy",
    agentId: lead,
    state: "running",
    createdAt: new Date().toISOString(),
  });
  view = (await w.call("GET", `/projects/${a.id}`)).body;
  assert.equal(view.detach.offer, true);
  assert.ok(!view.detach.candidates.some((x: any) => x.agentId === frontend));
  assert.ok(view.detach.candidates.some((x: any) => x.agentId === backend));
  assert.match(
    view.detach.kept.find((x: any) => x.agentId === lead).reason,
    /is working/,
  );
  r = await w.call("POST", `/projects/${a.id}/detach`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!w.folders(backend).includes(repo));
  assert.ok(w.folders(frontend).includes(repo), "pre-existing folder kept");
  assert.ok(w.folders(lead).includes(repo), "busy agent kept");
  w.store.remove("session", "s-busy");
  // the lead, now idle, still keeps the folder: archived project C's unfinished lead task (no
  // declared paths, C's workspace is this folder) would run there once C is reopened, and C did
  // not record the folder as its own, so reopening C would not re-attach it
  view = (await w.call("GET", `/projects/${a.id}`)).body;
  assert.equal(view.detach.candidates.length, 0);
  assert.match(
    view.detach.kept.find((x: any) => x.agentId === lead).reason,
    /Needed by unfinished task/,
  );
  // C's lead task cancelled: the lead's attachment can go
  for (const task of w.store
    .list<Task>("task")
    .filter((x) => x.workflowId === c.id))
    w.service.transitionTask(task.id, { status: "cancelled" });
  view = (await w.call("GET", `/projects/${a.id}`)).body;
  assert.equal(view.detach.candidates.length, 1);
  // declining the offer hides it (the folders stay)
  r = await w.call("POST", `/projects/${a.id}/detach`, { dismiss: true });
  assert.equal(r.body.project.detach.offer, false);
  assert.ok(w.folders(lead).includes(repo));
  // reopening re-attaches what the project detached (with its recorded access)
  r = await w.call("POST", `/projects/${a.id}/lifecycle`, { action: "reopen" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const back = w.agent(backend).workspaces.find((x) => x.path === repo);
  assert.equal(back?.access, "write");
  // a project whose tasks all finished offers the detach without being archived
  const repo2 = await w.mkrepo("repo2");
  const d = await w.assign(teamId, {
    goal: "Project D on another repo",
    workspace: repo2,
    tasks: [{ title: "Docs", agentId: p.roles.docs[0] }],
  });
  w.service.transitionTask(d.tasks[0].id, { status: "cancelled" });
  view = (await w.call("GET", `/projects/${d.id}`)).body;
  assert.equal(view.finished, true);
  assert.equal(view.detach.offer, true);
  // an unfinished task elsewhere that declares a path inside the folder keeps it
  const other = w.service.workflow({
    name: "other",
    goal: "uses repo2",
    ownerId: lead,
    completionCriteria: "done",
    teamId: "main",
  });
  w.service.task({
    workflowId: other.id,
    agentId: p.roles.docs[0],
    title: "Edit the docs folder",
    instructions: "x",
    completionCriteria: "done",
    resourcePaths: [join(repo2, "a")],
  });
  view = (await w.call("GET", `/projects/${d.id}`)).body;
  assert.match(
    view.detach.kept.find((x: any) => x.agentId === p.roles.docs[0]).reason,
    /Needed by unfinished task/,
  );
});

test("free-form tasks take instructions, an assignee and dependencies validated by the backend", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const teamId = await w.insert("product-feature-team");
  const p = w.profile(teamId);
  const [fe, be] = p.roles.implement;
  const qa = p.roles.test[0];
  const bad = async (tasks: object[], sequential = false, code?: string) => {
    const r = await w.call("POST", `/team-spaces/${teamId}/projects`, {
      goal: "A project with task dependencies",
      workspace: repo,
      tasks,
      sequential,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    if (code) assert.equal(r.body.error, code);
    return r.body;
  };
  const n0 = w.store.list("workflow").length;
  await bad(
    [
      { title: "A", agentId: fe, dependsOn: [1] },
      { title: "B", agentId: be, dependsOn: [0] },
    ],
    false,
    "dependency_cycle",
  );
  await bad(
    [{ title: "A", agentId: fe, dependsOn: [0] }],
    false,
    "invalid_dependencies",
  );
  await bad(
    [{ title: "A", agentId: fe, dependsOn: [3] }],
    false,
    "invalid_dependencies",
  );
  await bad(
    [
      { title: "A", agentId: fe },
      { title: "B", agentId: be, dependsOn: [0, 0] },
    ],
    false,
    "invalid_dependencies",
  );
  await bad(
    [
      { title: "A", agentId: fe },
      { title: "B", agentId: be, dependsOn: [0] },
    ],
    true,
    "invalid_dependencies",
  );
  const outsider = w.store
    .list<Agent>("agent")
    .find(
      (a) =>
        a.kind !== "team-assistant" &&
        !Object.values(p.roles).flat().includes(a.id),
    );
  if (outsider)
    await bad([{ title: "A", agentId: outsider.id }], false, "not_in_team");
  assert.equal(w.store.list("workflow").length, n0, "refusals create nothing");
  // a diamond whose list order needs reordering: task 1 (tests) depends on later tasks 2 and 3
  const wf = await w.assign(teamId, {
    goal: "A project with task dependencies",
    workspace: repo,
    sequential: false,
    tasks: [
      { title: "Spec", agentId: be, instructions: "Write the API spec" },
      { title: "Tests", agentId: qa, dependsOn: [2, 3] },
      { title: "Backend", agentId: be, dependsOn: [0] },
      {
        title: "Frontend",
        agentId: fe,
        dependsOn: [0],
        instructions: "Build the UI",
      },
    ],
  });
  const by = (title: string) => wf.tasks.find((x) => x.title === title)!;
  assert.deepEqual(by("Spec").dependsOn, []);
  assert.deepEqual(by("Backend").dependsOn, [by("Spec").id]);
  assert.deepEqual(
    [...by("Tests").dependsOn].sort(),
    [by("Backend").id, by("Frontend").id].sort(),
  );
  assert.equal(by("Frontend").instructions, "Build the UI");
  assert.equal(by("Frontend").agentId, fe);
  assert.match(by("Tests").instructions, /Contribute to the project goal/);
  // the pure planner used by the route
  assert.deepEqual(
    planTaskOrder(
      [
        { title: "x", agentId: fe, instructions: "" },
        { title: "y", agentId: fe, instructions: "" },
      ],
      true,
    ).deps,
    [[], [0]],
  );
});

test("scoped verification: a second pipeline project on another folder keeps the first verified; an overlapping folder needs re-verify with the reason", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const repo2 = await w.mkrepo("repo2");
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  const a = await w.assign(teamId, {
    goal: "First pipeline project on repo",
    workspace: repo,
    isolation: "paths",
    paths: [join(repo, "a"), join(repo, "b")],
  });
  const pf = await w.service.pipelines.prepare(a.id, installed());
  assert.equal(pf.verified, true, pf.issues.join("\n"));
  // project B on another repository attaches repo2 to the same (shared) reviewers and workers
  const b = await w.assign(teamId, {
    goal: "Second pipeline project on repo2",
    workspace: repo2,
    isolation: "paths",
    paths: [join(repo2, "a"), join(repo2, "b")],
  });
  const rec = w.service.pipelines.record(a.id);
  assert.ok(w.folders(rec.agents.codexReview).includes(repo2));
  assert.equal(w.service.pipelines.verification(a.id).state, "verified");
  assert.equal(w.service.pauseWorkflow(a.id, false).paused, false);
  w.service.pauseWorkflow(a.id, true);
  // B verifies on its own and leaves A verified
  const pfb = await w.service.pipelines.prepare(b.id, installed());
  assert.equal(pfb.verified, true, pfb.issues.join("\n"));
  assert.equal(w.service.pipelines.verification(a.id).state, "verified");
  // B archived and detached: A is still verified
  await w.call("POST", `/projects/${b.id}/lifecycle`, { action: "archive" });
  const det = await w.call("POST", `/projects/${b.id}/detach`, {});
  assert.equal(det.status, 200, JSON.stringify(det.body));
  assert.ok(!w.folders(rec.agents.codexReview).includes(repo2));
  assert.equal(w.service.pipelines.verification(a.id).state, "verified");
  // a project whose workspace lies inside A's workspace is A's business: re-verify, with reasons
  await w.assign(teamId, {
    goal: "Third project inside repo (overlapping)",
    workspace: join(repo, "a"),
  });
  const v = w.service.pipelines.verification(a.id);
  assert.equal(v.state, "stale");
  assert.match(v.reasons.join("\n"), /Review: Codex.*folders changed/);
  const view = (await w.call("GET", `/projects/${a.id}`)).body;
  assert.equal(view.verification.state, "stale");
  assert.equal(
    (await w.call("POST", `/workflows/${a.id}/pause`, { paused: false })).body
      .error,
    "pipeline_unverified",
  );
});

test("two pipeline projects on one team: each worker gets its own worktree per project, tasks run in their own worktree, no cross-project lease conflict beyond real overlaps", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const repo2 = await w.mkrepo("repo2");
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  // both projects are assigned before either is prepared (the order that used to break: the
  // first preparation dropped the shared source checkout from the workers)
  const a = await w.assign(teamId, {
    goal: "Worktree project A on repo",
    workspace: repo,
    isolation: "worktree",
  });
  const b = await w.assign(teamId, {
    goal: "Worktree project B on repo2",
    workspace: repo2,
    isolation: "worktree",
  });
  const c = await w.assign(teamId, {
    goal: "Worktree project C on repo too",
    workspace: repo,
    isolation: "worktree",
  });
  for (const id of [a.id, b.id, c.id]) {
    const pf = await w.service.pipelines.prepare(id, installed());
    assert.equal(pf.verified, true, `${id}: ${pf.issues.join("\n")}`);
  }
  for (const id of [a.id, b.id, c.id])
    assert.equal(w.service.pipelines.verification(id).state, "verified", id);
  const ra = w.service.pipelines.record(a.id);
  const rb = w.service.pipelines.record(b.id);
  const rc = w.service.pipelines.record(c.id);
  const wt = (rec: typeof ra, i: number) =>
    w.store.get<Task>("task", rec.tasks.implement[i]).resourcePaths![0];
  // one distinct worktree per worker and project; the same worker agent holds all three
  const dirs = [ra, rb, rc].flatMap((r) => [wt(r, 0), wt(r, 1)]);
  assert.equal(new Set(dirs).size, 6);
  for (const d of dirs) assert.match(d, /AgentTeam-worktrees/);
  const worker1 = ra.agents.implement[0];
  assert.equal(rb.agents.implement[0], worker1);
  for (const r of [ra, rb, rc])
    assert.ok(w.folders(worker1).includes(wt(r, 0)));
  // the shared checkouts stay attached; each task runs in its own project's worktree
  assert.ok(
    w.folders(worker1).includes(repo) && w.folders(worker1).includes(repo2),
  );
  for (const r of [ra, rb, rc]) {
    const plan = await w.service.launchPlan(worker1, r.tasks.implement[0]);
    assert.equal(plan.cwd, wt(r, 0));
  }
  // read-only stages and the integration step declare their own project's workspace only
  assert.deepEqual(
    w.store.get<Task>("task", ra.tasks.codexReview).resourcePaths,
    [repo],
  );
  const int1 = w.service.parallel.plan(a.id)!.integrationTaskId!;
  assert.deepEqual(w.store.get<Task>("task", int1).resourcePaths, [repo]);
  // run A's and B's workers at the same time (worker 1 on A, worker 2 on B)
  for (const id of [a.id, b.id]) w.service.pauseWorkflow(id, false);
  const finish = (id: string, result = "done") => {
    w.service.transitionTask(id, { status: "running" });
    w.service.transitionTask(id, { status: "completed", result });
  };
  finish(ra.tasks.plan);
  finish(rb.tasks.plan);
  w.service.transitionTask(ra.tasks.implement[0], { status: "running" });
  w.service.transitionTask(rb.tasks.implement[1], { status: "running" });
  assert.equal(
    w.store.get<Task>("task", rb.tasks.implement[1]).status,
    "running",
  );
  // A's reviewer (repo) does not wait for B's worker (repo2 worktree) or A's worktree lease
  assert.deepEqual(
    w.service.resources.conflicts(
      ra.agents.codexReview,
      a.id,
      ra.tasks.codexReview,
    ),
    [],
  );
  // ...but B's reviewer and a writer in the real shared checkout of B do conflict
  // a writer holding B's shared checkout (outside any project)
  w.store.put("lease", {
    id: "probe-writer",
    agentId: rb.agents.integrator,
    workflowId: null,
    paths: [repo2],
    scope: "declared",
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
  });
  assert.ok(
    w.service.resources
      .conflicts(rb.agents.codexReview, b.id, rb.tasks.codexReview)
      .some((l) => l.id === "probe-writer"),
    "a real overlap (the same checkout) still conflicts",
  );
  assert.deepEqual(
    w.service.resources
      .conflicts(ra.agents.codexReview, a.id, ra.tasks.codexReview)
      .filter((l) => l.id === "probe-writer"),
    [],
    "repo2 is not A's business",
  );
  w.service.resources.release("probe-writer");
});

test("worktree workers: the shared checkout is attached read-only while they have their own worktree (prevented, not only detected); the integrator keeps write; removing the worktree or a path-isolated project restores write", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  const a = await w.assign(teamId, {
    goal: "Worktree project on repo",
    workspace: repo,
    isolation: "worktree",
  });
  const pf = await w.service.pipelines.prepare(a.id, installed());
  assert.equal(pf.verified, true, pf.issues.join("\n"));
  const ra = w.service.pipelines.record(a.id);
  const [worker1] = ra.agents.implement;
  const access = (id: string, path: string) =>
    w.agent(id).workspaces.find((x) => x.path === path)?.access;
  const tree = w.store.get<Task>("task", ra.tasks.implement[0])
    .resourcePaths![0];
  assert.equal(access(worker1, repo), "read", "shared checkout is read-only");
  assert.equal(access(worker1, tree), "write", "own worktree is writable");
  assert.equal(access(ra.agents.integrator, repo), "write");
  // AgentTeam-mediated writes as the worker in the shared checkout are refused now
  const assignBack = await w.service.parallel
    .assign(a.id, {
      assignments: [
        { taskId: ra.tasks.implement[0], paths: [join(repo, "a")] },
      ],
    })
    .then(
      () => null,
      (e: { code?: string }) => e.code,
    );
  assert.equal(assignBack, "read_only_assignment");
  // the task still runs in its worktree; the read-only folder is not its working folder
  assert.equal(
    (await w.service.launchPlan(worker1, ra.tasks.implement[0])).cwd,
    tree,
  );
  // a second worktree project on the same checkout still prepares (branches from a read-only
  // source) and keeps the checkout read-only
  const b = await w.assign(teamId, {
    goal: "Second worktree project on repo",
    workspace: repo,
    isolation: "worktree",
  });
  const pfb = await w.service.pipelines.prepare(b.id, installed());
  assert.equal(pfb.verified, true, pfb.issues.join("\n"));
  assert.equal(w.service.pipelines.verification(a.id).state, "verified");
  const rb = w.service.pipelines.record(b.id);
  const tree2 = w.store.get<Task>("task", rb.tasks.implement[0])
    .resourcePaths![0];
  assert.equal(access(worker1, repo), "read");
  // the worker itself can no longer manage worktrees of the shared checkout (write needed); an
  // agent with write access there (the integrator) removes them. One removed keeps the
  // protection (the other worktree still exists) ...
  await assert.rejects(
    w.service.pipelines.worktrees!.remove(worker1, {
      workspace: repo,
      path: tree,
      mode: "archive",
      acknowledgeUsers: true,
    }),
    { code: "read_only" },
  );
  const remove = (path: string) =>
    w.service.pipelines.worktrees!.remove(ra.agents.integrator, {
      workspace: repo,
      path,
      mode: "archive",
      acknowledgeUsers: true,
    });
  await remove(tree);
  assert.equal(access(worker1, repo), "read");
  // ... and removing the last one gives the worker its write access back
  await remove(tree2);
  assert.equal(access(worker1, repo), "write");
  // a path-isolated project needs the checkout writable: its preparation restores it at once
  const c = await w.assign(teamId, {
    goal: "Worktree project again",
    workspace: repo,
    isolation: "worktree",
  });
  assert.equal(
    (await w.service.pipelines.prepare(c.id, installed())).verified,
    true,
  );
  assert.equal(access(worker1, repo), "read");
  const d = await w.assign(teamId, {
    goal: "Path-isolated project on repo",
    workspace: repo,
    isolation: "paths",
    paths: [join(repo, "a"), join(repo, "b")],
  });
  const pfd = await w.service.pipelines.prepare(d.id, installed());
  assert.equal(pfd.verified, true, pfd.issues.join("\n"));
  assert.equal(access(worker1, repo), "write");
});

test("launchPlan never runs a task outside its declared folders: a detached declared folder refuses the launch instead of falling back to another project's active folder", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const repo2 = await w.mkrepo("repo2");
  const id = (
    (await w.service.saveAgent({
      name: "Worker",
      environment: "codex",
    })) as Agent
  ).id;
  w.store.put("agent", {
    ...w.agent(id),
    workspaces: [
      { path: repo2, access: "write" as const, active: true },
      { path: repo, access: "write" as const, active: false },
    ],
  });
  const wf = w.service.workflow({
    name: "p",
    goal: "g",
    ownerId: id,
    completionCriteria: "done",
  });
  const task = w.service.task({
    workflowId: wf.id,
    agentId: id,
    title: "Work in repo/a",
    instructions: "x",
    completionCriteria: "done",
    resourcePaths: [join(repo, "a")],
  });
  assert.equal((await w.service.launchPlan(id, task.id)).cwd, repo);
  // paths over two folders: the active folder holds one of them
  const spread = w.service.task({
    workflowId: wf.id,
    agentId: id,
    title: "Both",
    instructions: "x",
    completionCriteria: "done",
    resourcePaths: [join(repo, "a"), join(repo2, "b")],
  });
  assert.equal((await w.service.launchPlan(id, spread.id)).cwd, repo2);
  // repo detached after the task was created: refused, never run in repo2 (unleased)
  w.store.put("agent", {
    ...w.agent(id),
    workspaces: [{ path: repo2, access: "write" as const, active: true }],
  });
  await assert.rejects(w.service.launchPlan(id, task.id), {
    code: "resource_path_detached",
  });
  await assert.rejects(w.service.launchPlan(id, spread.id), {
    code: "resource_path_detached",
  });
  // without a task, or for a task that declares nothing, the active folder is used
  assert.equal((await w.service.launchPlan(id)).cwd, repo2);
});

test("retired agents take no new work: no task, no delegation, no start or retry, no chat run; reinstating lifts it", async (t) => {
  const w = await world(t);
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  const p = w.profile(teamId);
  const retiredId = p.roles.implement[1];
  const lead = p.leadId!;
  const wf = w.service.workflow({
    name: "p",
    goal: "g",
    ownerId: lead,
    completionCriteria: "done",
  });
  const before = w.service.task({
    workflowId: wf.id,
    agentId: retiredId,
    title: "Old work",
    instructions: "x",
    completionCriteria: "done",
  });
  w.service.transitionTask(before.id, { status: "running" });
  w.service.transitionTask(before.id, { status: "completed", result: "ok" });
  // retire it through Team settings (finished history refers to it)
  const r = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 1 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.retired, [retiredId]);
  const refused = (fn: () => unknown) =>
    assert.throws(fn as () => void, { code: "agent_retired" });
  refused(() =>
    w.service.task({
      workflowId: wf.id,
      agentId: retiredId,
      title: "New work",
      instructions: "x",
      completionCriteria: "done",
    }),
  );
  // delegation (invoke_teammate goes through the same TeamService.task)
  const http = await w.call("POST", "/tasks", {
    workflowId: wf.id,
    agentId: retiredId,
    title: "Delegated",
    instructions: "x",
    completionCriteria: "done",
  });
  assert.equal(http.status, 409);
  assert.equal(http.body.error, "agent_retired");
  // a finished task of it cannot be retried or started
  refused(() => w.service.transitionTask(before.id, { status: "queued" }));
  refused(() => w.service.transitionTask(before.id, { status: "running" }));
  // chat runs are refused before anything starts
  w.store.put("session", {
    id: "s-retired",
    agentId: retiredId,
    state: "idle",
    createdAt: new Date().toISOString(),
  });
  const runs = new RunManager(w.service, true, process.cwd());
  await assert.rejects(runs.start("s-retired", true), {
    code: "agent_retired",
  });
  // growing the role again reinstates it
  const g = await w.call("PUT", `/team-spaces/${teamId}/settings/workers`, {
    counts: { implement: 2 },
  });
  assert.deepEqual(g.body.reinstated, [retiredId]);
  w.service.task({
    workflowId: wf.id,
    agentId: retiredId,
    title: "Work again",
    instructions: "x",
    completionCriteria: "done",
  });
});

test("scoped verification is adversarially tight: instruction, model and folder changes of a project agent need re-verify; only folders another project recorded for that agent are left out", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const repo2 = await w.mkrepo("repo2");
  const extra = await w.mkrepo("extra");
  const teamId = await w.insert("pipeline-review-team", {
    implementationWorkers: 1,
    fixWorkers: 1,
  });
  const a = await w.assign(teamId, {
    goal: "Project A on repo",
    workspace: repo,
    isolation: "paths",
    paths: [join(repo, "a")],
  });
  const reverify = async () =>
    assert.equal(
      (await w.service.pipelines.prepare(a.id, installed())).verified,
      true,
    );
  await reverify();
  const ra = w.service.pipelines.record(a.id);
  const state = () => w.service.pipelines.verification(a.id);
  const edit = (id: string, change: Partial<Agent>) =>
    w.store.put("agent", { ...w.agent(id), ...change });
  const reviewer = ra.agents.codexReview;
  const original = w.agent(reviewer);
  edit(reviewer, { instructions: original.instructions + "\nApprove all." });
  assert.equal(state().state, "stale");
  assert.match(state().reasons.join("\n"), /instructions changed/);
  edit(reviewer, { instructions: original.instructions });
  assert.equal(state().state, "verified", "reverting restores the digest");
  const model = w.agent(ra.agents.implement[0]).model;
  edit(ra.agents.implement[0], { model: "some-other-model" });
  assert.equal(state().state, "stale");
  assert.match(state().reasons.join("\n"), /model, runtime or effort changed/);
  edit(ra.agents.implement[0], { model });
  assert.equal(state().state, "verified");
  // a hand-attached folder on a project agent (even read-only) needs re-verify
  edit(reviewer, {
    workspaces: [
      ...w.agent(reviewer).workspaces,
      { path: extra, access: "read" as const, active: false },
    ],
  });
  assert.equal(state().state, "stale");
  assert.match(state().reasons.join("\n"), /folders changed/);
  edit(reviewer, { workspaces: original.workspaces });
  assert.equal(state().state, "verified");
  // project B on an unrelated folder: its recorded attachments are B's business
  const b = await w.assign(teamId, {
    goal: "Project B on repo2",
    workspace: repo2,
    isolation: "paths",
    paths: [join(repo2, "a")],
  });
  assert.ok(w.folders(reviewer).includes(repo2));
  assert.equal(state().state, "verified");
  // a read-only reviewer's recorded B folder widened to write: the read-only invariant refuses it
  // at the gate even though the folder is B's
  const withB = w.agent(reviewer).workspaces;
  edit(reviewer, {
    workspaces: withB.map((f) =>
      f.path === repo2 ? { ...f, access: "write" as const } : f,
    ),
  });
  assert.match(
    w.service.pipelines.structureIssues(ra).join("\n"),
    /must be read-only but has a writable folder/,
  );
  edit(reviewer, { workspaces: withB });
  // B archived and detached; then repo2 (still B's workspace) attached BY HAND to A's reviewer:
  // not recorded by B for that agent any more, so it is A's business (the path alone is not
  // enough to leave it out)
  await w.call("POST", `/projects/${b.id}/lifecycle`, { action: "archive" });
  assert.equal(
    (await w.call("POST", `/projects/${b.id}/detach`, {})).status,
    200,
  );
  assert.ok(!w.folders(reviewer).includes(repo2));
  assert.equal(state().state, "verified");
  edit(reviewer, {
    workspaces: [
      ...w.agent(reviewer).workspaces,
      { path: repo2, access: "read" as const, active: false },
    ],
  });
  assert.equal(state().state, "stale");
  assert.match(state().reasons.join("\n"), /folders changed/);
});

test("detach keeps folders an active project of ANOTHER team needs from the same agent", async (t) => {
  const w = await world(t);
  const repo = await w.mkrepo("repo");
  const teamId = await w.insert("product-feature-team");
  const p = w.profile(teamId);
  const be = p.roles.implement[1];
  const a = await w.assign(teamId, {
    goal: "Project A on repo",
    workspace: repo,
  });
  assert.ok(
    w.store
      .get<any>("workflow", a.id)
      .setup.attachments.some((x: any) => x.agentId === be),
  );
  // a project of another team (Main) uses the same agent with a task declaring nothing
  const other = w.service.workflow({
    name: "Main project",
    goal: "uses the backend engineer",
    ownerId: be,
    completionCriteria: "done",
    teamId: "main",
  });
  w.store.put("workflow", {
    ...w.store.get<any>("workflow", other.id),
    setup: { workspace: repo },
  });
  w.service.task({
    workflowId: other.id,
    agentId: be,
    title: "Backend work for Main",
    instructions: "x",
    completionCriteria: "done",
  });
  await w.call("POST", `/projects/${a.id}/lifecycle`, { action: "archive" });
  const view = (await w.call("GET", `/projects/${a.id}`)).body;
  const kept = view.detach.kept.find((x: any) => x.agentId === be);
  assert.ok(kept, JSON.stringify(view.detach));
  assert.match(kept.reason, /Used by active project|Needed by unfinished task/);
  const r = await w.call("POST", `/projects/${a.id}/detach`, {
    items: [{ agentId: be, path: repo }],
  });
  assert.equal(r.body.error, "not_detachable");
  assert.ok(w.folders(be).includes(repo));
});
