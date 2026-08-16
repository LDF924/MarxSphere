// empirical-reliability-service.ts — 信效度编排（V380+）
// Python 实算(α/KMO/Bartlett/因子) → LLM 解读 → 落 pipeline_runs
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { empiricalService } from "./empirical-service.js";
import { pool } from "../db/pool.js";
import { assertColumns, GuardError } from "./empirical-guards.js";

export async function runReliability(input: {
  dataVersionId?: string | null;
  projectId?: string | null;
  data: { columnOrder: string[]; rows: unknown[][] };
  scaleGroups: { name: string; columns: string[] }[];
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  // 白名单校验: 所有列必须在数据列中
  const allCols = new Set(input.data.columnOrder);
  for (const g of input.scaleGroups) {
    assertColumns(g.columns, input.data.columnOrder, `量表「${g.name}」变量`);
  }
  if (input.scaleGroups.length === 0) throw new GuardError("BAD_REQUEST", "需要 scaleGroups");

  const r = await empiricalService.spawnPythonTask("empirical_runner.py", {
    script: "reliability",
    data: input.data,
    params: { scaleGroups: input.scaleGroups },
  });
  if (!r.ok || !r.taskId) return r;
  // 异步完成后解读由 getEmpiricalResult 轮询触发, 这里返回 taskId
  void interpretWhenDone(input, r.taskId);
  return r;
}

/** 轮询 python 结果 → 完成后 LLM 解读 → 落库 */
async function interpretWhenDone(
  input: { projectId?: string | null; dataVersionId?: string | null },
  taskId: string
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const t = await empiricalService.getEmpiricalResult(taskId);
    if (t.status === "done") {
      const res = t.result as any;
      await interpretAndSave(input, res);
      return;
    }
    if (t.status === "error") return;
  }
}

async function interpretAndSave(input: { projectId?: string | null }, pythonResult: any): Promise<void> {
  try {
    // 表文本化喂 LLM
    const tableText = (pythonResult.tables ?? []).map((t: any) => `【${t.title}】\n${(t.rows ?? []).map((r: any[]) => r.join(" | ")).join("\n")}\n注: ${t.notes ?? ""}`).join("\n\n");
    const prompt = `你是问卷信效度分析师。基于以下信效度计算结果输出解读报告。
样本量: N=${pythonResult.meta?.n ?? "?"}
${pythonResult.warnings?.length ? `警告: ${pythonResult.warnings.join("; ")}` : ""}

计算结果:
${tableText.slice(0, 6000)}

只输出 JSON: {"summary": "总体结论一句话", "per_scale": [{"name": "量表名", "alpha": 数值, "verdict": "良好|可接受|较差|不可算"}], "recommendations": ["具体建议(如删除某题/补充样本/重新编码)"], "warning": "样本量或结构注意点"}。
约束: 只基于计算结果给出描述性解读; 给题项删除建议但绝不自动改数据。`;
    const r = await callLlm({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2, maxTokens: 1500, timeoutMs: 60_000, jsonMode: true,
      model: getRoleModel("reason"),
    });
    const interp = JSON.stringify(r?.json ?? { summary: r?.text?.slice(0, 300) ?? "解读失败" });
    if (input.projectId) {
      await pool.query(
        `insert into empirical_pipeline_runs (project_id, stage, input_snapshot, python_result, llm_interpretation)
         values ($1, 'reliability', $2, $3, $4)`,
        [input.projectId,
         JSON.stringify({ scaleGroups: (pythonResult.meta as any)?.scaleGroups ?? [], n: pythonResult.meta?.n }),
         JSON.stringify(pythonResult), interp]
      );
    }
  } catch {
    // 解读失败不影响 python 结果(部分成功)
  }
}

export const reliabilityService = { runReliability };
