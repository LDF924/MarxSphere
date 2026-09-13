// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// reason-billing.ts — 推理任务计费(按 retrieve_steps 里的真实模型定价)
//
// 由来: 这段逻辑原本嵌在 `server.ts` 的 registerRoutes 里(约 720 行深处), 无法单测;
//   而它出过一次真事故 —— 落库时只写了 tokens 没写 model, 于是 `parameters->>'model'` 恒空,
//   整条推理链(含 deepseek-v4-pro, 16 元/百万)一律按 flash(4 元/百万)计费, 长期少收 75%。
//   2026-09-13 抽成模块并补回归测试, 因为它还要再动一次(两份 LLM 实现合并会变更 tokens 的来源)。
import { pool } from "../db/pool.js";
import * as authService from "./auth-service.js";
import * as billingService from "./billing-service.js";

/** 聚合该任务各模型用量并分别计费。失败静默(计费不能阻塞推理响应)。 */
export async function chargeUserForReasonTask(userId: string, taskId: string | undefined): Promise<void> {
  try {
    if (!taskId) return;
    // 按模型分组计费 — 不能用 min(parameters->>'model') 取单一模型: 一条链路可能跨模型
    //   (plan 用 pro、其余用 flash), 取一个就把另一段的单价算错了。
    const agg = await pool.query(
      `select coalesce(nullif(parameters->>'model', ''), '') as model,
              coalesce(sum((parameters->'tokens'->>'in')::int), 0) as tin,
              coalesce(sum((parameters->'tokens'->>'out')::int), 0) as tout
         from retrieve_steps where task_id = $1
        group by 1`, [taskId]);
    const byModel = agg.rows.filter((r: { tin?: unknown; tout?: unknown }) => Number(r.tin) + Number(r.tout) > 0);
    if (!byModel.length) return;
    // 老数据(修复前落库的)没有 model 字段 → 退回按用户配置推断, 与旧行为一致
    const needGuess = byModel.some((r: { model?: string }) => !r.model);
    let guess = "";
    if (needGuess) {
      const llmCfg = await authService.getUserLlmConfig(userId);
      guess = llmCfg.provider === "byok" ? "byok" : "deepseek-v4-flash";
    }
    for (const row of byModel) {
      const model = String((row as { model?: string }).model || "") || guess;
      if (!model || model === "byok") continue;   // BYOK: LLM 自付, 平台不扣
      await billingService.chargeUser(userId, model, Number((row as { tin?: unknown }).tin), Number((row as { tout?: unknown }).tout), "/api/reason/query");
    }
  } catch { /* 计费失败不阻塞响应 */ }
}
