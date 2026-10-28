// Real folder access, not just grants.
//
// A grant says which folders a role may use. It does not say the operating system lets AgentTeam,
// and the programs AgentTeam starts, touch them. On macOS ~/Desktop, ~/Documents, ~/Downloads,
// removable and network volumes and iCloud Drive are protected per application ("Files and
// Folders"): until the user allows AgentTeam, every read and write by the app AND by every process
// it spawns (the providers, their sandboxed shells) fails with EPERM, and a refused prompt is
// remembered for that build. Nothing in the readiness evaluator could see this, so a launch with
// valid grants spent provider calls on workers that could not write one byte.
//
// This module asks the system instead of assuming. `probeFolderAccess` resolves the folder, lists
// it (on macOS this is what raises the system prompt for a protected folder) and, when writing is
// needed, creates, reads back and removes a uniquely named directory inside it, first from this
// process and then from a child shell, because the workers are children. `FolderAccess` keeps the
// results (short TTL for fresh answers, a known failure stays until it is probed again), shares
// probes that are already running, and is the one place readiness (src/launch-readiness.ts),
// project setup (src/project-setup.ts), Start, Recovery and the CLI (`folder-probe`) read from, so
// they agree about the same folder.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  mkdir,
  opendir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from "node:path";
import { canonicalPolicyPath } from "./filesystem-policy.ts";
import { AppError } from "./model.ts";
import type { Store } from "./store.ts";

export const FOLDER_PROBE_CODES = [
  "folder-denied",
  "folder-missing",
  "folder-not-directory",
  "folder-read-only",
  /** The platform cannot run the check (for example no shell to start); never read as "fine". */
  "probe-unavailable",
] as const;
export type FolderProbeCode = (typeof FOLDER_PROBE_CODES)[number];

export type FolderProbeSuccess = {
  ok: true;
  /** The canonical folder that was checked. */
  path: string;
  write: boolean;
  checkedAt: string;
  /** Which macOS-protected location contains it (Desktop, Documents, ...), else null. */
  protectedFolder: string | null;
  /** The steps that passed, in order (app process first, then the child shell). */
  steps: string[];
};
export type FolderProbeFailure = {
  ok: false;
  code: FolderProbeCode;
  /** The operating-system error code (EPERM, EACCES, EROFS, ENOENT, ...). */
  errno: string;
  /** The operation that failed (realpath, stat, readdir, mkdir, write, read, remove). */
  operation: string;
  /** Who was refused: AgentTeam itself or a program it starts. */
  actor: "app" | "child";
  /** Names the folder, the operation and the errno. */
  message: string;
  /** What the person can do about it. */
  fix: string;
  path: string;
  write: boolean;
  checkedAt: string;
  protectedFolder: string | null;
  steps: string[];
};
export type FolderProbeResult = FolderProbeSuccess | FolderProbeFailure;

/** The fix text for a macOS-protected folder that the system has not opened to AgentTeam. */
export const MACOS_FOLDER_FIX =
  "macOS has not allowed AgentTeam to access this folder. Open System Settings → Privacy & Security → Files and Folders → AgentTeam and enable it, then retry; or choose a folder outside Desktop, Documents and Downloads.";

type Platform = NodeJS.Platform;
const PROTECTED_IN_HOME: [string, string][] = [
  ["Desktop", "Desktop"],
  ["Documents", "Documents"],
  ["Downloads", "Downloads"],
  ["Library/Mobile Documents", "iCloud Drive"],
  ["Library/CloudStorage", "cloud storage"],
];

/**
 * The macOS-protected location that contains `path` (compared without regard to case, as the file
 * system is): Desktop, Documents and Downloads in the home folder, iCloud Drive and other cloud
 * folders, and anything under /Volumes (removable and network disks). Null elsewhere and on every
 * other platform.
 */
export function protectedFolderName(
  path: string,
  options: { platform?: Platform; home?: string } = {},
): string | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const lower = (value: string) =>
    posix.normalize(value).replace(/\/+$/, "").toLowerCase();
  const home = options.home ?? homedir();
  const target = lower(path);
  const within = (root: string) =>
    target === root || target.startsWith(root + "/");
  for (const [sub, label] of PROTECTED_IN_HOME)
    if (within(lower(posix.join(home, sub)))) return label;
  if (within("/volumes")) return "an external or network volume";
  return null;
}

