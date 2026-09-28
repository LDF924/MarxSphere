// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// service-token-patrol.ts — V418: 外部服务密钥的每日巡检
//
// 由来(2026-09-28): MinerU 的 OCR token 2026-09-16 过期, 直到 09-27 才被发现。
//   中间那 11 天里, 每一个扫描版 PDF 上传都会失败, 但**失败信息里没有一个字提到密钥**
//   —— 用户看到的是"抽不出正文", 只能靠人去猜。加上有效期只是记录, 巡检才是**提醒**。
//
// 每天一次, 对每个已配置的服务做两件事:
//   ① 看日期 —— 已过期 / 剩 ≤ EXPIRING_SOON_DAYS, 写一条告警(进告警中心, 前端有 toast);
//   ② 看上次校验 —— 超过 7 天没验过就**真的打一次远端**(见 service-token-store 里
//      "到期日是声明、校验是事实"那段)。远端已经拒了而日期还说"还剩几天", 只有打一次才知道。
//
// 去重: 同一天同一个服务只写一条同 kind 的告警。不然每天跑一次、每次写一条,
//   两周后告警中心会被同一件事刷屏, 人就再也不看它了 —— 这比不提醒更糟。
import { pool } from "../db/pool.js";
import { recordAlert } from "./alert-service.js";
import { listServiceTokens, verifyServiceToken, EXPIRING_SOON_DAYS } from "./service-token-store.js";

/** 超过这么久没校验过, 巡检就现场打一次远端 */
const VERIFY_IF_STALE_DAYS = 7;

/** 今天是否已经为这个服务写过同 kind 的告警(按日历日去重) */
async function alreadyAlertedToday(service: string, kind: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `select 1 from alerts
       where category = 'token'
         and detail->>'service' = $1
         and detail->>'kind' = $2
         and created_at >= date_trunc('day', now())
       limit 1`,
      [service, kind],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    // 查不了就去重不了 —— 宁可多写一条, 也不要因为去重查询失败而漏掉提醒
    return false;
  }
}

async function alertOnce(service: string, kind: string, level: "warning" | "error" | "critical", message: string, detail: Record<string, unknown>): Promise<boolean> {
  if (await alreadyAlertedToday(service, kind)) return false;
  await recordAlert({ level, category: "token", message, taskType: "token", taskId: service, detail: { service, kind, ...detail } });
  return true;
}

/** 巡检一轮。返回这一轮新写出的告警数(便于日志/测试断言) */
export async function runServiceTokenPatrol(now = new Date()): Promise<{ written: number; checked: number; notes: string[] }> {
  const notes: string[] = [];
  let written = 0;
  let checked = 0;

  for (const v of await listServiceTokens()) {
    if (!v.configured) continue;

    // ① 日期档
    if (v.daysLeft !== null) {
      if (v.daysLeft < 0) {
        const msg = `${v.label} 密钥已过期（${Math.abs(v.daysLeft)} 天前）。扫描版 PDF 暂时无法提取文字，换一枚新的即可恢复。`;
        if (await alertOnce(v.service, "expired", "error", msg, { daysLeft: v.daysLeft, expiresAt: v.expiresAt })) { written++; notes.push(`${v.service}: 已过期告警`); }
      } else if (v.daysLeft <= EXPIRING_SOON_DAYS) {
        const msg = `${v.label} 密钥还有 ${v.daysLeft} 天到期（${v.expiresAt?.slice(0, 10)}）。现在换掉，不会影响正在做的事。`;
        if (await alertOnce(v.service, "expiring", "warning", msg, { daysLeft: v.daysLeft, expiresAt: v.expiresAt })) { written++; notes.push(`${v.service}: 临近到期告警`); }
      }
    }

    // ② 事实档 —— 太久没验过就真打一次
    const lastMs = v.lastCheckedAt ? new Date(v.lastCheckedAt).getTime() : 0;
    const ageDays = lastMs ? (now.getTime() - lastMs) / 86_400_000 : Infinity;
    if (ageDays >= VERIFY_IF_STALE_DAYS) {
      checked++;
      const res = await verifyServiceToken(v.service);
      if (res.status === "rejected") {
        const msg = `${v.label} 密钥被远端拒绝了 —— ${
          v.daysLeft !== null && v.daysLeft > 0
            ? `日期上还剩 ${v.daysLeft} 天，但实际已经用不了（可能已被吊销）`
            : "远端返回 401/403"
        }。`;
        if (await alertOnce(v.service, "rejected", "error", msg, { note: res.message })) { written++; notes.push(`${v.service}: 被拒告警`); }
      } else if (res.status === "ok") {
        notes.push(`${v.service}: 验通(还剩 ${v.daysLeft ?? "?"} 天)`);
      }
      // unreachable 不告警: 网络抖动/对方维护都会走到这里, 天天报会变成噪音
    }

    // ③ 有校验结论且失败, 但还没到"日期档"的门槛 —— 也要说一声(事实优先于日期)
    if (v.lastCheckOk === false && v.status !== "expired") {
      const msg = `${v.label} 上次校验没通过：${v.lastCheckNote || "远端拒绝"}`;
      if (await alertOnce(v.service, "check_failed", "warning", msg, { note: v.lastCheckNote })) { written++; notes.push(`${v.service}: 校验失败提醒`); }
    }
  }

  return { written, checked, notes };
}

/**
 * 启动接入 —— 与 rss/期刊同步同一套: 首次延迟 + 跨副本租约 + 每 24h。
 * ⚠ 必须走 `withRunLease`: 多副本部署时几个副本同时打 MinerU 的校验接口,
 *   就是"同一账号短时间高频 401"的形态 —— 对方可能直接封 key, 反而弄坏了本来能用的东西。
 */
export function startServiceTokenPatrolScheduler(): void {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const run = async () => {
    const { withRunLease } = await import("./singleton-scheduler.js");
    const guarded = withRunLease("service-token-patrol", async () => runServiceTokenPatrol(), 5 * 60_000);
    const r = await guarded();
    if (!r) return;
    if (r.written > 0) console.warn(`[token-patrol] 新增 ${r.written} 条密钥告警: ${r.notes.join("; ")}`);
    else console.log(`[token-patrol] 巡检完成(校验 ${r.checked} 项, 无新告警)`);
  };
  void run().catch((e) => console.warn("[token-patrol] 首轮异常:", String(e).slice(0, 140)));
  setInterval(() => { void run().catch((e) => console.warn("[token-patrol] 巡检异常:", String(e).slice(0, 140))); }, DAY_MS);
  console.log("[token-patrol] 外部服务密钥巡检已启动 (每 24 小时)");
}

export const serviceTokenPatrol = { runServiceTokenPatrol, startServiceTokenPatrolScheduler };
