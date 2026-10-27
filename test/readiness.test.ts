import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { RuntimeDiscovery } from "../src/discovery.ts";
import type { ScanDeps } from "../src/runtime-scan.ts";
import { createWolframSample, type WorkflowSetup } from "../src/samples.ts";
import { createPipelineSample } from "../src/pipeline.ts";
import {
  RESCAN_TIMING,
  ReadinessService,
  RescanScheduler,
  commandLine,
  quoteArg,
  shellKind,
  signInCommand,
  type Clock,
  type DiscoveryLike,
} from "../src/readiness.ts";
import type { Agent, Task, Workflow } from "../src/model.ts";

/** Timers run only when the test advances the clock; scans resolve between timers. */
class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timers = this.timers.filter((x) => x.id !== id);
  }
  pending() {
    return this.timers.length;
  }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers]
        .sort((a, b) => a.at - b.at)
        .find((x) => x.at <= end);
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
function deps(over: Partial<ScanDeps> = {}): ScanDeps {
  return {
    find: async (name) => `/opt/bin/${name}`,
    check: async () => ({ ok: true }),
    codexModels: async () => ({ models: [], authenticated: true }),
    claudeAuth: async () => true,
    version: async () => "1.0.0",
    ...over,
  };
}
const make = () => {
  const store = new Store(":memory:");
  return { store, service: new TeamService(store, new SkillCatalog([])) };
};
const count = (store: Store, type: string) =>
  store.history(0, 100_000).filter((e) => e.type === type).length;

test("focus rescans are debounced to one per 15 s and only while a used runtime is blocked", async () => {
  const clock = new FakeClock();
  let blocked = true;
  const s = new RescanScheduler({
    clock,
    scan: async () => {},
    blocked: () => blocked,
    authenticated: () => false,
  });
  s.noteScan(); // the startup scan at t=0
  assert.equal(s.focus(), false, "within 15 s of the last scan");
  await clock.advance(RESCAN_TIMING.focusDebounceMs);
  assert.equal(s.focus(), true);
  await settle();
  assert.equal(s.scans, 1);
  assert.equal(s.focus(), false, "debounced");
  await clock.advance(RESCAN_TIMING.focusDebounceMs - 1);
  assert.equal(s.focus(), false);
  await clock.advance(1);
  blocked = false;
  assert.equal(s.focus(), false, "nothing blocked: no rescan");
  assert.equal(s.scans, 1);
  s.stop();
});

test("periodic rescans run every 60 s while blocked and stop once everything is ready", async () => {
  const clock = new FakeClock();
  let blocked = true;
  const s = new RescanScheduler({
    clock,
    scan: async () => {},
    blocked: () => blocked,
    authenticated: () => false,
  });
  s.noteScan();
  s.update();
  await clock.advance(RESCAN_TIMING.periodicMs - 1);
  assert.equal(s.scans, 0);
  await clock.advance(1);
  assert.equal(s.scans, 1);
  await clock.advance(RESCAN_TIMING.periodicMs * 3);
  assert.equal(s.scans, 4);
  blocked = false;
  s.update();
  await clock.advance(RESCAN_TIMING.periodicMs * 10);
  assert.equal(
    s.scans,
    4,
    "no periodic scan while every used runtime is ready",
  );
  assert.equal(clock.pending(), 0);
  // Blocked again (e.g. an agent now uses a missing runtime): the last scan is long ago, so
  // one runs right away, then every 60 s.
  blocked = true;
  s.update();
  await clock.advance(0);
  assert.equal(s.scans, 5);
  await clock.advance(RESCAN_TIMING.periodicMs);
  assert.equal(s.scans, 6);
  s.stop();
  await clock.advance(RESCAN_TIMING.periodicMs * 5);
  assert.equal(s.scans, 6, "stopped");
});

