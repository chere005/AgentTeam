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
import { TeamTemplates } from "../src/teams.ts";
import { pipelineTeamTemplate, type PipelineRecord } from "../src/pipeline.ts";
import { wolframTeamTemplate } from "../src/samples.ts";
import { productFeatureTemplate } from "../src/example-teams.ts";
import {
  attachProjectWorkspaceInTx,
  type TeamProfile,
} from "../src/team-profiles.ts";
import type { Agent, Edge, Rule, Task, Workflow } from "../src/model.ts";

// Team vs project: example teams are inserted as teams only; projects are assigned to a team's
// existing agents afterwards, any number of times, always paused behind the existing gates.
// No provider, kernel or runtime scan is involved (runtimes are never discovered here).

async function api(t: any) {
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
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-proj-")));
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
  await mkdir(join(repo, "b"), { recursive: true });
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
    return r.body;
  };
  return { store, service, call, repo, base, insert };
}

const roots = (agents: Agent[]) =>
  agents.filter((a) => !a.parentId || !agents.some((b) => b.id === a.parentId));

test("a project cannot attach a new workspace to an agent with a running task", async (t) => {
  const w = await api(t);
  const agent = await w.service.saveAgent({
    name: "Builder",
    environment: "codex",
  });
  const workflow = w.service.workflow({
    name: "Build",
    goal: "Ship",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Build",
    completionCriteria: "Done",
  });
  w.service.transitionTask(task.id, { status: "running" });

  assert.throws(
    () =>
      w.store.transaction(() =>
        attachProjectWorkspaceInTx(w.store, { [agent.id]: "write" }, w.repo),
      ),
    { code: "agent_busy" },
  );
  assert.deepEqual(w.store.get<Agent>("agent", agent.id).workspaces, []);
});

