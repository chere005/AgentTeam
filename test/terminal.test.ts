import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TERMINALS,
  TerminalSessions,
  resolveShell,
  terminalEnv,
  type PtyLike,
  type SpawnPty,
  type TerminalData,
  type TerminalExit,
} from "../src/terminal.ts";
import { ensureSpawnHelper } from "../src/terminal-native.ts";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_THEME,
  contrast,
  sessionTitle,
  shellOwnsKey,
  terminalFolders,
  terminalKeyAction,
} from "../ui/terminal-theme.ts";

function fakePty() {
  const spawned: {
    file: string;
    args: string[];
    options: Parameters<SpawnPty>[2];
    pty: PtyLike & {
      written: string[];
      sizes: [number, number][];
      killed: (string | undefined)[];
      emit: (data: string) => void;
      exit: (code: number) => void;
    };
  }[] = [];
  const spawn: SpawnPty = (file, args, options) => {
    let onData = (_: string) => {},
      onExit = (_: { exitCode: number; signal?: number }) => {};
    const pty = {
      pid: 1000 + spawned.length,
      written: [] as string[],
      sizes: [] as [number, number][],
      killed: [] as (string | undefined)[],
      onData: (l: (d: string) => void) => ((onData = l), { dispose() {} }),
      onExit: (l: typeof onExit) => ((onExit = l), { dispose() {} }),
      write: (d: string) => void pty.written.push(d),
      resize: (c: number, r: number) => void pty.sizes.push([c, r]),
      kill: (s?: string) => void pty.killed.push(s),
      emit: (d: string) => onData(d),
      exit: (code: number) => onExit({ exitCode: code }),
    };
    spawned.push({ file, args, options, pty });
    return pty;
  };
  return { spawn, spawned };
}
function sessions(
  extra: Partial<ConstructorParameters<typeof TerminalSessions>[0]> = {},
) {
  const fake = fakePty();
  const data: TerminalData[] = [],
    exits: TerminalExit[] = [];
  const s = new TerminalSessions({
    spawn: fake.spawn,
    home: "/home/u",
    folders: () => ["/work/repo", "/work/other/"],
    onData: (e) => void data.push(e),
    onExit: (e) => void exits.push(e),
    shell: () => ({ file: "/bin/zsh", args: ["-l"] }),
    isDirectory: () => true,
    platform: "linux",
    env: {
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      AGENTTEAM_DATA_DIR: "/x",
      HOME: "/home/u",
    },
    ...extra,
  });
  return { s, ...fake, data, exits };
}

