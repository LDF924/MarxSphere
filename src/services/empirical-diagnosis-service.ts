// empirical-diagnosis-service.ts — 数据诊断（V380+）
// 输入: 数据缺失率(TS 端算) + 田野信息 → LLM 发现问卷问题 + 解决方案 + 补齐要点
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { pool } from "../db/pool.js";
import { GuardError } from "./empirical-guards.js";

/** 计算各列缺失率/编码统计（TS 端, 不 spawn） */
export function analyzeMissingness(data: { columnOrder: string[]; rows: unknown[][] }): {
  columns: { name: string; missingRate: number; missingN: number; nUnique: number; sampleValues: unknown[] }[];
  totalRows: number;
} {
  const n = data.rows.length;
  const out = data.columnOrder.map((c, ci) => {
    let missing = 0;
    const values = new Set<string>();
    for (const row of data.rows) {
      const v = row[ci];
      if (v === null || v === undefined || v === "" || v === "-99" || v === "-88") {
        missing++;
        values.add(v === "-99" ? "-99" : v === "-88" ? "-88" : "");
      } else {
        values.add(String(v));
      }
    }
    return {
      name: c,
      missingRate: n > 0 ? Math.round((missing / n) * 1000) / 10 : 0,
      missingN: missing,
      nUnique: values.size,
      sampleValues: Array.from(values).slice(0, 8),
    };
  });
  return { columns: out, totalRows: n };
}

export async function runDiagnosis(input: {
  projectId?: string | null;
  data?: { columnOrder: string[]; rows: unknown[][] };
  missingSummary?: { columns: { name: string; missingRate: number; missingN: number; nUnique: number; sampleValues: unknown[] }[]; totalRows: number };
  fieldNotes: string;
}): Promise<{ ok: boolean; report: unknown }> {
  const missing = input.missingSummary ?? (input.data ? analyzeMissingness(input.data) : null);
  if (!missing) throw new GuardError("BAD_REQUEST", "需要数据或缺失摘要");
  if (!input.fieldNotes.trim()) throw new GuardError("BAD_REQUEST", "田野信息不能为空");

  const summaryText = missing.columns
    .map((c) => `${c.name}: 缺失率${c.missingRate}%(${c.missingN}条), 唯一值${c.nUnique}, 样例[${c.sampleValues.join(",")}]`)
    .join("\n");

  const prompt = `你是田野调查数据质量诊断专家。基于问卷数据缺失情况与田野调查信息, 发现问卷设计/编码问题, 给出解决方案与补齐要点。
总样本: N=${missing.totalRows}

各列缺失统计:
${summaryText.slice(0, 8000)}

田野调查信息(前期收集的数据/访谈观察):
${input.fieldNotes.slice(0, 3000)}

常见问题类型(用于对照, 不限于此): 缺失率过高、编码错误(-88/-99 混用)、跳转逻辑缺陷、多选未拆分、敏感题拒答率高、选项遗漏、量表方向反转、题目表述歧义、就业选项跳号等。

只输出 JSON: {
  "problems": [{"type": "missing|coding|skip_logic|sensitive|label|design", "location": "涉及变量/题号", "evidence": "证据(缺失率/样例)", "severity": "high|medium|low"}],
  "solutions": [{"problemIdx": 0, "action": "解决方案一句话", "steps": ["具体步骤"]}],
  "completeness": {"covered": ["已覆盖的维度"], "gaps": ["数据缺口"], "fillPoints": ["补齐要点(重访/电话追访/替代变量)"]}
}`;

  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, maxTokens: 3000, timeoutMs: 90_000, jsonMode: true,
    model: getRoleModel("reason"),
  });
  const report = r?.json;
  if (!report) throw new GuardError("LLM_OUTPUT_INVALID", "诊断输出非法: " + String(r?.text ?? "无输出").slice(0, 200));

  if (input.projectId) {
    await pool.query(
      `insert into empirical_pipeline_runs (project_id, stage, input_snapshot, llm_interpretation)
       values ($1, 'diagnosis', $2, $3)`,
      [input.projectId, JSON.stringify({ totalRows: missing.totalRows, fieldNotes: input.fieldNotes.slice(0, 500) }), JSON.stringify(report)]
    );
  }
  return { ok: true, report };
}

export const diagnosisService = { analyzeMissingness, runDiagnosis };