test("example teams are listed with their shape and insert as teams only: no goal, workflow or task", async (t) => {
  const w = await api(t);
  const list = (await w.call("GET", "/teams/examples")).body;
  assert.deepEqual(
    list.map((e: any) => e.id),
    [
      "quickstart-code-team",
      "pipeline-review-team",
      "wolfram-validated-team",
      "product-feature-team",
    ],
  );
  for (const e of list) {
    assert.ok(e.shape.length > 20 && e.description.length > 20, e.id);
    assert.ok(e.template.agents.length >= 3);
    // Every example is one org tree: a single lead on top.
    assert.equal(
      e.template.agents.filter((a: any) => !a.parentKey).length,
      1,
      e.id,
    );
  }
  // Runtimes were never discovered: insert is refused unless unverified models are accepted.
  const refused = await w.call(
    "POST",
    "/teams/examples/product-feature-team/insert",
    { options: {} },
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "models_unverified");
  assert.equal(w.store.list("agent").length, 0);
  // Preview reports the model check and structural issues (none) without writing.
  const preview = (
    await w.call("POST", "/teams/examples/pipeline-review-team/preview", {
      options: { implementationWorkers: 2, fixWorkers: 1 },
    })
  ).body;
  assert.equal(preview.preview.ok, true, JSON.stringify(preview.preview));
  assert.equal(preview.modelCheck.verified, false);
  assert.match(
    preview.modelCheck.issues.join("\n"),
    /not been discovered|not installed or detected/,
  );
  // planner, integrator, 2 implementation, 1 fix, 4 reviewers, adjudicator, reporter
  assert.equal(preview.template.agents.length, 1 + 1 + 2 + 1 + 4 + 1 + 1);
  // Bad options are refused.
  for (const options of [
    { implementationWorkers: 6 },
    { fixWorkers: 0 },
    { nope: 1 },
  ])
    assert.equal(
      (
        await w.call("POST", "/teams/examples/pipeline-review-team/insert", {
          options,
          acceptUnverifiedModels: true,
        })
      ).status,
      400,
    );

  for (const [id, options, agents] of [
    ["quickstart-code-team", {}, 5],
    ["pipeline-review-team", { implementationWorkers: 2, fixWorkers: 1 }, 11],
    ["wolfram-validated-team", { wolframAgents: 1 }, 2],
    ["product-feature-team", {}, 7],
  ] as const) {
    const r = await w.insert(id, options);
    assert.equal(w.service.teamSpaces.active(), r.teamId);
    const members = w.service.teamSpaces.members(r.teamId);
    assert.equal(members.agents.length, agents, id);
    assert.equal(members.workflows.length, 0, id);
    assert.equal(r.profile.source.example, id);
    assert.equal(r.profile.modelCheck.verified, false);
    assert.equal(roots(members.agents).length, 1, id);
    assert.equal(roots(members.agents)[0].id, r.profile.leadId);
    // Delegation edges follow the tree: every parent can reach its children.
    for (const a of members.agents.filter((x) => x.parentId))
      assert.ok(
        w.store
          .list<Edge>("edge")
          .some((e) => e.from === a.parentId && e.to === a.id),
        `${id}: edge to ${a.name}`,
      );
    if (id === "quickstart-code-team") {
      const byName = (name: string) =>
        members.agents.find((a) => a.name === name)!;
      const manager = byName("Manager (Claude Opus)");
      assert.equal(manager.maxConcurrentInvocations, 3);
      for (const name of [
        "C++ Builder (Claude Sonnet)",
        "Python Builder (Claude Sonnet)",
        "TypeScript Developer (Claude Sonnet)",
        "Code Reviewer (Codex)",
      ])
        assert.ok(
          w.service.permitted(manager.id, byName(name).id, "delegate"),
          `manager can delegate to ${name}`,
        );
      for (const a of members.agents)
        for (const skill of a.skills)
          assert.ok(
            w.service.skills.items.has(skill.id),
            `${a.name}: bundled skill ${skill.id} exists`,
          );
      assert.deepEqual(r.profile.expectations, {});
      assert.equal(r.profile.intendedLead, undefined);
      assert.match(manager.instructions, /queued\/running is not a result/);
      assert.match(
        manager.instructions,
        /regenerate them after the last source edit/,
      );
      assert.match(manager.instructions, /inconclusive, never approve/);
      const reference = manager.instructions.match(
        /independent reference: ([0-9]+\.[0-9]+)/,
      )?.[1];
      assert.ok(reference, "the Pi review prompt carries its expected output");
      assert.equal(reference!.replace(".", "").length, 300);
    }
  }
  assert.equal(w.store.list<Workflow>("workflow").length, 0);
  assert.equal(w.store.list<Task>("task").length, 0);

  // Product team: mandatory code review on source changes, advisory security trigger, read-only reviewers.
  const product = w.service.teamSpaces.members(w.service.teamSpaces.active());
  const byName = (n: string) => product.agents.find((a) => a.name === n)!;
  const rules = w.store.list<Rule>("rule");
  const mandatory = rules.filter((r) => r.mode === "mandatory");
  assert.equal(mandatory.length, 1);
  assert.equal(mandatory[0].agentId, byName("Code Reviewer").id);
  assert.ok(mandatory[0].match.changedFilesAny.includes("*.ts"));
  const security = rules.find((r) => r.specialty === "security")!;
  assert.equal(security.mode, "advisory");
  assert.equal(security.agentId, byName("Security Reviewer").id);
  assert.ok(security.match.changedFilesAny.includes("**/auth/**"));
  for (const n of ["Code Reviewer", "Security Reviewer"]) {
    assert.equal(byName(n).roleType, "reviewer");
    assert.deepEqual(byName(n).tools, ["read", "grep", "glob"]);
  }
  assert.equal(byName("Engineering Manager").roleType, "coordinator");
  assert.equal(
    byName("Frontend Engineer").parentId,
    byName("Engineering Manager").id,
  );
  // A source change by the Backend Engineer plans the required review and the security consult.
  const routed = await w.call("POST", "/orchestration/preview", {
    fromAgentId: byName("Backend Engineer").id,
    text: "Rotate the session secret",
    changedFiles: ["server/auth/session.ts"],
  });
  assert.equal(routed.status, 200, JSON.stringify(routed.body));
  const plans = routed.body.plan ?? routed.body.triggers ?? routed.body;
  const text = JSON.stringify(plans);
  assert.match(text, /"mode":"mandatory"/);
  assert.match(text, /"specialty":"security"/);
  assert.ok(!/"status":"denied"/.test(text), text);
});

