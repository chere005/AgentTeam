import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { AppError, assert } from "./model.ts";
import { locate } from "./locate.ts";
import { planSpawn } from "./runtime-spawn.ts";
import type { Store } from "./store.ts";
import type { WorkspaceService } from "./workspaces.ts";

/**
 * External editors and file-manager launching.
 *
 * Commands are built as argv (never a shell line). `planOpen` is pure apart from two injected
 * probes, so the platform-specific tables are fixture-testable on any OS. Only macOS has been run
 * for real on a developer machine; Windows and Linux paths are covered by fixtures only.
 */
export type EditorId = "sublime" | "vscode" | "system" | "custom";
export type OpenAction = "file" | "project" | "reveal" | "with";
export type EditorPaths = Partial<
  Record<"sublime" | "vscode" | "custom", string>
>;
export type OpenPlan = {
  executable: string;
  args: string[];
  /** The editor that will run (reveal always uses the file manager). */
  application: EditorId | "finder";
  /** How the executable was chosen: configured, a known install location, PATH lookup, or OS default. */
  source: "configured" | "installed" | "path" | "system" | "macos-app-name";
};
export type PlanEnv = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists: (path: string) => Promise<boolean>;
  /** Resolve a command name on PATH; null when absent. */
  which: (name: string) => Promise<string | null>;
};

const NAMES = {
  sublime: "Sublime Text",
  vscode: "Visual Studio Code",
} as const;
const path = (platform: NodeJS.Platform) =>
  platform === "win32" ? win32 : posix;

/** Known install locations, in preference order. Pure: depends only on platform and environment. */
export function installedCandidates(
  platform: NodeJS.Platform,
  editor: "sublime" | "vscode",
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs"),
    ].filter((v): v is string => !!v);
    return roots.flatMap((r) =>
      editor === "sublime"
        ? [
            win32.join(r, "Sublime Text", "subl.exe"),
            win32.join(r, "Sublime Text", "sublime_text.exe"),
          ]
        : [
            win32.join(r, "Microsoft VS Code", "Code.exe"),
            win32.join(r, "Microsoft VS Code", "bin", "code.cmd"),
          ],
    );
  }
  if (platform === "darwin")
    return editor === "sublime"
      ? ["/Applications/Sublime Text.app"]
      : ["/Applications/Visual Studio Code.app"];
  return editor === "sublime"
    ? ["/opt/sublime_text/sublime_text", "/snap/bin/subl"]
    : ["/usr/share/code/bin/code", "/snap/bin/code"];
}
const PATH_NAMES = {
  sublime: ["subl", "sublime_text", "sublime-text"],
  vscode: ["code"],
};

export function validExecutablePath(platform: NodeJS.Platform, value: string) {
  return (
    !!value &&
    value.length <= 1024 &&
    !/[\0\r\n]/.test(value) &&
    path(platform).isAbsolute(value)
  );
}
const isMacApp = (value: string) => /\.app[\\/]*$/i.test(value);

/** Pick the executable for an editor and the argv that opens `target` with it. */
async function editorCommand(
  p: PlanEnv,
  editor: "sublime" | "vscode" | "custom",
  target: string,
  paths: EditorPaths,
): Promise<OpenPlan> {
  const configured = paths[editor];
  if (editor === "custom")
    assert(
      configured,
      "editor_not_configured",
      "Set a custom application path in Preferences first",
      400,
    );
  if (configured) {
    assert(
      validExecutablePath(p.platform, configured),
      "invalid_editor_path",
      "The configured editor path must be absolute",
      400,
    );
    if (p.platform === "darwin" && isMacApp(configured))
      return {
        executable: "/usr/bin/open",
        args: ["-a", configured, "--", target],
        application: editor,
        source: "configured",
      };
    return {
      executable: configured,
      args: editor === "custom" ? [target] : ["--", target],
      application: editor,
      source: "configured",
    };
  }
  const known = editor as "sublime" | "vscode";
  if (p.platform === "darwin") {
    for (const app of installedCandidates(p.platform, known, p.env))
      if (await p.exists(app))
        return {
          executable: "/usr/bin/open",
          args: ["-a", app, "--", target],
          application: editor,
          source: "installed",
        };
    // Not under /Applications: let LaunchServices find it by name.
    return {
      executable: "/usr/bin/open",
      args: ["-a", NAMES[known], "--", target],
      application: editor,
      source: "macos-app-name",
    };
  }
  for (const exe of installedCandidates(p.platform, known, p.env))
    if (await p.exists(exe))
      return {
        executable: exe,
        args: ["--", target],
        application: editor,
        source: "installed",
      };
  for (const name of PATH_NAMES[known]) {
    const found = await p.which(name);
    if (found)
      return {
        executable: found,
        args: ["--", target],
        application: editor,
        source: "path",
      };
  }
  // Unresolved: launching the bare command reports a clear "not found" at execution time.
  return {
    executable: PATH_NAMES[known][0],
    args: ["--", target],
    application: editor,
    source: "path",
  };
}

