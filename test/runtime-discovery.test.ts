import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import {
  RuntimeDiscovery,
  defaults,
  normalizeModels,
  type ModelChoice,
} from "../src/discovery.ts";
import {
  scanRuntime,
  checkExecutable,
  defaultModelEfforts,
  type ScanDeps,
} from "../src/runtime-scan.ts";
import {
  planSpawn,
  shimNodeScript,
  escapeCmdArgument,
  executableNames,
} from "../src/runtime-spawn.ts";
import type { Task } from "../src/model.ts";

const npmShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% && "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
const base = (id: "codex" | "claude" | "wolfram") =>
  defaults.find((d) => d.id === id)!;
function deps(over: Partial<ScanDeps> = {}): ScanDeps {
  return {
    find: async () => null,
    check: async () => ({ ok: true }),
    codexModels: async () => ({ models: [], authenticated: null }),
    claudeAuth: async () => true,
    version: async () => "1.0.0",
    ...over,
  };
}
const codexModel = (
  id: string,
  efforts: string[],
  isDefault = false,
): ModelChoice => ({
  id,
  name: id,
  efforts,
  isDefault: isDefault || undefined,
});

test("Windows shims run without a shell: node script when recognisable, escaped cmd.exe otherwise", async () => {
  assert.equal(
    shimNodeScript(npmShim),
    "node_modules\\@openai\\codex\\bin\\codex.js",
  );
  const plan = await planSpawn("C:\\npm\\codex.cmd", ["exec", "--json"], {
    platform: "win32",
    readText: async () => npmShim,
    exists: async (p) => p === "C:\\npm\\node.exe",
  });
  assert.equal(plan.via, "node-script");
  assert.equal(plan.command, "C:\\npm\\node.exe");
  assert.deepEqual(plan.args, [
    "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    "exec",
    "--json",
  ]);
  const pathNode = await planSpawn("C:\\npm\\codex.cmd", [], {
    platform: "win32",
    readText: async () => npmShim,
    exists: async () => false,
  });
  assert.equal(pathNode.command, "node");

  const batch = await planSpawn(
    "C:\\tools\\agent.bat",
    ["a b", 'say "hi"', "50%"],
    {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    },
  );
  assert.equal(batch.via, "cmd-shell");
  assert.equal(batch.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(batch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(batch.options.windowsVerbatimArguments, true);
  assert.ok(
    batch.args[3].includes("^%"),
    "percent signs must be caret-escaped",
  );
  assert.ok(!/[^^]%/.test(batch.args[3]), "no unescaped percent");
  await assert.rejects(
    planSpawn("C:\\tools\\agent.cmd", ["multi\nline"], {
      platform: "win32",
      readText: async () => "@echo off\r\nfoo %*\r\n",
    }),
    /line breaks/,
  );
  assert.throws(() => escapeCmdArgument("a\0b", true));
  // Non-shims and other platforms are untouched.
  for (const [exe, platform] of [
    ["C:\\x\\codex.exe", "win32"],
    ["/usr/bin/codex.cmd", "linux"],
  ] as const) {
    const direct = await planSpawn(exe, ["a"], { platform });
    assert.equal(direct.via, "direct");
    assert.deepEqual(direct.args, ["a"]);
  }
  assert.deepEqual(executableNames("codex", "win32"), [
    "codex.exe",
    "codex.cmd",
    "codex.bat",
  ]);
  assert.deepEqual(executableNames("codex", "linux"), ["codex"]);
});

test("stale manual paths are reported, never silently replaced by another installation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-scan-"));
  try {
    const folder = join(dir, "folder");
    await mkdir(folder);
    assert.deepEqual(await checkExecutable(join(dir, "gone")), {
      ok: false,
      reason: "missing",
    });
    assert.deepEqual(await checkExecutable(folder), {
      ok: false,
      reason: "not-a-file",
    });
    if (process.platform !== "win32") {
      const plain = join(dir, "plain");
      await writeFile(plain, "x");
      await chmod(plain, 0o644);
      assert.deepEqual(await checkExecutable(plain), {
        ok: false,
        reason: "not-executable",
      });
      const exe = join(dir, "exe");
      await writeFile(exe, "#!/bin/sh\n");
      await chmod(exe, 0o755);
      assert.deepEqual(await checkExecutable(exe), { ok: true });
    }
    const real = deps({
      find: async () => "/usr/local/bin/codex",
      check: (p) => checkExecutable(p),
    });
    const stale = await scanRuntime(base("codex"), join(dir, "gone"), real);
    assert.equal(stale.installed, false);
    assert.equal(stale.source, "manual");
    assert.equal(stale.staleOverride?.reason, "missing");
    assert.equal(stale.autoDetected, "/usr/local/bin/codex");
    assert.deepEqual(
      stale.diagnostics!.map((d) => d.code),
      ["manual_path_stale", "auto_available"],
    );
    assert.match(stale.note!, /no longer exists/);
    const reset = await scanRuntime(base("codex"), undefined, real);
    assert.equal(reset.installed, true);
    assert.equal(reset.source, "auto");
    assert.equal(reset.executable, "/usr/local/bin/codex");
    assert.equal(reset.staleOverride, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan diagnostics: not found, signed out, failed discovery, upgrade, defaults and no wolframscript run", async () => {
  const missing = await scanRuntime(base("claude"), undefined, deps());
  assert.equal(missing.installed, false);
  assert.equal(missing.source, "none");
  assert.equal(missing.diagnostics![0].code, "not_found");

  const found = { find: async (n: string) => "/bin/" + n };
  const out = await scanRuntime(
    base("codex"),
    undefined,
    deps({
      ...found,
      codexModels: async () => ({
        models: [
          codexModel("gpt-a", ["low", "high"]),
          codexModel("gpt-b", ["low", "medium", "high"], true),
        ],
        authenticated: false,
      }),
    }),
  );
  assert.equal(out.modelSource, "installed-codex");
  assert.deepEqual(out.models[0].efforts, ["low", "medium", "high"]);
  assert.ok(
    out.diagnostics!.some(
      (d) => d.code === "signed_out" && /codex login/.test(d.message),
    ),
  );
  assert.equal(out.version, "1.0.0");

  const common = defaultModelEfforts([
    base("codex").models[0],
    codexModel("a", ["low", "high"]),
    codexModel("b", ["high", "low", "max"]),
  ]);
  assert.deepEqual(common, ["low", "high"]);

  const failed = await scanRuntime(
    base("codex"),
    undefined,
    deps({
      ...found,
      codexModels: async () => {
        throw new Error("Model discovery timed out");
      },
    }),
  );
  assert.equal(failed.installed, true);
  assert.equal(
    failed.diagnostics!.find((d) => d.level === "warn")!.code,
    "discovery_failed",
  );
  assert.match(failed.note!, /timed out/);

  const claude = await scanRuntime(
    base("claude"),
    undefined,
    deps({ ...found, claudeAuth: async () => false }),
  );
  assert.deepEqual(claude.models[0].efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.ok(claude.diagnostics!.some((d) => d.code === "signed_out"));

  const upgraded = await scanRuntime(
    base("claude"),
    undefined,
    deps({ ...found, version: async () => "2.0.0" }),
    { ...claude, executable: "/bin/claude", version: "1.0.0" },
  );
  assert.ok(
    upgraded.diagnostics!.some(
      (d) => d.code === "upgraded" && /1\.0\.0 to 2\.0\.0/.test(d.message),
    ),
  );

  const forbidden = async () => {
    throw new Error("must not run wolframscript");
  };
  const wolfram = await scanRuntime(
    base("wolfram"),
    undefined,
    deps({
      ...found,
      version: forbidden,
      codexModels: forbidden,
      claudeAuth: forbidden,
    }),
  );
  assert.equal(wolfram.installed, true);
  assert.equal(wolfram.version, undefined);

  const shim = await scanRuntime(
    base("codex"),
    "C:\\npm\\codex.cmd",
    deps({ platform: "win32" }),
  );
  assert.ok(shim.diagnostics!.some((d) => d.code === "windows_shim"));
  assert.deepEqual(
    normalizeModels([
      {
        model: "m",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ]).map((m) => m.isDefault),
    [true],
  );
});

test("discovery is unresolved until a scan finishes and overrides never return stale results", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: (string | undefined)[] = [];
  const discovery = new RuntimeDiscovery(
    undefined,
    deps({
      find: async (n) => (n === "codex" ? "/auto/codex" : null),
      check: async (p) =>
        p === "/manual/codex" ? { ok: true } : { ok: false, reason: "missing" },
      codexModels: async (exe) => {
        seen.push(exe);
        if (seen.length === 1) await gate;
        return { models: [], authenticated: true };
      },
    }),
  );
  assert.equal(discovery.readiness("codex").state, "resolving");
  const first = discovery.refresh();
  assert.equal(discovery.scanning, true);
  assert.equal(discovery.readiness("codex").state, "resolving");
  discovery.setOverride("codex", "/manual/codex");
  const second = discovery.refresh();
  assert.equal(second, first, "mid-scan refresh joins the running scan");
  release();
  const runtimes = await second;
  assert.equal(
    runtimes.find((r) => r.id === "codex")!.executable,
    "/manual/codex",
  );
  assert.deepEqual(seen, ["/auto/codex", "/manual/codex"]);
  assert.equal(discovery.readiness("codex").state, "ready");
  const wolfram = discovery.readiness("claude");
  assert.equal(wolfram.state, "unavailable");

  discovery.setOverride("codex", "/manual/missing");
  assert.equal(discovery.readiness("codex").state, "resolving");
  await discovery.refresh();
  const stale = discovery.readiness("codex");
  assert.equal(stale.state, "unavailable");
  assert.match((stale as { message: string }).message, /no longer exists/);
  discovery.setOverride("codex", null);
  await discovery.refresh();
  assert.equal(discovery.readiness("codex").state, "ready");
});

test("a scan that throws settles discovery as unavailable instead of leaving work resolving", async () => {
  const discovery = new RuntimeDiscovery(
    undefined,
    deps({
      check: async () => {
        throw new Error("disk exploded");
      },
    }),
  );
  discovery.setOverride("codex", "/manual/codex");
  const runtimes = await discovery.refresh();
  assert.equal(discovery.settled, true);
  assert.equal(discovery.scanning, false);
  assert.ok(runtimes.every((r) => !r.installed));
  const codex = discovery.readiness("codex");
  assert.equal(codex.state, "unavailable");
  assert.match((codex as { message: string }).message, /disk exploded/);
});

test("runtime readiness blocks an installed provider that explicitly needs sign-in", async () => {
  const discovery = new RuntimeDiscovery(
    undefined,
    deps({
      find: async (name) => (name === "claude" ? "/bin/claude" : null),
      claudeAuth: async () => false,
    }),
  );
  await discovery.refresh();
  const readiness = discovery.readiness("claude");
  assert.equal(readiness.state, "unavailable");
  assert.match((readiness as { message: string }).message, /claude auth login/);
});

test("queued work waits until its runtime is resolved and fails clearly when unavailable", async () => {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([])),
    runs = new RunManager(service, true, process.cwd());
  let state: any = { state: "resolving" };
  runs.readiness = () => state;
  let started = 0;
  const scheduler = new Scheduler(service, runs, async (_c, _e, emit) => {
    started++;
    emit({ type: "text", data: "ok" });
  });
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
    const session = service.session(agent.id);
    service.message(session.id, { text: "hello" });
    await runs.start(session.id);
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(started, 0);
    assert.equal(store.get<Task>("task", task.id).status, "queued");
    assert.equal(
      store.list("run-request").length,
      1,
      "chat request stays queued",
    );

    state = { state: "unavailable", message: "codex is not installed" };
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(started, 0);
    const failed = store.get<Task>("task", task.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.result ?? "", /codex is not installed/);
    assert.equal(store.list("run-request").length, 0);
    const failure = store
      .history(0, 1000)
      .find((e) => e.type === "session.failed");
    assert.match(
      (failure?.data as { message: string }).message,
      /codex is not installed/,
    );

    state = { state: "ready" };
    service.transitionTask(task.id, { status: "queued" });
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(started, 1);
    assert.equal(store.get<Task>("task", task.id).status, "completed");
  } finally {
    scheduler.stop();
    store.close();
  }
});
