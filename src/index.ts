// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// index.ts — 入口：读取 mode.json 设定运行模式（界面切换持久化）
// 模式：preview（省内存，无推理/MCP 池）| full（完整，拉 MCP 池）
// 优先级：环境变量 MARXSPHERE_PREVIEW > mode.json > 默认 preview
import fs from "node:fs";
import path from "node:path";

// V388: 进程级错误兜底 — 后台任务(自主研究/jobs worker/巡检)抛异常不挂进程, 记录日志
process.on("uncaughtException", (err) => {
  console.error("[sag] uncaughtException:", err?.message || err);
  try { console.error("[sag] stack:", (err as Error)?.stack?.split("\n").slice(0, 8).join(" | ")); } catch {}
});
process.on("unhandledRejection", (reason) => {
  console.error("[sag] unhandledRejection:", reason instanceof Error ? reason.message : String(reason));
});
import { startHttpServer } from "./api/server.js";
import { logger } from "./observability/logger.js";
import { startJournalSyncScheduler } from "./services/journal-sync-service.js";  // V395-38: 期刊实时同步管道
import { runStartupChecks } from "./startup-check.js";  // V407: 启动环境检查（密钥/目录缺失给明确警告）

// V407: 启动前环境检查 — 打印配置报告（不阻断启动）
runStartupChecks();

// 从 mode.json 读取持久化模式（界面切换按钮写入）
try {
  const modeFile = path.join(process.cwd(), "mode.json");
  if (fs.existsSync(modeFile) && process.env.MARXSPHERE_PREVIEW === undefined) {
    const saved = JSON.parse(fs.readFileSync(modeFile, "utf-8")) as { mode?: string };
    if (saved.mode === "full") {
      process.env.MARXSPHERE_PREVIEW = "0"; // 完整模式：不设 preview
      logger.info("mode.json 指定 full 模式（完整推理+MCP 池）");
    } else if (saved.mode === "preview") {
      process.env.MARXSPHERE_PREVIEW = "1";
      logger.info("mode.json 指定 preview 模式（省内存）");
    }
  }
} catch { /* mode.json 损坏忽略 */ }

// V397 桌面端: 启动前自举数据库迁移（迁移文件幂等, 首次启动安全执行）
import { migrate } from "./db/migrate.js";
migrate().catch((e: unknown) => {
  console.error("[sag] 数据库迁移失败（首次启动可忽略, 重试中）:", String((e as Error)?.message || e).slice(0, 200));
});

// V405(P0 成本账本): 启动后 seed 平台默认模型单价(仅插缺省, 不覆盖 admin 调价)
import { seedDefaultPrices } from "./services/cost-ledger-service.js";
setTimeout(() => { void seedDefaultPrices(); }, 2500);

startHttpServer().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") {
    console.error(`[sag] 端口 ${process.env.HTTP_PORT || 4173} 已被占用 — 请关闭旧实例后重试`);
    logger.error({ error }, "server failed: EADDRINUSE");
  } else {
    logger.error({ error }, "server failed");
  }
  process.exit(1);
});

// V395-38: 期刊实时同步管道（启动即同步一次 + 每6小时自动）
startJournalSyncScheduler();

// V6: Agent 评测集自动回归(启动即跑一次 + 每24小时, 通过率<50%告警)
// 2026-09-03: 加 AGENT_EVAL_AUTO_ENABLED 开关(默认关) — 自动评测消耗真实
// LLM token 且后端每次重启都会触发, 需用时在 .env 设 AGENT_EVAL_AUTO_ENABLED=true
import { config } from "./config/env.js";
if (config.AGENT_EVAL_AUTO_ENABLED) {
  import("./services/agent-eval-service.js").then(({ startEvalSuiteScheduler }) => {
    setTimeout(() => { startEvalSuiteScheduler(); }, 5000);
  });
} else {
  console.log("[agent-eval] V6 自动回归已关闭 (AGENT_EVAL_AUTO_ENABLED=false, 可在 Agent 面板手动跑)");
}

// V396-5: Agent 队列恢复 — 启动后把 running 卡死任务置 failed(可重试), 清空遗留队列条目
// G9: 同时处理 planning 卡死(>24h) + awaiting_approval 超时(60分钟)
import { agentTaskQueue } from "./services/agent-task-queue.js";
setTimeout(() => { void agentTaskQueue.recoverAfterRestart(); }, 3000);

// V404-25(H6): 文档变更集崩溃恢复 — 启动时把 reserved/ambiguous 残留置 failed(客户端幂等重试)
import { reconcileMutationAttempts } from "./services/doc-session-service.js";
setTimeout(() => { void reconcileMutationAttempts(); }, 4000);

// G6: 审批超时自动处理 — 每 30 分钟把超时未响应的 awaiting_approval 任务置 failed(按拒绝处理)
import { agentTaskService } from "./services/agent-task-service.js";
setTimeout(() => { agentTaskService.startApprovalTimeoutScheduler(); }, 8000);

// P2: 主动研究 — 每日自主巡检（失败任务/评测回退/热点 → 生成研究假设 → 发起任务）
// 关闭: AGENT_PROACTIVE_RESEARCH=0
import { startProactiveResearchScheduler } from "./services/agent-proactive-research.js";
setTimeout(() => { startProactiveResearchScheduler(); }, 15000);

// 差距P③: Agent 设置持久化恢复（预设/自主级别/沙箱级别, DB 覆盖环境变量默认）
import { restoreAgentSettings } from "./services/agent-settings.js";
setTimeout(() => { void restoreAgentSettings(); }, 20000);

// V404-7: 记忆 Dream 巩固 — 每日确定性扫描一次(零 LLM 成本, 候选隔离区人工审)
// 开关: SAG_DREAM_DAILY=0 关闭(默认开); 与 Agent 定时器同款模式
import { startDreamDailyScheduler } from "./services/dream-consolidation-service.js";
setTimeout(() => { startDreamDailyScheduler(); }, 120000); // 启动 2 分钟后首跑, 之后每 24h

// 差距T④(Codex session_startup_prewarm): Agent 组件预热 — 注册内置钩子/工具注册表预热
setTimeout(() => {
  void (async () => {
    try {
      const { registerBuiltinHooks } = await import("./services/agent-hooks.js");
      registerBuiltinHooks();
      // 架构A1: 插件热加载监听（plugins/ 目录, 新增插件无需重启）
      const { startPluginWatcher } = await import("./services/agent-file-plugins.js");
      startPluginWatcher();
      const { buildAgentTools } = await import("./services/agent-tool-router.js");
      const tools = await buildAgentTools({});
      console.log(`[agent] 差距T④ 预热完成: 内置钩子已注册, ${tools.length} 个工具已加载`);
    } catch (e: any) {
      console.error("[agent] 预热失败:", String(e?.message || e).slice(0, 100));
    }
  })();
}, 25000);