test("quickstart Pi review fails closed without fresh execution evidence", async (t) => {
  const w = await api(t);
  const examples = (await w.call("GET", "/teams/examples")).body;
  const quickstart = examples.find(
    (example: any) => example.id === "quickstart-code-team",
  );
  assert.ok(quickstart, "quickstart example is available");
  const manager = quickstart.template.agents.find(
    (agent: any) => agent.key === "manager",
  );
  const reviewer = quickstart.template.agents.find(
    (agent: any) => agent.key === "codex-reviewer",
  );
  assert.ok(manager && reviewer, "manager and reviewer are configured");

  assert.match(
    manager.instructions,
    /read-only.*commands such as cat, sed, grep, cmp, wc, and sha256sum\/shasum inside that scope/i,
  );
  assert.match(
    manager.instructions,
    /do not ask the reviewer to build or run programs, install dependencies, or modify files/i,
  );
  assert.match(manager.instructions, /dedicated safe verification setup/);
  assert.match(manager.instructions, /stale \.out files do not count/);
  assert.match(
    reviewer.instructions,
    /read-only commands such as cat, sed, grep, cmp, wc, and sha256sum\/shasum within your resourcePaths/i,
  );
  assert.match(
    reviewer.instructions,
    /Do not build or run programs, install dependencies, or modify files/i,
  );
  assert.match(
    reviewer.instructions,
    /fresh execution evidence is provided for all three current source files/,
  );
  assert.match(
    reviewer.instructions,
    /exact byte-for-byte comparison against this independent reference:/,
  );
  assert.match(
    reviewer.instructions,
    /report Pi output verification as inconclusive/,
  );
  assert.match(
    reviewer.instructions,
    /request a dedicated safe verification setup/,
  );
  const reference = reviewer.instructions.match(
    /independent reference: ([0-9]+\.[0-9]+)\./,
  )?.[1];
  assert.ok(reference, "reviewer has the independent Pi reference");
  assert.equal(
    reference,
    manager.instructions.match(
      /independent reference: ([0-9]+\.[0-9]+)\./,
    )?.[1],
  );
  assert.equal(reference!.replace(".", "").length, 300);
});

