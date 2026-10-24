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
  setTheme: (_setting: "light") => ipcRenderer.invoke("set-theme", setting),
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
  platform: process.platform,
});