test("after a sign-in starts, the fast poll scans every 5 s and stops on sign-in or after 5 min", async () => {
  const clock = new FakeClock();
  const signedIn = new Set<string>();
  let overlapping = 0,
    running = 0;
  const s = new RescanScheduler({
    clock,
    scan: async () => {
      running++;
      overlapping = Math.max(overlapping, running);
      await settle();
      running--;
    },
    blocked: () => false,
    authenticated: (id) => signedIn.has(id),
  });
  s.signInStarted("codex");
  assert.equal(s.polling("codex"), true);
  await clock.advance(RESCAN_TIMING.fastPollMs * 3);
  assert.equal(s.scans, 3);
  signedIn.add("codex");
  await clock.advance(RESCAN_TIMING.fastPollMs);
  assert.equal(s.scans, 4, "the scan that sees the sign-in is the last one");
  assert.equal(s.polling("codex"), false);
  await clock.advance(RESCAN_TIMING.fastPollMs * 10);
  assert.equal(s.scans, 4);
  // Never signed in: the poll ends after five minutes.
  s.signInStarted("claude");
  await clock.advance(
    RESCAN_TIMING.fastPollForMs + RESCAN_TIMING.fastPollMs * 4,
  );
  assert.equal(s.polling("claude"), false);
  const total = s.scans;
  assert.ok(
    total - 4 >= 59 && total - 4 <= 61,
    `about 60 polls, got ${total - 4}`,
  );
  await clock.advance(RESCAN_TIMING.fastPollMs * 10);
  assert.equal(s.scans, total);
  assert.equal(overlapping, 1, "scans never overlap");
  s.stop();
});

test("rescan emits runtimes.discovered only when the result changed; the startup/Rescan form always does", async () => {
  const { store, service } = make();
  let signedIn = true;
  const discovery = new RuntimeDiscovery(
    undefined,
    deps({
      codexModels: async () => ({ models: [], authenticated: signedIn }),
    }),
  );
  const readiness = new ReadinessService({
    service,
    discovery,
    clock: new FakeClock(),
  }).start();
  try {
    await readiness.rescan();
    assert.equal(count(store, "runtimes.discovered"), 1);
    await readiness.rescan();
    assert.equal(count(store, "runtimes.discovered"), 1, "unchanged: quiet");
    await readiness.rescan({ always: true });
    assert.equal(count(store, "runtimes.discovered"), 2);
    signedIn = false;
    await readiness.rescan();
    assert.equal(count(store, "runtimes.discovered"), 3, "signed out: changed");
    // A used runtime that is signed out blocks; an unused one does not.
    assert.deepEqual(readiness.blocked(), []);
    await service.saveAgent({ name: "Coder", environment: "codex" });
    assert.deepEqual(readiness.blocked(), ["codex"]);
  } finally {
    readiness.stop();
    store.close();
  }
});