test("terminal create: home by default, only known folders, validated size and options", () => {
  const { s, spawned } = sessions();
  const home = s.create({ cols: 100, rows: 30 });
  assert.match(home.id, /^[a-f0-9]{16}$/);
  assert.equal(home.cwd, "/home/u");
  assert.equal(home.shell, "/bin/zsh");
  assert.deepEqual(spawned[0].args, ["-l"]);
  assert.equal(spawned[0].options.cols, 100);
  assert.equal(spawned[0].options.env.TERM, "xterm-256color");
  assert.equal(spawned[0].options.env.COLORTERM, "truecolor");
  assert.equal(spawned[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawned[0].options.env.AGENTTEAM_DATA_DIR, undefined);
  assert.equal(s.create({ cwd: "/work/repo" }).cwd, "/work/repo");
  // Trailing separators and `..` normalise to the known folder.
  assert.equal(s.create({ cwd: "/work/other" }).cwd, "/work/other/");
  assert.equal(s.create({ cwd: "/work/x/../repo" }).cwd, "/work/repo");
  for (const bad of [
    { cwd: "/etc" },
    { cwd: "relative/path" },
    { cwd: 42 },
    { cwd: "/work/repo\0" },
    { cols: 1 },
    { rows: 0 },
    { cols: 80.5 },
    { cols: "80" },
    { shell: "/bin/sh" },
    { file: "/usr/bin/python3" },
  ])
    assert.throws(() => s.create(bad), JSON.stringify(bad));
  assert.equal(spawned.length, 4);
});

test("terminal create refuses a known folder that no longer exists, and caps sessions", () => {
  const gone = sessions({ isDirectory: (p) => p !== "/work/repo" });
  assert.throws(() => gone.s.create({ cwd: "/work/repo" }), /no longer exists/);
  const { s } = sessions();
  for (let i = 0; i < MAX_TERMINALS; i++) s.create({});
  assert.throws(() => s.create({}), /At most/);
});

test("terminal write/resize/kill validate ids and arguments; output is batched; exit is reported", async () => {
  const { s, spawned, data, exits } = sessions();
  const { id } = s.create({});
  const pty = spawned[0].pty;
  s.write(id, "echo hi\r");
  assert.deepEqual(pty.written, ["echo hi\r"]);
  assert.throws(() => s.write(id, 5));
  assert.throws(() => s.write(id, "x".repeat(1_000_001)));
  assert.throws(() => s.write("nope", "x"), /Invalid terminal id/);
  assert.throws(() => s.write("0123456789abcdef", "x"), /ended/);
  s.resize(id, 120, 40);
  assert.deepEqual(pty.sizes, [[120, 40]]);
  assert.throws(() => s.resize(id, 0, 40));
  assert.throws(() => s.resize(id, 120, 9999));
  pty.emit("a");
  pty.emit("b");
  assert.equal(data.length, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(data, [{ id, data: "ab" }]);
  pty.emit("tail");
  pty.exit(3);
  assert.deepEqual(data.at(-1), { id, data: "tail" });
  assert.deepEqual(exits, [{ id, exitCode: 3, signal: null }]);
  assert.equal(s.size, 0);
  assert.throws(() => s.kill(id), /ended/);
});

test("terminal killAll ends every PTY (window close, quit)", () => {
  const { s, spawned } = sessions();
  s.create({});
  const second = s.create({});
  s.kill(second.id);
  assert.equal(spawned[1].pty.killed.length, 1);
  s.create({});
  s.killAll();
  assert.equal(s.size, 0);
  assert.equal(spawned[0].pty.killed.length, 1);
  assert.equal(spawned[2].pty.killed.length, 1);
});

test("resolveShell: validated $SHELL as a login shell, else the platform default", () => {
  const fs = (ok: string[], shells: string[] | null = null) => ({
    executable: (p: string) => ok.includes(p),
    shells: () => shells,
  });
  assert.deepEqual(
    resolveShell({ SHELL: "/usr/bin/fish" }, "linux", fs(["/usr/bin/fish"])),
    {
      file: "/usr/bin/fish",
      args: ["-l"],
    },
  );
  // Not listed in /etc/shells, relative, or missing: fall back.
  assert.equal(
    resolveShell(
      { SHELL: "/tmp/evil" },
      "darwin",
      fs(["/tmp/evil", "/bin/zsh"], ["/bin/zsh"]),
    ).file,
    "/bin/zsh",
  );
  assert.equal(
    resolveShell({ SHELL: "zsh" }, "darwin", fs(["zsh", "/bin/zsh"])).file,
    "/bin/zsh",
  );
  assert.equal(resolveShell({}, "linux", fs(["/bin/bash"])).file, "/bin/bash");
  assert.deepEqual(resolveShell({}, "linux", fs([])), {
    file: "/bin/sh",
    args: [],
  });
  const win = resolveShell(
    { SystemRoot: "C:\\Windows", SHELL: "/bin/bash" },
    "win32",
    fs(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]),
  );
  assert.match(win.file, /powershell\.exe$/);
  assert.equal(
    resolveShell({ ComSpec: "C:\\Windows\\cmd.exe" }, "win32", fs([])).file,
    "C:\\Windows\\cmd.exe",
  );
});

test("terminalEnv drops Electron/AgentTeam switches and advertises truecolor", () => {
  const env = terminalEnv({
    PATH: "/bin",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--inspect",
    AGENTTEAM_TEST: "1",
    npm_lifecycle_event: "start",
    TERM: "dumb",
  });
  assert.equal(env.PATH, "/bin");
  for (const k of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "AGENTTEAM_TEST",
    "npm_lifecycle_event",
  ])
    assert.equal(env[k], undefined, k);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
});

