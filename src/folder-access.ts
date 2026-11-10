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
// process and then from a child program, because the workers are children (the child is this
// app's own executable run as Node: no shell, so the folder is an argument on every platform).
//
// `FolderAccess` keeps the answers and is the one place readiness (src/launch-readiness.ts),
// project setup (src/project-setup.ts), Start, Recovery and the CLI (`folder-probe`) read from,
// so they agree about the same folder. Its rules, in one place:
//   - A folder is refused until proven allowed, in the context the work will run in, before any
//     provider call, on every path.
//   - The latest answer per folder and access level is stored (entity `folder-access`) and
//     survives a restart: a stored refusal keeps blocking until a fresh probe succeeds. A success
//     is trusted for a short window in memory only.
//   - An answer that is still outstanding (an unanswered system prompt) is `folder-probe-pending`,
//     not a refusal. One probe runs per folder at a time and every caller shares its deadline, so a
//     stuck prompt costs one wait, not one per caller. At most two probes run at once and only one
//     per protected location, so the file system thread pool cannot be exhausted by prompts.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import {
  mkdir,
  opendir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
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
  /** The probe itself failed unexpectedly; never read as "fine". */
  "probe-unavailable",
  /**
   * No answer yet: a system prompt nobody has answered, or the probe is queued behind one. Not a
   * refusal; the work waits and starts by itself when the answer arrives.
   */
  "folder-probe-pending",
] as const;
export type FolderProbeCode = (typeof FOLDER_PROBE_CODES)[number];

