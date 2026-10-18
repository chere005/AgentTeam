import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { decide, hasRestrictions } from "./access.ts";
import { AppError, type Agent } from "./model.ts";
import { contains } from "./resources.ts";
import { killTree } from "./devserver.ts";
import { planSpawn } from "./runtime-spawn.ts";
import { argValue, pathLike, type GraphNode } from "./workflow-graph-model.ts";

/**
 * Deterministic command steps: no model call, argv based, bounded in time and output, started in an
 * attached workspace. This is path confinement (working directory and path-like arguments are
 * checked against the attached root, symlinks resolved), NOT an OS sandbox: the program itself can
 * still do whatever the user account can. That is why a command is shown before a graph runs, runs
 * only through the resource lease/limits/ledger paths in workflow-graph.ts, and is never started
 * through a shell unless the node says `shell: true`.
 */
type CommandNode = Extract<GraphNode, { type: "command" }>;
export type Resolved = (string | { input: string })[];

export type CommandPlan = {
  /** Program and arguments exactly as they will be spawned (shell form: the script). */
  command: string;
  args: string[];
  cwd: string;
  root: string;
  shell: boolean;
  /** Single-line text shown to the user before and during the run. */
  display: string;
  timeoutMs: number;
  maxOutputBytes: number;
  mutating: boolean;
  access: "read" | "write";
};
export type CommandResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  durationMs: number;
  /** Set when the program could not even be started (nothing ran, nothing can have changed). */
  spawnError?: string;
};

const ENV_ALLOW = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
];
export function commandEnv(source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const name = Object.keys(source).find(
      (k) => k.toLowerCase() === key.toLowerCase(),
    );
    if (name && source[name] !== undefined) env[name] = source[name]!;
  }
  return env;
}

