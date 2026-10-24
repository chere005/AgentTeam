/**
 * Terminal tab sessions (desktop main process). Each session is the user's own interactive
 * login shell in a pseudo-terminal (node-pty), with the user's permissions: it is outside
 * AgentTeam's agent locks, leases and filesystem policy. The renderer never names an
 * executable: the shell comes from $SHELL (validated) or the platform default, and the working
 * folder must be the home folder or a folder attached to an agent or project.
 */
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, normalize, resolve } from "node:path";

/** The subset of node-pty's IPty the sessions use (lets tests inject a fake). */
export type PtyLike = {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};
export type SpawnPty = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyLike;

export type TerminalInfo = {
  id: string;
  shell: string;
  cwd: string;
  pid: number;
};
export type TerminalData = { id: string; data: string };
export type TerminalExit = {
  id: string;
  exitCode: number;
  signal: number | null;
};

export const MAX_TERMINALS = 12;
/** Largest single write (a paste); larger pastes are refused rather than truncated. */
export const MAX_WRITE_BYTES = 1_000_000;
const ID = /^[a-f0-9]{16}$/;

export class TerminalError extends Error {}

function isExecutable(path: string) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shell to start: $SHELL when it is an absolute, executable file (and listed in
 * /etc/shells where that file exists), else the platform default. Unix shells start as login
 * shells so a Finder-launched app still gets the user's PATH and prompt.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fs: {
    executable: (path: string) => boolean;
    shells: () => string[] | null;
  } = {
    executable: isExecutable,
    shells: () => {
      try {
        return readFileSync("/etc/shells", "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"));
      } catch {
        return null;
      }
    },
  },
): { file: string; args: string[] } {
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const powershell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (fs.executable(powershell))
      return { file: powershell, args: ["-NoLogo"] };
    return { file: env.ComSpec ?? `${root}\\System32\\cmd.exe`, args: [] };
  }
  const wanted = env.SHELL;
  const listed = fs.shells();
  if (
    wanted &&
    isAbsolute(wanted) &&
    !/[\0\n]/.test(wanted) &&
    fs.executable(wanted) &&
    (!listed || listed.includes(wanted))
  )
    return { file: wanted, args: loginArgs(wanted) };
  for (const file of platform === "darwin"
    ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
    : ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"])
    if (fs.executable(file)) return { file, args: loginArgs(file) };
  return { file: "/bin/sh", args: [] };
}
function loginArgs(shell: string) {
  return ["bash", "zsh", "fish", "ksh", "sh", "dash", "tcsh", "csh"].includes(
    basename(shell),
  )
    ? ["-l"]
    : [];
}

/**
 * The shell's environment: the app's own minus Electron/Node switches that would change how
 * child tools behave and AgentTeam's internal settings, plus truecolor terminal capabilities.
 */
export function terminalEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(ELECTRON_|AGENTTEAM_|npm_|CHROME_)/i.test(key)) continue;
    if (
      /^(NODE_OPTIONS|NODE_CHANNEL_FD|NODE_UNIQUE_ID|ORIGINAL_XDG_CURRENT_DESKTOP)$/i.test(
        key,
      )
    )
      continue;
    out[key] = value;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.TERM_PROGRAM = "AgentTeam";
  if (!out.LANG && process.platform !== "win32") out.LANG = "en_US.UTF-8";
  return out;
}

const integer = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
export const validCols = (v: unknown): v is number => integer(v, 2, 1000);
export const validRows = (v: unknown): v is number => integer(v, 1, 500);

