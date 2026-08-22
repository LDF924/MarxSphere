// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// electron/preload.ts — 引导页安全桥（contextIsolation 下暴露最小 IPC 面）
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sagDesktop", {
  probe: () => ipcRenderer.invoke("env:probe"),
  saveEnv: (input: unknown) => ipcRenderer.invoke("env:save", input),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  startBackend: () => ipcRenderer.invoke("backend:start"),
  dbSetup: (mode?: "auto" | "docker" | "local") => ipcRenderer.invoke("db:setup", mode),
  onExtractProgress: (cb: (p: { done: number; total: number; pct: number }) => void) => {
    ipcRenderer.on("extract-progress", (_e, data) => cb(data));
  },
  onPgProgress: (cb: (p: { stage: string; pct: number }) => void) => {
    ipcRenderer.on("pg-progress", (_e, data) => cb(data));
  },
  pyCheck: (p: string) => ipcRenderer.invoke("py:check", p),
});
