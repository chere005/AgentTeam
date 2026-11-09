import "./fixtures/temp-data-dir.ts";
import { escapeRegExp } from "./fixtures/regexp.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { world, type World } from "./fixtures/execution-world.ts";
import { controlFolders } from "./fixtures/folder-probe.ts";
import { attachProjectWorkspaceInTx } from "../src/team-profiles.ts";
import { recoveryRoute } from "../src/recovery-routes.ts";
import { explainWaiting } from "../src/inspector.ts";
import {
  FolderAccess,
  macosRefusal,
  type FolderProbeResult,
  type ProbeFn,
} from "../src/folder-access.ts";
import type { Agent, Task } from "../src/model.ts";
import type { RuntimeWait } from "../src/runtime-waits.ts";

// Every way a provider can be launched asks the system about the folder first, the answer survives
// a restart, a question the person has not answered yet never stalls the scheduler, and a folder
// that cannot even be made is a typed wait instead of a task queued for ever. Fixture providers,
// temporary folders only; "macOS" is simulated by an injected probe (no real prompt is raised).

const notRoot = process.platform !== "win32" && process.getuid?.() !== 0;
// The simulated Mac's folders are POSIX paths (src/folder-access.ts compares them as such).
const simulatedMac = {
  skip: process.platform === "win32" && "simulated macOS paths are POSIX paths",
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAC_FIX =
  /System Settings → Privacy & Security → Files and Folders → AgentTeam/;

/** A worker with a write grant on `folder`, and a task for it: only the system can refuse it. */
async function grantedTask(
  w: World,
  folder: string,
  extra: object = {},
  name = "Writer",
) {
  const worker = await w.service.saveAgent({
    name,
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  const owner = await w.service.saveAgent({
    name: `Owner of ${name}`,
    environment: "claude",
  });
  const workflow = w.service.workflow({
    name: "Pi",
    goal: "Write and run a Python program",
    ownerId: owner.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: worker.id,
    title: "Write and run a Python program",
    instructions: "Create the program, then run it.",
    completionCriteria: "It ran",
    ...extra,
  });
  w.service.contracts.seedTask({
    task,
    text: "Write and run a Python program",
    source: "request",
  });
  return { worker, owner, workflow, task };
}

/** A writer that can be chatted with directly (no delegation edge). */
const chatWriter = (w: World, folder: string, name = "Writer") =>
  w.service.saveAgent({
    name,
    environment: "claude",
    roleType: "implementer",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: folder, access: "write", active: true }],
  });

/**
 * A Mac whose home folder is a temporary one and whose "Desktop" prompt nobody answers until the
 * test does: the probe waits for `answer`, exactly as the real `opendir` waits for the person.
 */
function prompting(w: World, home: string, promptWaitMs?: number) {
  const asked: { path: string; write: boolean }[] = [];
  const waiting: ((ok: boolean) => void)[] = [];
  // Once the person has answered, macOS does not ask again: later probes get that answer at once.
  let decided: boolean | null = null;
  const result = (
    path: string,
    write: boolean,
    ok: boolean,
  ): FolderProbeResult =>
    ok
      ? {
          ok: true,
          path,
          write,
          checkedAt: new Date().toISOString(),
          protectedFolder: "Desktop",
          steps: ["realpath", "stat", "readdir", "child"],
        }
      : macosRefusal(path, write);
  const probe: ProbeFn = (path, { write }) => {
    asked.push({ path, write });
    if (decided !== null) return Promise.resolve(result(path, write, decided));
    return new Promise<FolderProbeResult>((resolve) =>
      waiting.push((ok) => resolve(result(path, write, ok))),
    );
  };
  w.service.folderAccess = new FolderAccess({
    store: w.store,
    probe,
    platform: "darwin",
    home,
    ...(promptWaitMs ? { promptWaitMs } : {}),
    onSettled: (info) => w.service.onFolderSettled(info),
  });
  return {
    asked,
    /** The person answers the prompt: Allow (true) or Don't Allow (false). */
    answer: async (ok: boolean) => {
      decided = ok;
      for (const resolve of waiting.splice(0)) resolve(ok);
      await sleep(20);
    },
  };
}

// ---- P1: a chat launches nothing in a folder the system has not proven open -------------------------

test("a direct chat in a folder the system refuses spends no provider call, however often it is asked; once the folder is allowed it runs", async (t) => {
  const w = await world(t);
  w.runs.prepareExecutableChats = true; // the production default (src/runtime.ts)
  const control = controlFolders(w.service);
  const folder = await w.folder("desktop-like");
  control.refuse(folder);
  const writer = await chatWriter(w, folder);
  let calls = 0;
  w.setProvider(async (_c, _e, emit) => {
    calls++;
    emit({
      type: "text",
      data: `Write failed: EPERM: operation not permitted, open '${folder}/README.md'`,
    });
  });
  // Nothing was asked about the folder before: the chat itself asks, and is stopped.
  assert.equal(control.probes(folder), 0);
  const session = await w.chat(
    writer.id,
    "Add an installation section to README.md",
  );
  assert.equal(calls, 0, "no provider call in a folder the system refuses");
  assert.ok(control.probes(folder) >= 1, "the chat asked the system");
  const reply = w.messages(session.id).at(-1)!;
  assert.equal(reply.role, "assistant");
  assert.match(reply.text, MAC_FIX);
  assert.ok(reply.text.includes(folder), "the notice names the folder");
  const conversation = w.tasks().find((x) => x.agentId === writer.id)!;
  assert.equal(conversation.status, "blocked");
  const wait = w.waits().find((x) => x.id === `task:${conversation.id}`);
  assert.equal(wait?.reason, "capability-missing");
  // Asked again and again: still nothing is spent.
  await w.chat(
    writer.id,
    "Update README.md again, please add the installation section",
  );
  await w.chat(writer.id, "Fix README.md: add the installation section");
  assert.equal(calls, 0);
  // The person allowed the folder and came back to the window: the next chat runs.
  control.allow(folder);
  assert.equal(await w.service.folderAccess.recheckFailed(), 1);
  const ok = await w.chat(
    writer.id,
    "Add a troubleshooting section to README.md",
  );
  assert.equal(
    calls,
    1,
    "exactly one provider call, after the folder was proven",
  );
  assert.equal(w.messages(ok.id).at(-1)?.role, "assistant");
});

test("a chat answer that reports the system's refusal asks about the folder, for writing when the role writes", async (t) => {
  const w = await world(t);
  w.runs.prepareExecutableChats = true;
  const control = controlFolders(w.service);
  const folder = await w.folder("reports-denial");
  const writer = await chatWriter(w, folder);
  w.setProvider(async (_c, _e, emit) =>
    emit({
      type: "text",
      data: `I could not save it: EPERM, operation not permitted, mkdir '${folder}/docs'`,
    }),
  );
  await w.chat(writer.id, "Add a docs/index.md file with a table of contents");
  const afterRun = control.calls.filter((c) => c.path === folder);
  assert.ok(
    afterRun.length >= 2,
    "the launch probe, then the probe after the reply",
  );
  assert.ok(
    afterRun.every((c) => c.write === true),
    "a writer is probed for writing",
  );
});

test("the post-run probe of a read-only reviewer task asks for reading, never writing (reviewer fixture R9)", async (t) => {
  const w = await world(t);
  const control = controlFolders(w.service);
  const folder = await w.folder("review-only");
  const reviewer = await w.service.saveAgent({
    name: "Reviewer",
    environment: "claude",
    roleType: "reviewer",
    tools: ["read", "shell"],
    workspaces: [{ path: folder, access: "read", active: true }],
  });
  const owner = await w.service.saveAgent({
    name: "Owner",
    environment: "claude",
  });
  const workflow = w.service.workflow({
    name: "Review",
    goal: "Test the program",
    ownerId: owner.id,
    completionCriteria: "Done",
  });
  const task = w.service.task({
    workflowId: workflow.id,
    agentId: reviewer.id,
    title: "Test the program",
    instructions: "Run the tests of the program and report.",
    completionCriteria: "Tests ran",
  });
  w.service.contracts.seedTask({
    task,
    text: "Test the program",
    source: "request",
  });
  w.setProvider(async (_c, _e, emit) =>
    emit({
      type: "text",
      data: `I could not run the tests: Permission denied: ${folder}/tests/run.sh`,
    }),
  );
  await w.until(() =>
    ["failed", "completed", "blocked"].includes(
      w.store.get<Task>("task", task.id).status,
    ),
  );
  assert.ok(control.calls.length >= 1);
  assert.ok(
    control.calls.every((c) => c.write === false),
    `a write probe ran in a folder the role may only read: ${JSON.stringify(control.calls)}`,
  );
});

test(
  "a chat whose agent folder waits for a macOS prompt stays queued, holds no tick, captures no baseline, and runs once the folder is allowed",
  simulatedMac,
  async (t) => {
    const w = await world(t);
    w.runs.prepareExecutableChats = true;
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/notes");
    const prompt = prompting(w, home);
    const writer = await chatWriter(w, folder);
    let calls = 0;
    w.setProvider(async (_c, _e, emit) => {
      calls++;
      emit({ type: "text", data: "Added the section." });
    });
    // The baseline taken when the folder was attached is gone (as after a change of attachments).
    for (const baseline of w.store.list<{ id: string }>("workspace-baseline"))
      w.store.remove("workspace-baseline", baseline.id);
    const session = w.service.session(writer.id);
    w.service.message(session.id, {
      text: "Add an installation section to README.md",
    });
    await w.runs.start(session.id); // queued, as the composer does
    const started = Date.now();
    await w.scheduler.tick();
    assert.ok(
      Date.now() - started < 2000,
      "the tick did not wait for the prompt",
    );
    // Still queued: nothing failed, nothing started, nothing was looked at for a baseline.
    assert.equal(w.store.list("run-request").length, 1);
    assert.equal(w.events("session.failed").length, 0);
    assert.equal(calls, 0);
    assert.equal(w.store.list("workspace-baseline").length, 0);
    const next = Date.now();
    for (let i = 0; i < 3; i++) await w.scheduler.tick();
    assert.ok(
      Date.now() - next < 1500,
      "later ticks do not wait for the same prompt again",
    );
    assert.equal(prompt.asked.length, 1);
    // The person allows the folder: the next tick runs the chat.
    await prompt.answer(true);
    await w.until(() =>
      w.messages(session.id).some((m) => m.role === "assistant"),
    );
    assert.equal(calls, 1);
    assert.equal(
      w.store.list("workspace-baseline").length,
      1,
      "captured now that the folder is open",
    );
  },
);

test(
  "a chat in a protected folder the person refused is blocked with the refusal and no baseline is captured there",
  simulatedMac,
  async (t) => {
    const w = await world(t);
    w.runs.prepareExecutableChats = true;
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/notes");
    const prompt = prompting(w, home);
    await prompt.answer(false); // Don't Allow, before anyone asked
    const writer = await chatWriter(w, folder);
    for (const baseline of w.store.list<{ id: string }>("workspace-baseline"))
      w.store.remove("workspace-baseline", baseline.id);
    let calls = 0;
    w.setProvider(async (_c, _e, emit) => {
      calls++;
      emit({ type: "text", data: "ran" });
    });
    const session = await w.chat(
      writer.id,
      "Add an installation section to README.md",
    );
    assert.equal(calls, 0);
    assert.match(w.messages(session.id).at(-1)!.text, MAC_FIX);
    assert.equal(
      w.store.list("workspace-baseline").length,
      0,
      "a baseline captured in a refused folder would record an empty folder",
    );
  },
);

// ---- P5: a delegation to a worker is judged on a real answer ------------------------------------------

test("a delegation asks the system about the recipient's folder first: a refused folder creates nothing, a waiting one is accepted and held", async (t) => {
  const w = await world(t);
  const control = controlFolders(w.service);
  const team = w.insertPipeline();
  const folder = await w.folder("shared");
  w.store.transaction(() =>
    attachProjectWorkspaceInTx(
      w.store,
      { [team.integrator.id]: "write" },
      folder,
    ),
  );
  control.refuse(folder);
  const outcomes: string[] = [];
  let childCalls = 0;
  w.setProvider(async (command, _environment, emit) => {
    const ctx = w.runs.toolSessions.authenticate(command.teammateTools!.token);
    if (ctx.agentId === team.integrator.id) {
      childCalls++;
      emit({ type: "text", data: "child ran" });
      return;
    }
    const args = {
      recipient: team.integrator.id,
      title: "Develop: compute pi to 500 digits",
      instructions: "Write and run the program.",
      completionChecks: [{ type: "artifact-exists", path: "pi.py" }],
      resourcePaths: [folder],
    };
    try {
      // The tool endpoint's order: the folder question first, then the synchronous call.
      await w.service.orchestration.preflightFolders(ctx, args);
      w.service.orchestration.invokeTeammate(ctx, args);
      outcomes.push("accepted");
    } catch (error) {
      outcomes.push(`${(error as { code?: string }).code}`);
    }
    emit({ type: "text", data: "delegated" });
  });
  assert.equal(control.probes(folder), 0, "the cache is empty");
  await w.chat(
    team.planner.id,
    "make a program in python that computes pi to 500 significant digits and run it",
  );
  await w.settle();
  assert.deepEqual(
    outcomes,
    ["capability_missing"],
    "refused before any task exists",
  );
  assert.equal(
    w.tasks().filter((x) => x.agentId === team.integrator.id).length,
    0,
  );
  assert.equal(w.store.list("invocation").length, 0);
  assert.ok(control.probes(folder) >= 1);
  assert.equal(childCalls, 0);
});

test(
  "a delegation whose folder question is still unanswered is accepted, held without any provider call, and the tool result says so",
  simulatedMac,
  async (t) => {
    const w = await world(t);
    const team = w.insertPipeline();
    w.service.orchestration.delegationProbeMs = 150;
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/shared");
    w.store.transaction(() =>
      attachProjectWorkspaceInTx(
        w.store,
        { [team.integrator.id]: "write" },
        folder,
      ),
    );
    const prompt = prompting(w, home);
    const results: any[] = [];
    let childCalls = 0;
    w.setProvider(async (command, _environment, emit) => {
      const ctx = w.runs.toolSessions.authenticate(
        command.teammateTools!.token,
      );
      if (ctx.agentId === team.integrator.id) {
        childCalls++;
        await writeFile(join(folder, "pi.py"), "print(3)\n");
        emit({ type: "text", data: "child ran" });
        return;
      }
      // The planner asks once; its continuation turn after the child finished only reports.
      if (results.length) {
        emit({ type: "text", data: "all done" });
        return;
      }
      const args = {
        recipient: team.integrator.id,
        title: "Develop: compute pi to 500 digits",
        instructions: "Write and run the program.",
        completionChecks: [{ type: "artifact-exists", path: "pi.py" }],
        resourcePaths: [folder],
      };
      await w.service.orchestration.preflightFolders(ctx, args);
      results.push(w.service.orchestration.invokeTeammate(ctx, args));
      emit({ type: "text", data: "delegated" });
    });
    await w.chat(
      team.planner.id,
      "make a program in python that computes pi to 500 significant digits and run it",
    );
    assert.equal(results.length, 1, "the delegation was accepted");
    assert.equal(results[0].folderAccess.state, "pending");
    assert.match(
      results[0].folderAccess.note,
      /Waiting for macOS to allow access to /,
    );
    assert.match(results[0].folderAccess.note, /starts by itself/);
    // The scheduler holds the child: nothing is spent before the folder is proven.
    await w.scheduler.tick();
    const child = w.tasks().find((x) => x.agentId === team.integrator.id)!;
    assert.equal(child.status, "blocked");
    assert.equal(
      (w.waits().find((x) => x.id === `task:${child.id}`) as RuntimeWait)
        .reason,
      "folder-probe-pending",
    );
    assert.equal(childCalls, 0);
    assert.equal(prompt.asked.length, 1, "one question, however many callers");
    // The person allows the folder: the child goes on by itself and runs.
    await prompt.answer(true);
    await w.until(
      () => w.store.get<Task>("task", child.id).status === "completed",
    );
    assert.equal(childCalls, 1);
  },
);

test("the HTTP tool endpoint asks the system before it judges a delegation: with an empty cache a refused folder is refused, nothing is created", async (t) => {
  const { createApi } = await import("../src/http.ts");
  const w = await world(t);
  const control = controlFolders(w.service);
  const team = w.insertPipeline();
  const folder = await w.folder("shared");
  w.store.transaction(() =>
    attachProjectWorkspaceInTx(
      w.store,
      { [team.integrator.id]: "write" },
      folder,
    ),
  );
  control.refuse(folder);
  const workflow = w.service.workflow({
    name: "Pi",
    goal: "make a program in python that computes pi and run it",
    ownerId: team.planner.id,
    completionCriteria: "Done",
  });
  const parent = w.service.task({
    workflowId: workflow.id,
    agentId: team.planner.id,
    title: "Plan the work",
    completionCriteria: "Done",
  });
  w.service.transitionTask(parent.id, { status: "running" });
  const token = w.runs.toolSessions.issue({
    agentId: team.planner.id,
    taskId: parent.id,
  });
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
  assert.equal(control.probes(folder), 0, "nobody has asked the system yet");
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "invoke_teammate",
        arguments: {
          recipient: team.integrator.id,
          title: "Develop: compute pi to 500 digits",
          instructions: "Write and run the program.",
          completionChecks: [{ type: "artifact-exists", path: "pi.py" }],
          resourcePaths: [folder],
        },
      },
    }),
  });
  const body = (await response.json()) as any;
  assert.equal(body.result.isError, true);
  assert.equal(
    JSON.parse(body.result.content[0].text).error,
    "capability_missing",
  );
  assert.ok(control.probes(folder) >= 1, "the endpoint asked the system first");
  assert.equal(
    w.tasks().filter((x) => x.agentId === team.integrator.id).length,
    0,
  );
  assert.equal(w.store.list("invocation").length, 0);
  // A bad token is still a 401 before anything is probed.
  const before = control.calls.length;
  const bad = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer nope",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "invoke_teammate", arguments: {} },
    }),
  });
  assert.equal(bad.status, 401);
  assert.equal(control.calls.length, before);
});