/** Normalised comparison key (case-insensitive on Windows/macOS default volumes). */
function key(path: string, platform: NodeJS.Platform) {
  const p = normalize(resolve(path)).replace(/[\\/]+$/, "") || "/";
  return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

export type TerminalOptions = {
  spawn: SpawnPty;
  home: string;
  /** Folders a terminal may start in besides home (agent and project workspaces). */
  folders: () => string[];
  onData: (event: TerminalData) => void;
  onExit: (event: TerminalExit) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  shell?: () => { file: string; args: string[] };
  isDirectory?: (path: string) => boolean;
};

export class TerminalSessions {
  private sessions = new Map<
    string,
    {
      pty: PtyLike;
      buffer: string;
      timer: ReturnType<typeof setTimeout> | null;
      info: TerminalInfo;
    }
  >();
  private options: TerminalOptions;
  constructor(options: TerminalOptions) {
    this.options = options;
  }
  get size() {
    return this.sessions.size;
  }
  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }
  /** The validated working folder: null/omitted = home; anything else must be a known folder. */
  private folder(cwd: unknown) {
    const platform = this.options.platform ?? process.platform;
    if (cwd === undefined || cwd === null || cwd === "")
      return this.options.home;
    if (
      typeof cwd !== "string" ||
      cwd.length > 4096 ||
      cwd.includes("\0") ||
      !isAbsolute(cwd)
    )
      throw new TerminalError("Invalid terminal folder");
    const wanted = key(cwd, platform);
    const known = [this.options.home, ...this.options.folders()].find(
      (f) =>
        typeof f === "string" && isAbsolute(f) && key(f, platform) === wanted,
    );
    if (!known)
      throw new TerminalError(
        "A terminal can only start in your home folder or a folder attached to an agent or project",
      );
    const isDirectory =
      this.options.isDirectory ??
      ((p: string) => {
        try {
          return existsSync(p) && statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    if (!isDirectory(known))
      throw new TerminalError("That folder no longer exists");
    return known;
  }
  create(input: unknown): TerminalInfo {
    const v = (input && typeof input === "object" ? input : {}) as Record<
      string,
      unknown
    >;
    for (const k of Object.keys(v))
      if (!["cwd", "cols", "rows"].includes(k))
        throw new TerminalError("Invalid terminal options");
    const cols = v.cols ?? 80,
      rows = v.rows ?? 24;
    if (!validCols(cols) || !validRows(rows))
      throw new TerminalError("Invalid terminal size");
    if (this.sessions.size >= MAX_TERMINALS)
      throw new TerminalError(`At most ${MAX_TERMINALS} terminals can be open`);
    const cwd = this.folder(v.cwd);
    const shell = (
      this.options.shell ?? (() => resolveShell(this.options.env))
    )();
    const id = randomBytes(8).toString("hex");
    const pty = this.options.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnv(this.options.env),
    });
    const info: TerminalInfo = { id, shell: shell.file, cwd, pid: pty.pid };
    const session = {
      pty,
      buffer: "",
      timer: null as ReturnType<typeof setTimeout> | null,
      info,
    };
    this.sessions.set(id, session);
    // Coalesce output into ~one IPC message per frame; flush early on large bursts.
    const flush = () => {
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      if (!session.buffer) return;
      const data = session.buffer;
      session.buffer = "";
      this.options.onData({ id, data });
    };
    pty.onData((data) => {
      session.buffer += data;
      if (session.buffer.length > 128_000) flush();
      else if (!session.timer) session.timer = setTimeout(flush, 8);
    });
    pty.onExit(({ exitCode, signal }) => {
      flush();
      this.sessions.delete(id);
      this.options.onExit({ id, exitCode, signal: signal ? signal : null });
    });
    return info;
  }
  private get(id: unknown) {
    if (typeof id !== "string" || !ID.test(id))
      throw new TerminalError("Invalid terminal id");
    const session = this.sessions.get(id);
    if (!session) throw new TerminalError("That terminal has ended");
    return session;
  }
  write(id: unknown, data: unknown) {
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") > MAX_WRITE_BYTES
    )
      throw new TerminalError("Invalid terminal input");
    this.get(id).pty.write(data);
  }
  resize(id: unknown, cols: unknown, rows: unknown) {
    if (!validCols(cols) || !validRows(rows))
      throw new TerminalError("Invalid terminal size");
    this.get(id).pty.resize(cols, rows);
  }
  kill(id: unknown) {
    const session = this.get(id);
    this.end(id as string, session);
  }
  private end(
    id: string,
    session: { pty: PtyLike; timer: ReturnType<typeof setTimeout> | null },
  ) {
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(id);
    try {
      // SIGHUP is what a closing terminal window sends; the shell passes it to its jobs.
      session.pty.kill(process.platform === "win32" ? undefined : "SIGHUP");
    } catch {
      /* already gone */
    }
  }
  /** Ends every session (window closed, app quitting). */
  killAll() {
    for (const [id, session] of [...this.sessions]) this.end(id, session);
  }
}
