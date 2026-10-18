import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager } from "../src/runtime.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createApi } from "../src/http.ts";
import { roots, setProjectRoot } from "../src/config.ts";
import type { Agent, Session } from "../src/model.ts";
app.setName("AgentTeam");
const here = dirname(fileURLToPath(import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
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
  let enabled = false;
  try {
    enabled = store.get<any>("settings", "execution").enabled === true;
  } catch {}
  const runs = new RunManager(service, enabled, app.getPath("home"));
  runs.recover();
  const scheduler = new Scheduler(service, runs);
  scheduler.start();
  const token = randomBytes(32).toString("hex"),
    server = createApi(service, token, runs);
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
  ipcMain.handle("choose-folder", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("open-agent", async (event, id, mode) => {
    trusted(event);
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
  function createWindow() {
    win = new BrowserWindow({
      width: 1500,
      height: 960,
      minWidth: 900,
      minHeight: 600,
      title: "AgentTeam",
      backgroundColor: "#10141c",
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
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
    scheduler.stop();
    runs.close();
    server.closeAllConnections();
    server.close();
    const timer = setInterval(() => {
      if (!runs.active.size) {
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