/** The app-side steps passed but the check through a child program could not be completed. */
export type FolderProbeWarning = {
  code: "probe-inconclusive";
  operation: string;
  errno: string;
  message: string;
};
export type FolderProbeSuccess = {
  ok: true;
  /** The canonical folder that was checked. */
  path: string;
  write: boolean;
  checkedAt: string;
  /** Which macOS-protected location contains it (Desktop, Documents, ...), else null. */
  protectedFolder: string | null;
  /** The steps that passed, in order (app process first, then the child program). */
  steps: string[];
  /**
   * Present when the child check could not run at all (the program did not start, or it ended
   * without an answer). That does not block anything and is never read as a refusal; it is shown
   * as a warning because what the programs AgentTeam starts may do there is then unconfirmed.
   */
  warning?: FolderProbeWarning;
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

/**
 * What one scheduler tick spends, in all, waiting for the system's answers about folders (a macOS
 * prompt nobody has answered): the work that needs the folder waits in a `folder-probe-pending`
 * runtime wait and the tick moves on, so a prompt costs the whole app one second, not the length
 * of the prompt.
 */
export const TICK_PROBE_MS = 1000;
/** The answer is outstanding: nothing was refused, the system has not said yet. */
export const isPending = (result: FolderProbeResult | undefined) =>
  !!result && !result.ok && result.code === "folder-probe-pending";

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
  /** The program a child check used (named in the message). */
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
      ? `A program AgentTeam starts (${input.shell ?? "a child program"})`
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
      fix = `Check again, or choose another folder.`;
      break;
    case "folder-probe-pending":
      message = base.protectedFolder
        ? `Waiting for macOS to allow access to ${base.path}…`
        : `Waiting for the system to answer AgentTeam's access check of ${base.path}…`;
      fix = base.protectedFolder
        ? "Answer the macOS prompt that asks whether AgentTeam may use this folder; AgentTeam continues by itself once it is allowed. If no prompt is showing, open System Settings → Privacy & Security → Files and Folders → AgentTeam and enable it."
        : "AgentTeam continues by itself once the check finishes.";
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

/**
 * A failure observed outside a probe (for example a `mkdir` that the system refused while a task's
 * output folder was being made), worded exactly like a probe's: the caller records it with
 * `FolderAccess.noteFailure` so every reader sees the same typed cause and fix.
 */
export function failureFromError(
  path: string,
  write: boolean,
  error: unknown,
  operation: string,
  options: { platform?: Platform; home?: string } = {},
): FolderProbeFailure {
  const errno = (error as NodeJS.ErrnoException)?.code;
  return failureOf(
    {
      path,
      write,
      checkedAt: new Date().toISOString(),
      protectedFolder: protectedFolderName(path, options),
      steps: [],
    },
    {
      errno: typeof errno === "string" ? errno : "UNKNOWN",
      operation,
      detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
    },
  );
}

// ---- the child check ------------------------------------------------------------------------

export type ChildOutcome = {
  code: number | null;
  stderr: string;
  /** What the program printed (absent from runners that report only an exit status). */
  stdout?: string;
  /** The process could not be started at all. */
  error?: NodeJS.ErrnoException;
  timedOut?: boolean;
};
export type ChildRunner = (
  program: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<ChildOutcome>;

const CHILD_OK = "AGENTTEAM_PROBE_OK";
const CHILD_FAILED = "AGENTTEAM_PROBE";
/**
 * What the child check runs. It is Node (this app's own executable with ELECTRON_RUN_AS_NODE in
 * Electron), so no shell is involved on any platform: the folder arrives as an argument, never as
 * part of a command line, and the operating system's own error code comes back instead of
 * localized shell text. The program makes a uniquely named directory in the folder (or lists it),
 * writes a file, removes both, and reports the first step the system refused.
 */
const CHILD_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const [mode, target] = process.argv.slice(1);
let step = mode === "read" ? "readdir" : "mkdir";
try {
  if (mode === "read") fs.readdirSync(target);
  else {
    fs.mkdirSync(target);
    step = "write";
    fs.writeFileSync(path.join(target, "probe.txt"), "");
    step = "remove";
    fs.rmSync(path.join(target, "probe.txt"));
    fs.rmdirSync(target);
  }
} catch (error) {
  process.stderr.write("${CHILD_FAILED} " + ((error && error.code) || "UNKNOWN") + " " + step + "\\n");
  process.exit(3);
}
process.stdout.write("${CHILD_OK}\\n");
`;
/** One line: nothing in it depends on line breaks, and a command line on Windows is happier without them. */
const CHILD_PROGRAM = CHILD_SCRIPT.replace(/\s+/g, " ").trim();

/** Run the child check's program (exported for tests; the probe uses it unless a runner is injected). */
export const runChild: ChildRunner = (program, args, options) =>
  new Promise((resolveOutcome) => {
    let stderr = "";
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      resolveOutcome(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // The check needs nothing from the app's environment (tokens stay out); Electron runs its
        // own executable as Node when asked to.
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          PATH:
            process.platform === "win32"
              ? (process.env.PATH ?? "")
              : "/usr/bin:/bin",
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
      timedOut = true;
      child.kill("SIGKILL");
      // Report only when the program is gone (its streams close), so the clean-up that follows
      // cannot race a mkdir it had already started; the fallback covers a close that never comes.
      fallback = setTimeout(
        () => finish({ code: null, stderr, stdout, timedOut: true }),
        2000,
      );
      fallback.unref?.();
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 4000) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    child.on("error", (error) =>
      finish({
        code: null,
        stderr,
        stdout,
        error: error as NodeJS.ErrnoException,
      }),
    );
    child.on("close", (code) =>
      finish(
        timedOut
          ? { code: null, stderr, stdout, timedOut: true }
          : { code, stderr, stdout },
      ),
    );
  });

/** The OS error a program's message names (`mkdir: x: Operation not permitted`), when it names one. */
function errnoFromShell(stderr: string) {
  if (/operation not permitted/i.test(stderr)) return "EPERM";
  if (/permission denied|access is denied/i.test(stderr)) return "EACCES";
  if (/read-only file system|write.protected/i.test(stderr)) return "EROFS";
  if (/not a directory|directory name is invalid/i.test(stderr))
    return "ENOTDIR";
  if (/no such file|cannot find the path/i.test(stderr)) return "ENOENT";
  return null;
}
/** What the child reported: its own `AGENTTEAM_PROBE <errno> <step>` line, else the text of a message. */
function reportedFailure(stderr: string) {
  const own = stderr.match(
    new RegExp(`${CHILD_FAILED} (E[A-Z0-9]+|UNKNOWN) (\\w+)`),
  );
  if (own && own[1] !== "UNKNOWN") return { errno: own[1], operation: own[2] };
  const text = errnoFromShell(stderr);
  return text ? { errno: text, operation: null } : null;
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
  /** The program the child check runs (default: this process's executable, as Node). */
  execPath?: string;
  token?: () => string;
  childTimeoutMs?: number;
};

/**
 * Check, with the system's own answers, that `path` can be read (and, with `write`, written) by
 * this process and by a program this process starts. It never leaves anything behind: the probe
 * directory is removed even when a step fails or the child check runs out of time, and a removal
 * failure is itself reported.
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
  // (d) the same through a child program: the providers' workers are children of this process
  const child = await childCheck(real, write, token, {
    run: options.runChild ?? runChild,
    execPath: options.execPath ?? process.execPath,
    timeoutMs: options.childTimeoutMs ?? 15_000,
  });
  if (child.kind !== "ok") {
    // A child that made the directory but could not remove it, or was stopped half way, leaves it
    // behind: it is gone (the runner waits for it) and the clean-up happens from here.
    if (write && child.dir)
      await fs.rm(child.dir, { recursive: true, force: true }).catch(() => {});
  }
  if (child.kind === "failed")
    return failureOf(base(), {
      errno: child.errno,
      operation: child.operation,
      actor: "child",
      shell: child.shell,
      detail: child.detail,
    });
  if (child.kind === "ok") steps.push("child");
  return {
    ok: true,
    path: real,
    write,
    checkedAt,
    protectedFolder: base().protectedFolder,
    steps,
    ...(child.kind === "inconclusive"
      ? {
          warning: {
            code: "probe-inconclusive" as const,
            operation: child.operation,
            errno: child.errno,
            message: `AgentTeam could not confirm what the programs it starts may do in ${real} (${child.errno} on ${child.operation}${child.detail ? `: ${child.detail}` : ""}). The folder itself is usable by AgentTeam.`,
          },
        }
      : {}),
  };
}

type ChildCheck =
  | { kind: "ok" }
  | {
      /** The program ran and the system refused it. */
      kind: "failed";
      errno: string;
      operation: string;
      shell: string;
      /** The directory the child was asked to make (to remove it again when it could not). */
      dir: string;
      detail?: string;
    }
  | {
      /** The program could not be started or ended without an answer: neither allowed nor refused. */
      kind: "inconclusive";
      errno: string;
      operation: string;
      dir: string;
      detail?: string;
    };
async function childCheck(
  folder: string,
  write: boolean,
  token: () => string,
  context: { run: ChildRunner; execPath: string; timeoutMs: number },
): Promise<ChildCheck> {
  const dir = join(folder, `.agentteam-probe-${token()}`);
  const args = [
    "-e",
    CHILD_PROGRAM,
    "--",
    write ? "write" : "read",
    write ? dir : folder,
  ];
  const operation = write ? "mkdir" : "readdir";
  const outcome = await context.run(context.execPath, args, {
    timeoutMs: context.timeoutMs,
  });
  if (outcome.error)
    return {
      kind: "inconclusive",
      errno: outcome.error.code ?? "UNKNOWN",
      operation: "spawn",
      dir,
      detail: outcome.error.message.slice(0, 200),
    };
  if (outcome.timedOut)
    return {
      kind: "failed",
      errno: "ETIMEDOUT",
      operation,
      shell: "Node",
      dir,
      detail: "the child check did not finish",
    };
  if (
    outcome.code === 0 &&
    (outcome.stdout === undefined || outcome.stdout.includes(CHILD_OK))
  )
    return { kind: "ok" };
  const reported = reportedFailure(outcome.stderr);
  if (reported)
    return {
      kind: "failed",
      errno: reported.errno,
      operation: reported.operation ?? operation,
      shell: "Node",
      dir,
      detail: outcome.stderr.trim().slice(0, 200),
    };
  // It ran but said nothing about a refusal (a crash, a missing tool, an empty answer): that is no
  // evidence about the folder either way.
  return {
    kind: "inconclusive",
    errno: outcome.code === 0 ? "NOANSWER" : `EXIT${outcome.code}`,
    operation,
    dir,
    detail: outcome.stderr.trim().slice(0, 200) || undefined,
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

/** The latest answer for one folder and access level, as stored (entity `folder-access`). */
export type FolderAccessRecord = {
  id: string;
  path: string;
  write: boolean;
  ok: boolean;
  code?: FolderProbeCode;
  errno?: string;
  operation?: string;
  actor?: "app" | "child";
  message?: string;
  fix?: string;
  protectedFolder?: string | null;
  warning?: FolderProbeWarning;
  /** When the system gave this answer. */
  at: string;
  /** Which path asked (scheduler, chat, setup, start, retry, post-run, check, recheck, ...). */
  source: string;
  /** The attachments around this folder changed since: a refusal still blocks, a success is not trusted. */
  stale?: boolean;
};
export const FOLDER_ACCESS = "folder-access";

type Entry = {
  result: FolderProbeResult;
  at: number;
  stale: boolean;
  source: string;
};

/**
 * Test seam (AGENTTEAM_TEST=1 only): `AGENTTEAM_TEST_FOLDER_DENY` lists folders (separated like
 * PATH) that the probe reports as refused by macOS folder privacy, on every platform, so the setup
 * card's blocker text can be exercised without a protected folder; `AGENTTEAM_TEST_FOLDER_PENDING`
 * lists folders whose probe waits, like the real listing waits for an unanswered system prompt,
 * until the folder is no longer listed (a test lifts it by changing the variable in the app's
 * process). Anything outside the lists is probed for real.
 */
function injectedFolders(variable: string) {
  if (process.env.AGENTTEAM_TEST !== "1") return [];
  return (process.env[variable] ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((path) => canonicalPolicyPath(path));
}
const insideAny = (folders: string[], target: string) =>
  folders.some((entry) => {
    const rel = relative(entry, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
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
    if (
      process.env.AGENTTEAM_TEST === "1" &&
      (process.env.AGENTTEAM_TEST_FOLDER_DENY ||
        process.env.AGENTTEAM_TEST_FOLDER_PENDING)
    ) {
      const target = canonicalPolicyPath(path);
      while (
        insideAny(injectedFolders("AGENTTEAM_TEST_FOLDER_PENDING"), target)
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (insideAny(injectedFolders("AGENTTEAM_TEST_FOLDER_DENY"), target))
        return macosRefusal(target, options.write);
    }
    return next(path, options);
  };
}

export type FolderAccessOptions = {
  store?: Store;
  probe?: ProbeFn;
  /** How long a fresh answer counts as trusted for a new probe request (in memory only). */
  ttlMs?: number;
  /** How long a probe may stay unanswered before every caller is told "pending" (one deadline per probe). */
  promptWaitMs?: number;
  now?: () => number;
  /** Which locations count as macOS-protected (tests simulate a Mac and its home folder). */
  platform?: Platform;
  home?: string;
  /** Probes that may run at once (default 2); one per protected location and one per folder besides. */
  maxInFlight?: number;
  /** Called when a probe that callers had to wait for finished, or an answer changed. */
  onSettled?: (info: {
    path: string;
    write: boolean;
    ok: boolean;
    wasPending: boolean;
    changed: boolean;
  }) => void;
};
export type ProbeRequest = {
  write: boolean;
  /** Probe again even when a fresh answer exists. */
  force?: boolean;
  /** Which path asks; stored with the answer. */
  source?: string;
  /** How long this caller waits, counted from when the probe was requested (never beyond the prompt wait). */
  waitMs?: number;
  /** An absolute time (Date.now() scale) that several calls share, such as one scheduler tick's budget. */
  deadlineAt?: number;
  /** A folder that does not exist yet is answered but not remembered (an output folder not made yet). */
  ignoreMissing?: boolean;
};
type Flight = {
  key: string;
  /** The requested spelling, folded; the answer's canonical spelling may differ. */
  lexical: string;
  path: string;
  write: boolean;
  /** What one probe at a time may use: a protected location, else the folder itself. */
  domain: string;
  source: string;
  requestedAt: number;
  startedAt?: number;
  settled: boolean;
  /** A caller was told "pending": finishing it is news for whoever waited. */
  pendingReported: boolean;
  ignoreMissing: boolean;
  promise: Promise<FolderProbeResult>;
  finish: (result: FolderProbeResult) => void;
  /** Opens this probe's slot for the others once it has been stuck for the whole wait. */
  timer?: ReturnType<typeof setTimeout>;
};

/** Case is folded where file systems fold it by default (macOS, Windows); Linux keeps it. */
const fold = (path: string) =>
  process.platform === "linux" ? path : path.toLowerCase();
const READ_STEPS = ["realpath", "stat", "readdir"];
/** A caller whose budget is spent still gives a quick probe this long to finish. */
const MIN_WAIT_MS = 30;
/** Until a probe has run this long it is "being asked", not "pending". */
const PENDING_GRACE_MS = 250;
const KEY_MEMO_MS = 5_000;

/** The real path as stored on disk (native resolution), else the nearest existing parent plus the rest. */
function nativePath(resolved: string) {
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...tail].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolved;
      tail.push(relative(parent, current));
      current = parent;
    }
  }
}

export class FolderAccess {
  private store?: Store;
  private probeFn: ProbeFn;
  private ttlMs: number;
  private promptWaitMs: number;
  private now: () => number;
  private platform?: Platform;
  private home?: string;
  private maxInFlight: number;
  private onSettled?: FolderAccessOptions["onSettled"];
  /** The latest answer per folder and level: every refusal (stored ones included), recent successes. */
  private entries = new Map<string, Entry>();
  /** Everything stored, by record id: the previous state for transitions and what a sweep may visit. */
  private stored = new Map<string, FolderAccessRecord>();
  /** Spellings of a folder that resolve to another key (symlinks, case), learned from probes. */
  private aliases = new Map<string, string>();
  private keyMemo = new Map<string, { path: string; at: number }>();
  /** Folders whose leftover probe directories were already looked for in this process. */
  private swept = new Set<string>();
  private flights: Flight[] = [];
  constructor(options: FolderAccessOptions = {}) {
    this.store = options.store;
    this.probeFn = options.probe ?? ((path, o) => probeFolderAccess(path, o));
    this.ttlMs = options.ttlMs ?? 30_000;
    this.promptWaitMs = options.promptWaitMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.platform = options.platform;
    this.home = options.home;
    this.maxInFlight = options.maxInFlight ?? 2;
    this.onSettled = options.onSettled;
    this.load();
  }
  private protectedIn(path: string) {
    return protectedFolderName(path, {
      platform: this.platform,
      home: this.home,
    });
  }
  /**
   * Whether looking at this folder could raise a system prompt (a macOS-protected location):
   * only there can a lookup wait for the person, so only there is it worth asking first.
   */
  mayPrompt(path: string) {
    return !!this.protectedIn(resolve(path));
  }
  /** Replace the probe (tests); `null` restores the real one. */
  setProbe(probe: ProbeFn | null) {
    this.probeFn = probe ?? ((path, o) => probeFolderAccess(path, o));
  }
  /** Stored answers come back after a restart: a refusal keeps blocking until a probe succeeds. */
  private load() {
    let records: FolderAccessRecord[] = [];
    try {
      records = this.store?.list<FolderAccessRecord>(FOLDER_ACCESS) ?? [];
    } catch {
      return;
    }
    for (const record of records) {
      this.stored.set(record.id, record);
      if (record.ok) continue; // a success is trusted in memory only, never across a restart
      this.entries.set(this.slot(fold(record.path), record.write), {
        result: resultOf(record),
        at: Date.parse(record.at) || 0,
        stale: !!record.stale,
        source: record.source,
      });
    }
  }
  /**
   * The folder's real path as stored on disk (native resolution, symlinks followed). A protected
   * location is never touched from a synchronous caller: the lookup there could wait for a system
   * prompt, so it is only normalized; the first (asynchronous) probe learns its real spelling.
   */
  private canonical(path: string): string {
    const resolved = resolve(path);
    if (this.protectedIn(resolved)) return resolved;
    const memo = this.keyMemo.get(resolved);
    const nowMs = Date.now();
    if (memo && nowMs - memo.at < KEY_MEMO_MS) return memo.path;
    const real = nativePath(resolved);
    this.keyMemo.set(resolved, { path: real, at: nowMs });
    if (this.keyMemo.size > 500) this.keyMemo.clear();
    return real;
  }
  /** The key a folder is known by: its real path, whatever spelling was asked about. */
  private keyOf(path: string): string {
    const resolved = resolve(path);
    return this.aliases.get(fold(resolved)) ?? fold(this.canonical(resolved));
  }
  private slot(key: string, write: boolean) {
    return `${key}\u0000${write ? "w" : "r"}`;
  }
  private fresh(entry: Entry | undefined) {
    return !!entry && !entry.stale && this.now() - entry.at < this.ttlMs;
  }
  /** A refusal is always trusted (until probed again); a success only while fresh. */
  private trusted(entry: Entry | undefined) {
    return !!entry && (!entry.result.ok || this.fresh(entry));
  }
  private pendingResult(path: string, write: boolean) {
    return failureOf(
      {
        path,
        write,
        checkedAt: new Date(this.now()).toISOString(),
        protectedFolder: this.protectedIn(path),
        steps: [],
      },
      {
        errno: "ETIMEDOUT",
        operation: "readdir",
        code: "folder-probe-pending",
      },
    );
  }
  /**
   * The last answer for this folder (synchronous, for the readiness evaluator). A refusal stays
   * until the folder is probed again, also after a restart and after the attachments around it
   * changed, so a preview never offers an action that would fail the same way; a success counts
   * only while it is fresh. A write answer also answers a read question when it succeeded, and a
   * failed read answers a write question. A probe still waiting for the system answers "pending",
   * and a refusal of a folder that contains this one applies to it until it is proven otherwise.
   */
  cached(path: string, write: boolean): FolderProbeResult | undefined {
    const key = this.keyOf(path);
    const exact = this.entries.get(this.slot(key, write));
    if (this.trusted(exact)) return exact!.result;
    const other = this.entries.get(this.slot(key, !write));
    if (this.trusted(other)) {
      if (!write && other!.result.ok) return other!.result;
      if (write && !other!.result.ok) return other!.result;
    }
    const flight = this.flights.find((f) => !f.settled && f.key === key);
    if (flight) {
      if (Date.now() - flight.requestedAt >= PENDING_GRACE_MS)
        flight.pendingReported = true;
      return this.pendingResult(flight.path, write);
    }
    for (let parent = dirname(key); ; parent = dirname(parent)) {
      for (const level of [write, !write]) {
        const above = this.entries.get(this.slot(parent, level));
        if (above && !above.result.ok) return above.result;
      }
      if (dirname(parent) === parent) break;
    }
    return undefined;
  }
  /** Bound lookup for `HostFacts`. */
  lookup: FolderLookup = (path, write) => this.cached(path, write);
  /** Probes that have been asked and have not answered yet. */
  pending() {
    return this.flights
      .filter((f) => !f.settled)
      .map((f) => ({ path: f.path, write: f.write, since: f.requestedAt }));
  }
  /**
   * The attachments around `path` (or all of them) changed. A refusal stays (marked stale) and
   * still blocks until a probe says otherwise; a success is forgotten, because nothing vouches for
   * it any more. Nothing here deletes what the system said.
   */
  invalidate(path?: string) {
    const target = path ? this.keyOf(path) : null;
    const related = (key: string) => {
      if (!target) return true;
      const a = relative(target, key);
      const b = relative(key, target);
      return (
        a === "" ||
        (!a.startsWith("..") && !isAbsolute(a)) ||
        (!b.startsWith("..") && !isAbsolute(b))
      );
    };
    for (const [slotKey, entry] of [...this.entries]) {
      if (!related(slotKey.split("\u0000")[0])) continue;
      if (entry.result.ok) this.entries.delete(slotKey);
      else entry.stale = true;
    }
    for (const [id, record] of [...this.stored]) {
      if (record.stale || !related(fold(record.path))) continue;
      const next = { ...record, stale: true };
      this.stored.set(id, next);
      try {
        this.store?.put(FOLDER_ACCESS, next);
      } catch {
        // The store was closed meanwhile (shutdown); the memory copy is enough.
      }
    }
  }

  /**
   * Ask the system. A fresh answer is reused unless `force`; a probe that is already running (or
   * queued) for the folder is joined, so N callers share one probe and one deadline. A probe stuck
   * on a system prompt does not hold callers: once the shared deadline (or the caller's own,
   * shorter one) passes they are told `folder-probe-pending`, the probe keeps running, and when
   * the person finally answers the prompt the answer is recorded and announced. Never throws.
   */
  async probe(path: string, request: ProbeRequest): Promise<FolderProbeResult> {
    const write = request.write;
    const resolved = resolve(path);
    const key = this.keyOf(resolved);
    if (!request.force) {
      const hit = this.entries.get(this.slot(key, write));
      if (this.fresh(hit)) return hit!.result;
      if (!write) {
        const stronger = this.entries.get(this.slot(key, true));
        if (stronger?.result.ok && this.fresh(stronger)) return stronger.result;
      }
    }
    // A write probe also answers a read question: join it instead of asking twice.
    let flight = this.flights.find(
      (f) => !f.settled && f.key === key && (f.write || !write),
    );
    if (flight)
      flight.ignoreMissing = flight.ignoreMissing && !!request.ignoreMissing;
    else flight = this.enqueue(resolved, key, write, request);
    const outcome = await this.waitFor(flight, request);
    if (outcome === "pending") {
      flight.pendingReported = true;
      return this.pendingResult(flight.path, write);
    }
    if (this.answers(outcome, write)) return outcome;
    // The shared write probe failed after listing the folder: reading it is a question of its own.
    return this.probe(path, { ...request, force: false });
  }
  private answers(result: FolderProbeResult, write: boolean) {
    if (result.write === write) return true;
    return (
      result.write &&
      !write &&
      (result.ok ||
        (result.actor === "app" && READ_STEPS.includes(result.operation)))
    );
  }
  private async waitFor(
    flight: Flight,
    request: ProbeRequest,
  ): Promise<FolderProbeResult | "pending"> {
    if (flight.settled) return flight.promise;
    const shared = flight.requestedAt + this.promptWaitMs;
    const limits = [shared];
    if (request.waitMs !== undefined)
      limits.push(flight.requestedAt + request.waitMs);
    if (request.deadlineAt !== undefined) limits.push(request.deadlineAt);
    const nowMs = Date.now();
    // Past the probe's own deadline nobody waits; a spent budget still lets a quick probe finish.
    if (shared <= nowMs) return "pending";
    const ms = Math.max(Math.min(...limits) - nowMs, MIN_WAIT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"pending">((resolveWait) => {
      timer = setTimeout(() => resolveWait("pending"), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([flight.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private enqueue(
    resolved: string,
    key: string,
    write: boolean,
    request: ProbeRequest,
  ) {
    let finish!: (result: FolderProbeResult) => void;
    const promise = new Promise<FolderProbeResult>((done) => (finish = done));
    const flight: Flight = {
      key,
      lexical: fold(resolved),
      path: this.canonical(resolved),
      write,
      domain: this.protectedIn(resolved) ?? key,
      source: request.source ?? "unknown",
      requestedAt: Date.now(),
      settled: false,
      pendingReported: false,
      ignoreMissing: !!request.ignoreMissing,
      promise,
      finish,
    };
    this.flights.push(flight);
    this.pump();
    return flight;
  }
  /**
   * Start queued probes while the limits allow: one per folder and per protected location (a
   * second probe in a location that is waiting for the person would only pin another thread),
   * `maxInFlight` at once, and a probe that has been stuck for the whole prompt wait no longer
   * counts against that number (so unrelated folders are not starved) but still counts towards a
   * hard cap one above it, which keeps threads in reserve for the rest of the app.
   */
  private pump() {
    for (const flight of this.flights) {
      if (flight.settled || flight.startedAt !== undefined) continue;
      const running = this.flights.filter(
        (f) => f.startedAt !== undefined && !f.settled,
      );
      if (
        running.some((f) => f.key === flight.key || f.domain === flight.domain)
      )
        continue;
      const nowMs = Date.now();
      const active = running.filter(
        (f) => nowMs - f.startedAt! < this.promptWaitMs,
      ).length;
      if (active >= this.maxInFlight || running.length >= this.maxInFlight + 1)
        continue;
      flight.startedAt = nowMs;
      // When this probe has been stuck for the whole wait its slot opens for the others.
      flight.timer = setTimeout(() => this.pump(), this.promptWaitMs + 5);
      flight.timer.unref?.();
      void this.run(flight);
    }
  }
  private async run(flight: Flight) {
    let result: FolderProbeResult;
    try {
      result = await this.probeFn(flight.path, { write: flight.write });
    } catch (error) {
      result = failureOf(
        {
          path: flight.path,
          write: flight.write,
          checkedAt: new Date(this.now()).toISOString(),
          protectedFolder: this.protectedIn(flight.path),
          steps: [],
        },
        {
          errno: "UNKNOWN",
          operation: "probe",
          code: "probe-unavailable",
          detail: error instanceof Error ? error.message : String(error),
        },
      );
    }
    this.settle(flight, result);
  }
  private settle(flight: Flight, result: FolderProbeResult) {
    flight.settled = true;
    if (flight.timer) clearTimeout(flight.timer);
    this.flights = this.flights.filter((f) => f !== flight);
    let changed = false;
    try {
      changed = this.record(flight, result);
    } catch {
      // The store was closed meanwhile (shutdown); the answer is cached all the same.
    }
    flight.finish(result);
    this.pump();
    if (flight.pendingReported || changed)
      try {
        this.onSettled?.({
          path: result.path,
          write: flight.write,
          ok: result.ok,
          wasPending: flight.pendingReported,
          changed,
        });
      } catch {
        // A listener must never break the probe.
      }
  }
  /** Remember an answer, store it, and announce a transition. Returns whether one happened. */
  private record(flight: Flight, result: FolderProbeResult) {
    if (flight.ignoreMissing && !result.ok && result.code === "folder-missing")
      return false;
    // The probe resolved the folder itself: that spelling is the key, whatever was asked.
    const key = result.steps.includes("realpath")
      ? fold(result.path)
      : flight.key;
    if (key !== flight.lexical) this.aliases.set(flight.lexical, key);
    const changed = this.remember(
      key,
      flight.write,
      result,
      flight.source,
      flight.pendingReported,
    );
    // Refused while listing the folder, so reading it is refused the same way; allowed for
    // writing, so a refusal of reading it that was recorded before is over.
    if (flight.write) {
      const listing =
        !result.ok &&
        result.actor === "app" &&
        READ_STEPS.includes(result.operation);
      const reopened =
        result.ok &&
        this.entries.get(this.slot(key, false))?.result.ok === false;
      if (listing || reopened)
        this.remember(
          key,
          false,
          { ...result, write: false },
          flight.source,
          false,
          true,
        );
    }
    return changed;
  }
  /** Store one answer; true when it is a transition worth announcing. */
  private remember(
    key: string,
    write: boolean,
    result: FolderProbeResult,
    source: string,
    wasPending: boolean,
    quiet = false,
  ) {
    const slotKey = this.slot(key, write);
    const id = `${write ? "w" : "r"}:${key}`;
    const previous = this.entries.get(slotKey);
    const before = this.stored.get(id);
    const wasRefused = previous
      ? !previous.result.ok
      : before
        ? !before.ok
        : false;
    this.entries.set(slotKey, {
      result,
      at: this.now(),
      stale: false,
      source,
    });
    const record = recordOf(id, result, source, new Date(this.now()));
    this.stored.set(id, record);
    try {
      this.store?.put(FOLDER_ACCESS, record);
    } catch {
      // The store was closed meanwhile (shutdown); the answer is cached all the same.
    }
    // Access to this folder is proven for writing: the first time in this process, look for the
    // hidden directories an interrupted probe may have left in it.
    if (result.ok && write && !this.swept.has(key)) {
      this.swept.add(key);
      void this.sweepLeftovers({ roots: [result.path] }).catch(() => {});
    }
    const refused = !result.ok && !wasRefused;
    const allowed = result.ok && (wasRefused || wasPending);
    if ((refused || allowed) && !quiet)
      try {
        this.store?.emit(
          refused ? "folder.access_refused" : "folder.access_allowed",
          result.path,
          {
            path: result.path,
            write,
            ok: result.ok,
            ...(result.ok
              ? {}
              : {
                  code: result.code,
                  errno: result.errno,
                  operation: result.operation,
                }),
            source,
          },
        );
      } catch {
        // See above.
      }
    return (refused || allowed) && !quiet;
  }
  /**
   * Record a refusal observed outside a probe (a `mkdir` that the system refused while a task's
   * output folder was made), so previews, Recovery and the next launch read the same typed cause.
   */
  noteFailure(failure: FolderProbeFailure, source = "observed") {
    const key = this.keyOf(failure.path);
    const changed = this.remember(key, failure.write, failure, source, false);
    if (changed)
      try {
        this.onSettled?.({
          path: failure.path,
          write: failure.write,
          ok: false,
          wasPending: false,
          changed: true,
        });
      } catch {
        // See above.
      }
  }
  /**
   * Probe again every folder whose last answer was a refusal (the window came back to the front),
   * restricted to the ones `relevant` accepts when given (a stored refusal of a folder nothing
   * uses any more is not worth a system prompt). Returns how many opened.
   */
  async recheckFailed(relevant?: (path: string) => boolean) {
    // One probe per folder, at the strongest level anything was refused at.
    const folders = new Map<string, { path: string; write: boolean }>();
    for (const [slotKey, entry] of this.entries) {
      if (entry.result.ok || (relevant && !relevant(entry.result.path)))
        continue;
      const key = slotKey.split("\u0000")[0];
      const known = folders.get(key);
      folders.set(key, {
        path: entry.result.path,
        write: (known?.write ?? false) || entry.result.write,
      });
    }
    let opened = 0;
    await Promise.all(
      [...folders.values()].map(async (folder) => {
        const result = await this.probe(folder.path, {
          write: folder.write,
          force: true,
          source: "recheck",
        });
        if (result.ok) opened++;
      }),
    );
    return opened;
  }
  /**
   * Remove probe directories a killed or crashed probe left behind: older than `olderThanMs`,
   * named exactly like a probe's, inside folders this app has probed for writing before (the
   * stored answers say where). At start-up it visits only folders macOS does not protect: listing
   * a protected one before the system has been asked again (an unsigned build is a new app to
   * macOS after every rebuild) would raise a system prompt nobody expects; those folders are swept
   * the first time a probe succeeds in them in this process, when access is proven. Refused
   * folders are never listed.
   */
  async sweepLeftovers(
    options: { olderThanMs?: number; roots?: string[] } = {},
  ) {
    const olderThanMs = options.olderThanMs ?? 60_000;
    const roots = options.roots ?? [
      ...new Set(
        [...this.stored.values()]
          .filter(
            (r) =>
              r.write &&
              (r.ok || (r.errno === "ETIMEDOUT" && r.actor === "child")) &&
              !this.protectedIn(r.path),
          )
          .map((r) => r.path),
      ),
    ];
    for (const root of roots) this.swept.add(fold(root));
    let removed = 0;
    for (const root of roots) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^\.agentteam-probe-[0-9a-f]+$/.test(name)) continue;
        const full = join(root, name);
        try {
          if (Date.now() - (await stat(full)).mtimeMs <= olderThanMs) continue;
          await rm(full, { recursive: true, force: true });
          removed++;
        } catch {
          // Gone, or not ours to remove: leave it.
        }
      }
    }
    return removed;
  }
}

function recordOf(
  id: string,
  result: FolderProbeResult,
  source: string,
  at: Date,
): FolderAccessRecord {
  const base = {
    id,
    path: result.path,
    write: result.write,
    at: at.toISOString(),
    source,
    protectedFolder: result.protectedFolder,
  };
  return result.ok
    ? {
        ...base,
        ok: true,
        ...(result.warning ? { warning: result.warning } : {}),
      }
    : {
        ...base,
        ok: false,
        code: result.code,
        errno: result.errno,
        operation: result.operation,
        actor: result.actor,
        message: result.message,
        fix: result.fix,
      };
}
/** A stored refusal as the probe result it was. */
function resultOf(record: FolderAccessRecord): FolderProbeFailure {
  return {
    ok: false,
    code: record.code ?? "folder-denied",
    errno: record.errno ?? "UNKNOWN",
    operation: record.operation ?? "readdir",
    actor: record.actor ?? "app",
    message: record.message ?? `AgentTeam cannot use ${record.path}.`,
    fix:
      record.fix ?? "Check the folder's permissions or choose another folder.",
    path: record.path,
    write: record.write,
    checkedAt: record.at,
    protectedFolder: record.protectedFolder ?? null,
    steps: [],
  };
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

/**
 * The error that refuses an action on a folder the system refuses (the typed code names the
 * cause). An answer that is still outstanding is `folder_probe_pending`: nothing was refused, the
 * action cannot go on yet, and asking again later is the right thing to do.
 */
export function folderRefusal(result: FolderProbeFailure) {
  return new AppError(
    409,
    result.code === "folder-probe-pending"
      ? "folder_probe_pending"
      : result.code,
    `${result.message} ${result.fix}`,
  );
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
  return createFolder(path);
}
/** `mkdir -p` with the typed refusal; callers decide whether the path may be created at all. */
export async function createFolder(path: string) {
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
