import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPlanned, planSpawn } from "../src/runtime-spawn.ts";
import { killTree } from "../src/devserver.ts";
import { executeCommand } from "../src/runtime.ts";

// Native Windows execution, for real: no injected platform, no stubbed file reads. Each test
// spawns actual processes through the same planning AgentTeam uses for provider executables
// (npm `.cmd` shims, other batch files, plain executables), in a folder whose name needs quoting,
// and checks that arguments arrive byte for byte and that stopping a run ends the whole process
// tree (a grandchild holding the pipes is what makes a cancelled provider hang on Windows).
// The tests only run on Windows; the fixture-level planning tests live in runtime-discovery.

const windows = { skip: process.platform !== "win32" && "Windows only" };
const node = process.execPath;

// Arguments a provider really receives: spaces, quotes, cmd.exe metacharacters, a trailing
// backslash, environment-variable syntax that must not expand, and non-ASCII text.
const hostile = [
  "plain",
  "two words",
  'a "quoted" word',
  "C:\\Program Files\\x\\",
  "a&b|c<d>e^f",
  "100% done %PATH% !USERNAME!",
  "(paren) [bracket] {brace};semi,comma",
  "ünïcödé — π",
  "",
];

async function folder(t: { after: (fn: () => unknown) => void }) {
  // A folder name with a space, an ampersand, a percent sign and parentheses.
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam native & 100% (x) ")),
  );
  t.after(() =>
    rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  return base;
}

/** A Node script that writes the arguments it received as JSON to `out`. */
async function echoScript(base: string) {
  const script = join(base, "echo args.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.AGENTTEAM_ECHO_OUT, JSON.stringify(process.argv.slice(2)));\n`,
  );
  return script;
}

function run(command: string, args: string[], options: object, env: object) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      ...options,
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.once("error", (e) => resolve({ code: -1, stderr: String(e) }));
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}
async function readPid(path: string) {
  let pid = 0;
  await waitFor(async () => {
    pid = Number(await readFile(path, "utf8").catch(() => "0"));
    return pid > 0;
  });
  assert.ok(pid > 0, "the grandchild reported its pid");
  return pid;
}

/** A provider stand-in that starts a long-lived grandchild sharing its stdio, records the
 * grandchild's pid, then waits for ever. */
async function treeScript(base: string) {
  const script = join(base, "tree.mjs");
  await writeFile(
    script,
    [
      `import { spawn } from "node:child_process";`,
      `import { writeFileSync } from "node:fs";`,
      `const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", windowsHide: true });`,
      `writeFileSync(process.env.AGENTTEAM_TREE_PID, String(g.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  return script;
}

test("an npm-style .cmd shim runs its Node script directly and passes every argument intact", windows, async (t) => {
  const base = await folder(t);
  const script = await echoScript(base);
  const shim = join(base, "agent.cmd");
  await writeFile(shim, `@node "%~dp0\\echo args.mjs" %*\r\n`);
  const plan = await planSpawn(shim, hostile);
  assert.equal(plan.via, "node-script");
  assert.equal(plan.args[0], script);
  const out = join(base, "out.json");
  const result = await run(plan.command, plan.args, plan.options, {
    AGENTTEAM_ECHO_OUT: out,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), hostile);
});

test("a .bat file goes through cmd.exe /d /s /c with escaping that survives metacharacters", windows, async (t) => {
  const base = await folder(t);
  await echoScript(base);
  const batch = join(base, "agent.bat");
  await writeFile(
    batch,
    `@"${node}" "%~dp0echo args.mjs" %*\r\n`,
  );
  // cmd.exe cannot carry an empty argument through %* reliably; everything else must arrive.
  const args = hostile.filter((a) => a !== "");
  const plan = await planSpawn(batch, args);
  assert.equal(plan.via, "cmd-shell");
  assert.equal(plan.options.windowsVerbatimArguments, true);
  const out = join(base, "out.json");
  const result = await run(plan.command, plan.args, plan.options, {
    AGENTTEAM_ECHO_OUT: out,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), args);
});

test("a plain executable in a quoted folder is spawned directly", windows, async (t) => {
  const base = await folder(t);
  const script = await echoScript(base);
  const plan = await planSpawn(node, [script, ...hostile]);
  assert.equal(plan.via, "direct");
  const out = join(base, "out.json");
  const result = await run(plan.command, plan.args, plan.options, {
    AGENTTEAM_ECHO_OUT: out,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), hostile);
});

for (const kind of ["cmd", "bat"] as const)
  test(`stopping a ${kind === "cmd" ? "node-script (.cmd)" : "cmd-shell (.bat)"} launch ends its grandchild too`, windows, async (t) => {
    const base = await folder(t);
    await treeScript(base);
    const launcher = join(base, `provider.${kind}`);
    await writeFile(
      launcher,
      kind === "cmd"
        ? `@node "%~dp0\\tree.mjs" %*\r\n`
        : `@"${node}" "%~dp0tree.mjs" %*\r\n`,
    );
    const plan = await planSpawn(launcher, []);
    assert.equal(plan.via, kind === "cmd" ? "node-script" : "cmd-shell");
    const pidFile = join(base, "grandchild.pid");
    const child = spawn(plan.command, plan.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: { ...process.env, AGENTTEAM_TREE_PID: pidFile },
      ...plan.options,
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    const grandchild = await readPid(pidFile);
    t.after(() => {
      if (alive(grandchild)) process.kill(grandchild);
    });
    killPlanned(child, plan);
    // "close" waits for every holder of the pipes: it only fires once the grandchild is gone.
    const ended = await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000).unref()),
    ]);
    assert.equal(ended, true, "the launch closed its pipes");
    assert.equal(await waitFor(() => !alive(grandchild)), true);
  });

test("cancelling a provider run launched through a .cmd shim ends the tree and settles", windows, async (t) => {
  const base = await folder(t);
  await treeScript(base);
  const shim = join(base, "codex.cmd");
  await writeFile(shim, `@node "%~dp0\\tree.mjs" %*\r\n`);
  const pidFile = join(base, "grandchild.pid");
  process.env.AGENTTEAM_TREE_PID = pidFile;
  t.after(() => delete process.env.AGENTTEAM_TREE_PID);
  const controller = new AbortController();
  const running = executeCommand(
    { executable: shim, args: ["exec", "--json"], cwd: base, stdin: "hi" } as any,
    "codex",
    () => {},
    controller.signal,
  );
  const grandchild = await readPid(pidFile);
  t.after(() => {
    if (alive(grandchild)) process.kill(grandchild);
  });
  controller.abort();
  const outcome = await Promise.race([
    running.then(
      () => "resolved",
      (e) => (e as { code?: string }).code ?? "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 10_000).unref()),
  ]);
  assert.equal(outcome, "cancelled");
  assert.equal(await waitFor(() => !alive(grandchild)), true);
});

test("killTree (dev servers, graph commands) ends a process tree with taskkill /T", windows, async (t) => {
  const base = await folder(t);
  const script = await treeScript(base);
  const pidFile = join(base, "grandchild.pid");
  const child = spawn(node, [script], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, AGENTTEAM_TREE_PID: pidFile },
  });
  const grandchild = await readPid(pidFile);
  t.after(() => {
    if (alive(grandchild)) process.kill(grandchild);
  });
  await killTree(child.pid!);
  assert.equal(await waitFor(() => !alive(child.pid!)), true);
  assert.equal(await waitFor(() => !alive(grandchild)), true);
});
