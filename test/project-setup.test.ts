import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { world } from "./fixtures/execution-world.ts";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import { assignProject } from "../src/projects.ts";
import { resumeProject } from "../src/readiness.ts";
import { defaults } from "../src/discovery.ts";
import type { Agent, Task } from "../src/model.ts";
import type { ProjectSetupRecord } from "../src/project-setup.ts";

const REQUEST =
  "Have the developers make a Python program that computes pi to 500 digits and run it.";

/** The incident's conversation: a pipeline team, a coding chat, the planner delegated nothing yet. */
async function incident(t: Parameters<typeof world>[0]) {
  const w = await world(t);
  const team = w.insertPipeline();
  w.setProvider(async (command, _e, emit) => {
    if (command.teammateTools)
      w.runs.toolSessions.authenticate(command.teammateTools.token);
    emit({ type: "text", data: "Setup needed." });
  });
  await w.chat(team.planner.id, REQUEST);
  const workflowId = w.tasks()[0].workflowId;
  return { w, team, workflowId };
}
const agentOf = (w: Awaited<ReturnType<typeof world>>, id: string) =>
  w.store.get<Agent>("agent", id);

test("the setup card proposes the folder, the participants and the least access each role needs", async (t) => {
  const { w, team, workflowId } = await incident(t);
  const view = w.service.setups.view(workflowId);
  assert.equal(view.state, "needed");
  assert.equal(view.kind, "conversation");
  assert.equal(view.contract?.workKind, "executable-implementation");
  assert.equal(
    view.proposal.folder,
    null,
    "nothing to propose: the user chooses",
  );
  const access = Object.fromEntries(
    view.proposal.participants.map((p) => [
      p.name,
      `${p.roleClass}:${p.access}`,
    ]),
  );
  // Writers write; the adjudicator and the reviewers read the artifacts; the planner and the
  // reporter need nothing from the folder.
  assert.equal(access[team.integrator.name], "implementer:write");
  for (const worker of [...team.workers, ...team.fixers])
    assert.equal(access[worker.name], "implementer:write");
  assert.equal(access[team.adjudicator.name], "adjudicator:read");
  for (const reviewer of team.reviewers)
    assert.equal(access[reviewer.name], "reviewer:read");
  assert.equal(access[team.planner.name], undefined);
  assert.equal(access[team.reporter.name], "reporter:read");
  // One repair per blocked worker.
  assert.ok(view.blockers.length >= 4);
  for (const blocker of view.blockers)
    assert.equal(blocker.issues[0].fix?.kind, "choose-project-folder");
});

test("applying the approved setup attaches exactly those roles and makes the saved assignment ready; repeating changes nothing", async (t) => {
  const { w, team, workflowId } = await incident(t);
  const folder = await w.folder("pi");
  const first = await w.service.setups.apply(workflowId, { folder });
  assert.equal(first.state, "ready");
  assert.deepEqual(first.blockers, []);
  for (const worker of [team.integrator, ...team.workers, ...team.fixers])
    assert.deepEqual(
      agentOf(w, worker.id).workspaces.map((x) => [x.path, x.access, x.active]),
      [[folder, "write", true]],
      worker.name,
    );
  for (const reader of [team.adjudicator, team.reporter, ...team.reviewers])
    assert.deepEqual(
      agentOf(w, reader.id).workspaces.map((x) => [x.path, x.access]),
      [[folder, "read"]],
      reader.name,
    );
  for (const none of [team.planner])
    assert.deepEqual(agentOf(w, none.id).workspaces, [], none.name);
  // The contract now authorizes this folder, and the setup record is ready.
  assert.equal(w.service.contracts.project(workflowId)!.projectFolder, folder);
  assert.equal(
    w.store.get<ProjectSetupRecord>("project-setup", workflowId).state,
    "ready",
  );
  assert.equal(w.events("project.setup_ready").length, 1);
  // Repeating the same action changes nothing and creates no duplicates.
  const agentsBefore = JSON.stringify(w.store.list("agent"));
  const second = await w.service.setups.apply(workflowId, { folder });
  assert.equal(second.state, "ready");
  assert.equal(JSON.stringify(w.store.list("agent")), agentsBefore);
  assert.equal(w.store.list("project-setup").length, 1);
  assert.equal(w.events("project.setup_ready").length, 1, "published once");
  // A different folder for the same project is refused instead of moving the authorized scope.
  const other = await w.folder("other");
  await assert.rejects(w.service.setups.apply(workflowId, { folder: other }), {
    code: "folder_differs_from_contract",
  });
});

