import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("agentteam", {
  request: (method: string, path: string, body?: unknown) =>
    ipcRenderer.invoke("api", method, path, body),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openAgent: (id: string, mode: string) =>
    ipcRenderer.invoke("open-agent", id, mode),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("team-event", listener);
    return () => ipcRenderer.removeListener("team-event", listener);
  },
  platform: process.platform,
});
