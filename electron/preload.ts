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
  onPgProgress: (cb: (p: { stage: string; pct: number; type: "download" | "install" }) => void) => {
    ipcRenderer.on("pg-progress", (_e, data) => cb(data));
  },
  pyCheck: (p: string) => ipcRenderer.invoke("py:check", p),
  // V415: 端口状态探测（错误页用——"后端服务已退出"时展示端口/数据库状态，让用户放心）
  portProbe: () => ipcRenderer.invoke("port:probe"),
  // V417: 一键结束占用端口的残留 MarxSphere 进程（错误页按钮用）
  killPortOwner: () => ipcRenderer.invoke("port:kill-owner"),
  // V419: 一键修复数据库（端口通但库缺失时自动建库 + 扩展 + 验证）
  fixDb: () => ipcRenderer.invoke("port:fix-db"),
});
