import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter, dirname } from "node:path";
import type { Store } from "./store.ts";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type ModelChoice = {
  id: string;
  name: string;
  efforts: string[];
  description?: string;
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
      efforts: (m.supportedReasoningEfforts ?? [])
        .map((e: any) => e.reasoningEffort ?? e.effort)
        .filter((e: unknown) => typeof e === "string"),
    }));
}
export async function findExecutable(name: string) {
  const home = homedir(),
    extension = process.platform === "win32" ? ".exe" : "";
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const dirs = [
    ...paths,
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  if (process.platform === "win32")
    dirs.push(
      join(process.env.LOCALAPPDATA ?? home, "Microsoft", "WinGet", "Links"),
      join(process.env.APPDATA ?? home, "npm"),
    );
  const candidates = [...dirs.map((dir) => join(dir, name + extension))];
  if (process.platform === "darwin" && name === "codex")
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
  if (process.platform === "darwin" && name === "wolframscript") {
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
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
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
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
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
export class RuntimeDiscovery {
  runtimes = structuredClone(defaults);
  scanning = false;
  overrides: Record<string, string> = {};
  constructor(store?: Store) {
    if (store)
      try {
        this.overrides = store.get<any>("settings", "harnesses").paths ?? {};
      } catch {}
  }

  async refresh() {
    if (this.scanning) return this.runtimes;
    this.scanning = true;
    try {
      this.runtimes = await Promise.all(
        defaults.map(async (initial) => {
          const runtime = structuredClone(initial),
            executable =
              this.overrides[initial.id] ??
              (await findExecutable(
                initial.id === "wolfram" ? "wolframscript" : initial.id,
              ));
          runtime.executable = executable;
          runtime.installed = !!executable;
          if (executable)
            try {
              await access(
                executable,
                process.platform === "win32" ? constants.F_OK : constants.X_OK,
              );
            } catch {
              runtime.installed = false;
              delete executablePaths[runtime.id];
              runtime.note = "Configured executable is not available";
              return runtime;
            }
          if (!executable) {
            runtime.note = "Installation not found";
            return runtime;
          }
          executablePaths[runtime.id] = executable;
          try {
            if (runtime.id === "codex") {
              const found = await codexModels(executable);
              runtime.authenticated = found.authenticated;
              if (found.models.length) {
                runtime.models = [runtime.models[0], ...found.models];
                runtime.modelSource = "installed-codex";
              }
            } else if (runtime.id === "claude") {
              const result = await exec(
                executable,
                ["auth", "status", "--json"],
                { timeout: 8000, maxBuffer: 128000 },
              );
              runtime.authenticated =
                JSON.parse(result.stdout).loggedIn === true;
            } else
              runtime.note = "Uses your existing Wolfram LLM configuration";
          } catch {
            runtime.note =
              "Installation detected; account or model discovery unavailable. Existing provider configuration will be used.";
          }
          return runtime;
        }),
      );
      return this.runtimes;
    } finally {
      this.scanning = false;
    }
  }
}