test(
  "a real PTY (node-pty) runs the shell in the chosen folder and reports its output",
  { skip: process.platform === "win32" },
  async () => {
    const require = createRequire(import.meta.url);
    const pty = require("node-pty") as typeof import("node-pty");
    ensureSpawnHelper(require.resolve("node-pty"));
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "agentteam-pty-")));
    try {
      let out = "";
      let exited: TerminalExit | null = null;
      const s = new TerminalSessions({
        spawn: (file, args, options) => pty.spawn(file, args, options),
        home: dir,
        folders: () => [],
        onData: (e) => void (out += e.data),
        onExit: (e) => void (exited = e),
        shell: () => ({ file: "/bin/sh", args: [] }),
      });
      const { id } = s.create({ cols: 80, rows: 24 });
      s.write(id, "echo agentteam-$((40+2)); pwd; exit 7\r");
      const deadline = Date.now() + 10_000;
      while (!exited && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      assert.match(out, /agentteam-42/);
      assert.ok(out.includes(dir), out);
      assert.deepEqual(exited, { id, exitCode: 7, signal: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("terminal UI helpers: folders, titles, key routing, theme contrast", () => {
  const folders = terminalFolders(
    {
      agents: [
        {
          name: "Alpha",
          nickname: "",
          workspaces: [{ path: "/w/repo" }, { path: "/w/docs" }],
        },
        { name: "Beta", nickname: "B", workspaces: [{ path: "/w/repo" }] },
      ] as any,
    },
    "/w/repo",
  );
  assert.deepEqual(folders, [
    { path: null, label: "Home folder" },
    { path: "/w/repo", label: "Current project: repo" },
    { path: "/w/docs", label: "Alpha: docs" },
  ]);
  assert.equal(sessionTitle("/u", true, []), "~");
  assert.equal(
    sessionTitle("/w/repo", false, ["repo", "repo (2)"]),
    "repo (3)",
  );
  const key = (
    k: string,
    m: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>>,
  ) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...m,
  });
  assert.equal(terminalKeyAction(key("f", { metaKey: true }), true), "search");
  assert.equal(terminalKeyAction(key("f", { ctrlKey: true }), true), "pass");
  assert.equal(terminalKeyAction(key("f", { ctrlKey: true }), false), "search");
  assert.equal(
    terminalKeyAction(key("C", { ctrlKey: true, shiftKey: true }), false),
    "copy",
  );
  assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), false), "pass");
  assert.equal(
    terminalKeyAction(key("V", { ctrlKey: true, shiftKey: true }), false),
    "paste",
  );
  assert.equal(shellOwnsKey(key("k", { ctrlKey: true })), true);
  assert.equal(shellOwnsKey(key("k", { metaKey: true })), false);
  assert.equal(
    shellOwnsKey(key("P", { ctrlKey: true, shiftKey: true })),
    false,
  );
  assert.match(
    TERMINAL_FONT_FAMILY,
    /^"JetBrainsMono Nerd Font".*"MesloLGS NF".*"Fira Code".*Menlo.*monospace$/,
  );
  assert.ok(
    contrast(TERMINAL_THEME.foreground, TERMINAL_THEME.background) >= 7,
  );
  for (const c of [
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "brightBlack",
  ] as const)
    assert.ok(contrast(TERMINAL_THEME[c], TERMINAL_THEME.background) >= 3.5, c);
});