// ---- P2: the answer survives a restart -----------------------------------------------------------------

async function failedLeaf(
  w: World,
  control: ReturnType<typeof controlFolders>,
) {
  const folder = await w.folder("desktop-like");
  const { task, worker } = await grantedTask(w, folder, {
    resourcePaths: [folder],
    completionChecks: [{ type: "artifact-exists", path: "python/pi.py" }],
  });
  let calls = 0;
  w.setProvider(async (_c, _e, emit) => {
    calls++;
    control.refuse(folder);
    emit({
      type: "text",
      data: `Both attempts to write under \`${folder}\` failed with "Operation not permitted": Bash \`mkdir -p ${folder}/python\` was refused; the Write tool failed with \`EPERM\` on \`${folder}\`.`,
    });
  });
  await w.until(() => w.store.get<Task>("task", task.id).status === "failed");
  assert.equal(w.service.recovery.view(task.id).decision?.kind, "setup-repair");
  return { folder, task, worker, calls: () => calls };
}
const retry = (w: World, id: string) =>
  recoveryRoute(
    w.service,
    "POST",
    new URL(`http://app.invalid/tasks/${id}/retry-from-checkpoint`),
    async () => ({}),
  );

test("a refusal survives a restart: preview and action agree on setup, and a fresh probe that succeeds ends it (reviewer fixture R2a)", async (t) => {
  const first = await world(t);
  const storePath = join(first.base, "state.sqlite");
  first.store.close();
  const w1 = await world(t, { storePath, base: first.base });
  const control1 = controlFolders(w1.service);
  const { folder, task, calls } = await failedLeaf(w1, control1);
  // What was stored: the latest answer per folder and access level, with its cause and the fix.
  const stored = w1.store.list<any>("folder-access");
  const write = stored.find((r) => r.write === true && r.path === folder);
  assert.equal(write.ok, false);
  assert.equal(write.code, "folder-denied");
  assert.equal(write.errno, "EPERM");
  assert.equal(write.operation, "readdir");
  assert.match(write.message, new RegExp(escapeRegExp(folder)));
  assert.match(write.fix, MAC_FIX);
  assert.match(write.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(write.source, "post-run");
  assert.equal(w1.events("folder.access_refused").length >= 1, true);
  w1.store.close();

  // The app is started again: an empty memory, the same database.
  const w2 = await world(t, { storePath, base: first.base });
  w2.service.recovery.recover();
  const control2 = controlFolders(w2.service);
  const preview = w2.service.recovery.view(task.id).decision;
  assert.equal(
    preview?.kind,
    "setup-repair",
    "the stored refusal is read, not forgotten",
  );
  assert.equal(preview?.providerCall, false);
  assert.doesNotMatch(preview?.summary ?? "", /Start attempt/);
  assert.equal(w2.service.folderAccess.cached(folder, true)?.ok, false);
  // The action agrees: it asks the system again first and is refused the same way; nothing is spent.
  control2.refuse(folder);
  await assert.rejects(retry(w2, task.id), { code: "capability_missing" });
  assert.equal(
    w2.service.recovery.view(task.id).decision?.kind,
    "setup-repair",
  );
  assert.equal(calls(), 1, "no provider call was spent");
  // A launch is blocked as well until a fresh probe succeeds.
  const queued = w2.service.task({
    workflowId: w2.store.get<Task>("task", task.id).workflowId,
    agentId: w2.store.get<Task>("task", task.id).agentId,
    title: "Write another program",
    instructions: "Write and run it.",
    completionCriteria: "Done",
  });
  w2.service.contracts.seedTask({
    task: queued,
    text: "Write and run a Python program",
    source: "request",
  });
  await w2.scheduler.tick();
  assert.equal(w2.store.get<Task>("task", queued.id).status, "blocked");
  // The folder is allowed: the app asks again (window focus), the answer replaces the stored one,
  // and the preview offers a new attempt.
  control2.allow(folder);
  assert.equal(await w2.service.folderAccess.recheckFailed(), 1);
  assert.equal(w2.service.recovery.view(task.id).decision?.kind, "new-attempt");
  assert.equal(
    w2.store
      .list<any>("folder-access")
      .find((r) => r.write && r.path === folder).ok,
    true,
  );
  assert.equal(w2.events("folder.access_allowed").length, 1);
});

test("a stored success is not trusted after a restart (the 30 second trust stays in memory)", async (t) => {
  const first = await world(t);
  const storePath = join(first.base, "state.sqlite");
  first.store.close();
  const w1 = await world(t, { storePath, base: first.base });
  const folder = await w1.folder("fine");
  await w1.service.folderAccess.probe(folder, { write: true });
  assert.equal(w1.service.folderAccess.cached(folder, true)?.ok, true);
  assert.equal(w1.store.list<any>("folder-access").length, 1);
  w1.store.close();
  const w2 = await world(t, { storePath, base: first.base });
  assert.equal(
    w2.store.list<any>("folder-access").length,
    1,
    "kept as history",
  );
  assert.equal(w2.service.folderAccess.cached(folder, true), undefined);
});

test("a change to the worker's folders marks the answer stale instead of deleting it: a stale refusal still blocks until it is probed again (reviewer fixture R2b)", async (t) => {
  const w = await world(t);
  const control = controlFolders(w.service);
  const { folder, task, worker } = await failedLeaf(w, control);
  const other = await w.folder("notes");
  const current = w.store.get<Agent>("agent", worker.id);
  await w.service.saveAgent(
    {
      name: current.name,
      environment: current.environment,
      roleType: "implementer",
      tools: current.tools,
      workspaces: [
        ...current.workspaces,
        { path: other, access: "read", active: false },
      ],
    },
    worker.id,
  );
  const answer = w.service.folderAccess.cached(folder, true);
  assert.equal(answer?.ok, false, "the refusal is still known");
  assert.equal(w.service.recovery.view(task.id).decision?.kind, "setup-repair");
  const record = w.store
    .list<any>("folder-access")
    .find((r) => r.write && r.path === folder);
  assert.equal(record.stale, true, "marked stale, not deleted");
  // A stale refusal is probed again by the next launch (it is never "fresh"): allowed, it ends.
  control.allow(folder);
  const again = await w.service.folderAccess.probe(folder, { write: true });
  assert.equal(again.ok, true);
  assert.equal(w.service.recovery.view(task.id).decision?.kind, "new-attempt");
});

// ---- P3: a question the person has not answered never stalls the scheduler -----------------------------

test(
  "three tasks on one folder that waits for a macOS prompt: the tick moves on in about a second, the tasks wait with the reason, and the answer starts them",
  simulatedMac,
  async (t) => {
    const w = await world(t);
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/pi");
    const prompt = prompting(w, home);
    const tasks: Awaited<ReturnType<typeof grantedTask>>[] = [];
    for (const name of ["A", "B", "C"])
      tasks.push(await grantedTask(w, folder, {}, `Writer ${name}`));
    let calls = 0;
    w.setProvider(async (_c, _e, emit) => {
      calls++;
      emit({ type: "text", data: "ran" });
    });
    const started = Date.now();
    await w.scheduler.tick();
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 2000,
      `one tick took ${elapsed} ms for three tasks on one stuck folder`,
    );
    assert.equal(prompt.asked.length, 1, "one probe is shared");
    for (const { task, workflow } of tasks) {
      assert.equal(w.store.get<Task>("task", task.id).status, "blocked");
      const wait = w
        .waits()
        .find((x) => x.id === `task:${task.id}`) as RuntimeWait;
      assert.equal(wait.reason, "folder-probe-pending");
      assert.match(
        wait.message ?? "",
        /^Waiting for macOS to allow access to .*pi…/,
      );
      // Visible in the setup card and in Recovery.
      const card = w.service.setups.view(workflow.id);
      assert.ok(
        card.blockers.some((b) =>
          b.issues.some((i) => i.code === "folder-probe-pending"),
        ),
      );
      const recovery = w.service.recovery.view(task.id);
      assert.equal(recovery.decision?.kind, "setup-repair");
      assert.match(
        recovery.decision?.summary ?? "",
        /Waiting for macOS to allow access to/,
      );
      assert.equal(
        w.service.taskState(task.id).runtimeBlocker?.code,
        "folder_probe_pending",
      );
      // "Why is this waiting?" says so in words, not as a sandbox problem.
      const why = explainWaiting(
        w.service,
        { liveEnabled: () => true },
        { taskId: task.id },
      );
      assert.equal(why.reasons[0].code, "folder-probe-pending");
      assert.match(why.headline, /^Waiting: the system has not said yet/);
      assert.match(
        why.reasons[0].detail,
        /Waiting for macOS to allow access to/,
      );
    }
    assert.equal(calls, 0);
    assert.equal(w.waits().length, 3);
    // The next ticks do not wait for the same prompt again.
    const next = Date.now();
    for (let i = 0; i < 3; i++) await w.scheduler.tick();
    assert.ok(
      Date.now() - next < 1500,
      "ticks do not queue up behind a prompt",
    );
    assert.equal(prompt.asked.length, 1);
    // The person allows the folder: the probe's completion requeues the waiting tasks.
    await prompt.answer(true);
    for (const { task } of tasks)
      assert.equal(w.store.get<Task>("task", task.id).status, "queued");
    await w.until(() =>
      tasks.every(
        ({ task }) => w.store.get<Task>("task", task.id).status === "completed",
      ),
    );
    assert.equal(calls, 3);
    assert.equal(w.waits().length, 0);
  },
);