test("model checks run automatically after a scan and after an agent's model changes", async () => {
  const { store, service } = make();
  const clock = new FakeClock();
  const discovery = new RuntimeDiscovery(undefined, deps());
  const readiness = new ReadinessService({ service, discovery, clock }).start();
  try {
    const wf = createWolframSample(service, {
      wolframAgents: 1,
      leadModel: "claude-opus-5-5",
    });
    const setup = () =>
      store.get<Workflow & { setup: WorkflowSetup }>("workflow", wf.id).setup;
    // Nothing is checked before the providers were detected.
    await clock.advance(1000);
    assert.equal(setup().modelCheck.checkedAt, null);
    await readiness.rescan();
    await clock.advance(1000);
    const first = setup().modelCheck;
    assert.equal(first.trigger, "auto");
    assert.equal(first.verified, true, first.issues.join("; "));
    // The gate holds as before; with a passing automatic check resume needs no click.
    assert.equal(service.pauseWorkflow(wf.id, false).paused, false);
    service.pauseWorkflow(wf.id, true);
    const checks = count(store, "workflow.models_verified");
    // A change that does not touch runtime/model/effort does not re-run the check.
    const lead = store.get<Agent>("agent", wf.ownerId);
    const { id, createdAt, control, ...input } = lead;
    await service.saveAgent({ ...input, role: "Plans the work" }, id);
    await clock.advance(1000);
    assert.equal(count(store, "workflow.models_verified"), checks);
    // A model change does, and the failure names the agent.
    await service.saveAgent(
      { ...input, role: "Plans the work", model: "claude-sonnet-5-5" },
      id,
    );
    await clock.advance(1000);
    const second = setup().modelCheck;
    assert.equal(second.verified, false);
    assert.equal(second.trigger, "auto");
    assert.ok(second.issues.some((i) => i.startsWith(`${lead.name}:`)));
    assert.throws(
      () => service.pauseWorkflow(wf.id, false),
      (e: any) => {
        assert.equal(e.code, "models_unverified");
        assert.match(e.message, new RegExp(`did not pass: ${lead.name}`));
        return true;
      },
    );
    // Archived projects are left alone.
    store.put("workflow", {
      ...store.get<Workflow>("workflow", wf.id),
      lifecycle: { state: "archived", at: new Date().toISOString() },
    });
    const before = count(store, "workflow.models_verified");
    await readiness.rescan({ always: true });
    await clock.advance(1000);
    assert.equal(count(store, "workflow.models_verified"), before);
  } finally {
    readiness.stop();
    store.close();
  }
});

