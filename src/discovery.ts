import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import type { Store } from "./store.ts";
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
export async function findExecutable(name: string) {
  const home = homedir(),
    names = executableNames(name);
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  // Tests set AGENTTEAM_DISCOVERY_PATH_ONLY=1 so scans never find the developer's real installs.
  const pathOnly = process.env.AGENTTEAM_DISCOVERY_PATH_ONLY === "1";
  const dirs = pathOnly
    ? paths
    : [
        ...paths,
        join(home, ".local", "bin"),
        join(home, ".cargo", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
  if (process.platform === "win32" && !pathOnly)
    dirs.push(
      join(process.env.LOCALAPPDATA ?? home, "Microsoft", "WinGet", "Links"),
      join(process.env.APPDATA ?? home, "npm"),
    );
  const candidates = dirs.flatMap((dir) => names.map((n) => join(dir, n)));
  if (process.platform === "darwin" && name === "codex" && !pathOnly)
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
  if (process.platform === "darwin" && name === "wolframscript" && !pathOnly) {
    for (const root of ["/Applications", join(home, "Applications")])
      try {
        for (const app of (await readdir(root))
          .filter((a) => /^(Wolfram|Mathematica).*\.app$/.test(a))
          .sort()
          .reverse())
          candidates.push(join(root, app, "Contents/MacOS/wolframscript"));
      } catch {}
  }
  if (name === "wolframscript" && process.env.AGENTTEAM_WOLFRAMSCRIPT)
    candidates.unshift(process.env.AGENTTEAM_WOLFRAMSCRIPT);
  for (const path of candidates)
    try {
      await access(
        path,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return path;
    } catch {}
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
export const systemScanDeps: ScanDeps = {
  find: findExecutable,
  check: checkExecutable,
  codexModels,
  async claudeAuth(executable) {
    const plan = await planSpawn(executable, ["auth", "status", "--json"]);
    const result = await exec(plan.command, plan.args, {
      timeout: 8000,
      maxBuffer: 128000,
      windowsHide: true,
      ...plan.options,
    });
    const parsed = JSON.parse(result.stdout);
    return typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
  },
  version: probeVersion,
};
export class RuntimeDiscovery {
  runtimes = structuredClone(defaults);
  scanning = false;
  /** True once a scan has finished for the current overrides; queued work waits until then. */
  settled = false;
  overrides: Record<string, string> = {};
  deps: ScanDeps;
  private inflight: Promise<DetectedRuntime[]> | undefined;
  private dirty = false;
  constructor(store?: Store, deps: ScanDeps = systemScanDeps) {
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