test("existing attachments, rules and other folders are preserved; widening a read-only attachment needs its own approval", async (t) => {
  const { w, team, workflowId } = await incident(t);
  const folder = await w.folder("pi");
  const kept = await w.folder("kept");
  const integrator = agentOf(w, team.integrator.id);
  await w.service.saveAgent(
    {
      name: integrator.name,
      environment: integrator.environment,
      model: integrator.model,
      effort: integrator.effort,
      roleType: integrator.roleType,
      role: integrator.role,
      instructions: integrator.instructions,
      tools: integrator.tools,
      parentId: integrator.parentId,
      workspaces: [
        { path: kept, access: "write", active: true },
        {
          path: folder,
          access: "read",
          active: false,
          rules: [{ path: "secrets", access: "none" }],
        },
      ],
    },
    integrator.id,
  );
  const view = w.service.setups.view(workflowId);
  const entry = view.proposal.participants.find(
    (p) => p.agentId === integrator.id,
  );
  assert.equal(entry?.access, "write");
  const result = await w.service.setups.apply(workflowId, { folder });
  const afterSimple = agentOf(w, integrator.id).workspaces;
  assert.deepEqual(
    afterSimple.map((x) => [x.path, x.access]),
    [
      [kept, "write"],
      [folder, "read"],
    ],
    "nothing widened without approval; the other folder stays",
  );
  assert.equal(result.state, "needed");
  assert.ok(result.blockers.some((b) => b.agentId === integrator.id));
  assert.ok(
    result.blockers.every((b) => b.agentId === integrator.id),
    "everyone else is ready",
  );
  // Approving the widening changes the access only; the rules and the other folder stay.
  const widened = await w.service.setups.apply(workflowId, {
    folder,
    widen: [integrator.id],
  });
  const after = agentOf(w, integrator.id).workspaces;
  assert.deepEqual(
    after.map((x) => [x.path, x.access]),
    [
      [kept, "write"],
      [folder, "write"],
    ],
  );
  assert.deepEqual(after[1].rules, [{ path: "secrets", access: "none" }]);
  assert.equal(after[0].active, true);
  // With per-file rules the provider cannot enforce, file tools stay withheld, and setup says so.
  assert.equal(widened.state, "needed");
  assert.equal(widened.blockers[0].issues[0].code, "confinement-unsupported");
  assert.equal(widened.blockers[0].issues[0].fix?.kind, "remove-access-rules");
});

test("grants go only to listed roles, never past a global denial, never to .git or a missing folder", async (t) => {
  const { w, team, workflowId } = await incident(t);
  const folder = await w.folder("pi");
  await assert.rejects(
    w.service.setups.apply(workflowId, {
      folder,
      participants: [team.planner.id],
    }),
    { code: "participant_not_in_setup" },
  );
  await assert.rejects(
    w.service.setups.apply(workflowId, {
      folder,
      widen: [team.planner.id],
    }),
    { code: "participant_not_in_setup" },
  );
  await assert.rejects(
    w.service.setups.apply(workflowId, { folder: join(w.base, "missing") }),
    { code: "invalid_path" },
  );
  await mkdir(join(folder, ".git"));
  await assert.rejects(
    w.service.setups.apply(workflowId, { folder: join(folder, ".git") }),
    { code: "git_dir_blocked" },
  );
  const denied = await w.folder("denied");
  filesystemPolicy(w.store).add({
    paths: [denied],
    acknowledgePermanent: true,
  });
  const before = JSON.stringify(w.store.list("agent"));
  await assert.rejects(w.service.setups.apply(workflowId, { folder: denied }), {
    code: "filesystem_blocked",
  });
  assert.equal(
    JSON.stringify(w.store.list("agent")),
    before,
    "nothing attached",
  );
  // A subset can be approved; the rest stays blocked.
  const partial = await w.service.setups.apply(workflowId, {
    folder,
    participants: [team.integrator.id],
  });
  assert.equal(partial.state, "needed");
  assert.ok(partial.blockers.every((b) => b.agentId !== team.integrator.id));
  assert.ok(partial.blockers.length > 0);
});