const ERRNO_TEXT: Record<string, string> = {
  EPERM: "operation not permitted",
  EACCES: "permission denied",
  EROFS: "read-only file system",
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  ETIMEDOUT: "no answer in time",
};
const codeOfErrno = (errno: string): FolderProbeCode =>
  errno === "ENOENT"
    ? "folder-missing"
    : errno === "ENOTDIR"
      ? "folder-not-directory"
      : errno === "EROFS"
        ? "folder-read-only"
        : "folder-denied";

type FailureInput = {
  errno: string;
  operation: string;
  actor?: "app" | "child";
  /** The shell a child check used (named in the message). */
  shell?: string;
  code?: FolderProbeCode;
  detail?: string;
};
/** Build a failure; the macOS advice applies only to permission-class errors in a protected place. */
function failureOf(
  base: {
    path: string;
    write: boolean;
    checkedAt: string;
    protectedFolder: string | null;
    steps: string[];
  },
  input: FailureInput,
): FolderProbeFailure {
  const actor = input.actor ?? "app";
  const code = input.code ?? codeOfErrno(input.errno);
  const who =
    actor === "child"
      ? `A program AgentTeam starts (${input.shell ?? "a shell"})`
      : "AgentTeam";
  const text = ERRNO_TEXT[input.errno] ?? input.detail ?? "failed";
  const verb = base.write ? "write in" : "read";
  let message: string;
  let fix: string;
  switch (code) {
    case "folder-missing":
      message = `The folder ${base.path} does not exist (${input.errno} on ${input.operation}).`;
      fix = "Create the folder, or choose a folder that exists.";
      break;
    case "folder-not-directory":
      message = `${base.path} is not a folder (${input.errno} on ${input.operation}).`;
      fix = "Choose a folder, not a file.";
      break;
    case "probe-unavailable":
      message = `AgentTeam could not run the access check for ${base.path} (${input.errno} on ${input.operation}).`;
      fix = `Make sure ${input.shell ?? "the system shell"} exists and can start, or choose another folder.`;
      break;
    default:
      message = `${who} got ${input.errno} (${text}) on ${input.operation} in ${base.path}.`;
      fix =
        code === "folder-denied" &&
        base.protectedFolder &&
        ["EPERM", "EACCES", "ETIMEDOUT"].includes(input.errno)
          ? MACOS_FOLDER_FIX
          : `AgentTeam cannot ${verb} ${base.path} (${input.errno} on ${input.operation}). Check the folder's permissions or choose another folder.`;
  }
  return {
    ok: false,
    code,
    errno: input.errno,
    operation: input.operation,
    actor,
    message,
    fix,
    ...base,
  };
}

// ---- the child check ------------------------------------------------------------------------

export type ChildOutcome = {
  code: number | null;
  stderr: string;
  /** The process could not be started at all. */
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
};
export type ChildRunner = (
  program: string,
  args: string[],
  options: { timeoutMs: number; verbatim?: boolean },
) => Promise<ChildOutcome>;

const runChild: ChildRunner = (program, args, options) =>
  new Promise((resolveOutcome) => {
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveOutcome(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim,
        // The check needs only the system tools; the app's environment (tokens) is not passed on.
        env: {
          PATH:
            process.platform === "win32"
              ? (process.env.PATH ?? "")
              : "/usr/bin:/bin:/usr/sbin:/sbin",
          ...(process.platform === "win32" && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          LC_ALL: "C",
        },
      });
    } catch (error) {
      finish({ code: null, stderr, error: error as NodeJS.ErrnoException });
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stderr, timedOut: true });
    }, options.timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    child.on("error", (error) =>
      finish({ code: null, stderr, error: error as NodeJS.ErrnoException }),
    );
    child.on("close", (code) => finish({ code, stderr }));
  });

/** The OS error a shell's message names (`mkdir: x: Operation not permitted`), when it names one. */
function errnoFromShell(stderr: string) {
  if (/operation not permitted/i.test(stderr)) return "EPERM";
  if (/permission denied|access is denied/i.test(stderr)) return "EACCES";
  if (/read-only file system|write.protected/i.test(stderr)) return "EROFS";
  if (/not a directory|directory name is invalid/i.test(stderr))
    return "ENOTDIR";
  if (/no such file|cannot find the path/i.test(stderr)) return "ENOENT";
  return null;
}

