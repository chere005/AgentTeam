import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./fixtures/execution-world.ts";
import type { Task } from "../src/model.ts";
import type { ProjectSetupRecord } from "../src/project-setup.ts";
import type { RuntimeWait } from "../src/runtime-waits.ts";

// The incident: a pipeline team inserted with no project and no folders receives a coding request
// in chat. These tests prove the app now stops at ONE setup state before any implementation
// provider call, record, counter or attempt, and that the unchanged assignment is ready once the
// folder is chosen. Fixture providers only.

const REQUEST =
  "Have the developers make a Python program that computes pi to 500 digits, run it, and have it reviewed.";
const INVENTED = {
  type: "output-matches" as const,
  pattern: "3\\.14159265358979323846\\d{458}2164201989",
};

test("a folderless pipeline team stops at one setup state: no implementation call, record, counter or attempt", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  const refusals: string[] = [];
  let delegate: ((args: object) => unknown) | undefined;
  w.setProvider(async (command, _environment, emit) => {
    // The planner's own chat turn is the only provider call allowed to happen.
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools!.token);
    delegate = (args) => w.service.orchestration.invokeTeammate(ctx, args);
    const tryDelegate = (args: object) => {
      try {
        delegate!(args);
        refusals.push("accepted");
      } catch (error) {
        refusals.push(
          `${(error as { code?: string }).code}: ${(error as Error).message}`,
        );
      }
    };
    // First attempt: files, a folder scope and a model-written acceptance regex.
    tryDelegate({
      recipient: team.integrator.id,
      title: "Develop: compute pi to 500 digits",
      instructions: "Write and run the program.",
      completionChecks: [{ type: "artifact-exists", path: "pi.py" }, INVENTED],
      resourcePaths: [w.base],
    });
    // The workaround from the incident: the same request with the checks and paths dropped.
    tryDelegate({
      recipient: team.integrator.id,
      title: "Develop: compute pi to 500 digits",
      instructions: "Write and run the program.",
    });
    emit({ type: "text", data: "The integrator cannot work yet." });
  });
  const session = await w.chat(team.planner.id, REQUEST);

  // Both attempts were refused; nothing was created. The first one carried a file contract and
  // keeps its specific error (the recipient has no folder to check files in); the one that dropped
  // the checks and paths, which the incident's model used to get through, is refused with text
  // that names the repair.
  assert.equal(refusals.length, 2);
  assert.match(
    refusals[0],
    /^(artifact_workspace_required|resource_path_outside):/,
  );
  assert.match(refusals[1], /^capability_missing:/);
  assert.match(refusals[1], /Pipeline Integrator .* cannot/);
  assert.match(refusals[1], /Assign the team a project|attach a folder/i);
  assert.match(refusals[1], /Nothing was created/);
  assert.equal(w.store.list("invocation").length, 0);
  const root = w.tasks();
  assert.equal(
    root.length,
    1,
    "only the planner's own conversation task exists",
  );
  assert.equal(root[0].agentId, team.planner.id);
  const limits = w.service.limits.state(root[0].workflowId);
  assert.equal(limits.counters.handoffs, 0);
  assert.equal(limits.counters.spawned, 0);
  // Zero implementation provider effects and attempts: the only effect is the planner's chat run.
  const effects = w.service.recovery.ledger.list();
  assert.ok(effects.every((e) => e.kind === "chat-run"));
  assert.equal(w.service.recovery.state(root[0].id).attempt, 1);

  // One setup state for the conversation, naming the workers with one repair each.
  const records = w.store.list<ProjectSetupRecord>("project-setup");
  assert.equal(records.length, 1);
  assert.equal(records[0].workflowId, root[0].workflowId);
  assert.equal(records[0].state, "needed");
  const integrator = records[0].blockers.find(
    (b) => b.agentId === team.integrator.id,
  )!;
  assert.deepEqual(
    integrator.issues.map((i) => [i.code, i.fix?.kind]),
    [["no-folder", "choose-project-folder"]],
  );
  assert.deepEqual(
    w.events("project.setup_required").map((e) => e.entityId),
    [root[0].workflowId],
    "published once, not per refusal",
  );
  assert.ok(session);
  // The assistant's reply is delivered: ordinary conversation was not blocked.
  assert.ok(
    w
      .messages(session.id)
      .some((m) => m.role === "assistant" && /cannot work/.test(m.text)),
  );
});