test("an existing project with usable folders and grants needs no new step; one without them is reported, never silently granted", async (t) => {
  const w = await world(t);
  const folder = await w.folder("legacy");
  const builder = await w.service.saveAgent({
    name: "Builder",
    environment: "claude",
    roleType: "implementer",
  });
  const project = await assignProject(w.service, "main", {
    mode: "simple",
    goal: "Write the notes file",
    workspace: folder,
    tasks: [
      {
        agentId: builder.id,
        title: "Write notes.txt",
        instructions: "Write notes.txt with the summary.",
      },
    ],
  });
  // Simulate a project saved before contracts and setup existed.
  w.store.remove("execution-contract", `project:${project.id}`);
  const writesBefore = JSON.stringify(w.store.list("project-setup"));
  const view = w.service.setups.view(project.id);
  assert.equal(view.state, "ready");
  assert.equal(view.migration.existingProject, true);
  assert.equal(view.migration.needsNewStep, false);
  assert.equal(
    JSON.stringify(w.store.list("project-setup")),
    writesBefore,
    "viewing writes nothing",
  );
  const discovery = {
    settled: true,
    runtimes: structuredClone(defaults).map((r) => ({
      ...r,
      installed: true,
      authenticated: true,
    })),
  };
  const resumed = await resumeProject(w.service, discovery, project.id);
  assert.equal(resumed.paused, false, "Start works exactly as before");

  // An older project whose writer lost its folder is reported, and nothing is granted for it.
  const orphan = await w.service.saveAgent({
    name: "Orphan",
    environment: "claude",
    roleType: "implementer",
  });
  const workflow = w.service.workflow({
    name: "Old",
    goal: "Write",
    ownerId: orphan.id,
    completionCriteria: "Done",
  });
  w.service.task({
    workflowId: workflow.id,
    agentId: orphan.id,
    title: "Write",
    completionCriteria: "Done",
  });
  const before = JSON.stringify(agentOf(w, orphan.id));
  const old = w.service.setups.view(workflow.id);
  assert.equal(old.state, "needed");
  assert.equal(old.migration.needsNewStep, true);
  assert.equal(
    JSON.stringify(agentOf(w, orphan.id)),
    before,
    "no access inferred",
  );
});

test("applying to a real project records its attachments where detach looks for them", async (t) => {
  const w = await world(t);
  const folder = await w.folder("proj");
  const builder = await w.service.saveAgent({
    name: "Builder",
    environment: "claude",
    roleType: "implementer",
  });
  const project = await assignProject(w.service, "main", {
    mode: "simple",
    goal: "Write the notes file",
    workspace: folder,
    tasks: [
      {
        agentId: builder.id,
        title: "Write notes.txt",
        instructions: "Write notes.txt with the summary.",
      },
    ],
  });
  // The builder lost the folder; the setup action restores it for that project.
  w.store.put("agent", { ...agentOf(w, builder.id), workspaces: [] });
  const workflowBefore = w.store.get<any>("workflow", project.id);
  // The writer is proposed with the narrower scope its task declares.
  const proposed = w.service.setups.view(project.id).proposal.participants;
  assert.deepEqual(
    proposed.map((p) => [p.name, p.access, p.scope]),
    [["Builder", "write", folder]],
  );
  const result = await w.service.setups.apply(project.id, { folder });
  assert.equal(result.state, "ready");
  const workflow = w.store.get<any>("workflow", project.id);
  assert.equal(
    workflow.setup.attachments.length,
    workflowBefore.setup.attachments.length + 1,
  );
  assert.deepEqual(workflow.setup.attachments.at(-1), {
    agentId: builder.id,
    path: folder,
    access: "write",
    at: workflow.setup.attachments.at(-1).at,
  });
});