test(
  "a prompt that is refused turns the waiting tasks into the plain refusal, with the fix",
  simulatedMac,
  async (t) => {
    const w = await world(t);
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/pi");
    const prompt = prompting(w, home);
    const { task } = await grantedTask(w, folder);
    w.setProvider(async (_c, _e, emit) => emit({ type: "text", data: "ran" }));
    await w.scheduler.tick();
    const waitOf = () =>
      w.waits().find((x) => x.id === `task:${task.id}`) as RuntimeWait;
    assert.equal(waitOf().reason, "folder-probe-pending");
    await prompt.answer(false);
    assert.equal(
      w.store.get<Task>("task", task.id).status,
      "blocked",
      "refused: still blocked",
    );
    assert.equal(waitOf().reason, "capability-missing");
    assert.match(waitOf().message ?? "", MAC_FIX);
    assert.equal(waitOf().issues?.[0].fix?.kind, "allow-folder-access");
    assert.equal(w.events("folder.access_refused").length, 1);
  },
);

// ---- the actions that wait for the person's answer return a typed pending, never a hang -----------------

test(
  "Retry while the folder question is unanswered answers with the typed folder_probe_pending and spends nothing",
  simulatedMac,
  async (t) => {
    const w = await world(t);
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/pi");
    const { task } = await grantedTask(w, folder, {
      resourcePaths: [folder],
      completionChecks: [{ type: "artifact-exists", path: "missing.py" }],
    });
    let calls = 0;
    w.setProvider(async (_c, _e, emit) => {
      calls++;
      emit({ type: "text", data: "I could not decide what to write." });
    });
    await w.until(() => w.store.get<Task>("task", task.id).status === "failed");
    assert.equal(
      w.service.recovery.view(task.id).decision?.kind,
      "new-attempt",
    );
    // The folder question is now waiting for the person.
    const prompt = prompting(w, home, 60);
    const started = Date.now();
    await assert.rejects(retry(w, task.id), {
      code: "folder_probe_pending",
      status: 409,
    });
    assert.ok(Date.now() - started < 1500);
    assert.equal(calls, 1, "no provider call was spent");
    assert.equal(w.service.recovery.state(task.id).attempt, 1);
    assert.equal(w.store.get<Task>("task", task.id).status, "failed");
    assert.equal(prompt.asked.length, 1);
    // The person allows the folder: the same action goes ahead.
    await prompt.answer(true);
    const result = (await retry(w, task.id))!;
    assert.equal(result.status, 202);
  },
);