export function displayCommand(
  node: CommandNode,
  args: Resolved,
  cwd?: string,
): string {
  const shown = args
    .map((a) => (typeof a === "string" ? a : `{${a.input}}`))
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(" ");
  return `${cwd ? cwd + " " : ""}${node.shell ? "[shell] " : ""}$ ${shown}`;
}
function withinRoot(root: string, path: string) {
  const rel = relative(root, path);
  return (
    contains(root, path) &&
    !rel.split(sep).includes(".git") &&
    !rel.split("/").includes(".git")
  );
}
async function realOfNearest(path: string): Promise<string> {
  let probe = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      return resolve(real, ...tail.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      tail.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}
function confined(code: string, message: string): never {
  throw new AppError(409, code, message);
}

/**
 * Resolves the workspace, working directory and path-like arguments against the attached root.
 * `args` are fully resolved strings (input substitutions already applied).
 */
export async function planCommand(
  node: CommandNode,
  agent: Agent,
  args: string[],
): Promise<CommandPlan> {
  const attached = node.workspace
    ? agent.workspaces.find((w) => w.path === node.workspace)
    : (agent.workspaces.find((w) => w.active) ?? agent.workspaces[0]);
  if (!attached)
    confined(
      "command_no_workspace",
      "The agent has no attached workspace for this command",
    );
  const root = await realpath(attached.path).catch(() =>
    confined("workspace_changed", "The attached workspace no longer exists"),
  );
  if (root !== attached.path)
    confined(
      "workspace_changed",
      "Attached workspace path changed; reattach it",
    );
  if (node.mutating && attached.access !== "write")
    confined(
      "command_read_only",
      "A mutating command needs a workspace with write access",
    );
  const cwdPath = resolve(root, node.cwd ?? ".");
  if (!withinRoot(root, cwdPath))
    confined(
      "command_confined",
      "Working directory leaves the attached workspace",
    );
  const cwd = await realpath(cwdPath).catch(() =>
    confined("command_confined", "Working directory does not exist"),
  );
  if (!withinRoot(root, cwd) || !(await stat(cwd)).isDirectory())
    confined(
      "command_confined",
      "Working directory resolves outside the attached workspace",
    );
  // File rules and exclusions of the attachment (src/access.ts): the working directory and every
  // path-like argument must be visible (writable for a mutating command's working directory). A
  // shell script cannot be checked path by path, so it is refused on a restricted attachment.
  const restricted = hasRestrictions(attached);
  const ruleCheck = (full: string, what: string, needWrite: boolean) => {
    if (!restricted) return;
    const rel = relative(root, full).split(sep).join("/");
    const d = decide(attached, rel);
    if (d.access === "none" || (needWrite && d.access !== "write"))
      confined(
        "access_denied",
        `${what} is not allowed by the attachment's access rules: ${d.reason}`,
      );
  };
  if (node.shell && restricted)
    confined(
      "access_rules_command",
      "This attachment has exclusions or explicit-only rules; a shell script cannot be confined to them. Use an argv command naming its paths",
    );
  {
    const lexicalCwd = resolve(root, node.cwd ?? ".");
    for (const p of new Set([lexicalCwd, cwd]))
      // The working directory may be an allowed folder or only lead to one (explicit-only); a
      // mutating command needs write access there.
      if (restricted) {
        const rel = relative(root, p).split(sep).join("/");
        const d = decide(attached, rel);
        if (d.source === "exclusion" || (node.mutating && d.access !== "write"))
          confined(
            "access_denied",
            `Working directory is not allowed by the attachment's access rules: ${d.reason}`,
          );
      }
  }
  const checkPath = async (arg: string, force = false) => {
    const value = argValue(arg);
    if (/(^|[\\/])\.git([\\/]|$)/.test(value))
      confined(
        "command_confined",
        `Argument "${arg.slice(0, 80)}" touches .git`,
      );
    // On a restricted attachment a bare relative name ("secrets/key.txt", "notes.md") is a path too
    // when it contains a separator or names something that exists.
    const namesPath =
      restricted &&
      !value.startsWith("-") &&
      (/[\\/]/.test(value) ||
        (await lstat(resolve(cwd, value)).then(
          () => true,
          () => false,
        )));
    if (
      !force &&
      !namesPath &&
      !pathLike(value) &&
      !/(^|[\\/])\.\.([\\/]|$)/.test(value) &&
      !value.startsWith("~")
    )
      return;
    if (value.startsWith("~"))
      confined(
        "command_confined",
        `Argument "${arg.slice(0, 80)}" uses ~, which is outside the workspace`,
      );
    const full = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
    const real = await realOfNearest(full);
    if (!withinRoot(root, full) || !withinRoot(root, real))
      confined(
        "command_confined",
        `Argument "${arg.slice(0, 80)}" names a path outside the attached workspace (or inside .git)`,
      );
    ruleCheck(full, `Argument "${arg.slice(0, 80)}"`, false);
    ruleCheck(real, `Argument "${arg.slice(0, 80)}"`, false);
  };
  const display = (list: string[]) =>
    displayCommand(node, list, relative(root, cwd) || ".");
  const base = {
    cwd,
    root,
    timeoutMs: node.timeoutMs,
    maxOutputBytes: node.maxOutputBytes,
    mutating: node.mutating,
    access: attached.access,
  };
  if (node.shell) {
    if (args.length !== 1)
      confined(
        "command_shell_form",
        "A shell command is exactly one script string",
      );
    const win = process.platform === "win32";
    return {
      ...base,
      shell: true,
      command: win ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
      args: win ? ["/d", "/s", "/c", args[0]] : ["-c", args[0]],
      display: display(args),
    };
  }
  if (!args[0]?.trim()) confined("command_empty", "The program name is empty");
  if (/[\\/]/.test(args[0])) await checkPath(args[0], true);
  for (const arg of args.slice(1)) await checkPath(arg);
  for (const arg of args)
    if (arg.includes("\0"))
      confined("command_argument", "Arguments cannot contain NUL");
  const spawnPlan = await planSpawn(args[0], args.slice(1));
  return {
    ...base,
    shell: false,
    command: spawnPlan.command,
    args: spawnPlan.args,
    display: display(args),
  };
}

/** Starts the planned command and resolves when the whole process tree is gone. Never rejects. */
export function runCommand(
  plan: CommandPlan,
  signal?: AbortSignal,
  onSpawn?: (pid: number) => void,
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((done) => {
    const out: Record<"stdout" | "stderr", Buffer[]> = {
      stdout: [],
      stderr: [],
    };
    const size = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let timedOut = false,
      aborted = false,
      settled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const text = (k: "stdout" | "stderr") =>
        Buffer.concat(out[k]).toString("utf8");
      done({
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        stdout: text("stdout"),
        stderr: text("stderr"),
        truncated,
        durationMs: Date.now() - started,
        ...r,
      });
    };
    let child: ReturnType<typeof spawn>;
    const stop = async () => {
      if (child.pid) await killTree(child.pid, 1500);
      // Stopped right after the fork the process group may not exist yet: signal the child itself.
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const onAbort = () => {
      aborted = true;
      void stop();
    };
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: commandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      finish({ spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (child.pid) onSpawn?.(child.pid);
    const collect = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = plan.maxOutputBytes - size[kind];
      if (room > 0) {
        out[kind].push(chunk.subarray(0, room));
        size[kind] += Math.min(room, chunk.length);
      }
      if (chunk.length > room) truncated[kind] = true;
    };
    child.stdout!.on("data", collect("stdout"));
    child.stderr!.on("data", collect("stderr"));
    child.on("error", (e) =>
      finish({
        spawnError: (e as NodeJS.ErrnoException).code
          ? `${(e as NodeJS.ErrnoException).code}: ${e.message}`
          : e.message,
      }),
    );
    // `close` fires after the stdio pipes end, so output is complete; the group is then reaped.
    child.on("close", (code, sig) => {
      if (child.pid && process.platform !== "win32")
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* group already gone */
        }
      finish({ exitCode: code, signal: sig });
    });
    timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, plan.timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