async function pipelineWorld(t: any) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-ready-")),
  );
  const { store, service } = make();
  service.hostPlatform = () => "linux"; // Controlled pipeline host, not a native provider launch.
  const root = join(base, "repo");
  await mkdir(join(root, "a"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  await writeFile(join(root, "a", "x.txt"), "x");
  git("add", ".");
  git("commit", "-qm", "init");
  const wf = await createPipelineSample(service, {
    goal: "Add a greeting feature to the sample project",
    workspace: root,
    isolation: "paths",
    paths: [join(root, "a"), join(root, "b")],
    implementationWorkers: 2,
    fixWorkers: 1,
  });
  const servers: { close(): void }[] = [];
  t.after(async () => {
    for (const s of servers) s.close();
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const api = async (
    discovery: RuntimeDiscovery,
    readiness?: ReadinessService,
  ) => {
    const { createApi } = await import("../src/http.ts");
    const runs = new RunManager(service, false, base);
    runs.runtimePlatform = "linux";
    const server = createApi(service, "tok", runs, discovery, readiness);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() };
    };
  };
  return { store, service, wf, api };
}

test("resuming an unprepared pipeline project prepares it first and resumes when every check passes", async (t) => {
  const w = await pipelineWorld(t);
  const discovery = new RuntimeDiscovery(undefined, deps());
  await discovery.refresh();
  const call = await w.api(discovery);
  assert.equal(w.service.parallel.plan(w.wf.id), null);
  const r = await call("POST", `/workflows/${w.wf.id}/pause`, {
    paused: false,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paused, false);
  assert.equal(w.service.pipelines.verification(w.wf.id).state, "verified");
  // Exactly what Prepare and verify does: workers got their disjoint paths.
  assert.equal(w.service.parallel.plan(w.wf.id)?.assignments.length, 2);
  // Prepare and verify still works on its own.
  await call("POST", `/workflows/${w.wf.id}/pause`, { paused: true });
  const prepared = await call("POST", `/pipelines/${w.wf.id}/prepare`);
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.preflight.verified, true);
});

test("resuming a pipeline project whose checks fail answers 409 with the failed checks and assigns nothing", async (t) => {
  const w = await pipelineWorld(t);
  const discovery = new RuntimeDiscovery(
    undefined,
    deps({ find: async () => null }),
  );
  await discovery.refresh();
  const call = await w.api(discovery);
  const r = await call("POST", `/workflows/${w.wf.id}/pause`, {
    paused: false,
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "models_unverified");
  assert.match(r.body.message, /did not pass: .*not installed or detected/);
  assert.equal(
    w.service.parallel.plan(w.wf.id),
    null,
    "no worktree/assignment",
  );
  assert.equal(w.service.pipelines.verification(w.wf.id).state, "failed");
  assert.equal(
    w.store.get<Workflow & { setup: WorkflowSetup }>("workflow", w.wf.id).setup
      .modelCheck.trigger,
    "auto",
  );
});

test("sign-in command lines for PowerShell, cmd and POSIX shells", () => {
  assert.equal(
    shellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    "powershell",
  );
  assert.equal(
    shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    "powershell",
  );
  assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(shellKind("/bin/zsh"), "posix");
  assert.equal(shellKind("/usr/bin/fish"), "posix");
  const exe =
    "C:\\Users\\Me\\AppData\\Roaming\\Claude\\claude-code\\2.1.295\\d2e2\\claude.exe";
  assert.equal(
    commandLine([exe, "auth", "login"], "powershell"),
    `& "${exe}" auth login`,
  );
  assert.equal(
    commandLine([exe, "auth", "login"], "cmd"),
    `"${exe}" auth login`,
  );
  assert.equal(
    commandLine(["/usr/local/bin/codex", "login"], "posix"),
    "/usr/local/bin/codex login",
  );
  assert.equal(
    commandLine(
      ["/Users/me/Library/Application Support/Claude/claude", "auth", "login"],
      "posix",
    ),
    "'/Users/me/Library/Application Support/Claude/claude' auth login",
  );
  // Quoting: nothing in the path is interpreted by the shell.
  assert.equal(quoteArg("/tmp/it's/$(x)", "posix"), `'/tmp/it'\\''s/$(x)'`);
  assert.equal(
    commandLine(["C:\\a$b`c\u201dd\\codex.exe", "login"], "powershell"),
    '& "C:\\a`$b``c`\u201dd\\codex.exe" login',
  );
  assert.throws(() => commandLine(["C:\\100%\\codex.exe", "login"], "cmd"), {
    code: "sign_in_unsafe",
  });
  for (const shell of ["posix", "cmd", "powershell"] as const)
    assert.throws(() => commandLine(["/x\n/codex", "login"], shell), {
      code: "sign_in_unsafe",
    });
  // argv uses the executable AgentTeam runs.
  assert.deepEqual(
    signInCommand(
      { id: "codex", installed: true, executable: "/opt/codex" },
      "/bin/bash",
    ),
    {
      runtime: "codex",
      argv: ["/opt/codex", "login"],
      shell: "posix",
      commandLine: "/opt/codex login",
    },
  );
  assert.throws(
    () =>
      signInCommand(
        { id: "claude", installed: false, executable: null },
        "/bin/sh",
      ),
    { code: "runtime_not_installed" },
  );
  assert.throws(
    () =>
      signInCommand(
        { id: "wolfram", installed: true, executable: "/w" },
        "/bin/sh",
      ),
    { code: "sign_in_unsupported" },
  );
});

test("POST /runtimes/:id/sign-in returns the command for the detected executable, arms the poll, 409 when not installed", async (t) => {
  const { store, service } = make();
  t.after(() => store.close());
  const discovery = new RuntimeDiscovery(
    undefined,
    deps({
      find: async (name) => (name === "claude" ? "/opt/claude/claude" : null),
      claudeAuth: async () => false,
    }),
  );
  await discovery.refresh();
  const clock = new FakeClock();
  const readiness = new ReadinessService({
    service,
    discovery,
    clock,
    auto: true,
  }).start();
  t.after(() => readiness.stop());
  const { createApi } = await import("../src/http.ts");
  const server = createApi(
    service,
    "tok",
    new RunManager(service, false, process.cwd()),
    discovery,
    readiness,
  );
  t.after(() => server.close());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const ok = await post("/runtimes/claude/sign-in", { shell: "/bin/zsh" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, {
    runtime: "claude",
    argv: ["/opt/claude/claude", "auth", "login"],
    shell: "posix",
    commandLine: "/opt/claude/claude auth login",
  });
  assert.equal(readiness.scheduler.polling("claude"), true);
  const ps = await post("/runtimes/claude/sign-in", {
    shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });
  assert.equal(ps.body.commandLine, '& "/opt/claude/claude" auth login');
  const missing = await post("/runtimes/codex/sign-in", {});
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error, "runtime_not_installed");
  assert.match(missing.body.message, /Codex is not installed/);
  assert.equal(readiness.scheduler.polling("codex"), false);
  // The poll rescans by itself and stops once the runtime reports it is signed in.
  const scans = readiness.scheduler.scans;
  await clock.advance(RESCAN_TIMING.fastPollMs);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readiness.scheduler.scans, scans + 1);
});

test("work that failed only because its runtime was unavailable is re-queued once the runtime is ready", async () => {
  const { store, service } = make();
  const runs = new RunManager(service, true, process.cwd());
  let state: any = { state: "unavailable", message: "Codex needs sign-in" };
  runs.readiness = () => state;
  runs.execute = (async () => {}) as any;
  let started = 0;
  const scheduler = new Scheduler(service, runs, async (_c, _e, emit) => {
    started++;
    emit({ type: "text", data: "ok" });
  });
  const discovery = {
    runtimes: [],
    settled: true,
    scanning: false,
    refresh: async () => [],
    readiness: () => state,
  } as unknown as DiscoveryLike;
  const readiness = new ReadinessService({
    service,
    discovery,
    runs,
    clock: new FakeClock(),
  }).start();
  try {
    const agent = await service.saveAgent({ name: "A", environment: "codex" });
    const wf = service.workflow({
      name: "W",
      goal: "G",
      ownerId: agent.id,
      completionCriteria: "D",
    });
    const task = service.task({
      workflowId: wf.id,
      agentId: agent.id,
      title: "T",
      completionCriteria: "D",
    });
    const second = await service.saveAgent({ name: "B", environment: "codex" });
    const other = service.task({
      workflowId: wf.id,
      agentId: second.id,
      title: "Retried by hand",
      completionCriteria: "D",
    });
    const session = service.session(agent.id);
    service.message(session.id, { text: "hello" });
    await runs.start(session.id);
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.get<Task>("task", task.id).status, "failed");
    assert.equal(store.list("run-request").length, 0);
    assert.equal(store.list("runtime-wait").length, 3);
    // Still unavailable: nothing happens.
    assert.deepEqual(readiness.requeueReady(), []);
    // One task was retried by hand meanwhile (a new attempt); it is not touched again.
    service.recovery.requeue(other.id);
    service.transitionTask(other.id, { status: "running" });
    service.transitionTask(other.id, { status: "failed", result: "boom" });

    state = { state: "ready" };
    const requeued = readiness.requeueReady();
    assert.deepEqual(
      requeued.sort(),
      [`chat:${session.id}`, `task:${task.id}`].sort(),
    );
    assert.equal(store.list("runtime-wait").length, 0);
    const after = store.get<Task>("task", task.id);
    assert.equal(after.status, "queued");
    // Retry path: a new attempt, the failed attempt's checkpoint is kept.
    assert.equal(service.recovery.state(task.id).attempt, 2);
    assert.ok(
      service.recovery
        .checkpoints(task.id)
        .some((c) => c.boundary === "task.failed" && c.attempt === 1),
    );
    assert.equal(store.get<Task>("task", other.id).status, "failed");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      store.list("run-request").length,
      1,
      "the chat is queued again",
    );
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.get<Task>("task", task.id).status, "completed");
    assert.ok(started >= 1);
    assert.ok(count(store, "task.runtime_requeued") === 1);
  } finally {
    readiness.stop();
    scheduler.stop();
    store.close();
  }
});
