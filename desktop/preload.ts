import { contextBridge, ipcRenderer } from "electron";
// Apply Sand Ink before first paint; legacy stored theme values are intentionally ignored.
try {
  document.documentElement.dataset.theme = "light";
  document.documentElement.style.colorScheme = "light";
} catch {
  /* no document yet: ui/theme.ts applies the theme */
}
contextBridge.exposeInMainWorld("agentteam", {
  request: (method: string, path: string, body?: unknown) =>
    ipcRenderer.invoke("api", method, path, body),
  chooseExecutable: () => ipcRenderer.invoke("choose-executable"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  setTheme: (setting: "light") => ipcRenderer.invoke("set-theme", setting),
  saveDiagnostics: (format: "zip" | "json") =>
    ipcRenderer.invoke("save-diagnostics", format),
  saveTextFile: (name: string, content: string) =>
    ipcRenderer.invoke("save-text-file", name, content),
  openAgent: (id: string, mode: string) =>
    ipcRenderer.invoke("open-agent", id, mode),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("team-event", listener);
    return () => ipcRenderer.removeListener("team-event", listener);
  },
  // Terminal tab (desktop/main.ts, src/terminal.ts): the renderer names only a starting folder.
  terminal: {
    create: (options: { cwd: string | null; cols: number; rows: number }) =>
      ipcRenderer.invoke("terminal-create", options),
    write: (id: string, data: string) =>
      ipcRenderer.send("terminal-write", id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send("terminal-resize", id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke("terminal-kill", id),
    openLink: (url: string) => ipcRenderer.invoke("terminal-open-link", url),
    onData: (callback: (event: { id: string; data: string }) => void) => {
      const listener = (_event: unknown, data: { id: string; data: string }) =>
        callback(data);
      ipcRenderer.on("terminal-data", listener);
      return () => ipcRenderer.removeListener("terminal-data", listener);
    },
    onExit: (
      callback: (event: {
        id: string;
        exitCode: number;
        signal: number | null;
      }) => void,
    ) => {
      const listener = (
        _event: unknown,
        data: { id: string; exitCode: number; signal: number | null },
      ) => callback(data);
      ipcRenderer.on("terminal-exit", listener);
      return () => ipcRenderer.removeListener("terminal-exit", listener);
    },
  },
  platform: process.platform,
});