export type ProbeDeps = {
  platform?: Platform;
  home?: string;
  now?: () => Date;
  /** Test seams: file system calls, the child runner and the probe names. */
  fs?: Partial<{
    realpath: typeof realpath;
    stat: typeof stat;
    opendir: typeof opendir;
    mkdir: typeof mkdir;
    writeFile: typeof writeFile;
    readFile: typeof readFile;
    rm: typeof rm;
  }>;
  runChild?: ChildRunner;
  token?: () => string;
  childTimeoutMs?: number;
};

/**
 * Check, with the system's own answers, that `path` can be read (and, with `write`, written) by
 * this process and by a program this process starts. It never leaves anything behind: the probe
 * directory is removed even when a step fails, and a removal failure is itself reported.
 */
export async function probeFolderAccess(
  path: string,
  options: { write?: boolean } & ProbeDeps = {},
): Promise<FolderProbeResult> {
  const write = options.write === true;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const fs = {
    realpath,
    stat,
    opendir,
    mkdir,
    writeFile,
    readFile,
    rm,
    ...options.fs,
  };
  const token = options.token ?? (() => randomBytes(6).toString("hex"));
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const steps: string[] = [];
  let real = path;
  const base = () => ({
    path: real,
    write,
    checkedAt,
    protectedFolder:
      protectedFolderName(real, { platform, home }) ??
      protectedFolderName(path, { platform, home }),
    steps: [...steps],
  });
  const fail = (
    operation: string,
    error: unknown,
    extra: Partial<FailureInput> = {},
  ) =>
    failureOf(base(), {
      errno: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN",
      operation,
      detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
      ...extra,
    });

  if (!isAbsolute(path))
    return failureOf(base(), {
      errno: "EINVAL",
      operation: "realpath",
      code: "folder-missing",
    });
  // (a) the folder itself
  try {
    real = await fs.realpath(path);
  } catch (error) {
    return fail("realpath", error);
  }
  steps.push("realpath");
  try {
    if (!(await fs.stat(real)).isDirectory())
      return failureOf(base(), { errno: "ENOTDIR", operation: "stat" });
  } catch (error) {
    return fail("stat", error);
  }
  steps.push("stat");
  // (b) list it. On macOS the first listing of a protected folder is what raises the system prompt
  // when this app is the responsible process, and it fails with EPERM when the prompt was refused.
  try {
    const directory = await fs.opendir(real);
    try {
      await directory.read();
    } finally {
      await directory.close().catch(() => {});
    }
  } catch (error) {
    return fail("readdir", error);
  }
  steps.push("readdir");
  // (c) create, write, read back and remove a uniquely named directory
  if (write) {
    const dir = join(real, `.agentteam-probe-${token()}`);
    const marker = `agentteam folder probe ${token()}`;
    let step = "mkdir";
    let created = false;
    let failure: FolderProbeFailure | null = null;
    try {
      await fs.mkdir(dir);
      created = true;
      step = "write";
      await fs.writeFile(join(dir, "probe.txt"), marker);
      step = "read";
      const back = await fs.readFile(join(dir, "probe.txt"), "utf8");
      if (back !== marker)
        failure = fail("read", new Error("read back a different content"), {
          errno: "EIO",
        });
    } catch (error) {
      failure = fail(step, error);
    }
    if (created)
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        failure ??= fail("remove", error);
      }
    if (failure) return failure;
    steps.push("mkdir", "write", "read", "remove");
  }
  // (d) the same through a child shell: the providers' workers are children of this process
  const child = await childCheck(real, write, token, {
    platform,
    run: options.runChild ?? runChild,
    timeoutMs: options.childTimeoutMs ?? 15_000,
  });
  if (child.kind === "failed") {
    // A child that made the directory but could not remove it leaves it behind: clean up from here.
    if (write && child.dir)
      await fs.rm(child.dir, { recursive: true, force: true }).catch(() => {});
    return failureOf(base(), {
      errno: child.errno,
      operation: child.operation,
      actor: "child",
      shell: child.shell,
      code: child.code,
      detail: child.detail,
    });
  }
  if (child.kind === "ok") steps.push("child");
  return {
    ok: true,
    path: real,
    write,
    checkedAt,
    protectedFolder: base().protectedFolder,
    steps,
  };
}

type ChildCheck =
  | { kind: "ok" }
  | { kind: "skipped" }
  | {
      kind: "failed";
      errno: string;
      operation: string;
      shell: string;
      /** The directory the child was asked to make (to remove it again when the child could not). */
      dir: string;
      code?: FolderProbeCode;
      detail?: string;
    };
