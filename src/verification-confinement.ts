import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { AppError, assert } from "./model.ts";
import { killTree } from "./devserver.ts";

export type ConfinedCommand = {
  executable: string;
  args: string[];
  inputDirectory: string;
  outputDirectory: string;
  readRoots: string[];
  deniedRoots: string[];
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  /** Only a trusted compiler driver needs subprocesses; generated programs cannot fork. */
  allowFork?: boolean;
};
export type ConfinedResult = {
  executable: string;
  args: string[];
  cwd: string;
  sandbox: "macos-seatbelt" | "linux-bubblewrap";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  durationMs: number;
};
export const VERIFICATION_MAX_OUTPUT_BYTES = 1_000_000;
const unavailable = (message: string): never => {
  throw new AppError(409, "verifier_unavailable", message);
};
const quoted = (value: string) => JSON.stringify(value);

/** Locate a native runtime, never use packaged Electron's process.execPath as Node. */
export async function verificationExecutable(names: string[]) {
  let developerPaths: string[] = [];
  if (process.platform === "darwin") {
    try {
      const developer = await realpath("/var/select/developer_dir");
      developerPaths = [
        join(developer, "Toolchains/XcodeDefault.xctoolchain/usr/bin"),
        join(developer, "usr/bin"),
      ];
    } catch {
      developerPaths = ["/Library/Developer/CommandLineTools/usr/bin"];
    }
  }
  const compiler = names.some((name) =>
    ["clang++", "clang", "g++", "gcc"].includes(name),
  );
  const candidates = [
    ...(compiler ? developerPaths : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(!compiler ? developerPaths : []),
    "/usr/bin",
    "/bin",
    ...(process.env.PATH ?? "").split(delimiter),
  ].filter(Boolean);
  for (const name of names)
    for (const root of candidates) {
      const file = resolve(root, name);
      try {
        await access(file, constants.X_OK);
        const target = await realpath(file);
        if ((await stat(target)).isFile()) return target;
      } catch {
        // An unavailable candidate is not a fallback to an unconstrained process.
      }
    }
  return unavailable(`No installed ${names.join(" / ")} toolchain was found`);
}

/** Runtime support files; these are system/toolchain roots, never arbitrary agent grants. */
export function verificationRuntimeRoots(executable: string) {
  const roots = [
    "/usr",
    "/bin",
    "/System",
    "/Library/Developer",
    "/Library/Apple",
    "/lib",
    "/lib64",
  ];
  const appDeveloper = executable.match(
    /^(.*\.app\/Contents\/Developer)\//,
  )?.[1];
  if (appDeveloper) roots.push(appDeveloper);
  else if (executable.startsWith("/opt/homebrew/")) roots.push("/opt/homebrew");
  else if (executable.startsWith("/usr/local/")) roots.push("/usr/local");
  else if (
    !roots.some(
      (root) => executable === root || executable.startsWith(root + "/"),
    )
  )
    roots.push(dirname(executable));
  return roots;
}

/** Default deny: generated code can read its immutable input and write only disposable outputs. */
export function macVerificationProfile(command: ConfinedCommand) {
  const readRoots = [
    ...new Set([
      ...command.readRoots,
      command.inputDirectory,
      command.outputDirectory,
    ]),
  ];
  const metadataParents = new Set<string>(["/dev"]);
  for (const root of readRoots) {
    let parent = dirname(root);
    while (!metadataParents.has(parent)) {
      metadataParents.add(parent);
      if (parent === dirname(parent)) break;
      parent = dirname(parent);
    }
  }
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    // clang's driver needs compiler children; every descendant inherits the same sandbox.
    command.allowFork ? "(allow process-fork)" : "(deny process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    `(allow file-read* ${readRoots.map((root) => `(subpath ${quoted(root)})`).join(" ")})`,
    `(allow file-map-executable ${readRoots.map((root) => `(subpath ${quoted(root)})`).join(" ")})`,
    `(allow file-read-metadata ${[...metadataParents].map((root) => `(literal ${quoted(root)})`).join(" ")})`,
    // macOS 26 dyld's cache finder reads the root directory, not its descendants.
    '(allow file-read-data (literal "/"))',
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    `(allow file-write* (subpath ${quoted(command.outputDirectory)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    "(deny network*)",
    // Permanent denials take precedence over any system/toolchain allowance.
    ...command.deniedRoots.map(
      (root) => `(deny file-read* file-write* (subpath ${quoted(root)}))`,
    ),
    "",
  ].join("\n");
}

/** OS confinement is mandatory; unsupported hosts return a typed refusal. */
export async function runVerificationCommand(
  command: ConfinedCommand,
): Promise<ConfinedResult> {
  const platform = process.platform;
  const output = await realpath(command.outputDirectory);
  const input = await realpath(command.inputDirectory);
  const executable = await realpath(command.executable);
  assert(
    output !== input && !output.startsWith(input + "/"),
    "invalid_verifier_scope",
    "Verification output must be separate from immutable source inputs",
    400,
  );
  let sandbox: ConfinedResult["sandbox"];
  let launcher: string;
  let args: string[];
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: output,
    TMPDIR: output + "/",
    TMP: output,
    TEMP: output,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  if (platform === "darwin") {
    launcher = "/usr/bin/sandbox-exec";
    try {
      await access(launcher, constants.X_OK);
    } catch {
      return unavailable(
        "macOS sandbox-exec is unavailable; verification was not run",
      );
    }
    sandbox = "macos-seatbelt";
    args = [
      "-p",
      macVerificationProfile({
        ...command,
        inputDirectory: input,
        outputDirectory: output,
      }),
      executable,
      ...command.args,
    ];
  } else if (platform === "linux") {
    launcher = await verificationExecutable(["bwrap"]);
    sandbox = "linux-bubblewrap";
    args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
    ];
    for (const root of [...new Set(command.readRoots)]) {
      try {
        await access(root);
      } catch {
        continue;
      }
      if (
        command.deniedRoots.some(
          (denied) =>
            root === denied ||
            root.startsWith(denied + "/") ||
            denied.startsWith(root + "/"),
        )
      )
        return unavailable(
          "The Linux verifier cannot expose a toolchain root containing a permanent filesystem denial",
        );
      args.push("--ro-bind", root, root);
    }
    args.push(
      "--ro-bind",
      input,
      input,
      "--bind",
      output,
      output,
      "--chdir",
      output,
      "--",
      executable,
      ...command.args,
    );
  } else
    return unavailable(
      "Confined execution verification is unavailable on this platform",
    );
  const started = Date.now();
  return new Promise<ConfinedResult>((resolveResult, reject) => {
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    let timedOut = false,
      cancelled = false,
      truncated = false;
    let stopPromise: Promise<void> | undefined;
    let child: ReturnType<typeof spawn>;
    const stop = () => {
      if (!stopPromise && child.pid)
        stopPromise = killTree(child.pid, 100).catch(() => undefined);
      return stopPromise;
    };
    try {
      child = spawn(launcher, args, {
        cwd: output,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (child.pid) command.onSpawn?.(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, command.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      void stop();
    };
    command.signal?.addEventListener("abort", onAbort, { once: true });
    if (command.signal?.aborted) onAbort();
    const collect = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
      const before = kind === "stdout" ? stdout : stderr;
      const room =
        VERIFICATION_MAX_OUTPUT_BYTES - stdout.length - stderr.length;
      const next = Buffer.concat([
        before,
        chunk.subarray(0, Math.max(0, room)),
      ]);
      if (kind === "stdout") stdout = next;
      else stderr = next;
      if (chunk.length > room) {
        truncated = true;
        void stop();
      }
    };
    child.stdout!.on("data", collect("stdout"));
    child.stderr!.on("data", collect("stderr"));
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(command.stdin ?? "");
    child.once("error", (error) => {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", onAbort);
      reject(
        new AppError(
          409,
          "verifier_unavailable",
          `Confined verifier could not start: ${error.message}`,
        ),
      );
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", onAbort);
      // The leader can exit while descendants continue. Reap its process group before releasing.
      await stop();
      resolveResult({
        executable,
        args: command.args,
        cwd: output,
        sandbox,
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        cancelled,
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}
