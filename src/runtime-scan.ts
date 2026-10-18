import { stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import type { DetectedRuntime, ModelChoice } from "./discovery.ts";
import { isWindowsShim } from "./runtime-spawn.ts";

export type Diagnostic = {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
};
export type ExecutableCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "not-a-file" | "not-executable" };
export type ScanDeps = {
  /** Auto-detection for `codex`, `claude` or `wolframscript`. */
  find(name: string): Promise<string | null>;
  check(path: string): Promise<ExecutableCheck>;
  codexModels(
    executable: string,
  ): Promise<{ models: ModelChoice[]; authenticated: boolean | null }>;
  claudeAuth(executable: string): Promise<boolean | null>;
  version(executable: string): Promise<string | null>;
  platform?: NodeJS.Platform;
};
export async function checkExecutable(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecutableCheck> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!info.isFile()) return { ok: false, reason: "not-a-file" };
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    return { ok: false, reason: "not-executable" };
  }
  return { ok: true };
}
/** Effort levels offered for "provider default": the default model's, else those every listed model supports. */
export function defaultModelEfforts(models: ModelChoice[]) {
  const real = models.filter((m) => m.id !== "default");
  const flagged = real.find((m) => m.isDefault);
  if (flagged) return [...flagged.efforts];
  if (!real.length) return [];
  return real[0].efforts.filter((e) =>
    real.every((m) => m.efforts.includes(e)),
  );
}
const staleReason = {
  missing: "no longer exists",
  "not-a-file": "is not a file",
  "not-executable": "is not executable",
} as const;
const commandName = (id: DetectedRuntime["id"]) =>
  id === "wolfram" ? "wolframscript" : id;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/**
 * Resolve one runtime. A manual override is honoured exactly: when it has gone stale the runtime
 * is reported unavailable (with the auto-detected alternative named) rather than silently
 * switching to another installation or to whatever happens to be on PATH.
 */
export async function scanRuntime(
  initial: DetectedRuntime,
  override: string | undefined,
  deps: ScanDeps,
  previous?: DetectedRuntime,
): Promise<DetectedRuntime> {
  const runtime = structuredClone(initial);
  const diagnostics: Diagnostic[] = [];
  runtime.diagnostics = diagnostics;
  const platform = deps.platform ?? process.platform;
  const auto = await deps.find(commandName(runtime.id)).catch(() => null);
  runtime.autoDetected = auto;
  if (override) {
    runtime.executable = override;
    runtime.source = "manual";
    const checked = await deps.check(override);
    if (!checked.ok) {
      runtime.installed = false;
      runtime.staleOverride = { path: override, reason: checked.reason };
      diagnostics.push({
        level: "error",
        code: "manual_path_stale",
        message: `The manual executable ${override} ${staleReason[checked.reason]}.`,
      });
      diagnostics.push(
        auto
          ? {
              level: "info",
              code: "auto_available",
              message: `An installation was auto-detected at ${auto}. Choose Auto-detect to use it.`,
            }
          : {
              level: "info",
              code: "reset_hint",
              message:
                "Choose a new executable, or reset to auto-detect after installing the provider.",
            },
      );
      runtime.note = diagnostics[0].message;
      return runtime;
    }
  } else if (auto) {
    runtime.executable = auto;
    runtime.source = "auto";
  } else {
    runtime.installed = false;
    runtime.source = "none";
    diagnostics.push({
      level: "error",
      code: "not_found",
      message: `No ${commandName(runtime.id)} installation was found on PATH or in the usual install locations. Install it or choose an executable.`,
    });
    runtime.note = "Installation not found";
    return runtime;
  }
  const executable = runtime.executable!;
  runtime.installed = true;
  if (isWindowsShim(executable, platform))
    diagnostics.push({
      level: "info",
      code: "windows_shim",
      message:
        "Command shim detected; it is launched without a shell (Node script) or through cmd.exe with escaped arguments.",
    });
  if (runtime.id !== "wolfram") {
    // Never run wolframscript for diagnostics: it can start a kernel and consume a license.
    runtime.version =
      (await deps.version(executable).catch(() => null)) ?? undefined;
    if (
      previous?.executable === executable &&
      previous.version &&
      runtime.version &&
      previous.version !== runtime.version
    )
      diagnostics.push({
        level: "info",
        code: "upgraded",
        message: `Installation changed from ${previous.version} to ${runtime.version}; models were rediscovered.`,
      });
  }
  try {
    if (runtime.id === "codex") {
      const found = await deps.codexModels(executable);
      runtime.authenticated = found.authenticated;
      if (found.models.length) {
        runtime.models = [runtime.models[0], ...found.models];
        runtime.modelSource = "installed-codex";
        runtime.models[0].efforts = defaultModelEfforts(runtime.models);
      } else
        diagnostics.push({
          level: "warn",
          code: "no_models",
          message:
            "The installed Codex advertised no models; only its default can be selected.",
        });
      if (found.authenticated === false)
        diagnostics.push({
          level: "warn",
          code: "signed_out",
          message:
            "Codex is installed but not signed in. Run `codex login` in a terminal.",
        });
      else if (found.authenticated === null)
        diagnostics.push({
          level: "info",
          code: "auth_unknown",
          message:
            "Codex did not report account status; existing provider configuration will be used.",
        });
    } else if (runtime.id === "claude") {
      runtime.models[0].efforts = defaultModelEfforts(runtime.models);
      runtime.authenticated = await deps.claudeAuth(executable);
      if (runtime.authenticated === false)
        diagnostics.push({
          level: "warn",
          code: "signed_out",
          message:
            "Claude Code is installed but not signed in. Run `claude auth login` in a terminal.",
        });
      else if (runtime.authenticated === null)
        diagnostics.push({
          level: "info",
          code: "auth_unknown",
          message:
            "This Claude Code version did not report login status; existing configuration will be used.",
        });
    } else
      diagnostics.push({
        level: "info",
        code: "wolfram_config",
        message:
          "Uses your existing Wolfram LLM configuration. The installation is not executed during scanning.",
      });
  } catch (error) {
    runtime.models = structuredClone(initial.models);
    runtime.models[0].efforts = defaultModelEfforts(runtime.models);
    diagnostics.push({
      level: "warn",
      code: "discovery_failed",
      message: `Installation detected, but account or model discovery failed (${message(error)}). Existing provider configuration will be used.`,
    });
  }
  runtime.note =
    diagnostics.find((d) => d.level !== "info")?.message ??
    diagnostics[0]?.message;
  return runtime;
}
export type Readiness =
  | { state: "ready" }
  | { state: "resolving" }
  | { state: "unavailable"; message: string };
