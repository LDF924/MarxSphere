// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// eval-runner.ts — 评测脚本 SSE 运行器（2026-08-06）
// 启动评测脚本子进程（node <tsx> scripts/<script>.ts），逐行解析 [EVAL-SSE] 进度协议
// 转发为 SSE 事件流；客户端断开时杀掉子进程
// 事件类型: phase | question_start | question_done | metric_done | log | done | error
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// V399-2 P1(3.5): 评测 Run 参数/环境快照 — 完成回调把参数 + 环境 + dataFingerprint 写回 agent_eval_runs
// agent_eval_runs 主键为自增 id；RAGAS 评测经 /api/eval/run 启动, 与 agent 评测共用该表
// 每次完成插入新行（唯一键为 id, 无法按业务键去重; 重复评测各留一行, 时间戳可区分新旧）

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

// ─────────────────── V399-2 P1(3.5): Run 参数/环境快照 ───────────────────
// 读取输出文件里的 fingerprint（eval-32-metrics.ts 落盘: 数组尾部 __fingerprint__ 条目 / perq 顶层）
function readDataFingerprint(rootDir: string, env: Record<string, string>): string | null {
  try {
    const outputName = env.EVAL_OUTPUT || "eval_32metrics.json";
    const candidates = [
      path.join(rootDir, "evaluation", outputName),
      path.join(rootDir, outputName),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const fp = Array.isArray(data)
        ? data.find((r: any) => r?.question_id === "__fingerprint__")?.fingerprint
        : data?.fingerprint;
      if (fp && typeof fp.value === "string") return fp.value;
    }
  } catch { /* 读不到指纹不阻塞快照 */ }
  return null;
}

/** 落库 eval run 快照（参数 + 环境 + 数据指纹）。尽力而为, 失败只打日志, 不阻塞评测流程 */
async function persistEvalRunSnapshot(opts: EvalRunOptions, runId: string): Promise<void> {
  const rootDir = process.env.SAG_ROOT || process.cwd();
  const parameters: Record<string, unknown> = {};
  const environment: Record<string, unknown> = {};
  try {
    // 参数快照: 仅记录本评测的覆盖项（EVAL_* 白名单前缀, 不落全量 process.env 避免泄露密钥）
    for (const [k, v] of Object.entries(opts.env || {})) {
      if (k.startsWith("EVAL_")) parameters[k] = v;
    }
    if (Object.keys(parameters).length === 0) {
      parameters._note = "default (no EVAL_* overrides)";
    }
    environment.node = process.version;
    environment.platform = process.platform;
    environment.arch = process.arch;
    environment.script = opts.script;
    environment.tsxVersion = (() => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules", "tsx", "package.json"), "utf8"));
        return pkg.version || "unknown";
      } catch { return "unknown"; }
    })();
    environment.dataFingerprint = readDataFingerprint(rootDir, opts.env || {});
    environment.recordedAt = new Date().toISOString();

    const { pool } = await import("../db/pool.js");
    // V399-2 P1 幂等: eval_run_id 关联键, 重复评测(同 runId)更新同一条记录, 不插新行 (089 迁移)
    // agent_eval_runs 的 suite_id/task_id 为 agent 评测语义, RAGAS 评测不适用 → 置 null
    await pool.query(
      `insert into agent_eval_runs (suite_id, task_id, passed, score, metrics, fault_injected, error, parameters_json, environment_json, eval_run_id)
       values (null, null, $1, 0, '{}'::jsonb, 'none', null, $2, $3, $4)
       on conflict (eval_run_id) do update
         set parameters_json = excluded.parameters_json,
             environment_json = excluded.environment_json,
             passed = excluded.passed,
             metrics = excluded.metrics,
             created_at = now()`,
      [false, JSON.stringify(parameters), JSON.stringify(environment), runId]
    );
  } catch (e: any) {
    console.warn("[eval-runner] 快照落库失败(不影响评测结果): " + String(e?.message || e).substring(0, 120));
  }
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
      // V399-2 P1(3.5): 评测完成(exit 0) → 参数/环境/数据指纹快照落库, 按 runId 幂等 upsert（异步不阻塞）
      if (!aborted && code === 0) {
        void persistEvalRunSnapshot(opts, runId);
      }
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