async function childCheck(
  folder: string,
  write: boolean,
  token: () => string,
  context: { platform: Platform; run: ChildRunner; timeoutMs: number },
): Promise<ChildCheck> {
  const windows = context.platform === "win32";
  const dir = join(folder, `.agentteam-probe-${token()}`);
  let program: string;
  let args: string[];
  let verbatim = false;
  let shell: string;
  if (windows) {
    // cmd.exe expands %VAR% even inside quotes; a folder named like that cannot be checked safely.
    if (/[%"^!]/.test(folder)) return { kind: "skipped" };
    program = process.env.ComSpec || "cmd.exe";
    shell = "cmd.exe";
    verbatim = true;
    args = [
      "/d",
      "/s",
      "/c",
      write ? `"mkdir "${dir}" && rmdir "${dir}""` : `"dir "${folder}" > nul"`,
    ];
  } else {
    program = "/bin/sh";
    shell = "/bin/sh";
    args = write
      ? [
          "-c",
          'mkdir -- "$1" && : > "$1/probe.txt" && rm -f -- "$1/probe.txt" && rmdir -- "$1"',
          "sh",
          dir,
        ]
      : ["-c", 'ls -1 -- "$1" > /dev/null', "sh", folder];
  }
  const operation = write ? "mkdir" : "readdir";
  const outcome = await context.run(program, args, {
    timeoutMs: context.timeoutMs,
    verbatim,
  });
  if (outcome.error)
    return {
      kind: "failed",
      errno: outcome.error.code ?? "ENOENT",
      operation: `spawn ${program}`,
      shell,
      dir,
      code: "probe-unavailable",
      detail: outcome.error.message,
    };
  if (outcome.timedOut)
    return {
      kind: "failed",
      errno: "ETIMEDOUT",
      operation,
      shell,
      dir,
      detail: "the child check did not finish",
    };
  if (outcome.code === 0) return { kind: "ok" };
  return {
    kind: "failed",
    errno: errnoFromShell(outcome.stderr) ?? `EXIT${outcome.code}`,
    operation,
    shell,
    dir,
    detail: outcome.stderr.trim().slice(0, 200) || `exit ${outcome.code}`,
  };
}

// ---- the cache, shared by every launch path ---------------------------------------------------

export type ProbeFn = (
  path: string,
  options: { write: boolean },
) => Promise<FolderProbeResult>;
/** What readiness reads: the last answer for a folder, or undefined when it was never asked. */
export type FolderLookup = (
  path: string,
  write: boolean,
) => FolderProbeResult | undefined;

type Entry = { result: FolderProbeResult; at: number; provisional: boolean };

/**
 * Test seam (AGENTTEAM_TEST=1 only): `AGENTTEAM_TEST_FOLDER_DENY` lists folders (separated like
 * PATH) that the probe reports as refused by macOS folder privacy, on every platform, so the setup
 * card's blocker text can be exercised without a protected folder. Anything outside the list is
 * probed for real.
 */
function injectedDenials() {
  if (process.env.AGENTTEAM_TEST !== "1") return [];
  return (process.env.AGENTTEAM_TEST_FOLDER_DENY ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((path) => canonicalPolicyPath(path));
}
/** The answer macOS folder privacy gives for a protected folder AgentTeam was not allowed to use. */
export function macosRefusal(path: string, write: boolean): FolderProbeFailure {
  return failureOf(
    {
      path,
      write,
      checkedAt: new Date().toISOString(),
      protectedFolder: "Desktop",
      steps: ["realpath", "stat"],
    },
    { errno: "EPERM", operation: "readdir" },
  );
}
export function withInjectedDenials(next: ProbeFn): ProbeFn {
  return async (path, options) => {
    const denied = injectedDenials();
    if (denied.length) {
      const target = canonicalPolicyPath(path);
      const hit = denied.find((entry) => {
        const rel = relative(entry, target);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
      if (hit) return macosRefusal(target, options.write);
    }
    return next(path, options);
  };
}

export type FolderAccessOptions = {
  store?: Store;
  probe?: ProbeFn;
  /** How long an answer counts as fresh for a new probe request. */
  ttlMs?: number;
  /** How long one request waits for a probe that is stuck (a system prompt nobody answered). */
  promptWaitMs?: number;
  now?: () => number;
  /** Which locations count as macOS-protected (tests simulate a Mac and its home folder). */
  platform?: Platform;
  home?: string;
};

export class FolderAccess {
  private store?: Store;
  private probeFn: ProbeFn;
  private ttlMs: number;
  private promptWaitMs: number;
  private now: () => number;
  private entries = new Map<string, Entry>();
  private running = new Map<string, Promise<FolderProbeResult>>();
  constructor(options: FolderAccessOptions = {}) {
    this.store = options.store;
    this.probeFn = options.probe ?? ((path, o) => probeFolderAccess(path, o));
    this.ttlMs = options.ttlMs ?? 30_000;
    this.promptWaitMs = options.promptWaitMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.platform = options.platform;
    this.home = options.home;
  }
  private platform?: Platform;
  private home?: string;
  private protectedIn(path: string) {
    return protectedFolderName(path, {
      platform: this.platform,
      home: this.home,
    });
  }
  /** Replace the probe (tests); `null` restores the real one. */
  setProbe(probe: ProbeFn | null) {
    this.probeFn = probe ?? ((path, o) => probeFolderAccess(path, o));
  }
  private key(path: string, write: boolean) {
    return `${canonicalPolicyPath(path)}\u0000${write ? "w" : "r"}`;
  }
  private fresh(entry: Entry | undefined) {
    return !!entry && !entry.provisional && this.now() - entry.at < this.ttlMs;
  }
  /**
   * The last answer for this folder (synchronous, for the readiness evaluator). A failure stays
   * until the folder is probed again, so a preview never offers an action that would fail the same
   * way; a success counts only while it is fresh. A write answer also answers a read question
   * when it succeeded, and a failed read answers a write question.
   */
  cached(path: string, write: boolean): FolderProbeResult | undefined {
    const exact = this.entries.get(this.key(path, write));
    if (exact && (!exact.result.ok || this.fresh(exact))) return exact.result;
    const other = this.entries.get(this.key(path, !write));
    if (other && write === false && other.result.ok && this.fresh(other))
      return other.result;
    if (other && write === true && !other.result.ok) return other.result;
    return undefined;
  }
  /** Bound lookup for `HostFacts`. */
  lookup: FolderLookup = (path, write) => this.cached(path, write);
  /** Forget answers (all, or the folders that contain or sit inside `path`). */
  invalidate(path?: string) {
    if (!path) {
      this.entries.clear();
      return;
    }
    const target = canonicalPolicyPath(path);
    const related = (other: string) => {
      const a = relative(target, other);
      const b = relative(other, target);
      return (
        a === "" ||
        (!a.startsWith("..") && !isAbsolute(a)) ||
        (!b.startsWith("..") && !isAbsolute(b))
      );
    };
    for (const key of [...this.entries.keys()])
      if (related(key.split("\u0000")[0])) this.entries.delete(key);
  }
  /**
   * Ask the system. A fresh answer is reused unless `force`; a probe that is already running is
   * joined. A probe stuck on a system prompt does not hold the caller for ever: after
   * `promptWaitMs` it answers "not allowed (yet)", and when the person finally answers the prompt
   * the late result replaces it and `folder.access_changed` tells the rest of the app.
   */
  async probe(
    path: string,
    options: { write: boolean; force?: boolean },
  ): Promise<FolderProbeResult> {
    const write = options.write;
    const key = this.key(path, write);
    if (!options.force) {
      const hit = this.entries.get(key);
      if (this.fresh(hit)) return hit!.result;
      if (!write) {
        const stronger = this.entries.get(this.key(path, true));
        if (stronger?.result.ok && this.fresh(stronger)) return stronger.result;
      }
    }
    let work = this.running.get(key);
    if (!work) {
      work = Promise.resolve()
        .then(() => this.probeFn(canonicalPolicyPath(path), { write }))
        .then(
          (result) => this.record(key, result),
          (error) =>
            this.record(
              key,
              failureOf(
                {
                  path,
                  write,
                  checkedAt: new Date(this.now()).toISOString(),
                  protectedFolder: this.protectedIn(path),
                  steps: [],
                },
                {
                  errno: "UNKNOWN",
                  operation: "probe",
                  code: "probe-unavailable",
                  detail:
                    error instanceof Error ? error.message : String(error),
                },
              ),
            ),
        );
      this.running.set(key, work);
      void work.finally(() => {
        if (this.running.get(key) === work) this.running.delete(key);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"timeout">((resolveWait) => {
      timer = setTimeout(() => resolveWait("timeout"), this.promptWaitMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([work, waited]);
    if (timer) clearTimeout(timer);
    if (outcome !== "timeout") return outcome;
    const stuck = failureOf(
      {
        path: canonicalPolicyPath(path),
        write,
        checkedAt: new Date(this.now()).toISOString(),
        protectedFolder: this.protectedIn(path),
        steps: [],
      },
      { errno: "ETIMEDOUT", operation: "readdir" },
    );
    this.entries.set(key, {
      result: stuck,
      at: this.now(),
      provisional: true,
    });
    return stuck;
  }
  /** Probe again every folder whose last answer was a failure (the window came back to the front). */
  async recheckFailed() {
    const failing = [...this.entries.values()].filter((e) => !e.result.ok);
    let opened = 0;
    await Promise.all(
      failing.map(async (entry) => {
        const result = await this.probe(entry.result.path, {
          write: entry.result.write,
          force: true,
        });
        if (result.ok) opened++;
      }),
    );
    return opened;
  }
  private record(key: string, result: FolderProbeResult) {
    const previous = this.entries.get(key);
    this.entries.set(key, { result, at: this.now(), provisional: false });
    if (previous && previous.result.ok !== result.ok) {
      try {
        this.store?.emit("folder.access_changed", result.path, {
          path: result.path,
          write: result.write,
          ok: result.ok,
          ...(result.ok ? {} : { code: result.code }),
        });
      } catch {
        // The store was closed meanwhile (shutdown); the answer is cached all the same.
      }
    }
    return result;
  }
}

const DENIAL_PHRASE =
  /\b(?:operation not permitted|EPERM|EACCES|permission denied)\b/i;
/**
 * Whether a run's output reports the operating system's refusal for a path under `root`: the
 * phrases a failed write prints, together with a path that lies inside (not merely beside) the
 * task folder. Only decides whether to ask the system about the folder; the probe decides.
 */
export function reportsDeniedPath(output: string, root: string) {
  if (!root || !DENIAL_PHRASE.test(output)) return false;
  // Either separator matches either, every other character is literal.
  const escaped = root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  return new RegExp(`${escaped}(?![\\w.~-])`, "i").test(output);
}

/** The error that refuses an action on a folder the system refuses (the typed code names the cause). */
export function folderRefusal(result: FolderProbeFailure) {
  return new AppError(409, result.code, `${result.message} ${result.fix}`);
}

// ---- default project folders -------------------------------------------------------------------

/** Where AgentTeam proposes new project folders: never inside a protected macOS location. */
export function projectsRoot() {
  return (
    process.env.AGENTTEAM_PROJECTS_DIR || join(homedir(), "AgentTeam Projects")
  );
}
/** A short folder-name slug of some words (letters and digits, hyphen separated). */
export function slugify(text: string, maxWords = 6) {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .match(/[a-z0-9]+/g);
  return (words ?? []).slice(0, maxWords).join("-").slice(0, 48);
}
/**
 * A new folder under the projects root named for the request (or the team): the first free name,
 * or an existing empty folder. Pure suggestion; `createProjectsFolder` makes it on apply.
 */
export function suggestProjectFolder(request: string, fallback = "project") {
  const root = projectsRoot();
  const base = slugify(request) || slugify(fallback) || "project";
  for (let n = 1; n < 100; n++) {
    const candidate = join(root, n === 1 ? base : `${base}-${n}`);
    if (!existsSync(candidate)) return candidate;
    try {
      if (!readdirSync(candidate).length) return candidate;
    } catch {
      // Unreadable: do not suggest it.
    }
  }
  return join(root, `${base}-${randomBytes(3).toString("hex")}`);
}
/** Whether `path` lies inside the projects root (the only place AgentTeam creates folders itself). */
export function insideProjectsRoot(path: string) {
  const rel = relative(resolve(projectsRoot()), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/**
 * Create a proposed project folder; refuses (returns false) outside the projects root. A folder
 * that cannot be made is a typed refusal naming the system's error, never an unexpected 500.
 */
export async function createProjectsFolder(path: string) {
  if (!insideProjectsRoot(path)) return false;
  try {
    await mkdir(resolve(path), { recursive: true });
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    const refused = errno === "EPERM" || errno === "EACCES";
    throw new AppError(
      refused ? 409 : 400,
      refused ? "folder-denied" : "invalid_path",
      refused
        ? `AgentTeam cannot create ${resolve(path)} (${errno} on mkdir). Check the folder's permissions or choose another folder.`
        : `AgentTeam cannot create ${resolve(path)} (${errno} on mkdir): choose a folder that can be created.`,
    );
  }
  return true;
}