export type PlanInput = {
  action: OpenAction;
  editor: EditorId;
  /** Absolute, already boundary-checked path. */
  target: string;
  isDirectory: boolean;
  paths: EditorPaths;
};
/** Build the launch command. `action: "reveal"` uses the platform file manager. */
export async function planOpen(
  p: PlanEnv,
  input: PlanInput,
): Promise<OpenPlan> {
  const { target } = input;
  if (input.action === "reveal") {
    if (p.platform === "darwin")
      return {
        executable: "/usr/bin/open",
        args: ["-R", target],
        application: "finder",
        source: "system",
      };
    if (p.platform === "win32")
      return {
        executable: "explorer.exe",
        // explorer parses /select,<path> as a single argument.
        args: input.isDirectory ? [target] : [`/select,${target}`],
        application: "finder",
        source: "system",
      };
    // xdg-open cannot select a file; open its folder.
    return {
      executable: "xdg-open",
      args: [input.isDirectory ? target : posix.dirname(target)],
      application: "finder",
      source: "system",
    };
  }
  if (input.editor === "system") {
    if (p.platform === "darwin")
      return {
        executable: "/usr/bin/open",
        args: ["--", target],
        application: "system",
        source: "system",
      };
    return {
      executable: p.platform === "win32" ? "explorer.exe" : "xdg-open",
      args: [target],
      application: "system",
      source: "system",
    };
  }
  return editorCommand(p, input.editor, target, input.paths);
}

const defaultProbe = (
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): PlanEnv => ({
  platform,
  env,
  exists: (p) =>
    access(p).then(
      () => true,
      () => false,
    ),
  which: async (name) => {
    const dirs = (env.PATH ?? "").split(platform === "win32" ? ";" : ":");
    const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const dir of dirs.filter(Boolean))
      for (const ext of exts) {
        const full = path(platform).join(dir, name + ext);
        try {
          await access(
            full,
            platform === "win32" ? constants.F_OK : constants.X_OK,
          );
          if ((await stat(full)).isFile()) return full;
        } catch {
          /* keep looking */
        }
      }
    return null;
  },
});

const editorSettingsSchema = z
  .object({
    sublime: z.string().max(1024).nullable().optional(),
    vscode: z.string().max(1024).nullable().optional(),
    custom: z.string().max(1024).nullable().optional(),
  })
  .strict();
const openSchema = z
  .object({
    workspace: z.string(),
    path: z.string().default("."),
    action: z.enum(["file", "project", "reveal", "with"]).optional(),
    /** `application` is the legacy name used by earlier UI builds. */
    editor: z.enum(["sublime", "vscode", "system", "custom"]).optional(),
    application: z
      .enum(["sublime", "vscode", "system", "finder", "custom"])
      .optional(),
  })
  .strict();

