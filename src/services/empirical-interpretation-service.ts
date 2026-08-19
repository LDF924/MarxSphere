// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-interpretation-service.ts — 结果解释闸门（V380+）: LLM 草稿 + 防越界扫描
// 硬约束: 只描述系数方向/显著性/置信区间, 不推断因果; 服务端正则扫禁用词
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { pool } from "../db/pool.js";
import { GuardError } from "./empirical-guards.js";

// 禁用词(宁少勿多, 命中返回提示人工改写而非静默丢弃)
const BANNED_WORDS = ["因果", "导致", "有效", "显著改善", "证明"];

export async function generateInterpretationDraft(input: {
  runId: string;
  tablesText: string;
  projectId?: string | null;
}): Promise<{ ok: boolean; draft?: any; error?: string }> {
  if (!input.tablesText.trim()) throw new GuardError("BAD_REQUEST", "结果表为空");
  const prompt = `你是实证结果解读员。基于以下回归结果表生成统计描述解释。
硬约束:
1. 只描述系数的方向/显著性/置信区间/样本量
2. 不推断因果, 不写"这说明政策有效"类结论
3. 假设检验由研究者判断

结果表:
${input.tablesText.slice(0, 6000)}

只输出 JSON: {
  "interpretation": "总体统计描述(只谈方向/显著性/样本量)",
  "key_findings": [{"coefficient": "变量名", "finding": "系数方向+显著性+数值描述"}],
  "caveats": ["统计局限(如样本量小/缺失)或需研究者进一步验证的点"]
}`;

  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, maxTokens: 1500, timeoutMs: 60_000, jsonMode: true,
    model: getRoleModel("reason"),
  });
  const draft = r?.json;
  if (!draft) throw new GuardError("LLM_OUTPUT_INVALID", "解释生成失败: " + String(r?.text ?? "").slice(0, 200));

  // 禁用词扫描
  const text = JSON.stringify(draft);
  const hits = BANNED_WORDS.filter((w) => text.includes(w));
  if (hits.length > 0) {
    throw new GuardError("INTERPRETATION_OVERREACH",
      `解释包含因果推断禁用词(${hits.join(",")}), 请改写为纯统计描述: 只谈方向/显著性/置信区间`);
  }
  return { ok: true, draft };
}

export const interpretationService = { generateInterpretationDraft };
