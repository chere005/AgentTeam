import { contextBridge, ipcRenderer } from "electron";
// Theme before the first paint (ui/theme.ts applies the same once the page script runs): the main
// process passes the stored Appearance setting and already set prefers-color-scheme to match it.
try {
  const arg = process.argv
    .find((a) => a.startsWith("--agentteam-theme="))
    ?.slice("--agentteam-theme=".length);
  const theme =
    arg === "light" || arg === "dark"
      ? arg
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch {
  /* no document yet: ui/theme.ts applies the theme */
}
contextBridge.exposeInMainWorld("agentteam", {
  request: (method: string, path: string, body?: unknown) =>
    ipcRenderer.invoke("api", method, path, body),
  chooseExecutable: () => ipcRenderer.invoke("choose-executable"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  setTheme: (setting: "system" | "light" | "dark") =>
    ipcRenderer.invoke("set-theme", setting),
  saveDiagnostics: (format: "zip" | "json") =>
    ipcRenderer.invoke("save-diagnostics", format),
  openAgent: (id: string, mode: string) =>
    ipcRenderer.invoke("open-agent", id, mode),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("team-event", listener);
    return () => ipcRenderer.removeListener("team-event", listener);
  },
  platform: process.platform,
});
