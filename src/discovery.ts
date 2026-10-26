import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import type { Store } from "./store.ts";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { killPlanned, planSpawn, executableNames } from "./runtime-spawn.ts";
import {
  scanRuntime,
  checkExecutable,
  type Diagnostic,
  type Readiness,
  type ScanDeps,
} from "./runtime-scan.ts";
const exec = promisify(execFile);
export type ModelChoice = {
  id: string;
  name: string;
  efforts: string[];
  description?: string;
  /** Set when the installation marks this as its default model. */
  isDefault?: boolean;
};
export type DetectedRuntime = {
  id: "codex" | "claude" | "wolfram";
  installed: boolean;
  executable: string | null;
  authenticated: boolean | null;
  models: ModelChoice[];
  modelSource: string;
  execution: string;
  adapter: string;
  note?: string;
  /** Where `executable` came from: a manual override, auto-detection, or nowhere. */
  source?: "manual" | "auto" | "none";
  version?: string;
  /** What auto-detection finds regardless of a manual override. */
  autoDetected?: string | null;
  /** Set when a manual override no longer points at a usable executable. */
  staleOverride?: { path: string; reason: string };
  diagnostics?: Diagnostic[];
};
export const defaults: DetectedRuntime[] = [
  {
    id: "codex",
    installed: false,
    executable: null,
    authenticated: null,
    adapter: "cli",
    execution: "read-only",
    modelSource: "provider-default",
    models: [{ id: "default", name: "Codex default", efforts: [] }],
  },
  {
    id: "claude",
    installed: false,
    executable: null,
    authenticated: null,
    adapter: "cli",
    execution: "chat-only",
    modelSource: "provider-aliases",
    models: [
      { id: "default", name: "Claude recommended", efforts: [] },
      ...["sonnet", "opus", "haiku"].map((id) => ({
        id,
        name: id[0].toUpperCase() + id.slice(1),
        efforts: ["low", "medium", "high", "xhigh", "max"],
      })),
    ],
  },
  {
    id: "wolfram",
    installed: false,
    executable: null,
    authenticated: null,
    adapter: "wolframscript",
    execution: "LLMSynthesize",
    modelSource: "evaluator-aliases",
    models: [
      { id: "default", name: "Wolfram installation default", efforts: [] },
      { id: "WolframAIAssistant", name: "Wolfram AI Assistant", efforts: [] },
    ],
  },
];
export const executablePaths: Record<string, string> = {};
export function normalizeModels(data: any): ModelChoice[] {
  return (Array.isArray(data) ? data : [])
    .filter(
      (m: any) =>
        typeof m.model === "string" &&
        !m.hidden &&
        m.visibility !== "hide" &&
        m.visibility !== "none",
    )
    .map((m: any) => ({
      id: m.model,
      name: m.displayName ?? m.model,
      description: m.description,
      isDefault: m.isDefault === true || undefined,
      efforts: (m.supportedReasoningEfforts ?? [])
        .map((e: any) => e.reasoningEffort ?? e.effort)
        .filter((e: unknown) => typeof e === "string"),
    }));
}
type BundleOptions = {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
};
async function mtimeOf(path: string) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
async function subdirs(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
/** The `<hash>` folder under `dir` whose `file` was modified last, as a path plus its mtime. */
async function newestIn(dir: string, file: string) {
  let best: { path: string; mtime: number } | undefined;
  for (const hash of await subdirs(dir)) {
    const path = join(dir, hash, file);
    const mtime = await mtimeOf(path);
    if (mtime !== null && (!best || mtime > best.mtime)) best = { path, mtime };
  }
  return best;
}
/** Numeric semver-style segments, or null for a folder name that is not a plain version. */
function versionParts(name: string) {
  return /^\d+(\.\d+)*$/.test(name) ? name.split(".").map(Number) : null;
}
function compareVersions(a: number[] | null, b: number[] | null) {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
/**
 * Executables bundled by the Claude and Codex desktop apps. They live in versioned or hashed
 * folders that are not on PATH. Returns existing files, newest first; never throws.
 */
export async function bundledExecutables(
  name: string,
  { platform, home, env }: BundleOptions,
): Promise<string[]> {
  const win = platform === "win32";
  if (name === "codex") {
    if (!win) return [];
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const found: { path: string; mtime: number }[] = [];
    const root = join(local, "OpenAI", "Codex", "bin");
    for (const hash of await subdirs(root)) {
      const path = join(root, hash, "codex.exe");
      const mtime = await mtimeOf(path);
      if (mtime !== null) found.push({ path, mtime });
    }
    return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
  }
  if (name !== "claude") return [];
  const file = win ? "claude.exe" : "claude";
  const roots: string[] = [];
  if (win) {
    roots.push(
      join(
        env.APPDATA ?? join(home, "AppData", "Roaming"),
        "Claude",
        "claude-code",
      ),
    );
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    for (const pkg of (await subdirs(join(local, "Packages")))
      .filter((d) => d.startsWith("Claude_"))
      .sort())
      roots.push(
        join(
          local,
          "Packages",
          pkg,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude-code",
        ),
      );
  } else if (platform === "darwin")
    roots.push(
      join(home, "Library", "Application Support", "Claude", "claude-code"),
    );
  else roots.push(join(home, ".config", "Claude", "claude-code"));
  const found: { path: string; mtime: number; version: number[] | null }[] = [];
  for (const root of roots)
    for (const version of await subdirs(root)) {
      const best = await newestIn(join(root, version), file);
      if (best) found.push({ ...best, version: versionParts(version) });
    }
  return found
    .sort((a, b) => compareVersions(a.version, b.version) || b.mtime - a.mtime)
    .map((f) => f.path);
}
/**
 * Find a harness executable. Order: real executables on PATH and in the usual install folders,
 * then the Claude/Codex desktop app bundles, then `.cmd`/`.bat` shims (Windows). A real
 * executable beats a shim because shims launched through cmd.exe cannot carry line breaks in
 * arguments. `opts` exists so tests can run against a fake machine.
 */
export async function findExecutable(
  name: string,
  opts: Partial<BundleOptions> = {},
) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir(),
    env = opts.env ?? process.env;
  const win = platform === "win32";
  const names = executableNames(name, platform);
  const direct = names.filter((n) => !/\.(cmd|bat)$/i.test(n));
  const shims = names.filter((n) => !direct.includes(n));
  const paths = (env.PATH ?? "").split(win ? ";" : delimiter).filter(Boolean);
  // Tests set AGENTTEAM_DISCOVERY_PATH_ONLY=1 so scans never find the developer's real installs.
  const pathOnly = env.AGENTTEAM_DISCOVERY_PATH_ONLY === "1";
  const dirs = pathOnly
    ? paths
    : [
        ...paths,
        join(home, ".local", "bin"),
        join(home, ".cargo", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
  if (win && !pathOnly)
    dirs.push(
      join(env.LOCALAPPDATA ?? home, "Microsoft", "WinGet", "Links"),
      join(env.APPDATA ?? home, "npm"),
    );
  const candidates = dirs.flatMap((dir) => direct.map((n) => join(dir, n)));
  if (platform === "darwin" && name === "codex" && !pathOnly)
    for (const root of ["/Applications", join(home, "Applications")])
      for (const app of ["Codex.app", "ChatGPT.app"])
        candidates.push(
          join(
            root,
            app,
            "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
          ),
          join(root, app, "Contents/Resources/codex"),
        );
  if (platform === "darwin" && name === "wolframscript" && !pathOnly) {
    for (const root of ["/Applications", join(home, "Applications")])
      try {
        for (const app of (await readdir(root))
          .filter((a) => /^(Wolfram|Mathematica).*\.app$/.test(a))
          .sort()
          .reverse())
          candidates.push(join(root, app, "Contents/MacOS/wolframscript"));
      } catch {}
  }
  if (name === "wolframscript" && env.AGENTTEAM_WOLFRAMSCRIPT)
    candidates.unshift(env.AGENTTEAM_WOLFRAMSCRIPT);
  const exists = async (path: string) => {
    try {
      await access(path, win ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const path of candidates) if (await exists(path)) return path;
  if (!pathOnly)
    for (const path of await bundledExecutables(name, { platform, home, env }))
      if (await exists(path)) return path;
  for (const path of dirs.flatMap((dir) => shims.map((n) => join(dir, n))))
    if (await exists(path)) return path;
  return null;
}
export async function codexModels(
  executable: string,
): Promise<{ models: ModelChoice[]; authenticated: boolean | null }> {
  const plan = await planSpawn(executable, ["app-server", "--stdio"]);
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
      ...plan.options,
    });
    let buffer = "",
      bytes = 0,
      done = false,
      models: ModelChoice[] | undefined,
      authenticated: boolean | null = null,
      accountDone = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killPlanned(child, plan);
      const force = setTimeout(() => killPlanned(child, plan, "SIGKILL"), 1000);
      force.unref();
      child.once("close", () => clearTimeout(force));
      error ? reject(error) : resolve({ models: models ?? [], authenticated });
    };
    const timer = setTimeout(
      () => finish(new Error("Model discovery timed out")),
      10000,
    );
    const send = (value: unknown) =>
      child.stdin.write(JSON.stringify(value) + "\n");
    child.once("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        finish(new Error("Discovery output limit"));
        return;
      }
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) {
              finish(new Error("Initialization unavailable"));
              return;
            }
            send({ method: "initialized", params: {} });
            send({
              id: 2,
              method: "model/list",
              params: { limit: 100, includeHidden: false },
            });
            send({
              id: 3,
              method: "account/read",
              params: { refreshToken: false },
            });
          }
          if (message.id === 2) models = normalizeModels(message.result?.data);
          if (message.id === 3) {
            accountDone = true;
            authenticated = message.error ? null : !!message.result?.account;
          }
          if (models && accountDone) finish();
        } catch {}
      }
    });
    child.once("close", () => {
      if (!done) finish(new Error("Discovery process exited"));
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agentteam", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
async function probeVersion(executable: string) {
  const plan = await planSpawn(executable, ["--version"]);
  const result = await exec(plan.command, plan.args, {
    timeout: 5000,
    maxBuffer: 64000,
    windowsHide: true,
    ...plan.options,
  });
  return result.stdout.trim().split(/\r?\n/)[0].slice(0, 120) || null;
}
/**
 * Read `loggedIn` from `claude auth status --json` output. Returns null when the output holds no
 * JSON object with a boolean `loggedIn` (tolerates noise around the first `{...}` block).
 */
export function parseClaudeAuthStatus(stdout: string): boolean | null {
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };
  let parsed = parse(stdout);
  if (parsed === undefined) {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = parse(stdout.slice(start, end + 1));
  }
  const loggedIn =
    parsed && typeof parsed === "object"
      ? (parsed as { loggedIn?: unknown }).loggedIn
      : undefined;
  return typeof loggedIn === "boolean" ? loggedIn : null;
}
export const systemScanDeps: ScanDeps = {
  find: findExecutable,
  check: checkExecutable,
  codexModels,
  async claudeAuth(executable) {
    const plan = await planSpawn(executable, ["auth", "status", "--json"]);
    let stdout: string;
    try {
      ({ stdout } = await exec(plan.command, plan.args, {
        timeout: 8000,
        maxBuffer: 128000,
        windowsHide: true,
        ...plan.options,
      }));
    } catch (error) {
      // Signed out, the CLI exits non-zero but still prints the status JSON on stdout.
      const output = (error as { stdout?: unknown }).stdout;
      const status =
        typeof output === "string" ? parseClaudeAuthStatus(output) : null;
      if (status === null) throw error;
      return status;
    }
    return parseClaudeAuthStatus(stdout);
  },
  version: probeVersion,
};
export class RuntimeDiscovery {
  store?: Store;
  runtimes = structuredClone(defaults);
  scanning = false;
  /** True once a scan has finished for the current overrides; queued work waits until then. */
  settled = false;
  overrides: Record<string, string> = {};
  deps: ScanDeps;
  private inflight: Promise<DetectedRuntime[]> | undefined;
  private dirty = false;
  constructor(store?: Store, deps: ScanDeps = systemScanDeps) {
    this.store = store;
    this.deps = deps;
    if (store)
      try {
        this.overrides = store.get<any>("settings", "harnesses").paths ?? {};
      } catch {}
  }
  /** Change (or with null clear) a manual executable; the runtime is unresolved until the next scan ends. */
  setOverride(id: string, path: string | null) {
    if (path) this.overrides[id] = path;
    else delete this.overrides[id];
    delete executablePaths[id];
    this.settled = false;
  }
  /** Whether work for `environment` may start now. */
  readiness(environment: string): Readiness {
    if (!this.settled) return { state: "resolving" };
    const runtime = this.runtimes.find((r) => r.id === environment);
    if (!runtime) return { state: "ready" };
    if (runtime.installed && runtime.authenticated === false)
      return {
        state: "unavailable",
        message:
          runtime.diagnostics?.find((d) => d.code === "signed_out")?.message ??
          `${environment} is installed but needs you to sign in again.`,
      };
    if (runtime.installed) return { state: "ready" };
    return {
      state: "unavailable",
      message:
        runtime.diagnostics?.find((d) => d.level === "error")?.message ??
        runtime.note ??
        `${environment} is not installed`,
    };
  }
  /** Rescan. A request that arrives mid-scan triggers one more full pass so it never returns stale results. */
  refresh(): Promise<DetectedRuntime[]> {
    if (this.store) {
      try {
        filesystemPolicy(this.store).assertConfinedExecution();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.dirty = true;
    if (this.inflight) return this.inflight;
    this.scanning = true;
    const run = async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          const previous = this.runtimes;
          const overrides = { ...this.overrides };
          const next = await Promise.all(
            defaults.map((initial) =>
              scanRuntime(
                initial,
                overrides[initial.id],
                this.deps,
                previous.find((r) => r.id === initial.id),
              ),
            ),
          );
          for (const runtime of next)
            if (runtime.installed && runtime.executable)
              executablePaths[runtime.id] = runtime.executable;
            else delete executablePaths[runtime.id];
          this.runtimes = next;
        }
        return this.runtimes;
      } catch (error) {
        // A failed scan must not strand queued work in "resolving": report every runtime as unavailable.
        const reason = `Runtime discovery failed (${error instanceof Error ? error.message : String(error)}). Rescan in Settings.`;
        this.dirty = false;
        this.runtimes = defaults.map((initial) => ({
          ...structuredClone(initial),
          installed: false,
          note: reason,
          diagnostics: [
            { level: "error", code: "discovery_failed", message: reason },
          ],
        }));
        for (const runtime of defaults) delete executablePaths[runtime.id];
        return this.runtimes;
      } finally {
        this.settled = true;
        this.scanning = false;
        this.inflight = undefined;
      }
    };
    return (this.inflight = run());
  }
}