test(
  "Start while the folder question is unanswered keeps the project paused with the typed folder_probe_pending",
  simulatedMac,
  async (t) => {
    const { assignProject } = await import("../src/projects.ts");
    const { resumeProject } = await import("../src/readiness.ts");
    const { defaults } = await import("../src/discovery.ts");
    const w = await world(t);
    const team = w.insertPipeline();
    const home = join(w.base, "home");
    const folder = await w.folder("home/Desktop/assigned");
    const project = await assignProject(w.service, team.teamId, {
      mode: "simple",
      goal: "Write notes.txt containing a greeting",
      workspace: folder,
      tasks: [
        {
          agentId: team.integrator.id,
          title: "Write notes.txt",
          instructions: "Create notes.txt containing a greeting.",
          completionChecks: [{ type: "artifact-exists", path: "notes.txt" }],
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
    const prompt = prompting(w, home, 60);
    await assert.rejects(resumeProject(w.service, discovery, project.id), {
      code: "folder_probe_pending",
      status: 409,
    });
    assert.equal(
      w.store.get<{ paused: boolean }>("workflow", project.id).paused,
      true,
    );
    assert.equal(w.service.recovery.ledger.list().length, 0);
    await prompt.answer(true);
    await resumeProject(w.service, discovery, project.id);
    assert.equal(
      w.store.get<{ paused: boolean }>("workflow", project.id).paused,
      false,
    );
  },
);

// ---- a folder nobody asked about is not assumed fine at a launch gate ---------------------------------

test("at a launch gate a folder that was never probed is 'not checked yet', not 'fine'; a preview leaves the question open", async (t) => {
  const w = await world(t);
  const control = controlFolders(w.service);
  const folder = await w.folder("never-asked");
  const { worker, task } = await grantedTask(w, folder);
  const plan = await w.service.launchPlan(worker.id, task.id);
  assert.equal(control.probes(folder), 0);
  const lenient = w.service.launchReadiness.evaluatePlan(worker, plan, {
    task,
  });
  assert.equal(
    lenient.ready,
    true,
    "a synchronous preview cannot ask the system",
  );
  const strict = w.service.launchReadiness.evaluatePlan(worker, plan, {
    task,
    strictFolders: true,
  });
  assert.equal(strict.ready, false);
  assert.deepEqual(
    strict.issues.map((i) => [i.code, i.capability, i.fix]),
    [["folder-probe-pending", "write", null]],
  );
  assert.match(strict.message ?? "", /has not asked the system/);
  // Probing it is what makes the gate pass, and the answers it got are the ones judged.
  const probed = await w.service.launchReadiness.probeLaunch(worker, plan, {
    task,
  });
  assert.equal(probed.results.length, 1);
  assert.equal(control.probes(folder), 1);
  const decision = w.service.launchReadiness.evaluatePlan(worker, plan, {
    task,
    host: probed.host,
    strictFolders: true,
  });
  assert.equal(decision.ready, true);
  assert.deepEqual(
    decision.folderAccess?.map(({ path, write, ok }) => ({ path, write, ok })),
    [{ path: folder, write: true, ok: true }],
  );
  // The answers a gate probed are pinned: forgetting them between probing and judging changes nothing.
  w.service.folderAccess.invalidate();
  assert.equal(
    w.service.launchReadiness.evaluatePlan(worker, plan, {
      task,
      host: probed.host,
      strictFolders: true,
    }).ready,
    true,
  );
  assert.equal(
    w.service.launchReadiness.evaluatePlan(worker, plan, {
      task,
      strictFolders: true,
    }).ready,
    false,
    "while the shared answers are gone, the same gate would stop",
  );
});

test("starting the scheduler removes probe directories a crash left behind in folders it has probed before", async (t) => {
  const w = await world(t);
  const folder = await w.folder("probed-before");
  await w.service.folderAccess.probe(folder, { write: true });
  await sleep(50); // the sweep that follows a first success has run
  const old = join(folder, ".agentteam-probe-0123456789ab");
  await mkdir(old);
  await writeFile(join(old, "probe.txt"), "x");
  const { utimes, access } = await import("node:fs/promises");
  const past = new Date(Date.now() - 120_000);
  await utimes(old, past, past);
  w.scheduler.start();
  try {
    for (let i = 0; i < 40; i++) {
      const gone = await access(old).then(
        () => false,
        () => true,
      );
      if (gone) break;
      await sleep(10);
    }
    await assert.rejects(access(old), { code: "ENOENT" });
  } finally {
    w.scheduler.stop();
  }
});

// ---- P4: a folder that cannot be made is a typed wait --------------------------------------------------

test(
  "a declared task folder inside a folder that refuses creation is blocked with the refusal, like its sibling (reviewer fixture R4)",
  { skip: !notRoot && "needs POSIX permissions and a non-root user" },
  async (t) => {
    const w = await world(t);
    const folder = await w.folder("read-only");
    const { task } = await grantedTask(w, folder, {
      resourcePaths: [join(folder, "python")],
    });
    const plain = await grantedTask(w, folder, {}, "Writer 2");
    await chmod(folder, 0o555); // lookups work, creating fails: what folder privacy does to writes
    t.after(() => chmod(folder, 0o755).catch(() => {}));
    let calls = 0;
    w.setProvider(async (_c, _e, emit) => {
      calls++;
      emit({ type: "text", data: "ran" });
    });
    for (let i = 0; i < 3; i++) await w.scheduler.tick();
    for (const id of [task.id, plain.task.id]) {
      assert.equal(w.store.get<Task>("task", id).status, "blocked", id);
      const wait = w.waits().find((x) => x.id === `task:${id}`) as RuntimeWait;
      assert.equal(wait.reason, "capability-missing");
      assert.equal(wait.issues?.[0].code, "folder-denied");
      assert.match(wait.message ?? "", /EACCES/);
      assert.match(
        wait.message ?? "",
        /Check the folder's permissions or choose another folder/,
      );
    }
    assert.equal(calls, 0);
    await assert.rejects(
      (async () => {
        await mkdir(join(folder, "python"));
      })(),
      { code: "EACCES" },
      "the folder really could not be made",
    );
    // Permissions repaired and the window came back: both tasks go on and run.
    await chmod(folder, 0o755);
    assert.equal(await w.service.folderAccess.recheckFailed(), 1);
    assert.equal(w.service.launchReadiness.requeueWaiting().length, 2);
    await w.until(() =>
      [task.id, plain.task.id].every(
        (id) => w.store.get<Task>("task", id).status === "completed",
      ),
    );
    assert.equal(calls, 2);
  },
);

test(
  "an output folder the system refuses to create inside a writable folder is blocked with the error's own cause, never left queued",
  { skip: !notRoot && "needs POSIX permissions and a non-root user" },
  async (t) => {
    const w = await world(t);
    const folder = await w.folder("mixed");
    const sub = join(folder, "locked");
    await mkdir(sub);
    await chmod(sub, 0o555);
    t.after(() => chmod(sub, 0o755).catch(() => {}));
    const { task } = await grantedTask(w, folder, {
      resourcePaths: [join(sub, "out")],
    });
    w.setProvider(async (_c, _e, emit) => emit({ type: "text", data: "ran" }));
    for (let i = 0; i < 3; i++) await w.scheduler.tick();
    assert.equal(w.store.get<Task>("task", task.id).status, "blocked");
    const wait = w
      .waits()
      .find((x) => x.id === `task:${task.id}`) as RuntimeWait;
    assert.equal(wait.reason, "capability-missing");
    assert.equal(wait.issues?.[0].code, "folder-denied");
    assert.match(wait.message ?? "", /EACCES/);
    assert.equal(w.waits().length, 1, "one wait, not one per tick");
  },
);

// ---- the files the probe makes are not the user's changes ----------------------------------------------

test("the probe's hidden directory is not a change for the watcher or the review baseline", async (t) => {
  const { classifyEvent } = await import("../src/fs-watch.ts");
  assert.equal(classifyEvent(".agentteam-probe-0a1b2c3d4e5f"), null);
  assert.equal(classifyEvent(".agentteam-probe-0a1b2c3d4e5f/probe.txt"), null);
  assert.equal(
    classifyEvent("src/.agentteam-probe-0a1b2c3d4e5f/probe.txt"),
    null,
  );
  assert.deepEqual(classifyEvent("src/index.ts"), { git: false });
  const w = await world(t);
  const folder = await w.folder("watched");
  await writeFile(join(folder, "kept.txt"), "keep");
  await mkdir(join(folder, ".agentteam-probe-abcdef012345"));
  await writeFile(
    join(folder, ".agentteam-probe-abcdef012345", "probe.txt"),
    "x",
  );
  const { ensureWorkspaceBaseline } =
    await import("../src/workspace-changes.ts");
  const agent = await chatWriter(w, folder);
  await ensureWorkspaceBaseline(w.store, agent, folder);
  const baseline = w.store.list<{ files: Record<string, unknown> }>(
    "workspace-baseline",
  )[0];
  assert.deepEqual(Object.keys(baseline.files), ["kept.txt"]);
});
