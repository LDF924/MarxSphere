// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// sync-patrol-service.ts — 同步链路巡检(2026-10-02)
//
// ═══ 由来: 一次"9 天没人知道"的静默失效 ═══
//
//   2026-10-02 推送时被拒: `remote: No anonymous write access`
//   —— `SAG-open-source` 的 origin 指向 `gh-proxy.com`, 那是**只读镜像**, 不转发写。
//
//   但真正的问题不是这次失败, 而是**它本来藏了 9 天**:
//   `.cache/sync-open.log` 显示 09-23~10-01 每天 14:30 都是 `push=未执行` + `无差异`,
//   因为"没差异就早退"压根没走到 push。**那条计划任务没人看输出** ——
//   于是"不需要推"和"推不上去"在日志里长得一模一样。
//
//   两道对策:
//     ① 脚本侧: 把 push 的三种结局分开记(`sync-open.mjs` 的 pushOutcome), 并落一个
//        机器可读的状态文件 —— 那一步已经做了;
//     ② 平台侧: **这个服务** —— 读那个状态文件, 连续失败就写 alerts 表,
//        让它在告警中心里响起来, 而不是躺在没人看的日志里。
//
// ═══ 为什么读文件而不是让脚本直连数据库 ═══
//
//   `sync-open.mjs` 是纯文件同步脚本。让它连 pg 就等于给它加了对 `.env` / 数据库
//   可达性的依赖 —— **网络或库不可用时, 同步本身会因此挂掉**, 本末倒置。
//   脚本只落 JSON, 判断与告警都放在这里(平台侧), 两边各自保持自己能独立工作。
//
// ═══ 为什么按"连续失败次数"而不是"多久没成功"告警 ═══
//
//   "多久没成功"会被**计划任务没跑**干扰: 任务停了三天, 那是另一件事(该由任务自身的
//   看门狗管), 拿它当同步故障报会指向错误的方向。
//   而"连续 N 次失败"直接说明**每次跑都失败**, 是通道本身坏了 —— 判据直指病因。
import fs from "node:fs";
import path from "node:path";
import { recordAlert } from "./alert-service.js";
import { projectRoot } from "./storage-paths.js";

/** 状态文件默认落点 —— 与 sync-open.mjs 从 `--log` 推导出来的位置一致 */
export function syncStatePath(): string {
  return process.env.SAG_SYNC_STATE
    || path.join(projectRoot(), ".cache", "sync-open-state.json");
}

export interface SyncState {
  at: string;
  exitCode: number;
  mode: string;
  changed: number;
  added: number;
  commit: string | null;
  pushOutcome: "ok" | "failed" | "skipped" | "not-reached";
  pushError: string | null;
  ghosts: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  note: string | null;
}

export function readSyncState(file = syncStatePath()): SyncState | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
  } catch {
    // 文件不存在 / 解析失败都返回 null —— 由调用方决定"没状态"该怎么算
    return null;
  }
}

/**
 * 连续失败到第几次才告警。
 *
 * 1 次太敏感(偶发网络抖动就会响), 3 次说明"连着三次都推不上去"——
 * 而那已经是三天(每日一次), 足够确认不是抖动。可用 `SAG_SYNC_ALERT_AFTER` 覆盖。
 */
const ALERT_AFTER = Math.max(1, parseInt(process.env.SAG_SYNC_ALERT_AFTER || "3", 10));

/** 状态超过这么久没更新 → 计划任务本身可能没在跑(与"同步失败"是两件事) */
const STALE_STATE_HOURS = Math.max(1, parseInt(process.env.SAG_SYNC_STALE_HOURS || "48", 10));

/**
 * 巡检一轮。返回这一轮写了哪些告警(便于日志/测试断言)。
 *
 * @param now 注入时间, 便于测试
 */
export async function runSyncPatrol(now = new Date()): Promise<{ written: number; notes: string[] }> {
  const notes: string[] = [];
  let written = 0;
  const file = syncStatePath();
  const st = readSyncState(file);

  if (!st) {
    /**
     * 没有状态文件 = **从来没跑过**或落点不对。
     * 这不是"同步正常", 所以要说一声 —— 但级别用 info: 全新环境里本来就没有,
     * 报成 error 会变成噪音。真正跑起来之后它自己会消失。
     */
    await recordAlert({
      level: "info", category: "sync",
      message: "同步巡检：还没有同步状态记录（计划任务可能从未运行，或状态落点不一致）",
      taskType: "sync",
      detail: { stateFile: file, hint: "确认 MarxSphere-SyncOpen 计划任务在有 --log 时也落 state（同一目录）" },
    });
    return { written: 1, notes: ["无状态文件"] };
  }

  // ① 连续失败 —— 主判据
  if (st.consecutiveFailures >= ALERT_AFTER) {
    const since = st.lastSuccessAt ? `上次成功是 ${st.lastSuccessAt.slice(0, 16).replace("T", " ")}` : "从未成功过";
    await recordAlert({
      level: "error", category: "sync",
      message: `同步到开源仓连续 ${st.consecutiveFailures} 次失败（${since}）`,
      taskType: "sync",
      detail: {
        consecutiveFailures: st.consecutiveFailures,
        pushOutcome: st.pushOutcome,
        // 真因原文 —— 没有它, 用户只知道"推失败了", 不知道该修什么
        pushError: st.pushError,
        lastSuccessAt: st.lastSuccessAt,
        lastRunAt: st.at,
      },
    });
    written++; notes.push(`连续失败 ${st.consecutiveFailures} 次`);
  } else if (st.consecutiveFailures > 0) {
    // 还没到门槛就先用 warning 说一声 —— 不至于等到第 3 天才第一次看见。
    //   级别差刻意保留: warning=「已经失败但还可能是偶发」, error=「连着 N 次都失败, 是通道坏了」
    await recordAlert({
      level: "warning", category: "sync",
      message: `同步到开源仓失败（连续 ${st.consecutiveFailures} 次，达 ${ALERT_AFTER} 次将升级为错误）`,
      taskType: "sync",
      detail: { pushOutcome: st.pushOutcome, pushError: st.pushError, lastRunAt: st.at },
    });
    written++; notes.push(`失败 ${st.consecutiveFailures} 次(未达门槛)`);
  }

  // ② 状态太旧 —— 计划任务可能没在跑(与"同步失败"是两回事, 分开报)
  const ageH = (now.getTime() - new Date(st.at).getTime()) / 3_600_000;
  if (Number.isFinite(ageH) && ageH >= STALE_STATE_HOURS) {
    await recordAlert({
      level: "warning", category: "sync",
      message: `同步已 ${Math.round(ageH)} 小时没有运行记录 —— 计划任务可能没在跑`,
      taskType: "sync",
      detail: { lastRunAt: st.at, stateFile: file, thresholdHours: STALE_STATE_HOURS },
    });
    written++; notes.push(`状态已 ${Math.round(ageH)}h 未更新`);
  }

  // ③ 有残留待清理 —— 不严重, 但会一直堆积, 提一句
  if (st.ghosts > 0) {
    await recordAlert({
      level: "info", category: "sync",
      message: `开源仓有 ${st.ghosts} 个残留文件待人工清理（主仓已删、open 仍跟踪）`,
      taskType: "sync", detail: { ghosts: st.ghosts },
    });
    written++; notes.push(`残留 ${st.ghosts} 个`);
  }

  return { written, notes };
}

export const syncPatrolService = { runSyncPatrol, readSyncState, syncStatePath };
