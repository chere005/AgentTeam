import { spawn, type ChildProcess } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { AppError } from "./model.ts";

/**
 * Spawn planning for provider executables.
 *
 * Node refuses to spawn `.cmd`/`.bat` files without a shell on current releases (EINVAL), and
 * AgentTeam never uses `shell: true`. npm-style Windows shims are therefore launched by
 * resolving the Node script they wrap (no shell involved), or, for other batch files, through
 * `cmd.exe /d /s /c` with cross-spawn-compatible argument escaping. Arguments that cmd.exe
 * cannot carry safely (line breaks, NUL) are rejected instead of being truncated or reinterpreted.
 */
export type SpawnPlan = {
  command: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
  via: "direct" | "node-script" | "cmd-shell";
};
export type SpawnPlanOptions = {
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
  comspec?: string;
};
export function isWindowsShim(
  executable: string,
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}
const meta = /([()\][%!^"`<>&|;, *?])/g;
export function escapeCmdArgument(value: string, double: boolean) {
  if (/[\r\n\0]/.test(value))
    throw new AppError(
      400,
      "shim_argument",
      "A Windows command shim cannot receive line breaks in arguments. Point the executable override at the underlying .exe or node script instead.",
    );
  let arg = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  arg = `"${arg}"`;
  arg = arg.replace(meta, "^$1");
  if (double) arg = arg.replace(meta, "^$1");
  return arg;
}
/** Extract the Node entry script an npm-generated .cmd shim wraps, if recognisable. */
export function shimNodeScript(text: string): string | null {
  const match = text.match(/"%(?:~dp0|dp0%)\\?([^"%]+?\.(?:c|m)?js)"/i);
  return match ? match[1].replace(/^[\\/]+/, "") : null;
}
export async function planSpawn(
  executable: string,
  args: string[],
  options: SpawnPlanOptions = {},
): Promise<SpawnPlan> {
  const platform = options.platform ?? process.platform;
  if (!isWindowsShim(executable, platform))
    return { command: executable, args, options: {}, via: "direct" };
  const readText =
    options.readText ?? ((path: string) => readFile(path, "utf8"));
  const exists =
    options.exists ??
    ((path: string) =>
      access(path).then(
        () => true,
        () => false,
      ));
  const directory = win32.dirname(executable);
  if (/\.cmd$/i.test(executable))
    try {
      const script = shimNodeScript(await readText(executable));
      if (script) {
        const bundled = win32.join(directory, "node.exe");
        return {
          command: (await exists(bundled)) ? bundled : "node",
          args: [win32.join(directory, script), ...args],
          options: {},
          via: "node-script",
        };
      }
    } catch {
      // unreadable shim: fall through to cmd.exe handling
    }
  const command = (options.comspec ?? process.env.ComSpec ?? "cmd.exe").trim();
  const line = [
    executable.replace(meta, "^$1"),
    ...args.map((a) => escapeCmdArgument(a, true)),
  ].join(" ");
  return {
    command,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
    via: "cmd-shell",
  };
}
/**
 * Stop a spawned provider. For a `cmd-shell` plan, killing cmd.exe would leave the batch file's
 * child running (and holding the pipes), so the whole tree is ended with `taskkill /T /F`.
 */
export function killPlanned(
  child: ChildProcess,
  plan: Pick<SpawnPlan, "via">,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (plan.via === "cmd-shell" && process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    killer.on("error", () => child.kill(signal));
    return;
  }
  child.kill(signal);
}
/** Candidate file names for a command on a platform (Windows also finds .cmd/.bat shims). */
export function executableNames(name: string, platform = process.platform) {
  return platform === "win32"
    ? [name + ".exe", name + ".cmd", name + ".bat"]
    : [name];
}
export const pathModule = (platform: NodeJS.Platform) =>
  platform === "win32" ? win32 : posix;
