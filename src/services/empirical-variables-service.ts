// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-variables-service.ts — 变量敲定（V380+）: 被解释/核心解释/控制/识别策略
// LLM 四段式建议 + 白名单校验(反 hallucinate: 变量必须在数据列中) + 闸门落库
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { assertColumns, assertExprVars, GuardError } from "./empirical-guards.js";

export async function suggestVariables(input: {
  topic?: string;
  columns: string[];         // 数据版本列(白名单)
  nRows: number;
  missingRates?: Record<string, number>;
  questionMeta?: any;
}): Promise<{ ok: boolean; suggestion: any }> {
  const missingText = Object.entries(input.missingRates ?? {})
    .map(([c, r]) => `${c}:${r}%`).join(", ");

  const prompt = `你是计量经济学研究设计专家。为以下课题敲定回归模型变量, 输出四段式建议。
课题: ${input.topic ?? "农村土地流转与经营形态研究"}
样本量: N=${input.nRows}
${missingText ? `各列缺失率: ${missingText.slice(0, 500)}` : ""}

可用数据列(必须全部从以下列中选择, 不得发明新变量):
${input.columns.join(", ")}

${input.questionMeta ? `问卷结构摘要: ${JSON.stringify(input.questionMeta).slice(0, 500)}` : ""}

只输出 JSON: {
  "dep": [{"var": "被解释变量", "rationale": "为什么用它"}],
  "core": [{"var": "核心解释变量", "rationale": "理论依据"}],
  "controls": ["控制变量列表"],
  "identification": "识别策略(如: 内生性来源 + 建议 FE/IV, IV 候选需人工验证排他性)",
  "derived": [{"name": "衍生变量名", "expr": "公式(引用现有列)"}],
  "concerns": ["数据可行性警示(缺失率>30%/样本<100 等)"]
}
约束: dep/core/controls 每个变量必须来自可用数据列; derived 的 expr 只能引用可用数据列; 每项给 rationale。`;

  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, maxTokens: 2500, timeoutMs: 90_000, jsonMode: true,
    model: getRoleModel("reason"),
  });
  const sug = r?.json;
  if (!sug) throw new GuardError("LLM_OUTPUT_INVALID", "变量建议输出非法: " + String(r?.text ?? "").slice(0, 200));

  // 白名单校验(服务端强制)
  const allVars = [
    ...(sug.dep ?? []).map((v: any) => v.var),
    ...(sug.core ?? []).map((v: any) => v.var),
    ...(sug.controls ?? []),
  ].filter(Boolean);
  assertColumns(allVars, input.columns, "建议变量");
  for (const d of sug.derived ?? []) {
    assertExprVars(String(d.expr ?? ""), input.columns, `衍生变量 ${d.name}`);
  }

  return { ok: true, suggestion: sug };
}

export const variablesService = { suggestVariables };