test("choosing the folder makes the same saved assignment ready; a retry that omits checks keeps them", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  const folder = await w.folder("pi");
  let workflowId = "";
  let second: { childTaskId: string } | undefined;
  w.setProvider(async (command, _environment, emit) => {
    if (!command.teammateTools) return; // task runs are handled below
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools.token);
    workflowId = w.store.get<Task>("task", ctx.taskId!).workflowId;
    const call = (args: object) =>
      w.service.orchestration.invokeTeammate(ctx, args);
    const base = {
      recipient: team.integrator.id,
      title: "Develop: compute pi to 500 digits",
      instructions: "Write and run the program.",
    };
    assert.throws(
      () =>
        call({
          ...base,
          completionChecks: [
            { type: "artifact-exists", path: "pi.py" },
            INVENTED,
          ],
        }),
      { code: "artifact_workspace_required" },
    );
    // The user chooses the project folder (the one setup action) while the planner waits.
    const applied = await w.service.setups.apply(workflowId, { folder });
    assert.equal(applied.state, "ready");
    // The retry omits the paths AND the checks: the original requirements are kept.
    second = call(base) as { childTaskId: string };
    emit({ type: "text", data: "Delegated." });
  });
  await w.chat(team.planner.id, REQUEST);
  assert.ok(second);
  const child = w.store.get<Task>("task", second!.childTaskId);
  assert.deepEqual(
    (child.completionChecks ?? []).map((c) => c.type),
    ["artifact-exists"],
    "the structural file check came back; the invented literal is held back",
  );
  const contract = w.service.contracts.task(child.id)!;
  assert.equal(contract.workKind, "executable-implementation");
  const literal = contract.requiredChecks.find((c) => c.literal)!;
  assert.equal(literal.enforcement, "advisory");
  assert.equal(literal.label, "unverified");
  assert.deepEqual(
    w.service.contracts.unresolved(child).map((c) => c.slot),
    ["output-matches"],
  );
});

// ---- the same decision through every entry point -----------------------------------------------

