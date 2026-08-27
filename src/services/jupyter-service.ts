// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// jupyter-service.ts — 轻量 notebook 单元执行（2026-08-27, ScienceX 通用计算环境）
// 设计: 复用实证沙箱 spawn 模式(独立 venv + input.json → result.json), 无完整 Jupyter 依赖
// 核心: 单元格代码 → venv 执行 → 输出/图表/持久变量回传（variables 模拟 notebook 内核状态）
// API: POST /api/jupyter/execute { code, variables?, sessionId? }
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TASKS_DIR = path.join(process.env.SAG_ROOT || process.cwd(), ".cache", "jupyter-tasks");
const PYTHON = process.env.EMPIRICAL_PYTHON || process.env.PYTHON || "python";
const RUNNER = path.join(process.env.SAG_ROOT || process.cwd(), "scripts", "jupyter_runner.py");

// 会话变量持久（模拟 notebook 内核: 同 sessionId 的变量跨单元保留; 内存态, 重启清空）
const sessionVars = new Map<string, Record<string, unknown>>();
// 会话输出历史（前端 Restart & Run All 展示）
const sessionLogs = new Map<string, Array<{ cell: number; output: string; ok: boolean; error?: string }>>();

export interface JupyterExecInput {
  code: string;
  sessionId?: string;
  /** 是否清空会话变量（Restart 语义） */
  restart?: boolean;
  cellIndex?: number;
}

export interface JupyterExecResult {
  ok: boolean;
  output: string;
  error?: string;
  variables: Record<string, unknown>;
  figures: string[];   // base64 PNG
  sessionId: string;
  cellIndex?: number;
}

export function resetJupyterSession(sessionId: string): void {
  sessionVars.delete(sessionId);
  sessionLogs.delete(sessionId);
}

/** 执行一个 notebook 单元（异步, 复用实证沙箱的 execFile 模式） */
export function executeJupyterCell(input: JupyterExecInput, timeoutMs = 120_000): Promise<JupyterExecResult> {
  const sessionId = input.sessionId || `nb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (input.restart) {
    sessionVars.delete(sessionId);
    sessionLogs.delete(sessionId);
  }
  const taskId = randomUUID();
  const taskDir = path.join(TASKS_DIR, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  // 当前会话变量传入执行器
  fs.writeFileSync(
    path.join(taskDir, "input.json"),
    JSON.stringify({ code: input.code, variables: sessionVars.get(sessionId) || {} }),
    "utf-8"
  );

  return new Promise((resolve) => {
    execFile(
      PYTHON,
      [RUNNER, taskDir],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, cwd: process.env.SAG_ROOT || process.cwd() },
      () => {
        const resultPath = path.join(taskDir, "result.json");
        try {
          if (!fs.existsSync(resultPath)) {
            resolve({ ok: false, output: "", error: "执行器未产生结果", variables: {}, figures: [], sessionId });
            return;
          }
          const r = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as JupyterExecResult;
          // 更新会话变量（持久）
          if (r.variables) sessionVars.set(sessionId, r.variables);
          // 记录日志
          const logs = sessionLogs.get(sessionId) || [];
          logs.push({ cell: input.cellIndex ?? logs.length, output: r.output, ok: r.ok, error: r.error });
          sessionLogs.set(sessionId, logs.slice(-200));
          resolve({ ...r, sessionId, cellIndex: input.cellIndex });
        } catch (e: any) {
          resolve({ ok: false, output: "", error: String(e?.message || e).slice(0, 300), variables: {}, figures: [], sessionId });
        } finally {
          try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
        }
      }
    );
  });
}

/** 会话日志（Restart & Run All 进度展示） */
export function getJupyterSessionLog(sessionId: string): Array<{ cell: number; output: string; ok: boolean; error?: string }> {
  return sessionLogs.get(sessionId) || [];
}

/** venv 就绪检查（前端徽标） */
export function checkJupyterReady(): { ready: boolean; python: string } {
  return { ready: PYTHON !== "", python: PYTHON || "未配置 EMPIRICAL_PYTHON" };
}

export const jupyterService = {
  executeJupyterCell,
  resetJupyterSession,
  getJupyterSessionLog,
  checkJupyterReady,
};
