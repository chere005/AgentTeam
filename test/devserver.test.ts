import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import {
  DevServerRunner,
  liveDevServerCount,
  shutdownDevServers,
  recordPreviewConsole,
  previewNavigationAllowed,
} from "../src/devserver.ts";
import { DevServerService } from "../src/devserver-service.ts";

const fixtureFile = fileURLToPath(
  new URL("./fixtures/devserver-fixture.mjs", import.meta.url),
);
const command = `"${process.execPath}" "${fixtureFile}"`;
const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
};
function setup(t: any) {
  const runner = new DevServerRunner();
  t.after(async () => {
    await runner.closeAll();
    runner.dispose();
  });
  const start = async (
    mode: string,
    extra: Record<string, string> = {},
    opts: any = {},
  ) => {
    const port = opts.port ?? (await freePort());
    // Environment for the child is inherited from this process.
    const saved = { ...process.env };
    Object.assign(process.env, { FIXTURE_MODE: mode, ...extra });
    try {
      const info = await runner.start({
        key: opts.key ?? "k" + port,
        agentId: "a",
        workspace: tmpdir(),
        cwd: tmpdir(),
        command,
        url: `http://127.0.0.1:${port}`,
        readyTimeoutMs: opts.timeout ?? 15000,
        graceMs: 1000,
      });
      return { info, port, key: info.key };
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
  return { runner, start };
}

test("lifecycle: starting only becomes ready after the URL answers; stop ends in stopped", async (t) => {
  const { runner, start } = setup(t);
  const { info, key } = await start("serve", { FIXTURE_DELAY_MS: "800" });
  assert.equal(info.state, "starting");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    runner.get(key)!.state,
    "starting",
    "spawned process is not ready",
  );
  assert.ok(await until(() => runner.get(key)!.state === "ready"));
  assert.match(runner.get(key)!.log, /Local: http:/);
  assert.equal(runner.get(key)!.embeddable, true);
  await runner.stop(key);
  assert.equal(runner.get(key)!.state, "stopped");
  assert.equal(await (async () => (alive(info.pid!) ? 1 : 0))(), 0);
});

test("a second start while active is refused", async (t) => {
  const { start } = setup(t);
  const { info, port, key } = await start("serve");
  assert.ok(info);
  const other = await freePort();
  await assert.rejects(
    () => start("serve", {}, { port: other, key }),
    /Stop the existing server/,
  );
  assert.ok(port);
});

test("occupied port is refused and the other process is left alone", async (t) => {
  const { start } = setup(t);
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  t.after(() => blocker.close());
  const port = (blocker.address() as { port: number }).port;
  await assert.rejects(
    () => start("serve", {}, { port }),
    /already accepting connections/,
  );
  assert.ok(blocker.listening);
});

test("early exit fails with exit code and a missing-dependency hint", async (t) => {
  const { runner, start } = setup(t);
  const a = await start("early-exit");
  assert.ok(await until(() => runner.get(a.key)!.state === "failed"));
  assert.equal(runner.get(a.key)!.exitCode, 3);
  assert.match(
    runner.get(a.key)!.failure!,
    /exited before the server became ready/,
  );
  assert.match(runner.get(a.key)!.log, /boom/);
  const b = await start("missing-deps");
  assert.ok(await until(() => runner.get(b.key)!.state === "failed"));
  assert.match(runner.get(b.key)!.hints.join(" "), /dependency or the command/);
});

test("never-ready server times out, is killed and reports a hint", async (t) => {
  const { runner, start } = setup(t);
  const a = await start("never", {}, { timeout: 1500 });
  assert.ok(await until(() => runner.get(a.key)!.state === "failed", 10000));
  assert.match(runner.get(a.key)!.failure!, /did not become ready/);
  assert.equal(alive(a.info.pid!), false);
});

test("server ignoring PORT is detected from its output and stopped with a detected URL", async (t) => {
  const { runner, start } = setup(t);
  const real = await freePort();
  const a = await start("ignore-port", { FIXTURE_REAL_PORT: String(real) });
  assert.ok(await until(() => runner.get(a.key)!.state === "failed"));
  assert.equal(runner.get(a.key)!.detectedUrl, `http://127.0.0.1:${real}/`);
  assert.match(runner.get(a.key)!.failure!, /ignored PORT/);
});

test("redirects: same-origin followed, off-origin reported; frame-deny marks blocked embedding", async (t) => {
  const { runner, start } = setup(t);
  const a = await start("redirect");
  assert.ok(await until(() => runner.get(a.key)!.state === "ready"));
  assert.equal(runner.get(a.key)!.previewUrl, `http://127.0.0.1:${a.port}/app`);
  const b = await start("redirect-away");
  assert.ok(await until(() => runner.get(b.key)!.state === "ready"));
  assert.equal(runner.get(b.key)!.redirect?.sameOrigin, false);
  assert.equal(runner.get(b.key)!.previewUrl, `http://127.0.0.1:${b.port}`);
  assert.match(
    runner.get(b.key)!.hints.join(" "),
    /outside the configured origin/,
  );
  const c = await start("frame-deny");
  assert.ok(await until(() => runner.get(c.key)!.state === "ready"));
  assert.equal(runner.get(c.key)!.embeddable, false);
  assert.match(runner.get(c.key)!.embedNote!, /X-Frame-Options/);
});

test("stopping kills the whole process tree and no AgentTeam env leaks", async (t) => {
  const { runner, start } = setup(t);
  const dir = await mkdtemp(join(tmpdir(), "agentteam-dev-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidfile = join(dir, "pids"),
    envfile = join(dir, "env");
  process.env.AGENTTEAM_API_TOKEN = "secret-token-should-not-leak";
  t.after(() => delete process.env.AGENTTEAM_API_TOKEN);
  const a = await start("serve", {
    FIXTURE_PIDFILE: pidfile,
    FIXTURE_ENVFILE: envfile,
  });
  assert.ok(await until(() => runner.get(a.key)!.state === "ready"));
  assert.ok(await until(() => readSync(pidfile).length >= 3));
  const pids = readSync(pidfile);
  assert.ok(pids.every(alive));
  assert.deepEqual(JSON.parse(await readFile(envfile, "utf8")), []);
  await runner.stop(a.key);
  assert.ok(
    await until(() => pids.every((p) => !alive(p)), 5000),
    "children survived: " + pids.filter(alive),
  );
});
function readSync(file: string): number[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

test("shutdown cleanup stops every running server tree", async (t) => {
  const { runner, start } = setup(t);
  const dir = await mkdtemp(join(tmpdir(), "agentteam-dev-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = [join(dir, "p1"), join(dir, "p2")];
  const a = await start("serve", { FIXTURE_PIDFILE: files[0] });
  const b = await start("serve", { FIXTURE_PIDFILE: files[1] });
  assert.ok(
    await until(
      () =>
        runner.get(a.key)!.state === "ready" &&
        runner.get(b.key)!.state === "ready",
    ),
  );
  assert.ok(await until(() => files.every((f) => readSync(f).length >= 3)));
  const pids = files.flatMap(readSync);
  assert.equal(liveDevServerCount(), 2);
  await shutdownDevServers();
  assert.equal(liveDevServerCount(), 0);
  assert.ok(await until(() => pids.every((p) => !alive(p)), 5000));
  assert.equal(runner.get(a.key)!.state, "stopped");
});

test("console capture and navigation restriction apply to the configured origin only", async (t) => {
  const { runner, start } = setup(t);
  const a = await start("serve");
  assert.ok(await until(() => runner.get(a.key)!.state === "ready"));
  const origin = `http://127.0.0.1:${a.port}`;
  assert.equal(previewNavigationAllowed(origin + "/page"), true);
  assert.equal(
    previewNavigationAllowed(`http://127.0.0.1:${a.port + 1}/`),
    false,
  );
  assert.equal(previewNavigationAllowed("https://example.com/"), false);
  assert.equal(previewNavigationAllowed("file:///etc/passwd"), false);
  assert.equal(
    recordPreviewConsole(
      origin + "/",
      "error",
      "TypeError: x",
      origin + "/a.js",
      4,
    ),
    true,
  );
  assert.equal(
    recordPreviewConsole(origin + "/", "info", "chatter", "", 1),
    false,
  );
  assert.equal(
    recordPreviewConsole("https://example.com/", "error", "no", "", 1),
    false,
  );
  assert.equal(runner.consoleEntries(a.key).length, 1);
  runner.clearConsole(a.key);
  assert.equal(runner.consoleEntries(a.key).length, 0);
  await runner.stop(a.key);
  assert.equal(previewNavigationAllowed(origin + "/"), false);
});

test("log output is bounded", async (t) => {
  const { runner } = setup(t);
  const port = await freePort();
  const info = await runner.start({
    key: "noisy",
    agentId: "a",
    workspace: tmpdir(),
    cwd: tmpdir(),
    command: `"${process.execPath}" -e "for(let i=0;i<3000;i++)console.log('x'.repeat(100));process.exit(1)"`,
    url: `http://127.0.0.1:${port}`,
    readyTimeoutMs: 5000,
  });
  assert.ok(await until(() => runner.get("noisy")!.state === "failed"));
  assert.ok(info.log.length <= 64000);
  assert.equal(info.logTruncated, true);
  assert.equal(info.exitCode, 1);
});

test("service: per-folder settings persist, worktrees differ, cwd stays inside, suggestions are not executed", async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-devsvc-")),
  );
  const a = join(base, "project"),
    b = join(base, "other");
  await mkdir(join(a, "web"), { recursive: true });
  await mkdir(b);
  const wt = join(base, "wt");
  await mkdir(wt);
  await writeFile(
    join(wt, ".git"),
    `gitdir: ${join(a, ".git", "worktrees", "wt")}\n`,
  );
  await writeFile(
    join(a, "package.json"),
    JSON.stringify({
      scripts: {
        dev: "vite",
        start: "node server.js --port 4100",
        build: "tsc",
        "dev:marker": "touch ../should-not-exist",
      },
      devDependencies: { vite: "1" },
    }),
  );
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const agent = await team.saveAgent({
    name: "Dev",
    environment: "codex",
    workspaces: [
      { path: a, access: "write", active: true },
      { path: b, access: "write", active: false },
      { path: wt, access: "write", active: false },
    ],
  });
  const svc = new DevServerService(team);
  t.after(() => svc.close());
  const state = await svc.state(agent.id, { workspace: a });
  assert.equal(state.settings, null);
  assert.deepEqual(
    state.suggestions.map((s) => s.label).sort(),
    ["npm dev", "npm dev:marker", "npm start"].sort(),
  );
  assert.match(
    state.suggestions.find((s) => s.label === "npm dev")!.command,
    /--port 5173 --strictPort/,
  );
  assert.equal(
    state.suggestions.find((s) => s.label === "npm start")!.url,
    "http://127.0.0.1:4100",
  );
  assert.match(state.warnings.join(" "), /node_modules is missing/);
  await assert.rejects(() =>
    import("node:fs/promises").then((f) =>
      f.stat(join(base, "should-not-exist")),
    ),
  );
  await svc.save(agent.id, {
    workspace: a,
    command: "npm run dev",
    cwd: "web",
    url: "http://127.0.0.1:5199",
  });
  assert.equal(
    (await svc.state(agent.id, { workspace: a })).settings!.cwd,
    "web",
  );
  assert.equal((await svc.state(agent.id, { workspace: b })).settings, null);
  await assert.rejects(
    () =>
      svc.save(agent.id, {
        workspace: a,
        command: "x",
        cwd: "..",
        url: "http://127.0.0.1:5199",
      }),
    /escapes|relative/i,
  );
  await assert.rejects(() =>
    svc.save(agent.id, {
      workspace: a,
      command: "x",
      cwd: ".",
      url: "http://example.com:5199",
    }),
  );
  await assert.rejects(
    () => svc.state(agent.id, { workspace: base }),
    /not attached/,
  );
  // Worktree-style checkout inherits the source repository's settings.
  const inherited = await svc.state(agent.id, { workspace: wt });
  assert.equal(inherited.inheritedFrom, a);
  assert.equal(inherited.settings!.url, "http://127.0.0.1:5199/");
  await svc.save(agent.id, {
    workspace: wt,
    command: "npm start",
    cwd: ".",
    url: "http://127.0.0.1:5200",
  });
  assert.equal(
    (await svc.state(agent.id, { workspace: wt })).inheritedFrom,
    null,
  );
  assert.equal(
    (await svc.state(agent.id, { workspace: a })).settings!.url,
    "http://127.0.0.1:5199/",
  );
});

test("service: start/stop through settings, lock warning is visible", async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-devsvc-")),
  );
  const root = join(base, "p");
  await mkdir(root);
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const agent = await team.saveAgent({
    name: "Dev",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  const other = await team.saveAgent({
    name: "Writer",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  team.resources.acquire("lease-1", other.id, null);
  const svc = new DevServerService(team);
  t.after(() => svc.close());
  const port = await freePort();
  process.env.FIXTURE_MODE = "serve";
  t.after(() => delete process.env.FIXTURE_MODE);
  const info = (await svc.route(
    "POST",
    `/agents/${agent.id}/devserver/start`,
    async () => ({
      workspace: root,
      command,
      cwd: ".",
      url: `http://127.0.0.1:${port}`,
    }),
  )) as any;
  assert.ok(
    info.hints.join(" ").includes("holds a lease") ||
      info.hints.join(" ").includes("lease"),
  );
  assert.ok(await until(() => svc.runner.get(root)!.state === "ready"));
  const state = await svc.state(agent.id, { workspace: root });
  assert.equal(state.locks[0].agent, "Writer");
  assert.match(state.lockPolicy, /not an AgentTeam resource-lock holder/);
  assert.equal(await svc.route("GET", "/x", async () => ({})), undefined);
  await svc.restart(agent.id, { workspace: root });
  assert.ok(await until(() => svc.runner.get(root)!.state === "ready"));
  const stopped = await svc.stop(agent.id, { workspace: root });
  assert.equal(stopped.state, "stopped");
});