async function serve(w: Awaited<ReturnType<typeof world>>) {
  const { createApi } = await import("../src/http.ts");
  const server = createApi(w.service, "test-token", w.runs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  return {
    call,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("chat, nested delegation, the task API and Assign to team reach the same decision for the same request", async (t) => {
  const { assignProject } = await import("../src/projects.ts");
  const { resumeProject } = await import("../src/readiness.ts");
  const { defaults } = await import("../src/discovery.ts");
  const w = await world(t);
  const api = await serve(w);
  t.after(() => api.close());
  const team = w.insertPipeline();
  const decisions: Record<string, { code?: string; worker: string }> = {};

  // 1 + 4. Chat and the nested delegation inside it.
  w.setProvider(async (command, _environment, emit) => {
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools!.token);
    try {
      w.service.orchestration.invokeTeammate(ctx, {
        recipient: team.integrator.id,
        title: "Develop the pi program",
        instructions: "Write and run it.",
      });
    } catch (error) {
      assert.equal((error as { code?: string }).code, "capability_missing");
    }
    emit({ type: "text", data: "Setup is missing." });
  });
  await w.chat(team.planner.id, REQUEST);
  const chat = w.store.list<ProjectSetupRecord>("project-setup")[0];
  const chatIssue = chat.blockers.find((b) => b.agentId === team.integrator.id)!
    .issues[0];
  decisions.chat = { code: chatIssue.code, worker: team.integrator.name };

  // 2. The task API: the task is saved and the response carries the decision.
  const workflow = w.service.workflow({
    name: "API request",
    goal: REQUEST,
    ownerId: team.planner.id,
    completionCriteria: "Done",
  });
  const created = await api.call("POST", "/tasks", {
    workflowId: workflow.id,
    agentId: team.integrator.id,
    title: "Write and run a Python program that computes pi",
    instructions: REQUEST,
    completionCriteria: "The program ran",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.contract.workKind, "executable-implementation");
  assert.equal(created.body.readiness.ready, false);
  decisions.api = {
    code: created.body.readiness.issues[0].code,
    worker: created.body.readiness.issues[0].agentName,
  };
  assert.deepEqual(
    created.body.readiness.issues[0].fix.kind,
    "choose-project-folder",
  );
  // The scheduler blocks it before it starts: no provider call, no attempt.
  await w.until(
    () => w.store.get<Task>("task", created.body.id).status === "blocked",
  );
  assert.equal(w.service.recovery.state(created.body.id).attempt, 1);
  assert.equal(
    w.service.recovery.ledger.list(created.body.id).length,
    0,
    "no provider effect for the blocked task",
  );

  // 3. Assign to team (simple mode): the form needs a folder, so the cause here is that a simple
  // assignment withholds the shell a program needs.
  const folder = await w.folder("assigned");
  const project = await assignProject(w.service, team.teamId, {
    mode: "simple",
    goal: REQUEST,
    workspace: folder,
    tasks: [
      {
        agentId: team.integrator.id,
        title: "Write and run a Python program that computes pi",
        instructions: REQUEST,
      },
    ],
  });
  const discovery = {
    settled: true,
    runtimes: structuredClone(defaults).map((r) => ({
      ...r,
      installed: true,
      authenticated: true,
    })),
  };
  await assert.rejects(resumeProject(w.service, discovery, project.id), {
    code: "capability_missing",
  });
  const assigned = w.service.setups.view(project.id);
  const assignedIssue = assigned.blockers.find(
    (b) => b.agentId === team.integrator.id,
  )!.issues[0];
  decisions.assign = { code: assignedIssue.code, worker: team.integrator.name };
  assert.equal(w.store.get<any>("workflow", project.id).paused, true);
  assert.equal(
    w.tasks().filter((x) => x.workflowId === project.id)[0].status,
    "queued",
    "the saved assignment stays saved and unstarted",
  );

  // The same worker is named by every route; routes that evaluate the same facts agree exactly.
  assert.equal(chatIssue.code, decisions.api.code);
  assert.equal(chatIssue.code, "no-folder");
  assert.equal(decisions.assign.code, "shell-withheld");
  for (const d of Object.values(decisions))
    assert.equal(d.worker, team.integrator.name);
  // Nothing implementation-related ran anywhere.
  assert.ok(
    w.service.recovery.ledger.list().every((e) => e.kind === "chat-run"),
  );
});

test("the scheduler blocks a task before it starts: no turn, lease, effect or attempt; the repair requeues it once", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  const folder = await w.folder("repair");
  const workflow = w.service.workflow({
    name: "Direct task",
    goal: "Write a file",
    ownerId: team.planner.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: team.integrator.id,
    title: "Write notes.txt",
    completionCriteria: "File written",
  });
  let calls = 0;
  w.setProvider(async (_command, _environment, emit) => {
    calls++;
    emit({ type: "text", data: "wrote notes.txt" });
  });
  await w.scheduler.tick();
  await w.settle();
  assert.equal(calls, 0);
  assert.equal(w.store.get<Task>("task", task.id).status, "blocked");
  const wait = w.waits()[0] as RuntimeWait;
  assert.equal(wait.reason, "capability-missing");
  assert.equal(wait.attempt, 1);
  assert.equal(
    w.service.taskState(task.id).runtimeBlocker?.code,
    "capability_missing",
  );
  assert.equal(
    w.service.limits.state(workflow.id).counters.turns,
    0,
    "no turn consumed",
  );
  assert.equal(w.store.list("lease").length, 0);
  assert.equal(w.service.recovery.ledger.list().length, 0);
  assert.equal(w.service.recovery.state(task.id).attempt, 1);
  assert.ok(
    w.service.recovery
      .checkpoints(task.id)
      .every((c) => c.boundary !== "task.started"),
    "it never started",
  );
  // Recovery says so and refuses every retry that cannot resolve it.
  const view = w.service.recovery.view(task.id);
  assert.equal(view.retry.allowed, false);
  assert.equal(view.retry.blocker, "runtime-capability");
  assert.equal(view.decision?.kind, "setup-repair");
  assert.equal(view.decision?.providerCall, false);
  assert.equal(view.decision?.consumesAttempt, false);
  assert.equal(view.decision?.setup?.action?.kind, "choose-project-folder");
  assert.equal(view.decision?.setup?.then?.providerCall, true);
  for (let i = 0; i < 3; i++) {
    assert.throws(() => w.service.recovery.requeue(task.id), {
      code: "runtime_capability_blocked",
    });
    await w.scheduler.tick();
  }
  assert.equal(calls, 0, "repeated ticks and clicks start nothing");
  assert.equal(w.waits().length, 1, "one wait, not one per tick");

  // The one setup action repairs it; the blocked task requeues exactly once and then runs.
  const applied = await w.service.setups.apply(workflow.id, { folder });
  assert.equal(applied.outcome.requeued.length, 1);
  assert.equal(w.store.get<Task>("task", task.id).status, "queued");
  assert.equal(w.waits().length, 0);
  await w.until(
    () => w.store.get<Task>("task", task.id).status === "completed",
  );
  assert.equal(calls, 1);
  assert.equal(
    w.service.recovery.state(task.id).attempt,
    1,
    "the attempt was never consumed",
  );
  assert.equal(
    w.service.launchReadiness.requeueWaiting().length,
    0,
    "repeating changes nothing",
  );
});

// ---- the real cause of a block ---------------------------------------------------------------------

async function blockedWith(
  t: Parameters<typeof world>[0],
  setup: (
    w: Awaited<ReturnType<typeof world>>,
    folder: string,
  ) => Promise<{
    agentId: string;
    resourcePaths?: string[];
    mutate?: () => Promise<void> | void;
  }>,
  options: { platform?: NodeJS.Platform } = {},
) {
  const w = await world(t, options);
  const folder = await w.folder("area");
  const prepared = await setup(w, folder);
  const owner = await w.service.saveAgent({
    name: "Owner",
    environment: "claude",
  });
  const workflow = w.service.workflow({
    name: "Cause",
    goal: "Write and run a program",
    ownerId: owner.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: prepared.agentId,
    title: "Write and run a Python program",
    instructions: "Create the program, then run it.",
    completionCriteria: "It ran",
    ...(prepared.resourcePaths
      ? { resourcePaths: prepared.resourcePaths }
      : {}),
  });
  w.service.contracts.seedTask({
    task,
    text: "Write and run a Python program",
    source: "request",
  });
  await prepared.mutate?.();
  let calls = 0;
  w.setProvider(async (_c, _e, emit) => {
    calls++;
    emit({ type: "text", data: "ran" });
  });
  await w.scheduler.tick();
  await w.settle();
  const wait = w.waits().find((x) => x.id === `task:${task.id}`) as RuntimeWait;
  return { w, task, wait, calls, state: w.store.get<Task>("task", task.id) };
}

const writer = (w: Awaited<ReturnType<typeof world>>, extra: object = {}) =>
  w.service.saveAgent({
    name: "Writer",
    environment: "claude",
    roleType: "implementer",
    ...extra,
  });

test("detached folder, revoked grant, read-only folder, access rules, no active folder and unsupported adapters block with their real cause", async (t) => {
  const scenarios: {
    name: string;
    code: string;
    fix: string;
    setup: Parameters<typeof blockedWith>[1];
  }[] = [
    {
      name: "a folder detached after the task was assigned",
      code: "folder-detached",
      fix: "attach-folder",
      setup: async (w, folder) => {
        const sub = `${folder}/sub`;
        const { mkdir } = await import("node:fs/promises");
        await mkdir(sub);
        const agent = await writer(w, {
          workspaces: [{ path: folder, access: "write", active: true }],
        });
        return {
          agentId: agent.id,
          resourcePaths: [sub],
          mutate: () => {
            w.store.put("agent", { ...agent, workspaces: [] });
          },
        };
      },
    },
    {
      name: "a write grant revoked from the role",
      code: "grant-missing",
      fix: "grant-tool",
      setup: async (w, folder) => {
        const agent = await writer(w, {
          workspaces: [{ path: folder, access: "write", active: true }],
        });
        return {
          agentId: agent.id,
          mutate: () => {
            w.store.put("agent", { ...agent, tools: ["read", "grep", "glob"] });
          },
        };
      },
    },
    {
      name: "a folder attached read-only",
      code: "folder-read-only",
      fix: "grant-write-access",
      setup: async (w, folder) => ({
        agentId: (
          await writer(w, {
            workspaces: [{ path: folder, access: "read", active: true }],
          })
        ).id,
      }),
    },
    {
      name: "per-file access rules the provider cannot enforce",
      code: "folder-restricted",
      fix: "remove-access-rules",
      setup: async (w, folder) => ({
        agentId: (
          await writer(w, {
            workspaces: [
              {
                path: folder,
                access: "write",
                active: true,
                rules: [{ path: "private", access: "none" }],
              },
            ],
          })
        ).id,
      }),
    },
    {
      name: "folders attached but none active",
      code: "no-active-folder",
      fix: "choose-project-folder",
      setup: async (w, folder) => ({
        agentId: (
          await writer(w, {
            workspaces: [{ path: folder, access: "write", active: false }],
          })
        ).id,
      }),
    },
    {
      name: "a runtime without file or shell tools",
      code: "adapter-unsupported",
      fix: "change-runtime",
      setup: async (w) => ({
        agentId: (
          await writer(w, { environment: "wolfram", tools: ["write", "shell"] })
        ).id,
      }),
    },
    {
      name: "an ACP adapter AgentTeam cannot confine",
      code: "adapter-unsupported",
      fix: "change-runtime",
      setup: async (w, folder) => {
        const agent = await writer(w, {
          workspaces: [{ path: folder, access: "write", active: true }],
        });
        w.store.put("settings", {
          id: "connections",
          providers: {
            claude: { transport: "acp", executable: "/bin/true", args: [] },
          },
        });
        return { agentId: agent.id };
      },
    },
  ];
  for (const scenario of scenarios) {
    const r = await blockedWith(t, scenario.setup);
    assert.equal(r.calls, 0, `${scenario.name}: no provider call`);
    assert.equal(r.state.status, "blocked", scenario.name);
    assert.equal(r.wait.reason, "capability-missing", scenario.name);
    assert.equal(r.wait.issues?.[0].code, scenario.code, scenario.name);
    assert.equal(r.wait.issues?.[0].fix?.kind, scenario.fix, scenario.name);
    assert.ok(r.wait.message && r.wait.message.length > 20, scenario.name);
    assert.equal(
      r.w.service.recovery.state(r.task.id).attempt,
      1,
      scenario.name,
    );
    assert.equal(r.w.service.recovery.ledger.list().length, 0, scenario.name);
  }
});

test("an unsupported sandbox keeps its own blocker code and label", async (t) => {
  const r = await blockedWith(
    t,
    async (w, folder) => ({
      agentId: (
        await writer(w, {
          tools: ["read", "write", "shell"],
          workspaces: [{ path: folder, access: "write", active: true }],
        })
      ).id,
    }),
    { platform: "win32" },
  );
  assert.equal(r.calls, 0);
  assert.equal(r.wait.reason, "sandbox-unavailable");
  assert.equal(
    r.w.service.taskState(r.task.id).runtimeBlocker?.code,
    "sandbox_unavailable",
  );
  assert.equal(r.w.service.limits.state(r.state.workflowId).counters.turns, 0);
});

test("resume refuses a task whose folder was detached, before any attempt is used", async (t) => {
  const w = await world(t);
  const folder = await w.folder("resume");
  const agent = await writer(w, {
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const workflow = w.service.workflow({
    name: "Resume",
    goal: "Write",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Write notes.txt",
    completionCriteria: "Done",
  });
  let calls = 0;
  w.setProvider(async () => {
    calls++;
    throw new Error("provider exploded");
  });
  await w.until(() => w.store.get<Task>("task", task.id).status === "failed");
  assert.equal(calls, 1);
  // The writer's failed run may have written: the user states it did not (the effect decision).
  for (const effect of w.service.recovery.ledger.uncertainFor(task.id))
    w.service.recovery.ledger.decide(effect.id, {
      decision: "retry",
      note: "nothing was written",
    });
  w.store.put("agent", { ...agent, workspaces: [] });
  assert.throws(
    () => w.service.recovery.requeue(task.id),
    (error: any) => {
      assert.equal(error.code, "capability_missing");
      assert.match(
        error.message,
        /Nothing was started and no attempt was used/,
      );
      return true;
    },
  );
  assert.equal(w.service.recovery.state(task.id).attempt, 1);
  assert.equal(w.store.get<Task>("task", task.id).status, "failed");
  w.store.put("agent", agent);
  w.service.recovery.requeue(task.id);
  assert.equal(w.service.recovery.state(task.id).attempt, 2);
});

test("a read-only worker does not pass an any-tool test; a reviewer with a read folder is ready", async (t) => {
  const w = await world(t);
  const folder = await w.folder("roles");
  const readOnlyWorker = await writer(w, {
    name: "Read-only worker",
    tools: ["read", "grep", "glob"],
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  const reviewer = await w.service.saveAgent({
    name: "Reviewer",
    environment: "claude",
    roleType: "reviewer",
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  const workflow = w.service.workflow({
    name: "Roles",
    goal: "Write and run a program",
    ownerId: reviewer.id,
    completionCriteria: "Done",
  });
  const contract = w.service.contracts.seedProject({
    workflowId: workflow.id,
    text: "Write and run a Python program that computes pi",
    source: "request",
  })!;
  assert.equal(contract.workKind, "executable-implementation");
  const worker = w.service.launchReadiness.evaluateProspective(readOnlyWorker, {
    contract,
  });
  assert.equal(
    worker.ready,
    false,
    "it has tools, but not the ones the work needs",
  );
  assert.deepEqual(worker.required, ["read", "write", "shell"]);
  assert.ok(worker.issues.some((i) => i.capability === "write"));
  const review = w.service.launchReadiness.evaluateProspective(reviewer, {
    contract,
  });
  assert.equal(review.ready, true);
  assert.deepEqual(review.required, ["read"]);
});

test("ordinary discussion keeps working without a folder: no contract, no setup, delegation of analysis allowed", async (t) => {
  const w = await world(t);
  const team = w.insertPipeline();
  let adjudicatorTask: string | undefined;
  w.setProvider(async (command, _environment, emit) => {
    if (!command.teammateTools) return;
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools.token);
    // Analysis of a question goes to a read-only role without any folder.
    adjudicatorTask = (
      w.service.orchestration.invokeTeammate(ctx, {
        recipient: team.adjudicator.id,
        title: "Explain which algorithms compute pi",
        instructions: "Summarize the options in prose.",
      }) as { childTaskId: string }
    ).childTaskId;
    emit({ type: "text", data: "Here is how pi can be computed." });
  });
  const session = await w.chat(
    team.planner.id,
    "Explain how a Python program could compute pi to many digits.",
  );
  assert.ok(adjudicatorTask, "the analysis delegation was accepted");
  assert.equal(w.store.list("execution-contract").length, 0);
  assert.equal(w.store.list("project-setup").length, 0);
  assert.ok(
    w.messages(session.id).some((m) => /how pi can be computed/.test(m.text)),
  );
  // A direct chat with a folderless role that has nobody to delegate to is just a chat.
  let direct = 0;
  w.setProvider(async (_c, _e, emit) => {
    direct++;
    emit({ type: "text", data: "answered" });
  });
  await w.chat(team.workers[0].id, "What does a Python program need to run?");
  assert.equal(direct, 1);
  assert.equal(w.store.list("project-setup").length, 0);
});

test("restart and repeated Start create no duplicates; the setup action after a restart requeues once", async (t) => {
  const { assignProject } = await import("../src/projects.ts");
  const { resumeProject } = await import("../src/readiness.ts");
  const { defaults } = await import("../src/discovery.ts");
  const { join } = await import("node:path");
  const first = await world(t);
  const storePath = join(first.base, "state.sqlite");
  // The first life of the app runs on a file so a second one can reopen it.
  first.store.close();
  const w1 = await world(t, { storePath, base: first.base });
  const team = w1.insertPipeline();
  const folder = await w1.folder("assigned");
  const discovery = {
    settled: true,
    runtimes: structuredClone(defaults).map((r) => ({
      ...r,
      installed: true,
      authenticated: true,
    })),
  };
  // A saved Assign-to-team project that cannot start, a blocked direct task and a coding chat.
  const project = await assignProject(w1.service, team.teamId, {
    mode: "simple",
    goal: REQUEST,
    workspace: folder,
    tasks: [
      {
        agentId: team.integrator.id,
        title: "Write and run a Python program that computes pi",
        instructions: REQUEST,
      },
    ],
  });
  await assert.rejects(resumeProject(w1.service, discovery, project.id), {
    code: "capability_missing",
  });
  const workflow = w1.service.workflow({
    name: "Direct",
    goal: "Write",
    ownerId: team.planner.id,
    completionCriteria: "Done",
  });
  const direct = w1.service.task({
    workflowId: workflow.id,
    agentId: team.workers[0].id,
    title: "Write notes.txt",
    completionCriteria: "Done",
  });
  await w1.scheduler.tick();
  await w1.settle();
  assert.equal(w1.store.get<Task>("task", direct.id).status, "blocked");
  const snapshot = (w: typeof w1) =>
    JSON.stringify({
      tasks: w.tasks().map((x) => [x.id, x.status]),
      waits: w.waits().map((x) => x.id),
      setups: w.store
        .list<ProjectSetupRecord>("project-setup")
        .map((x) => [x.id, x.state, x.signature]),
      contracts: w.store.list("execution-contract").length,
      checkpoints: w
        .tasks()
        .map((x) => w.service.recovery.checkpoints(x.id).length),
      effects: w.service.recovery.ledger.list().length,
    });
  const before = snapshot(w1);
  const required = w1.events("project.setup_required").length;
  w1.store.close();

  // Restart: reopen the same database, run the startup recovery, tick repeatedly, press Start again.
  const w2 = await world(t, { storePath, base: first.base });
  w2.service.recovery.recover();
  w2.service.graphs.recover();
  for (let i = 0; i < 5; i++) await w2.scheduler.tick();
  for (let i = 0; i < 3; i++)
    await assert.rejects(resumeProject(w2.service, discovery, project.id), {
      code: "capability_missing",
    });
  assert.equal(
    snapshot(w2),
    before,
    "nothing was duplicated, restarted or consumed",
  );
  assert.equal(
    w2.events("project.setup_required").length,
    required,
    "no setup event is repeated",
  );
  assert.equal(w2.service.recovery.state(direct.id).attempt, 1);
  assert.equal(w2.service.limits.state(workflow.id).counters.turns, 0);
  // One setup action after the restart repairs the direct task exactly once.
  const applied = await w2.service.setups.apply(workflow.id, { folder });
  assert.equal(applied.outcome.requeued.length, 1);
  assert.equal(
    (await w2.service.setups.apply(workflow.id, { folder })).outcome.requeued
      .length,
    0,
  );
  assert.equal(
    w2.waits().filter((x) => x.id === `task:${direct.id}`).length,
    0,
  );
});

test("Prepare and verify holds every pipeline stage to the tools and folders it really has", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const { createPipelineSample } = await import("../src/pipeline.ts");
  const { defaults } = await import("../src/discovery.ts");
  const w = await world(t);
  const repo = await w.folder("repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(`${repo}/a`);
  await mkdir(`${repo}/b`);
  await writeFile(`${repo}/a/x.txt`, "x");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  git("add", ".");
  git("commit", "-qm", "init");
  const wt = new (await import("../src/worktrees.ts")).WorktreeService(
    w.service,
  );
  t.after(() => wt.close());
  w.service.pipelines.worktrees = wt;
  const wf = await createPipelineSample(w.service, {
    goal: "Add a greeting feature to the sample project",
    workspace: repo,
    isolation: "paths",
    paths: [`${repo}/a`, `${repo}/b`],
    implementationWorkers: 1,
    fixWorkers: 1,
  });
  const runtimes = structuredClone(defaults).map((r) => ({
    ...r,
    installed: true,
  }));
  const rec = w.store.get<any>("pipeline", wf.id);
  const worker = w.store.get<any>("agent", rec.agents.implement[0]);
  // The pipeline project's contract: write and shell from the workers, read from the reviewers.
  const contract = w.service.contracts.project(wf.id)!;
  assert.equal(contract.workKind, "executable-implementation");
  assert.equal(contract.projectFolder, repo);
  assert.equal(contract.maxCorrectionRounds, 1);
  assert.equal(contract.designatedReviewers.length, 4);
  assert.deepEqual(
    contract.approval?.reviewerIds,
    contract.designatedReviewers,
  );
  // Revoke the worker's write tools: it still has "some tools", but not the ones the work needs.
  w.store.put("agent", { ...worker, tools: ["read", "grep", "glob"] });
  const failed = await w.service.pipelines.prepare(wf.id, runtimes, "manual");
  assert.equal(failed.verified, false);
  const check = failed.checks.find((c) =>
    c.name.startsWith("Execution readiness"),
  )!;
  assert.equal(check.ok, false);
  assert.match(
    check.detail,
    /Implementation Worker 1 .* cannot create or change files/,
  );
  assert.equal(
    w.store.get<ProjectSetupRecord>("project-setup", wf.id).state,
    "needed",
  );
  // Restore the grants: the same project verifies.
  w.store.put("agent", worker);
  const passed = await w.service.pipelines.prepare(wf.id, runtimes, "manual");
  const ok = passed.checks.find((c) =>
    c.name.startsWith("Execution readiness"),
  )!;
  assert.equal(ok.ok, true, ok.detail);
});

test("authentication is reported where the answer is informational; the launch keeps its own requeueing path", async (t) => {
  const w = await world(t);
  w.runs.readiness = (environment) =>
    environment === "claude"
      ? {
          state: "unavailable",
          message: "claude is installed but needs you to sign in again.",
        }
      : { state: "ready" };
  const folder = await w.folder("auth");
  const agent = await writer(w, {
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const decision = w.service.launchReadiness.evaluateProspective(agent, {
    runtime: w.service.launchReadiness.runtime,
  });
  assert.equal(decision.ready, false);
  assert.deepEqual(
    decision.issues.map((i) => [i.code, i.fix?.kind]),
    [["runtime-unavailable", "sign-in"]],
  );
  // Without asking about the runtime the same agent is ready: folders and grants are fine.
  assert.equal(
    w.service.launchReadiness.evaluateProspective(agent).ready,
    true,
  );
  // The launch is not blocked as a capability problem: it fails with runtime_unavailable before
  // any provider process, exactly as before, and is requeued once the runtime is ready.
  const workflow = w.service.workflow({
    name: "Auth",
    goal: "Write",
    ownerId: agent.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Write notes.txt",
    completionCriteria: "Done",
  });
  let calls = 0;
  w.setProvider(async () => {
    calls++;
  });
  await w.until(() => w.store.get<Task>("task", task.id).status === "failed");
  assert.equal(calls, 0);
  const wait = w.waits().find((x) => x.id === `task:${task.id}`) as RuntimeWait;
  assert.equal(wait.reason, undefined, "the legacy runtime-unavailable wait");
  assert.equal(w.service.taskState(task.id).runtimeBlocker, undefined);
});
