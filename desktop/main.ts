import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
} from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import { execFile } from "node:child_process";
import { RuntimeDiscovery } from "../src/discovery.ts";
import { ReadinessService } from "../src/readiness.ts";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createApi } from "../src/http.ts";
import { roots, setProjectRoot } from "../src/config.ts";
import { saveDiagnosticBundle } from "../src/diagnostic-save.ts";
import {
  liveDevServerCount,
  previewNavigationAllowed,
  recordPreviewConsole,
  shutdownDevServers,
} from "../src/devserver.ts";
import type { Agent, Session, Workflow } from "../src/model.ts";
import {
  TerminalSessions,
  TerminalError,
  type SpawnPty,
} from "../src/terminal.ts";
import { ensureSpawnHelper } from "../src/terminal-native.ts";
app.setName("AgentTeam");
if (process.env.AGENTTEAM_DATA_DIR)
  app.setPath("userData", process.env.AGENTTEAM_DATA_DIR);
const here = dirname(fileURLToPath(import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
// Desktop tests (AGENTTEAM_TEST=1) run with a hidden window and, on macOS, no Dock icon,
// so a run never takes over the screen or the keyboard focus. Playwright drives the page
// through the DevTools protocol, which works on a hidden window. AGENTTEAM_SHOW_WINDOW=1
// shows it again for watching or debugging a spec.
const hiddenWindow =
  process.env.AGENTTEAM_TEST === "1" &&
  process.env.AGENTTEAM_SHOW_WINDOW !== "1";
if (hiddenWindow && process.platform === "darwin")
  app.setActivationPolicy("accessory");
async function start() {
  const project = app.isPackaged ? process.resourcesPath : join(here, "../..");
  setProjectRoot(project);
  const data = process.env.AGENTTEAM_DATA_DIR ?? app.getPath("userData");
  await mkdir(data, { recursive: true });
  const store = new Store(join(data, "agentteam.sqlite")),
    catalog = new SkillCatalog(roots());
  await catalog.scan();
  const service = new TeamService(store, catalog);
  if (!store.list<Agent>("agent").length)
    await service.saveAgent({
      name: "Team Assistant",
      kind: "team-assistant",
      environment: "codex",
      role: "Help design and coordinate this team",
      instructions:
        "Help the user construct agents and workflows. Clearly distinguish proposed changes from changes already applied.",
    });
  let enabled = process.env.AGENTTEAM_TEST !== "1";
  try {
    enabled = store.get<any>("settings", "execution").enabled === true;
  } catch {}
  const runs = new RunManager(service, enabled, app.getPath("home"));
  runs.recover();
  const scheduler = new Scheduler(service, runs);
  scheduler.start();
  const discovery = new RuntimeDiscovery(store);
  runs.readiness = (environment) => discovery.readiness(environment);
  // Automatic rescans (focus, periodic while blocked, sign-in poll), model checks and re-queues
  // (src/readiness.ts). Test mode never scans on its own unless a spec sets AGENTTEAM_AUTO_RESCAN=1.
  const testMode = process.env.AGENTTEAM_TEST === "1";
  const readiness = new ReadinessService({
    service,
    discovery,
    runs,
    auto: !testMode || process.env.AGENTTEAM_AUTO_RESCAN === "1",
  }).start();
  if (!testMode)
    void readiness.rescan({ always: true }).catch(() => {
      /* reported as runtimes.discovery_blocked */
    });
  const token = randomBytes(32).toString("hex"),
    server = createApi(service, token, runs, discovery, readiness);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Backend failed to start");
  const base = `http://127.0.0.1:${address.port}`;
  let win: BrowserWindow;
  function trusted(event: Electron.IpcMainInvokeEvent) {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      throw new Error("Untrusted IPC sender");
  }
  ipcMain.handle("api", async (event, method, path, body) => {
    trusted(event);
    if (
      !["GET", "POST", "PUT", "DELETE"].includes(method) ||
      typeof path !== "string" ||
      !/^\/[a-z][a-z0-9/\-?=&%]*$/i.test(path)
    )
      throw new Error("Invalid request");
    const response = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.message ??
          result.issues?.map((i: any) => i.message).join("; ") ??
          result.error,
      );
    return result;
  });
  // Terminal tab (src/terminal.ts): the user's own login shell in a PTY, outside AgentTeam's
  // agent locks. The renderer names only a starting folder (home or an attached folder), never
  // an executable (Sign in types the backend's command line, src/readiness.ts, as keystrokes);
  // every PTY ends when the window closes or the app quits.
  let spawnPty: SpawnPty | null = null;
  const loadPty = (): SpawnPty => {
    if (spawnPty) return spawnPty;
    // node-pty is a native module kept outside the esbuild bundle (scripts/build.mjs).
    const pty = require("node-pty") as typeof import("node-pty");
    ensureSpawnHelper(require.resolve("node-pty"));
    spawnPty = (file, args, options) => pty.spawn(file, args, options);
    return spawnPty;
  };
  const sendTerminal = (channel: string, payload: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const terminals = new TerminalSessions({
    spawn: (file, args, options) => loadPty()(file, args, options),
    home: app.getPath("home"),
    folders: () => [
      ...store
        .list<Agent>("agent")
        .flatMap((a) => a.workspaces.map((w) => w.path)),
      ...store
        .list<Workflow & { setup?: { workspace?: unknown } }>("workflow")
        .map((w) => w.setup?.workspace)
        .filter((p): p is string => typeof p === "string"),
    ],
    onData: (event) => sendTerminal("terminal-data", event),
    onExit: (event) => sendTerminal("terminal-exit", event),
  });
  const terminalCall =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (event: Electron.IpcMainInvokeEvent, ...args: A) => {
      trusted(event);
      try {
        return fn(...args);
      } catch (error) {
        throw new Error(
          error instanceof TerminalError
            ? error.message
            : "Terminal failed: " + String((error as Error)?.message ?? error),
        );
      }
    };
  ipcMain.handle(
    "terminal-create",
    terminalCall((options: unknown) => terminals.create(options)),
  );
  ipcMain.handle(
    "terminal-kill",
    terminalCall((id: unknown) => terminals.kill(id)),
  );
  // Keystrokes and resizes are fire-and-forget; an untrusted sender or bad argument is dropped.
  ipcMain.on("terminal-write", (event, id, data) => {
    if (
      event.sender !== win?.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      return;
    try {
      terminals.write(id, data);
    } catch {
      /* ended or invalid */
    }
  });
  ipcMain.on("terminal-resize", (event, id, cols, rows) => {
    if (
      event.sender !== win?.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      return;
    try {
      terminals.resize(id, cols, rows);
    } catch {
      /* ended or invalid */
    }
  });
  // Cmd/Ctrl+click on a link in the terminal: http(s) only, opened in the system browser
  // (recorded instead under AGENTTEAM_TEST=1).
  ipcMain.handle("terminal-open-link", async (event, url) => {
    trusted(event);
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error("Invalid link");
    }
    if (
      typeof url !== "string" ||
      url.length > 4096 ||
      !["http:", "https:"].includes(parsed.protocol)
    )
      throw new Error("Only http and https links open from the terminal");
    if (process.env.AGENTTEAM_TEST === "1")
      server.launches.push({ kind: "url", url: parsed.href });
    else await shell.openExternal(parsed.href);
    return true;
  });
  ipcMain.handle("choose-executable", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(win, {
      title: "Choose harness executable",
      properties: ["openFile"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("choose-folder", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("save-text-file", async (event, name, content) => {
    trusted(event);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 180 ||
      /[\\/\0]/.test(name) ||
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > 256_000 ||
      content.includes("\0")
    )
      throw new Error("Invalid text file");
    const picked = await dialog.showSaveDialog(win, {
      title: "Save text file to your computer",
      defaultPath: join(app.getPath("downloads"), name),
    });
    if (picked.canceled || !picked.filePath) return null;
    filesystemPolicy(store).assertPath(picked.filePath, false);
    await writeFile(picked.filePath, content, { encoding: "utf8" });
    return { path: picked.filePath };
  });
  // Diagnostic bundle "Save as…": the renderer names only the format; this process fetches the
  // redacted bundle, shows the dialog and writes the one chosen file (test mode records instead).
  ipcMain.handle("save-diagnostics", async (event, format) => {
    trusted(event);
    return saveDiagnosticBundle(
      { format },
      {
        testMode: process.env.AGENTTEAM_TEST === "1",
        record: (r) => void server.launches.push(r),
        defaultDirectory: app.getPath("downloads"),
        assertPath: (path) => filesystemPolicy(store).assertPath(path, false),
        showSaveDialog: (options) => dialog.showSaveDialog(win, options),
        fetchBundle: async (f) => {
          const response = await fetch(base + "/inspector/bundle", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ format: f }),
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.message ?? result.error ?? "Export failed");
          return result;
        },
      },
    );
  });
  // Appearance is fixed to Sand Ink; legacy dark/system preferences migrate on next launch.
  ipcMain.handle("set-theme", async (event, setting) => {
    trusted(event);
    if (setting !== "light") throw new Error("Invalid theme");
    if (setting !== storedTheme())
      store.put("settings", { id: "appearance", theme: setting });
    nativeTheme.themeSource = setting;
    win?.setBackgroundColor(windowBackground());
    return true;
  });
  nativeTheme.on("updated", () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
  });
  ipcMain.handle("open-agent", async (event, id, mode) => {
    trusted(event);
    filesystemPolicy(store).assertConfinedExecution();
    const agent = store.get<Agent>("agent", id),
      session = store.list<Session>("session").find((s) => s.agentId === id);
    if (mode === "native") {
      const name =
        agent.environment === "codex"
          ? "Codex"
          : agent.environment === "claude"
            ? "Claude"
            : "Wolfram";
      if (process.platform === "darwin") {
        await new Promise<void>((resolve, reject) =>
          execFile("/usr/bin/open", ["-a", name], (e) =>
            e ? reject(e) : resolve(),
          ),
        );
        return {
          message: `Opened ${name}. Native apps may use a separate conversation.`,
        };
      }
      throw new Error(
        "Native app launching on this platform is available through your desktop app launcher. Use CLI instructions below to resume this session.",
      );
    }
    if (mode !== "cli") throw new Error("Unknown open mode");
    return {
      command:
        agent.environment === "wolfram"
          ? "wolframscript"
          : agent.environment === "codex"
            ? `codex${session?.providerSessionId ? " resume " + session.providerSessionId : ""}`
            : `claude${session?.providerSessionId ? " --resume " + session.providerSessionId : ""}`,
      cwd: agent.workspaces.find((w) => w.active)?.path ?? app.getPath("home"),
      message:
        "Finish active work and Take control before resuming this session externally.",
    };
  });
  function storedTheme(): "light" {
    try {
      const current = store.get<{ theme?: string }>("settings", "appearance");
      if (current.theme !== "light")
        store.put("settings", { ...current, id: "appearance", theme: "light" });
      return "light";
    } catch {
      return "light";
    }
  }
  /** Sand Ink page background from ui/theme-light.css. */
  function windowBackground() {
    return "#eee8dd";
  }
  function createWindow() {
    nativeTheme.themeSource = storedTheme();
    win = new BrowserWindow({
      width: 1500,
      height: 960,
      minWidth: 900,
      minHeight: 600,
      title: "AgentTeam",
      backgroundColor: windowBackground(),
      show: !hiddenWindow,
      paintWhenInitiallyHidden: true,
      // Keep the test window at its full size on a small screen (a hosted macOS runner),
      // so width-dependent layouts match a desktop.
      enableLargerThanScreen: hiddenWindow,
      webPreferences: {
        // A hidden test window must keep timers and animation frames running.
        backgroundThrottling: !hiddenWindow,
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // macOS clamps a new window to the screen; resize after creation (allowed by
    // enableLargerThanScreen) so a 1024 px runner display still gets the desktop size.
    if (hiddenWindow) win.setBounds({ x: 0, y: 0, width: 1500, height: 960 });
    // Links in the embedded preview (target=_blank) open in the system browser,
    // only for the configured development-server origin. Nothing else may open.
    win.webContents.setWindowOpenHandler((details) => {
      if (previewNavigationAllowed(details.url))
        void shell.openExternal(details.url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // Coming back to the app (e.g. after installing or signing in elsewhere) rescans when needed.
    win.on("focus", () => readiness.windowFocused());
    // No orphaned shells: closing the window (or a renderer reload) ends its terminals.
    win.on("closed", () => terminals.killAll());
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) terminals.killAll();
    });
    // The renderer vetoes unload only while an agent has unsaved edits (ui/components/
    // UnsavedGuard.tsx). Ask instead of silently keeping the window open; Esc/Cancel keeps
    // editing. Test mode never shows a dialog and always lets the window close.
    win.webContents.on("will-prevent-unload", (event) => {
      if (process.env.AGENTTEAM_TEST === "1") return event.preventDefault();
      const choice = dialog.showMessageBoxSync(win, {
        type: "question",
        buttons: ["Discard changes", "Keep editing"],
        defaultId: 1,
        cancelId: 1,
        message: "Discard unsaved agent edits?",
        detail:
          "An agent has changes that are not saved yet. Keep editing to save them, or discard them and close.",
      });
      if (choice === 0) event.preventDefault();
    });
    // The preview iframe may only navigate within the configured local origin.
    const restrictFrames = (
      event: Electron.Event & { url: string; isMainFrame: boolean },
    ) => {
      if (!event.isMainFrame && !previewNavigationAllowed(event.url))
        event.preventDefault();
    };
    win.webContents.on("will-frame-navigate", restrictFrames);
    win.webContents.on("will-redirect", restrictFrames);
    // Console errors/warnings from the embedded preview, for UI QA.
    win.webContents.on("console-message", (event) => {
      if (event.frame !== win.webContents.mainFrame)
        recordPreviewConsole(
          event.frame?.url ?? "",
          event.level,
          event.message,
          event.sourceId,
          event.lineNumber,
        );
    });
    if (process.env.AGENTTEAM_DEV === "1")
      void win.loadURL("http://127.0.0.1:5173");
    else void win.loadFile(join(here, "../ui/index.html"));
  }
  store.events.on("event", (event) => {
    if (win && !win.isDestroyed()) win.webContents.send("team-event", event);
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "AgentTeam", submenu: [{ role: "about" }, { role: "quit" }] },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  createWindow();
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    terminals.killAll();
    readiness.stop();
    scheduler.stop();
    runs.close();
    void shutdownDevServers();
    server.closeAllConnections();
    server.close();
    const timer = setInterval(() => {
      if (!runs.active.size && !liveDevServerCount()) {
        clearInterval(timer);
        store.close();
        app.quit();
      }
    }, 100);
    setTimeout(() => app.exit(0), 6000).unref();
  });
}
void app
  .whenReady()
  .then(start)
  .catch((error) => {
    console.error(error);
    dialog.showErrorBox("AgentTeam startup failed", String(error));
    app.exit(1);
  });