test("the setup, contract and readiness data are served over the API", async (t) => {
  const { createApi } = await import("../src/http.ts");
  const { w, team, workflowId } = await incident(t);
  const server = createApi(w.service, "test-token", w.runs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const open = await call("GET", "/project-setups");
  assert.deepEqual(
    open.body.map((r: any) => r.workflowId),
    [workflowId],
  );
  const view = await call("GET", `/projects/${workflowId}/setup`);
  assert.equal(view.status, 200);
  assert.equal(view.body.state, "needed");
  const notice = await call(
    "GET",
    `/agents/${team.planner.id}/delegation-readiness`,
  );
  // A pipeline team without a project: chat does not start the pipeline (the composer notice).
  assert.equal(notice.body.notice.code, "pipeline-needs-project");
  assert.equal(
    notice.body.notice.text,
    "This team runs projects; chat does not start the pipeline.",
  );
  assert.equal(notice.body.projectType, "pipeline");
  assert.equal(notice.body.hasProject, false);
  assert.ok(notice.body.workers.some((x: any) => !x.ready));
  // A hand-built team: the notice follows the workers' own readiness, not the planner's folders.
  const lead = await w.service.saveAgent({
    name: "Lead",
    environment: "claude",
    roleType: "coordinator",
    teamId: "main",
  });
  const dev = await w.service.saveAgent({
    name: "Dev",
    environment: "claude",
    roleType: "implementer",
    teamId: "main",
  });
  w.service.saveEdge({ from: lead.id, to: dev.id, kind: "delegate" });
  const hand = await call("GET", `/agents/${lead.id}/delegation-readiness`);
  assert.equal(hand.body.notice.code, "workers-not-ready");
  assert.match(hand.body.notice.text, /Dev cannot write or run code yet/);
  assert.equal(hand.body.notice.action.kind, "choose-project-folder");
  const leaf = await call("GET", `/agents/${dev.id}/delegation-readiness`);
  assert.equal(
    leaf.body.notice.code,
    "agent-not-ready",
    "a folderless leaf needs its own setup",
  );
  assert.equal(
    (
      await call("POST", `/projects/${workflowId}/setup`, {
        folder: "relative",
      })
    ).status,
    400,
  );
  const folder = await w.folder("api");
  const applied = await call("POST", `/projects/${workflowId}/setup`, {
    folder,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.state, "ready");
  const after = await call(
    "GET",
    `/agents/${team.planner.id}/delegation-readiness`,
  );
  assert.ok(after.body.workers.every((x: any) => x.ready));
  assert.equal((await call("GET", "/project-setups")).body.length, 0);
  const contract = await call("GET", `/projects/${workflowId}/contract`);
  assert.equal(contract.body.project.workKind, "executable-implementation");
  assert.equal(contract.body.project.projectFolder, folder);
  const lowered = await call("POST", `/projects/${workflowId}/contract`, {
    workKind: "response-only",
  });
  assert.equal(lowered.body.project.workKindSource, "user");
  const task = w.service.task({
    workflowId,
    agentId: team.integrator.id,
    title: "Write notes",
    completionCriteria: "Done",
  });
  const readiness = await call("GET", `/tasks/${task.id}/readiness`);
  assert.equal(readiness.body.decision.ready, true);
  void (null as unknown as Task);
});

test("generic Start preserves a user correction and sends the original request exactly once", async (t) => {
  const { createApi } = await import("../src/http.ts");
  const { w, team, workflowId } = await incident(t);
  const server = createApi(w.service, "test-token", w.runs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: "Bearer test-token",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const session = w.store
    .list<any>("session")
    .find((s) => s.agentId === team.planner.id)!;
  const userMessages = () =>
    w.messages(session.id).filter((m) => m.role === "user");
  const start = `/projects/${workflowId}/setup/start`;

  let view = (await call("GET", `/projects/${workflowId}/setup`)).body;
  assert.equal(view.start.available, false);
  assert.equal(view.start.reason, "Finish the setup first");
  assert.equal(view.start.sessionId, session.id);
  const sent = await call("POST", start, {});
  assert.equal(sent.status, 409);
  assert.equal(sent.body.error, "setup_not_ready");
  assert.equal(userMessages().length, 1, "nothing was sent");

  const folder = await w.folder("start");
  view = (await call("POST", `/projects/${workflowId}/setup`, { folder })).body;
  assert.equal(view.start.available, true);

  // Execution paused: refused before anything is queued.
  w.runs.changeExecution("pause-now");
  const paused = await call("POST", start, {});
  assert.equal(paused.status, 409);
  assert.equal(paused.body.error, "execution_paused");
  assert.equal(userMessages().length, 1);
  w.runs.changeExecution("resume");

  w.service.contracts.setUserWorkKind(workflowId, "response-only");
  const calls: string[] = [];
  w.setProvider(async (command, _e, emit) => {
    calls.push(command.stdin);
    emit({ type: "text", data: "Delegating now." });
  });
  const started = await call("POST", start, {});
  assert.equal(started.status, 202);
  assert.equal(started.body.start.available, false);
  assert.equal(started.body.start.reason, "The request was already sent again");
  assert.equal(userMessages().length, 2);
  assert.equal(
    userMessages()[1].text,
    userMessages()[0].text,
    "the unchanged request",
  );
  await w.until(() => calls.length === 1);
  assert.match(calls[0], /Python program that computes pi to 500 digits/);
  // Repeating Start sends nothing and creates nothing.
  const again = await call("POST", start, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_started");
  assert.equal(userMessages().length, 2);
  await w.settle();
  assert.equal(calls.length, 1);
  // Only a chat request starts this way.
  const folderless = w.service.workflow({
    name: "Project",
    goal: "g",
    ownerId: team.planner.id,
    completionCriteria: "d",
  });
  assert.equal(
    (await call("POST", `/projects/${folderless.id}/setup/start`, {})).status,
    400,
  );
});
