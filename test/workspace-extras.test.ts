import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
  chmod,
  readFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import {
  EditorService,
  launch,
  installedCandidates,
  planOpen,
  type PlanEnv,
} from "../src/editors.ts";
import {
  WatchService,
  WorkspaceWatcher,
  classifyEvent,
} from "../src/fs-watch.ts";
import {
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  buildPreview,
  inspectFile,
  parseDelimited,
} from "../src/previews.ts";

process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const codeOf = (code: string) => (e: any) => e.code === code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await sleep(20);
  return fn();
};

async function fixture(t: any) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "agentteam-wx-"))),
    root = join(base, "project");
  await mkdir(root);
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([])),
    ws = new WorkspaceService(store);
  const agent = await team.saveAgent({
    name: "Builder",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true }],
  });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, store, team, ws, agent };
}

// ---- previews -------------------------------------------------------------
const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from([0, 0, 0, 7, 0, 0, 0, 5]), // 7 x 5
  Buffer.alloc(32),
]);
test("rich previews are typed, bounded and never rendered as HTML", async (t) => {
  const { root, agent, ws } = await fixture(t);
  const put = (name: string, data: string | Buffer) =>
    writeFile(join(root, name), data);
  const look = (path: string) =>
    inspectFile(ws, agent.id, { workspace: root, path });
  await put("pic.png", PNG);
  const img = await look("pic.png");
  assert.equal(img.kind, "image");
  assert.match(img.image!.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual([img.image!.width, img.image!.height], [7, 5]);
  // Oversized image: no bytes returned, opens externally.
  await put("huge.png", Buffer.concat([PNG, Buffer.alloc(4_100_000)]));
  const huge = await look("huge.png");
  assert.equal(huge.image, undefined);
  assert.equal(huge.externalOnly, true);
  assert.match(huge.note!, /Open it externally/);
  // A text file named .png is not served as an image.
  await put("fake.png", "not an image\n");
  assert.equal((await look("fake.png")).kind, "binary");
  // SVG may carry script: shown as source text only.
  await put("x.svg", '<svg onload="alert(1)"><script>1</script></svg>');
  const svg = await look("x.svg");
  assert.equal(svg.kind, "text");
  assert.equal(svg.image, undefined);
  assert.match(svg.content!, /<script>/);
  // HTML is text too.
  await put("page.html", "<script>alert(1)</script>");
  assert.equal((await look("page.html")).kind, "text");
  // Markdown is returned raw (the UI renders it with its safe renderer).
  await put("n.md", "# Title\n\n<img src=x onerror=alert(1)>\n");
  const md = await look("n.md");
  assert.equal(md.kind, "markdown");
  assert.match(md.content!, /# Title/);
  // JSON: valid is formatted, invalid keeps raw text with the error, huge is raw and truncated.
  await put("ok.json", '{"a":[1,2,{"b":null}]}');
  const ok = await look("ok.json");
  assert.equal(ok.json!.valid, true);
  assert.match(ok.json!.formatted, /\n {2}"a": \[/);
  await put("bad.json", '{"a":');
  const bad = await look("bad.json");
  assert.equal(bad.json!.valid, false);
  assert.ok(bad.json!.error);
  await put("big.json", JSON.stringify({ k: "v".repeat(1_200_000) }));
  const big = await look("big.json");
  assert.equal(big.truncated, true);
  assert.match(big.note!, /Too large to parse/);
  assert.ok(big.json!.formatted.length <= 256_000);
  // PDF: metadata only.
  await put("doc.pdf", "%PDF-1.7\n%binary\x00\x01");
  const pdf = await look("doc.pdf");
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.externalOnly, true);
  assert.equal(pdf.content, undefined);
  // Binary and large text.
  await put("blob.bin", Buffer.from([1, 2, 0, 3]));
  assert.equal((await look("blob.bin")).kind, "binary");
  await put("large.txt", "a".repeat(300_000));
  const large = await look("large.txt");
  assert.equal(large.truncated, true);
  assert.equal(large.content!.length, 256_000);
  assert.match(large.note!, /Large file/);
  // Path rules: traversal, .git and directories are refused.
  await assert.rejects(look("../x"), codeOf("path_escape"));
  await assert.rejects(look(".git/config"), codeOf("git_internal"));
  await assert.rejects(look("."), codeOf("not_file"));
});
test("CSV previews parse quotes and bound rows, columns and cells", async (t) => {
  const { root, agent, ws } = await fixture(t);
  await writeFile(
    join(root, "t.csv"),
    'name,quote\r\n"Smith, J","He said ""hi"""\r\nplain,"multi\nline"\n',
  );
  const t1 = await inspectFile(ws, agent.id, {
    workspace: root,
    path: "t.csv",
  });
  assert.deepEqual(t1.table!.rows, [
    ["name", "quote"],
    ["Smith, J", 'He said "hi"'],
    ["plain", "multi\nline"],
  ]);
  assert.equal(t1.truncated, false);
  const rows = Array.from({ length: 500 }, (_, i) =>
    Array.from({ length: 40 }, (_, c) =>
      c === 0 ? `r${i}` : c === 1 ? "x".repeat(300) : "y",
    ).join("\t"),
  );
  await writeFile(join(root, "w.tsv"), rows.join("\n"));
  const w = await inspectFile(ws, agent.id, { workspace: root, path: "w.tsv" });
  assert.equal(w.table!.rows.length, CSV_MAX_ROWS);
  assert.equal(w.table!.rows[0].length, CSV_MAX_COLUMNS);
  assert.ok(w.table!.rows[0][1].length <= 201);
  assert.equal(w.table!.rowsTruncated, true);
  assert.equal(w.table!.delimiter, "\t");
  assert.equal(parseDelimited("a,b\n1,2", ",", 10).rows.length, 2);
  // Truncation of an oversized file drops the partial last row.
  const cut = buildPreview(
    "c.csv",
    "c.csv",
    999_999,
    Buffer.from("a,b\n1,2\n3,"),
  );
  assert.deepEqual(cut.table!.rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

// ---- editors ----------------------------------------------------------------
const probe = (
  platform: NodeJS.Platform,
  present: string[] = [],
  env: Record<string, string> = {},
  path: Record<string, string> = {},
): PlanEnv => ({
  platform,
  env,
  exists: async (p) => present.includes(p),
  which: async (n) => path[n] ?? null,
});
const target = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? "C:\\work\\my project\\a file;$(x).txt"
    : "/work/my project/a file;$(x).txt";
const base = (
  platform: NodeJS.Platform,
  editor: any,
  action: any = "file",
  paths = {},
  isDirectory = false,
) => ({
  action,
  editor,
  target: target(platform),
  isDirectory,
  paths,
});
test("editor commands are argv (never shell) with platform-specific lookup [macOS verified, Windows/Linux fixture-tested]", async () => {
  // macOS
  const mac = (present: string[] = []) => probe("darwin", present);
  assert.deepEqual(await planOpen(mac(), base("darwin", "sublime")), {
    executable: "/usr/bin/open",
    args: ["-a", "Sublime Text", "--", target("darwin")],
    application: "sublime",
    source: "macos-app-name",
  });
  assert.deepEqual(
    (
      await planOpen(
        mac(["/Applications/Visual Studio Code.app"]),
        base("darwin", "vscode"),
      )
    ).args,
    ["-a", "/Applications/Visual Studio Code.app", "--", target("darwin")],
  );
  assert.deepEqual(
    (
      await planOpen(
        mac(),
        base("darwin", "sublime", "file", {
          sublime: "/Users/me/Apps/Sublime Text.app",
        }),
      )
    ).args,
    ["-a", "/Users/me/Apps/Sublime Text.app", "--", target("darwin")],
  );
  const cli = await planOpen(
    mac(),
    base("darwin", "sublime", "file", { sublime: "/usr/local/bin/subl" }),
  );
  assert.deepEqual(
    [cli.executable, cli.args, cli.source],
    ["/usr/local/bin/subl", ["--", target("darwin")], "configured"],
  );
  assert.deepEqual(
    (await planOpen(mac(), base("darwin", "system", "reveal"))).args,
    ["-R", target("darwin")],
  );
  assert.deepEqual((await planOpen(mac(), base("darwin", "system"))).args, [
    "--",
    target("darwin"),
  ]);
  // Windows
  const env = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  };
  const sub = "C:\\Program Files\\Sublime Text\\subl.exe";
  assert.deepEqual(installedCandidates("win32", "vscode", env).slice(0, 1), [
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
  ]);
  const win = await planOpen(
    probe("win32", [sub], env),
    base("win32", "sublime"),
  );
  assert.deepEqual([win.executable, win.args], [sub, ["--", target("win32")]]);
  const code = await planOpen(
    probe(
      "win32",
      ["C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"],
      env,
    ),
    base("win32", "vscode", "project", {}, true),
  );
  assert.equal(
    code.executable,
    "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
  );
  assert.deepEqual(
    (await planOpen(probe("win32", [], env), base("win32", "sublime")))
      .executable,
    "subl",
  );
  assert.deepEqual(
    (await planOpen(probe("win32"), base("win32", "system", "reveal"))).args,
    [`/select,${target("win32")}`],
  );
  assert.deepEqual(
    (
      await planOpen(
        probe("win32"),
        base("win32", "system", "reveal", {}, true),
      )
    ).args,
    [target("win32")],
  );
  assert.deepEqual(
    (await planOpen(probe("win32"), base("win32", "system"))).executable,
    "explorer.exe",
  );
  // Linux
  const lin = await planOpen(
    probe("linux", [], {}, { subl: "/usr/bin/subl" }),
    base("linux", "sublime"),
  );
  assert.deepEqual(
    [lin.executable, lin.args, lin.source],
    ["/usr/bin/subl", ["--", target("linux")], "path"],
  );
  assert.equal(
    (await planOpen(probe("linux"), base("linux", "vscode"))).executable,
    "code",
  );
  assert.deepEqual(
    (await planOpen(probe("linux"), base("linux", "system"))).args,
    [target("linux")],
  );
  assert.deepEqual(
    (await planOpen(probe("linux"), base("linux", "system", "reveal"))).args,
    ["/work/my project"],
  );
  assert.equal(
    (
      await planOpen(
        probe("linux"),
        base("linux", "system", "reveal", {}, true),
      )
    ).args[0],
    target("linux"),
  );
  // Custom application: requires a configured, absolute path; no `--` assumed.
  await assert.rejects(
    planOpen(probe("linux"), base("linux", "custom")),
    codeOf("editor_not_configured"),
  );
  await assert.rejects(
    planOpen(
      probe("linux"),
      base("linux", "sublime", "file", { sublime: "relative/subl" }),
    ),
    codeOf("invalid_editor_path"),
  );
  const custom = await planOpen(
    probe("linux"),
    base("linux", "custom", "with", { custom: "/opt/ed/ed" }),
  );
  assert.deepEqual(
    [custom.executable, custom.args],
    ["/opt/ed/ed", [target("linux")]],
  );
});
test("editor settings validate real executables; open uses configured path via argv (stub launcher)", async (t) => {
  const { base: dir, root, store, ws, agent } = await fixture(t);
  const stub = join(dir, "my editor.sh");
  await writeFile(join(root, "f.txt"), "x");
  await writeFile(
    stub,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/argv.txt"\n',
  );
  const launched: unknown[] = [];
  const svc = new EditorService(store, ws, {
    launcher: async (plan) => void launched.push(plan),
  });
  await assert.rejects(
    svc.save({ sublime: join(dir, "missing") }),
    codeOf("editor_not_found"),
  );
  await assert.rejects(
    svc.save({ sublime: "relative" }),
    codeOf("invalid_editor_path"),
  );
  if (process.platform !== "win32") {
    await assert.rejects(
      svc.save({ sublime: stub }),
      codeOf("editor_not_found"),
    ); // not executable
    await chmod(stub, 0o755);
  }
  const saved = await svc.save({ sublime: stub, custom: stub });
  assert.equal(saved.paths.sublime, stub);
  assert.equal(saved.detected.sublime.found, true);
  assert.equal((await svc.settings()).defaultEditor, "sublime"); // Sublime stays the default
  const plan = await svc.open(
    agent.id,
    { workspace: root, path: "f.txt" },
    false,
  );
  assert.equal(plan.executed, false);
  assert.equal(plan.executable, stub);
  assert.deepEqual(plan.args, ["--", join(root, "f.txt")]);
  assert.equal(launched.length, 0);
  const proj = await svc.open(
    agent.id,
    { workspace: root, action: "project" },
    true,
  );
  assert.equal(proj.action, "project");
  assert.equal((launched[0] as any).args[1], root);
  const withApp = await svc.open(
    agent.id,
    { workspace: root, path: "f.txt", action: "with", editor: "custom" },
    false,
  );
  assert.deepEqual(withApp.args, [join(root, "f.txt")]);
  await assert.rejects(
    svc.open(
      agent.id,
      { workspace: root, path: "f.txt", action: "with" },
      false,
    ),
    codeOf("editor_required"),
  );
  await assert.rejects(
    svc.open(agent.id, { workspace: root, path: "../x" }, false),
    codeOf("path_escape"),
  );
  await assert.rejects(
    svc.open(agent.id, { workspace: root, path: ".git/config" }, false),
    codeOf("git_internal"),
  );
  await mkdir(join(dir, "out"));
  await symlink(join(dir, "out"), join(root, "lnk"));
  await assert.rejects(
    svc.open(agent.id, { workspace: root, path: "lnk" }, false),
    codeOf("path_escape"),
  );
  await svc.save({ sublime: null });
  assert.equal((await svc.settings()).paths.sublime, undefined);
});
test("the real launcher starts the configured executable with literal arguments and reports failures", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell stub");
  const { base: dir, root, store, ws, agent } = await fixture(t);
  const stub = join(dir, "my editor.sh");
  await writeFile(join(root, "a file;$(touch pwned).txt"), "x");
  await writeFile(
    stub,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/argv.txt"\n',
  );
  await chmod(stub, 0o755);
  const svc = new EditorService(store, ws);
  await svc.save({ custom: stub });
  await svc.open(
    agent.id,
    {
      workspace: root,
      path: "a file;$(touch pwned).txt",
      action: "with",
      editor: "custom",
    },
    true,
  );
  assert.ok(await until(() => true));
  let argv = "";
  await until(() => {
    try {
      argv = execFileSync("cat", [join(dir, "argv.txt")], { encoding: "utf8" });
      return argv.length > 0;
    } catch {
      return false;
    }
  });
  assert.equal(argv.trim(), join(root, "a file;$(touch pwned).txt"));
  assert.throws(
    () => execFileSync("test", ["-e", join(root, "pwned")]),
    "no shell expansion happened",
  );
  // A missing executable surfaces a clear error.
  const plan = (executable: string) => ({
    executable,
    args: [],
    application: "custom" as const,
    source: "configured" as const,
  });
  await assert.rejects(
    launch(plan(join(dir, "does-not-exist"))),
    codeOf("app_unavailable"),
  );
  await assert.rejects(
    launch(plan("/usr/bin/false")),
    codeOf("app_unavailable"),
  );
});

// ---- watcher ------------------------------------------------------------------
test("watch events ignore Git internals and node_modules", () => {
  assert.equal(classifyEvent("node_modules/x/y.js"), null);
  assert.equal(classifyEvent(".git/objects/ab/cd"), null);
  assert.equal(classifyEvent(".git/index.lock"), null);
  assert.deepEqual(classifyEvent(".git/index"), { git: true });
  assert.deepEqual(classifyEvent(".git/refs/heads/main"), { git: true });
  assert.deepEqual(classifyEvent("src/a.ts"), { git: false });
  assert.deepEqual(classifyEvent(null), { git: false });
});
function fakeWatch() {
  const state: {
    listener?: (t: string, name: string | null) => void;
    closed: number;
    throws: boolean;
  } = {
    closed: 0,
    throws: false,
  };
  const watch: any = (_root: string, _o: unknown, listener: any) => {
    if (state.throws) throw new Error("ENOSPC");
    state.listener = listener;
    return { close: () => void state.closed++, on() {} };
  };
  return { state, watch };
}
test("a burst of events is debounced into one change; continuous writes still notify within the max wait", async () => {
  const { state, watch } = fakeWatch();
  const seen: any[] = [];
  const w = new WorkspaceWatcher({
    watch,
    debounceMs: 40,
    maxWaitMs: 250,
    onChange: (i) => seen.push(i),
  });
  assert.equal(w.subscribe("/r"), "watch");
  for (let i = 0; i < 100; i++) state.listener!("change", `src/f${i}.ts`);
  state.listener!("change", ".git/index");
  state.listener!("change", "node_modules/a.js");
  await sleep(150);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].git, true);
  assert.ok(seen[0].paths.length <= 20);
  assert.ok(!seen[0].paths.some((p: string) => p.includes("node_modules")));
  // Continuous activity (never quiet for 40 ms) cannot starve notifications.
  seen.length = 0;
  const end = Date.now() + 700;
  while (Date.now() < end) {
    state.listener!("change", "busy.txt");
    await sleep(15);
  }
  await sleep(100);
  assert.ok(seen.length >= 2 && seen.length <= 5, `got ${seen.length}`);
  w.close();
  assert.equal(state.closed, 1);
  state.listener!("change", "late.txt");
  await sleep(80);
  assert.ok(seen.length <= 5);
});
test("watcher falls back to a bounded poll, expires leases and caps watched roots", async () => {
  const { state, watch } = fakeWatch();
  state.throws = true;
  const seen: any[] = [];
  let value = "a";
  const w = new WorkspaceWatcher({
    watch,
    debounceMs: 10,
    pollMs: 25,
    maxRoots: 2,
    leaseMs: 600,
    fingerprint: async () => value,
    onChange: (i) => seen.push(i),
  });
  assert.equal(w.subscribe("/one"), "poll");
  await sleep(80);
  assert.equal(seen.length, 0); // baseline taken, nothing changed
  value = "b";
  assert.ok(await until(() => seen.length === 1, 1000));
  assert.equal(seen[0].mode, "poll");
  await sleep(120);
  assert.equal(seen.length, 1); // unchanged fingerprint: no more events
  assert.equal(w.subscribe("/two"), "poll");
  assert.equal(w.subscribe("/three"), "off"); // capped
  await sleep(650);
  w.expire();
  assert.deepEqual(w.list(), []); // leases lapsed without renewal
  w.close();
});
test("real fs.watch reports external edits (debounced) and WatchService publishes workspace.changed", async (t) => {
  const { root, store, ws, agent } = await fixture(t);
  const svc = new WatchService(store, ws, { debounceMs: 60, maxWaitMs: 500 });
  t.after(() => svc.close());
  const sub = await svc.subscribe(agent.id, { workspace: root });
  assert.ok(["watch", "poll"].includes(sub.mode), sub.mode);
  await sleep(200);
  for (let i = 0; i < 10; i++) await writeFile(join(root, `n${i}.txt`), "x");
  const got = () =>
    store.history(0, 100).filter((e) => e.type === "workspace.changed");
  assert.ok(await until(() => got().length >= 1, 8000), "no change event");
  await sleep(300);
  assert.ok(got().length <= 3, `events: ${got().length}`);
  assert.equal(got()[0].entityId, agent.id);
  assert.equal((got()[0].data as any).workspace, root);
  await svc.unsubscribe(agent.id, { workspace: root });
  assert.deepEqual(svc.watcher.list(), []);
  await assert.rejects(
    svc.subscribe(agent.id, { workspace: join(root, "..") }),
    codeOf("workspace_denied"),
  );
});

test("workspace.changed never names files the agent's exclusions hide", async (t) => {
  const { root, store, team, ws, agent } = await fixture(t);
  await mkdir(join(root, "secrets"));
  await team.saveAgent(
    {
      name: "Builder",
      environment: "codex",
      workspaces: [
        {
          path: root,
          access: "write",
          active: true,
          rules: [{ path: "secrets", access: "none" }],
        },
      ],
    },
    agent.id,
  );
  const svc = new WatchService(store, ws, { debounceMs: 60, maxWaitMs: 500 });
  t.after(() => svc.close());
  svc.subscribers.set(root, new Set([agent.id]));
  const fire = (paths: string[], git = false) =>
    svc.watcher.o.onChange({
      root,
      mode: "watch",
      paths,
      git,
      at: new Date().toISOString(),
    });
  const events = () =>
    store.history(0, 100).filter((e) => e.type === "workspace.changed");
  fire(["secrets/plan-acquisition.txt"]);
  assert.equal(
    events().length,
    0,
    "a change limited to excluded files emits nothing",
  );
  fire(["secrets/x.txt", "src/a.ts", "SECRETS/y.txt"]);
  assert.deepEqual((events()[0].data as any).paths, ["src/a.ts"]);
  assert.ok(
    !JSON.stringify(store.history(0, 100)).includes("plan-acquisition"),
  );
});

// ---- HTTP wiring ------------------------------------------------------------------
test("new workspace routes are authenticated and enforce folder boundaries", async (t) => {
  const { root, store, team, agent } = await fixture(t);
  void team;
  const server = createApi(
    team,
    "tok",
    new RunManager(team, false, process.cwd()),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (
    path: string,
    body: unknown = {},
    method = "POST",
    auth = true,
  ) =>
    fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: "Bearer tok" } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
  assert.equal(
    (
      await call(
        `/agents/${agent.id}/git/state`,
        { workspace: root },
        "POST",
        false,
      )
    ).status,
    401,
  );
  assert.equal((await call("/editors/settings", {}, "GET", false)).status, 401);
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  await writeFile(join(root, "n.json"), '{"x":1}');
  const state = await (
    await call(`/agents/${agent.id}/git/state`, { workspace: root })
  ).json();
  assert.equal(state.branch, "main");
  const view = await (
    await call(`/agents/${agent.id}/files/inspect`, {
      workspace: root,
      path: "n.json",
    })
  ).json();
  assert.equal(view.kind, "json");
  const escape = await call(`/agents/${agent.id}/files/inspect`, {
    workspace: root,
    path: "../x",
  });
  assert.equal(escape.status, 403);
  const denied = await call(`/agents/${agent.id}/git/state`, {
    workspace: "/tmp",
  });
  assert.equal(denied.status, 403);
  const plan = await (
    await call(`/agents/${agent.id}/files/open-plan`, {
      workspace: root,
      path: "n.json",
    })
  ).json();
  assert.equal(plan.executed, false);
  const settings = await (await call("/editors/settings", {}, "GET")).json();
  assert.equal(settings.defaultEditor, "sublime");
  const bad = await call("/editors/settings", { sublime: "relative" }, "PUT");
  assert.equal(bad.status, 400);
  const started = await (
    await call(`/agents/${agent.id}/watch/start`, { workspace: root })
  ).json();
  assert.ok(["watch", "poll"].includes(started.mode));
  await call(`/agents/${agent.id}/watch/stop`, { workspace: root });
  const mutating = await call(`/agents/${agent.id}/git/switch`, {
    workspace: root,
    branch: "--force",
  });
  assert.equal(mutating.status, 400);
  void store;
  void readFile;
});

test("watch-mode leases expire on events, flushes and the sweep (fake clock)", async () => {
  const { state, watch } = fakeWatch();
  let now = 1_000;
  const seen: any[] = [];
  const stopped: string[] = [];
  const w = new WorkspaceWatcher({
    watch,
    debounceMs: 10,
    leaseMs: 1_000,
    sweepMs: 20,
    now: () => now,
    onChange: (i) => seen.push(i),
    onStop: (root) => stopped.push(root),
  });
  assert.equal(w.subscribe("/r"), "watch");
  state.listener!("change", "a.txt");
  await sleep(40);
  assert.equal(seen.length, 1, "live lease delivers");
  // Lease lapses; the next event closes the watcher instead of notifying.
  now += 1_001;
  state.listener!("change", "b.txt");
  await sleep(40);
  assert.equal(seen.length, 1);
  assert.equal(state.closed, 1);
  assert.deepEqual(w.list(), []);
  assert.deepEqual(stopped, ["/r"]);
  // A pending flush whose lease lapses in the meantime is dropped too.
  assert.equal(w.subscribe("/s"), "watch");
  state.listener!("change", "c.txt");
  now += 5_000;
  await sleep(40);
  assert.equal(seen.length, 1);
  assert.deepEqual(w.list(), []);
  // A quiet folder is reclaimed by the sweep timer alone.
  assert.equal(w.subscribe("/quiet"), "watch");
  now += 5_000;
  assert.ok(await until(() => w.list().length === 0, 1000));
  assert.ok(stopped.includes("/quiet"));
  // Renewal keeps a lease alive.
  assert.equal(w.subscribe("/renewed"), "watch");
  now += 600;
  w.subscribe("/renewed");
  now += 600;
  await sleep(60);
  assert.deepEqual(
    w.list().map((e) => e.root),
    ["/renewed"],
  );
  w.close();
});

test("AGENTTEAM_TEST=1: editor, reveal and PR-open clicks are recorded, never launched", async (t) => {
  const { root, team, agent } = await fixture(t);
  const saved = process.env.AGENTTEAM_TEST;
  process.env.AGENTTEAM_TEST = "1";
  let server: ReturnType<typeof createApi>;
  try {
    server = createApi(team, "tok", new RunManager(team, false, process.cwd()));
  } finally {
    if (saved === undefined) delete process.env.AGENTTEAM_TEST;
    else process.env.AGENTTEAM_TEST = saved;
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(url + path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_COMMITTER_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
  await writeFile(join(root, "n.txt"), "x");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "first");
  git("switch", "-q", "-c", "feature");
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  const opened = await call(`/agents/${agent.id}/editors/open`, {
    workspace: root,
    path: "n.txt",
    action: "reveal",
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  const pr = await call(`/agents/${agent.id}/git/pr/open`, {
    workspace: root,
    base: "main",
  });
  assert.equal(pr.status, 200, JSON.stringify(pr.json));
  const recorded = (await call("/test/launches", undefined, "GET")).json
    .launches;
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].kind, "editor");
  // Reveal selects the file, except on Linux, where xdg-open opens its folder.
  const revealed = process.platform === "linux" ? basename(root) : "n.txt";
  assert.ok(recorded[0].args.some((a: string) => a.endsWith(revealed)));
  assert.deepEqual(recorded[1], {
    kind: "url",
    url: "https://github.com/acme/widgets/compare/main...feature?expand=1",
  });
  assert.equal(server.launches.length, 2);
  // Outside test mode the route does not exist.
  const plain = createApi(
    team,
    "tok2",
    new RunManager(team, false, process.cwd()),
  );
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  t.after(async () => {
    plain.closeAllConnections();
    await new Promise<void>((r) => plain.close(() => r()));
  });
  const res = await fetch(
    `http://127.0.0.1:${(plain.address() as any).port}/test/launches`,
    { headers: { authorization: "Bearer tok2" } },
  );
  assert.equal(res.status, 404);
});
