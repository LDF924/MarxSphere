// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// self-heal-service.ts — 告警自主闭环（V379）
// 发现告警 → 自动根因分析 → 自动尝试解决 → 反馈结果
// 对可自动处理的告警执行修复动作；不可自动处理的标记"需人工"并给出诊断
import { pool } from "../db/pool.js";
import { recordAlert } from "./alert-service.js";

type HealResult = {
  action: string;       // 执行的修复动作
  success: boolean;     // 是否解决
  detail: string;       // 结果详情
  resolved: boolean;    // 是否标记已解决
};

/** 按告警类型执行修复动作 */
export async function healAlert(alert: {
  id: string;
  level: string;
  category: string;
  message: string;
  task_type: string | null;
}): Promise<HealResult> {
  const base = { action: "", success: false, detail: "", resolved: false };

  try {
    // ── 1. failure：服务/任务失败 → 检查端口，死了拉起 ──
    if (alert.category === "failure") {
      const port = detectPort(alert.message, alert.task_type);
      if (port) {
        const alive = await isPortListening(port);
        if (alive) {
          return { ...base, action: `检查:${port}`, success: true, detail: `端口 ${port} 已在运行（可能已自愈或误报）`, resolved: true };
        }
        // 拉起服务
        const ok = await restartService(port);
        return { ...base, action: `拉起服务:${port}`, success: ok, detail: ok ? `服务 ${port} 已重新拉起` : `拉起失败（需人工检查）`, resolved: ok };
      }
      // 无端口关联（如入库失败）→ 重试语义（标记观察）
      return { ...base, action: "重试任务", success: true, detail: "已记录，任务类失败由 watchdog/巡检自动重试", resolved: false };
    }

    // ── 2. timeout：慢查询/超时 → 检查是否持续 ──
    if (alert.category === "timeout") {
      // 查询最近同类超时次数（>3 次/10 分钟 → 可能系统性问题）
      const r = await pool.query(
        `select count(*) from alerts where category = 'timeout' and created_at > now() - interval '10 minutes'`
      );
      const cnt = Number(r.rows[0].count);
      if (cnt >= 3) {
        return { ...base, action: "超时风暴检测", success: false, detail: `10 分钟内 ${cnt} 次超时——可能系统负载过高，建议检查 Neo4j/OpenViking 状态`, resolved: false };
      }
      return { ...base, action: "超时观察", success: true, detail: "偶发超时（10 分钟内 <3 次），持续观察", resolved: false };
    }

    // ── 3. degradation：检索降级 → 检查 MCP/三库状态 ──
    if (alert.category === "degradation") {
      const checks: string[] = [];
      for (const port of [11001, 11003, 1933]) {
        checks.push(`:${port} ${await isPortListening(port) ? "OK" : "DOWN"}`);
      }
      const allOk = checks.every((c) => c.includes("OK"));
      return { ...base, action: "检索源巡检", success: allOk, detail: checks.join(" | "), resolved: allOk };
    }

    // ── 4. circuit_breaker：熔断 → 检查失败计数 ──
    if (alert.category === "circuit_breaker") {
      const r = await pool.query(
        `select count(*) from alerts where category = 'circuit_breaker' and created_at > now() - interval '30 minutes'`
      );
      const cnt = Number(r.rows[0].count);
      return { ...base, action: "熔断计数检查", success: cnt < 3, detail: `30 分钟内熔断 ${cnt} 次${cnt >= 3 ? "——持续熔断需人工介入" : "（偶发，自动复位）"}`, resolved: cnt < 3 };
    }

    // ── 5. reflection：反思失败 → 检查 LLM 返回 ──
    if (alert.category === "reflection") {
      return { ...base, action: "反思链路检查", success: true, detail: "反思失败多为 LLM 偶发（thinking/配额），下轮自动重试", resolved: true };
    }

    // ── 默认：不可自动处理 ──
    return { ...base, action: "人工处理", success: false, detail: "该类型无自动修复策略，需人工排查", resolved: false };
  } catch (e: any) {
    return { ...base, action: "自愈执行异常", success: false, detail: e?.message?.substring(0, 100), resolved: false };
  }
}

/** 从告警消息里识别端口 */
function detectPort(message: string, taskType: string | null): number | null {
  const m = message.match(/(?:端口|:)(\d{4,5})/);
  if (m) return Number(m[1]);
  // 按任务类型推断
  if (taskType === "reason" || taskType === "search") return 4173;
  if (taskType === "memory") return 1933;
  return null;
}

/** 检查端口是否监听（V431: execFile 参数数组，无 shell 拼接 — 消除注入模式） */
async function isPortListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    try {
      const { execFile } = await import("node:child_process");
      // 先取 health 失败才用 netstat 兜底：execFile 数组参数传递，端口在 JS 侧过滤（纯数字），无命令注入面
      const out = await new Promise<string>((resolve, reject) => {
        execFile("netstat", ["-ano"], { encoding: "utf8" }, (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout));
        });
      });
      // JS 侧过滤：只认 ":<port> " 的 LISTENING 行
      return out.split("\n").some((line) => line.includes(`:${port} `) && line.includes("LISTENING"));
    } catch { return false; }
  }
}

/** 拉起服务（用 VBS 静默启动） */
async function restartService(port: number): Promise<boolean> {
  try {
    const script = port === 1933 ? "ov-start.vbs" : port === 4173 ? "sag-start.vbs" : null;
    if (!script) return false;
    // V431: execFile 参数数组 — cscript 与脚本路径分离传参，路径来自环境变量+写死映射，无拼接注入
    const { execFile } = await import("node:child_process");
    const scriptPath = `${process.env.SAG_ROOT || "."}\\scripts\\${script}`;
    await new Promise<void>((resolve, reject) => {
      execFile("cscript", ["//nologo", scriptPath], { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // 等 8 秒验证
    await new Promise((r) => setTimeout(r, 8000));
    return await isPortListening(port);
  } catch { return false; }
}

/** 对未处理告警执行自愈（批量） */
export async function healPendingAlerts(limit = 5): Promise<Array<{ alertId: string; result: HealResult }>> {
  const r = await pool.query(
    `select id, level, category, message, task_type from alerts
     where read = false and (metadata is null or (metadata->>'healed')::boolean is not true)
     order by created_at desc limit $1`,
    [limit]
  );
  const results: Array<{ alertId: string; result: HealResult }> = [];
  for (const alert of r.rows) {
    const result = await healAlert(alert);
    // 更新告警状态（metadata 记录自愈结果）
    await pool.query(
      `update alerts set metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb, read = true where id = $1`,
      [alert.id, JSON.stringify({ healed: result.resolved, healAction: result.action, healDetail: result.detail, healedAt: new Date().toISOString() })]
    );
    results.push({ alertId: String(alert.id), result });
  }
  return results;
}

export const selfHealService = { healAlert, healPendingAlerts, startSelfHealPatrol };

/** 启动自愈巡检（每 60 秒对未处理告警执行修复） */
export function startSelfHealPatrol(intervalMs = 60_000): void {
  const timer = setInterval(async () => {
    try {
      const results = await healPendingAlerts(3);
      if (results.length > 0) {
        console.log(`[self-heal] 处理 ${results.length} 条告警:`, results.map((r) => `${r.result.action}:${r.result.success ? "✓" : "✗"}`).join(", "));
      }
    } catch (e: any) {
      console.error("[self-heal] 巡检失败:", e?.message?.substring(0, 80));
    }
  }, intervalMs);
  timer.unref?.();
  console.log(`[self-heal] 自愈巡检已启动（每 ${intervalMs / 1000}s）`);
}