export class EditorService {
  store: Store;
  ws: WorkspaceService;
  probe: () => PlanEnv;
  /** Replaced in tests; the default really starts the process. */
  launcher: (plan: OpenPlan) => Promise<void>;
  constructor(
    store: Store,
    ws: WorkspaceService,
    options: {
      probe?: () => PlanEnv;
      launcher?: (plan: OpenPlan) => Promise<void>;
    } = {},
  ) {
    this.store = store;
    this.ws = ws;
    this.probe = options.probe ?? (() => defaultProbe());
    this.launcher = options.launcher ?? launch;
  }
  paths(): EditorPaths {
    try {
      return this.store.get<{ paths: EditorPaths }>("settings", "editors")
        .paths;
    } catch {
      return {};
    }
  }
  /** Saved paths plus whether each editor was found on this machine. */
  async settings() {
    const p = this.probe(),
      paths = this.paths(),
      detected: Record<string, { found: boolean; path: string | null }> = {};
    for (const editor of ["sublime", "vscode"] as const) {
      const configured = paths[editor];
      if (configured) {
        detected[editor] = {
          found: await p.exists(configured),
          path: configured,
        };
        continue;
      }
      let found: string | null = null;
      for (const c of installedCandidates(p.platform, editor, p.env))
        if (!found && (await p.exists(c))) found = c;
      for (const n of PATH_NAMES[editor]) found ??= await p.which(n);
      detected[editor] = { found: !!found, path: found };
    }
    return {
      ...this.ws.settings(),
      paths,
      detected,
      platform: p.platform,
    };
  }
  /** Save executable overrides; null/empty clears one. Paths must exist on this machine. */
  async save(input: unknown) {
    const data = editorSettingsSchema.parse(input),
      p = this.probe(),
      next: EditorPaths = { ...this.paths() };
    for (const key of ["sublime", "vscode", "custom"] as const) {
      const value = data[key];
      if (value === undefined) continue;
      if (value === null || value.trim() === "") {
        delete next[key];
        continue;
      }
      assert(
        validExecutablePath(p.platform, value),
        "invalid_editor_path",
        "Use an absolute path to the editor executable",
        400,
      );
      let ok = false;
      try {
        const info = await stat(value);
        ok =
          p.platform === "darwin" && isMacApp(value)
            ? info.isDirectory()
            : info.isFile();
        if (ok && p.platform !== "win32" && !isMacApp(value))
          await access(value, constants.X_OK);
      } catch {
        ok = false;
      }
      assert(ok, "editor_not_found", `No executable found at ${value}`, 400);
      next[key] = value;
    }
    this.store.put("settings", { id: "editors", paths: next });
    this.store.emit("settings.editors_updated", "editors", {
      configured: Object.keys(next),
    });
    return this.settings();
  }
  async open(agentId: string, input: unknown, execute: boolean) {
    const data = openSchema.parse(input);
    const loc = await locate(this.ws, agentId, {
      workspace: data.workspace,
      path: data.action === "project" ? "." : data.path,
    });
    const isDirectory = (await stat(loc.target)).isDirectory();
    // Legacy `application: "finder"` meant reveal.
    const action: OpenAction =
      data.action ??
      (data.application === "finder"
        ? "reveal"
        : data.path === "." || isDirectory
          ? "project"
          : "file");
    const editor: EditorId =
      data.editor ??
      (data.application && data.application !== "finder"
        ? data.application
        : this.ws.settings().defaultEditor);
    assert(
      action !== "with" || data.editor || data.application,
      "editor_required",
      "Choose an application for Open with",
      400,
    );
    const plan = await planOpen(this.probe(), {
      action,
      editor,
      target: loc.target,
      isDirectory,
      paths: this.paths(),
    });
    if (execute) {
      try {
        await this.launcher(plan);
      } catch (e) {
        throw e instanceof AppError
          ? e
          : new AppError(
              400,
              "app_unavailable",
              "The selected application could not be opened",
            );
      }
      this.store.emit("workspace.opened", agentId, {
        application: plan.application,
        action,
        path: loc.target,
      });
    }
    return { ...plan, action, executed: execute };
  }
}

/** Start the process detached; fail on spawn errors or an immediate non-zero exit. */
export async function launch(plan: OpenPlan): Promise<void> {
  const spawnPlan = await planSpawn(plan.executable, plan.args);
  await new Promise<void>((done, fail) => {
    let settled = false;
    const finish = (error?: AppError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? fail(error) : done();
    };
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
      ...spawnPlan.options,
    });
    // A launcher that is still running after a moment (a GUI started in the foreground) succeeded.
    const timer = setTimeout(() => {
      child.unref();
      finish();
    }, 1500);
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(
        new AppError(
          400,
          "app_unavailable",
          e.code === "ENOENT"
            ? `Application not found: ${plan.executable}. Set its path in Preferences.`
            : "The selected application could not be opened",
        ),
      ),
    );
    child.on("exit", (code) =>
      code === 0 || code === null
        ? finish()
        : finish(
            new AppError(
              400,
              "app_unavailable",
              `The application exited with code ${code}. Check the path in Preferences.`,
            ),
          ),
    );
  });
}
