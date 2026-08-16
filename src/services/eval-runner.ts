// eval-runner.ts — 评测脚本 SSE 运行器（2026-08-06）
// 启动评测脚本子进程（node <tsx> scripts/<script>.ts），逐行解析 [EVAL-SSE] 进度协议
// 转发为 SSE 事件流；客户端断开时杀掉子进程
// 事件类型: phase | question_start | question_done | metric_done | log | done | error
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export type EvalScript = "eval-32-metrics" | "run-eval-dual" | "ablation-eval";

export interface EvalRunOptions {
  script: EvalScript;
  /** 覆盖环境变量（EVAL_QUESTIONS / EVAL_OUTPUT / EVAL_DIMS / EVAL_MERGE_POLICY / EVAL_LIMIT / EVAL_OPERATORS） */
  env?: Record<string, string>;
  /** V382: 评测运行标识(客户端断开时按 runId 精准杀, 不误伤并发评测) */
  runId?: string;
}

export interface EvalEvent {
  type: string;
  [k: string]: unknown;
}

const SCRIPT_FILES: Record<EvalScript, string> = {
  "eval-32-metrics": "eval-32-metrics.ts",
  "run-eval-dual": "run-eval-dual.ts",
  "ablation-eval": "ablation-eval.ts",
};

// 当前活跃评测的杀进程回调（客户端断开时由 server.ts 调用，即使子进程阻塞在无输出的阶段也能立即终止）
// V382 fix: 单例 → 按 runId 关联, 一个客户端断开不再误杀另一个评测
let activeKill: Map<string, () => void> = new Map();
export function killActiveEvalRun(runId?: string) {
  if (runId) {
    const kill = activeKill.get(runId);
    if (kill) { try { kill(); } catch { /* 已退出 */ } activeKill.delete(runId); }
    return;
  }
  // 兼容旧调用(无 runId): 全部终止
  for (const [, kill] of activeKill) { try { kill(); } catch { /* 已退出 */ } }
  activeKill.clear();
}
export function registerEvalKill(runId: string, kill: () => void): void {
  activeKill.set(runId, kill);
}
export function unregisterEvalKill(runId: string): void {
  activeKill.delete(runId);
}

function spawnEval(opts: EvalRunOptions): { child: ChildProcess; scriptPath: string } {
  const scriptFile = SCRIPT_FILES[opts.script];
  const rootDir = process.env.SAG_ROOT || process.cwd();
  const scriptPath = path.join(rootDir, "scripts", scriptFile);
  if (!fs.existsSync(scriptPath)) {
    throw new Error("评测脚本不存在: " + scriptPath);
  }
  // 项目内 tsx（避免 Windows 下 npx 交互卡死）
  const tsxCli = path.join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, scriptPath], {
    cwd: rootDir,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, scriptPath };
}

/**
 * 启动评测并回调每个事件。返回 Promise<{code, output}>，评测进程退出时 resolve。
 * emit 返回 false 表示客户端已断开 → 杀掉子进程。
 */
export function runEvalWithEvents(
  opts: EvalRunOptions,
  emit: (evt: EvalEvent) => boolean | void
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const { child } = spawnEval(opts);
    let aborted = false;
    let lastOutput = "";
    const runId = opts.runId ?? `eval-${Date.now()}`;

    registerEvalKill(runId, () => { aborted = true; child.kill(); });
    // 评测结束清理注册(避免 Map 泄漏)
    child.on("exit", () => unregisterEvalKill(runId));
    child.on("error", () => unregisterEvalKill(runId));

    const dispatch = (evt: EvalEvent): boolean | void => {
      if (aborted) return false;
      if (typeof evt.output === "string" && evt.output) lastOutput = evt.output;
      return emit(evt);
    };

    const onLine = (line0: string) => {
      const line = line0.trimEnd();
      if (!line.trim()) return;
      const sseIdx = line.indexOf("[EVAL-SSE]");
      if (sseIdx >= 0) {
        const payload = line.slice(sseIdx + "[EVAL-SSE]".length).trim();
        try {
          const evt = JSON.parse(payload) as EvalEvent;
          if (dispatch(evt) === false) { aborted = true; child.kill(); }
          return;
        } catch { /* 协议行损坏 → 按普通日志 */ }
      }
      if (dispatch({ type: "log", line: line.substring(0, 300) }) === false) {
        aborted = true; child.kill();
      }
    };

    const pipe = (stream: NodeJS.ReadableStream) => {
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const l of lines) onLine(l);
      });
      stream.on("end", () => {
        if (buf.trim()) { onLine(buf); buf = ""; }
      });
    };
    pipe(child.stdout!);
    pipe(child.stderr!);

    child.on("close", (code) => {
      unregisterEvalKill(runId);
      if (!aborted) dispatch({ type: "phase", phase: "exit", code });
      // 真实事件 → 告警（评测失败/成功记录，异步不阻塞）
      try {
        const alertP = import("./alert-service.js").then(({ recordAlert }) => {
          if (aborted) {
            recordAlert({ level: "warning", category: "failure", message: `评测被中断（客户端断开或手动终止）`, taskType: "eval", detail: { script: opts.script } });
          } else if (code !== 0) {
            recordAlert({ level: "error", category: "failure", message: `评测进程异常退出（exit ${code}）`, taskType: "eval", detail: { script: opts.script, exitCode: code } });
          } else {
            recordAlert({ level: "info", category: "success", message: `评测完成（${opts.script}）`, taskType: "eval", detail: { script: opts.script } });
          }
        });
        alertP.catch(() => { /* 告警失败不阻塞 */ });
      } catch { /* 告警失败不阻塞 */ }
      resolve({ code, output: lastOutput });
    });
    child.on("error", (err) => {
      unregisterEvalKill(runId);
      dispatch({ type: "error", message: "评测进程启动失败: " + err.message });
      try {
        const alertP = import("./alert-service.js").then(({ recordAlert }) => {
          recordAlert({ level: "error", category: "failure", message: `评测进程启动失败：${err.message.substring(0, 60)}`, taskType: "eval", detail: { script: opts.script } });
        });
        alertP.catch(() => { /* 告警失败不阻塞 */ });
      } catch { /* 告警失败不阻塞 */ }
      resolve({ code: null, output: lastOutput });
    });
  });
}