test("assign project: a pipeline team gets paused staged projects on its existing agents, repeatedly", async (t) => {
  const w = await api(t);
  const team = await w.insert("pipeline-review-team", {
    implementationWorkers: 2,
    fixWorkers: 2,
    codexEffort: "high",
  });
  const agentsBefore = w.store.list<Agent>("agent").length;
  const info = (await w.call("GET", `/team-spaces/${team.teamId}/projects`))
    .body;
  assert.equal(info.projectType, "pipeline");
  assert.equal(info.defaults.implementationWorkers, 2);
  assert.deepEqual(info.projects, []);
  // Goal and workspace are required.
  for (const bad of [
    { workspace: w.repo },
    { goal: "Add a greeting feature" },
    { goal: "Add a greeting feature", workspace: join(w.repo, ".git") },
    {
      goal: "Add a greeting feature",
      workspace: w.repo,
      implementationWorkers: 3,
    },
  ])
    assert.equal(
      (await w.call("POST", `/team-spaces/${team.teamId}/projects`, bad))
        .status,
      400,
      JSON.stringify(bad),
    );
  const body = {
    goal: "Add a greeting feature to the sample project",
    workspace: w.repo,
    isolation: "paths",
    paths: [join(w.repo, "a"), join(w.repo, "b")],
  };
  const first = await w.call(
    "POST",
    `/team-spaces/${team.teamId}/projects`,
    body,
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.status, "paused");
  assert.equal(first.body.teamId, team.teamId);
  // No agent was created: the project runs on the team's agents.
  assert.equal(w.store.list<Agent>("agent").length, agentsBefore);
  const profile = w.store.get<TeamProfile>("team-profile", team.teamId);
  const rec = w.store.get<PipelineRecord>("pipeline", first.body.id);
  assert.equal(rec.agents.planner, profile.leadId);
  assert.deepEqual(rec.agents.implement, profile.roles.implement);
  assert.equal(rec.agents.adjudicator, profile.roles.adjudicator[0]);
  assert.deepEqual(w.service.pipelines.structureIssues(rec), []);
  // The workspace was attached: writers write, everyone else reads.
  const agent = (id: string) => w.store.get<Agent>("agent", id);
  assert.equal(
    agent(rec.agents.implement[0]).workspaces.find((x) => x.path === w.repo)
      ?.access,
    "write",
  );
  for (const id of [
    rec.agents.codexReview,
    rec.agents.adjudicator,
    rec.agents.planner,
  ])
    assert.equal(
      agent(id).workspaces.find((x) => x.path === w.repo)?.access,
      "read",
    );
  // Gates: models must verify, and the pipeline must be prepared, before resume.
  const resume = await w.call("POST", `/workflows/${first.body.id}/pause`, {
    paused: false,
  });
  assert.equal(resume.status, 409);
  // A second project on the same team, using fewer workers.
  const second = await w.call("POST", `/team-spaces/${team.teamId}/projects`, {
    ...body,
    goal: "Add a farewell feature to the sample project",
    implementationWorkers: 1,
    fixWorkers: 1,
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const rec2 = w.store.get<PipelineRecord>("pipeline", second.body.id);
  assert.equal(rec2.tasks.implement.length, 1);
  assert.equal(rec2.agents.planner, rec.agents.planner);
  assert.equal(w.store.list<Agent>("agent").length, agentsBefore);
  const after = (await w.call("GET", `/team-spaces/${team.teamId}/projects`))
    .body;
  assert.equal(after.projects.length, 2);
  assert.ok(after.projects.every((p: any) => p.paused));
  // Prepare verifies per project (fails here: runtimes are not discovered).
  const prep = await w.call("POST", `/pipelines/${second.body.id}/prepare`);
  assert.equal(prep.status, 200);
  assert.equal(prep.body.preflight.verified, false);
});

test("assign project: Wolfram-validated team and the legacy sample route still create gated work", async (t) => {
  const w = await api(t);
  const team = await w.insert("wolfram-validated-team", { wolframAgents: 2 });
  const r = await w.call("POST", `/team-spaces/${team.teamId}/projects`, {
    goal: "Check the closed form of a damped oscillator against its ODE",
    workspace: w.repo,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "paused");
  const tasks = w.store
    .list<Task>("task")
    .filter((x) => x.workflowId === r.body.id);
  assert.equal(tasks.length, 6);
  assert.ok(tasks.filter((x) => x.requiresValidation).length >= 3);
  const resume = await w.call("POST", `/workflows/${r.body.id}/pause`, {
    paused: false,
  });
  assert.equal(resume.body.error, "models_unverified");
  const validators = w.store
    .list<TeamProfile>("team-profile")
    .find((p) => p.id === team.teamId)!.roles.validators;
  assert.equal(
    w.store
      .get<Agent>("agent", validators[0])
      .workspaces.find((x) => x.path === w.repo)?.access,
    "write",
  );
  // Wrong project shape for this team (pipeline fields) is refused by the strict schema.
  assert.equal(
    (
      await w.call("POST", `/team-spaces/${team.teamId}/projects`, {
        goal: "Another validated problem statement",
        workspace: w.repo,
        isolation: "paths",
      })
    ).status,
    400,
  );
  // Legacy one-shot route: team + first project in one step, still paused.
  const legacy = await w.call("POST", "/samples/wolfram-validated-reasoning", {
    wolframAgents: 1,
  });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.status, "paused");
  assert.ok(
    w.store
      .list<TeamProfile>("team-profile")
      .some((p) => p.id === legacy.body.teamId),
  );
});

test("free-form projects: product team (profile access, task list) and a plain team (default lead and access)", async (t) => {
  const w = await api(t);
  const team = await w.insert("product-feature-team");
  const members = w.service.teamSpaces.members(team.teamId).agents;
  const id = (n: string) => members.find((a) => a.name === n)!.id;
  assert.match(
    w.store.get<Agent>("agent", id("Engineering Manager")).instructions,
    /resourcePaths are directory scopes, never target filenames.*missing path is created before launch.*owner has write access/i,
  );
  assert.match(
    w.store.get<Agent>("agent", id("Engineering Manager")).instructions,
    /poll teammate_result for that exact child.*review_pending, poll the included reviewTaskId.*check the original child again.*resource-busy.*do not start a same-workspace verifier.*do not create duplicate manual reviews/i,
  );
  const r = await w.call("POST", `/team-spaces/${team.teamId}/projects`, {
    goal: "Add a dark mode toggle to the settings page",
    workspace: w.repo,
    tasks: [
      { title: "Backend preference", agentId: id("Backend Engineer") },
      { title: "Toggle UI", agentId: id("Frontend Engineer") },
      { title: "Tests", agentId: id("QA/Test Engineer") },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "paused");
  assert.equal(r.body.ownerId, id("Engineering Manager"));
  const tasks = w.store
    .list<Task>("task")
    .filter((x) => x.workflowId === r.body.id);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[1].dependsOn, [tasks[0].id]);
  assert.equal(tasks[0].invokedBy, id("Engineering Manager"));
  const access = (n: string) =>
    w.store.get<Agent>("agent", id(n)).workspaces.find((x) => x.path === w.repo)
      ?.access;
  assert.equal(access("Code Reviewer"), "read");
  assert.equal(access("Security Reviewer"), "read");
  assert.equal(access("Backend Engineer"), "write");
  // The coordinator holds no project lease while its delegated writers work.
  assert.equal(access("Engineering Manager"), undefined);
  assert.ok(
    !r.body.setup.attachments.some(
      (attachment: { agentId: string }) =>
        attachment.agentId === id("Engineering Manager"),
    ),
  );
  const resume = await w.call("POST", `/workflows/${r.body.id}/pause`, {
    paused: false,
  });
  assert.equal(resume.body.error, "models_unverified");
  // A task for an agent of another team is refused; nothing is created.
  const before = w.store.list("workflow").length;
  const foreign = await w.call("POST", "/agents", {
    name: "Outsider",
    environment: "codex",
    teamId: "main",
  });
  assert.equal(
    (
      await w.call("POST", `/team-spaces/${team.teamId}/projects`, {
        goal: "Add a dark mode toggle to the settings page",
        workspace: w.repo,
        tasks: [{ title: "x", agentId: foreign.body.id }],
      })
    ).status,
    400,
  );
  assert.equal(w.store.list("workflow").length, before);

  // Plain team without a profile: the root agent leads, reviewers read, implementers write.
  const plain = (await w.call("POST", "/team-spaces", { name: "Plain" })).body;
  assert.equal(
    (
      await w.call("POST", `/team-spaces/${plain.id}/projects`, {
        goal: "Something worth doing well",
        workspace: w.repo,
      })
    ).body.error,
    "team_empty",
  );
  const lead = (
    await w.call("POST", "/agents", {
      name: "Lead",
      environment: "claude",
      teamId: plain.id,
    })
  ).body;
  const reviewer = (
    await w.call("POST", "/agents", {
      name: "Rev",
      environment: "claude",
      roleType: "reviewer",
      parentId: lead.id,
      teamId: plain.id,
    })
  ).body;
  const p = await w.call("POST", `/team-spaces/${plain.id}/projects`, {
    goal: "Something worth doing well",
    workspace: w.repo,
  });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.ownerId, lead.id);
  assert.equal(p.body.tasks.length, 1);
  assert.equal(
    w.store
      .get<Agent>("agent", reviewer.id)
      .workspaces.find((x) => x.path === w.repo)?.access,
    "read",
  );
  const info = (await w.call("GET", `/team-spaces/${plain.id}/projects`)).body;
  assert.equal(info.projectType, "free-form");
  assert.equal(info.projects.length, 1);
});

test("team templates v3: roleType and the project profile round-trip; a partial selection drops the profile", async () => {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const teams = new TeamTemplates(service);
  const inserted = teams.insertTemplate(
    pipelineTeamTemplate({ implementationWorkers: 1, fixWorkers: 1 }),
  );
  const ids = inserted.agents.map((a) => a.id);
  const whole = teams.create({ name: "Copy", agentIds: ids });
  assert.equal(whole.project?.type, "pipeline");
  assert.equal(
    whole.agents.find((a) => a.name.startsWith("Adjudicator"))?.roleType,
    "adjudicator",
  );
  const exported = teams.export(whole.id);
  assert.equal(exported.schemaVersion, 4);
  const again = await teams.insert({ envelope: exported });
  assert.equal(again.profile?.type, "pipeline");
  assert.equal(again.profile?.roles.implement.length, 1);
  const partial = teams.create({ name: "Part", agentIds: ids.slice(0, 3) });
  assert.equal(partial.project, undefined);
  // The generated and bundled example templates validate.
  for (const t of [
    wolframTeamTemplate({ wolframAgents: 2 }),
    pipelineTeamTemplate({ implementationWorkers: 5, fixWorkers: 5 }),
    productFeatureTemplate(),
  ])
    assert.ok(t.project && t.agents.length >= 3, t.name);
  // Deleting the team removes its profile.
  service.teamSpaces.delete(again.teamId, {});
  assert.equal(
    store.list<TeamProfile>("team-profile").some((p) => p.id === again.teamId),
    false,
  );
  store.close();
});
