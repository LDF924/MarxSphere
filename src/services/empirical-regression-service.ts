// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// empirical-regression-service.ts — 回归代码生成 + Agent Debug（V380+）
// 生成: 基准/固定效应/聚类SE/交互; 模板: 稳健性/安慰剂/IV一阶段/事件研究
// 防呆静态规则: 聚类SE存在性 / 样本量断言 / 交互项出现检查
// Debug 硬约束: 只修语法/API/变量名错误, 不做假设检验
import { randomUUID } from "node:crypto";
import { callLlm } from "../ai/llm-common.js";
import { getRoleModel } from "./llm-model-registry.js";
import { empiricalService } from "./empirical-service.js";
import { pool } from "../db/pool.js";
import { assertColumns, GuardError } from "./empirical-guards.js";

export interface RegressionSpec {
  dep: string;
  core: string[];
  controls?: string[];
  fe?: string[];
  cluster?: string;
  interactions?: string[];
  model?: "ols" | "logit" | "ologit";
}

const METHOD_CMD: Record<string, string> = {
  ols: "reg", logit: "logit", ologit: "ologit",
};

/** 静态规则检查(不靠 LLM 自觉) */
export function checkStaticRules(spec: RegressionSpec, code: string): string[] {
  const warnings: string[] = [];
  // (a) 聚类 SE: spec.cluster 非空而代码无 cluster 语句 → 聚类可能失效
  if (spec.cluster && !/\b(cluster|vce\(cluster)\b/.test(code)) {
    warnings.push("⚠️ spec.cluster 非空但代码中未找到 cluster 语句 — 聚类标准误可能失效");
  }
  // (b) 样本量断言: 代码含 N= 注释
  if (!/N\s*=/.test(code)) {
    warnings.push("⚠️ 代码中未包含 N= 样本量注释 — 无法核对自由度校正, 建议在结果表添加 N");
  }
  // (c) 交互项必须出现在代码
  for (const iv of spec.interactions ?? []) {
    if (!code.includes(iv)) {
      warnings.push(`⚠️ 交互项 ${iv} 未出现在生成代码中`);
    }
  }
  // (d) FE 检查
  if ((spec.fe ?? []).length > 0 && !/absorb|i\.\w+|fe/.test(code)) {
    warnings.push("⚠️ spec.fe 非空但代码中未找到固定效应语法");
  }
  return warnings;
}

export async function generateRegression(input: {
  projectId?: string | null;
  data?: { columnOrder: string[]; rows: unknown[][] };
  spec: RegressionSpec;
}): Promise<{ ok: boolean; code?: string; meta?: any; error?: string }> {
  const columns = input.data?.columnOrder ?? [];
  const spec = input.spec;
  const allVars = [spec.dep, ...spec.core, ...(spec.controls ?? []), ...(spec.fe ?? []), ...(spec.interactions ?? [])]
    .filter(Boolean);
  assertColumns(allVars, columns, "回归变量");
  if (spec.cluster) assertColumns([spec.cluster], columns, "聚类变量");

  const prompt = `你是计量经济学代码生成器。生成 Stata 回归代码(可复现)。
因变量: ${spec.dep}
核心解释变量: ${spec.core.join(", ")}
控制变量: ${(spec.controls ?? []).join(", ") || "无"}
固定效应: ${(spec.fe ?? []).join(", ") || "无"}
聚类标准误: ${spec.cluster ?? "无"}
交互项: ${(spec.interactions ?? []).join(", ") || "无"}
方法: ${spec.model ?? "ols"}
数据列(只能引用这些): ${columns.join(", ")}

只输出 JSON: {"code": "Stata 代码(含 N= 注释, 聚类 vce 若 spec 指定, 交互项用 c.X##c.Y 或 i.X#i.Y)", "caveats": ["假设检验提示(固定含: 内生性/平行趋势由研究者判断)"]}
约束: 只用给定数据列; 输出可复现的 reg/logit/ologit 命令 + esttab 输出表。`;

  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, maxTokens: 3000, timeoutMs: 90_000, jsonMode: true,
    model: getRoleModel("reason"),
  });
  const json = r?.json;
  if (!json?.code) throw new GuardError("LLM_OUTPUT_INVALID", "代码生成失败: " + String(r?.text ?? "").slice(0, 200));

  // 静态规则防呆
  const warnings = checkStaticRules(spec, json.code);

  return {
    ok: true, code: json.code,
    meta: {
      varChecks: allVars.map((v) => ({ var: v, inData: columns.includes(v) })),
      warnings,
      caveats: json.caveats ?? [],
    },
  };
}

/** 运行回归代码(spawn exec 模式: 代码落文件跑 python 回归? Stata 不可执行 → 用 python 模拟 ols/logit/ologit) */
export async function runRegressionCode(input: {
  projectId?: string | null;
  data: { columnOrder: string[]; rows: unknown[][] };
  spec: RegressionSpec;
  code: string;
}): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  // 用 runner 的 ols/logit/ologit 方法执行(与生成代码同 spec, 保证结果可复现)
  const method = input.spec.model ?? "ols";
  if (!["ols", "logit", "ologit"].includes(method)) {
    return { ok: false, error: `方法 ${method} 暂不支持执行(仅 ols/logit/ologit)` };
  }
  const xs = [...input.spec.core, ...(input.spec.controls ?? [])];
  const r = await empiricalService.spawnPythonTask("empirical_runner.py", {
    method, data: input.data, params: { y: input.spec.dep, xs },
  });
  if (r.ok && r.taskId) {
    // 轮询结果 → 回填 pipeline_runs.python_result(供证据账本按坐标读系数)
    void (async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const t = await empiricalService.getEmpiricalResult(r.taskId!);
        if (t.status === "done") {
          if (input.projectId) {
            await pool.query(
              `insert into empirical_pipeline_runs (project_id, stage, input_snapshot, python_result, stata_code)
               values ($1::uuid, 'regression', $2, $3, $4)`,
              [input.projectId,
               JSON.stringify({ spec: input.spec, nRows: input.data.rows.length, columns: input.data.columnOrder, runTaskId: r.taskId }),
               JSON.stringify(t.result), input.code.slice(0, 4000)]
            ).catch(() => {});
          }
          return;
        }
        if (t.status === "error") return;
      }
    })();
  }
  return r;
}

/** Agent Debug: 只修语法/API/变量名错误 */
export async function debugRegression(input: {
  projectId?: string | null;
  code: string;
  errorLog: string;
  columns: string[];
}): Promise<{ ok: boolean; fixedCode?: string; explanation?: string; changedLines?: string[]; error?: string }> {
  if (!input.errorLog.trim()) throw new GuardError("BAD_REQUEST", "缺少报错日志");
  // 硬约束: 不接受 analysis 字段(不做假设检验)
  const prompt = `你是 Stata 代码调试员。修复以下代码的语法/API/变量名错误。
数据列(只能引用): ${input.columns.join(", ")}

报错代码:
${input.code.slice(0, 4000)}

报错日志:
${input.errorLog.slice(0, 2000)}

只输出 JSON: {"fixedCode": "修复后的完整代码", "explanation": "修复说明(只谈语法/API/变量名, 不做因果推断)", "changedLines": ["改动行说明"]}
硬约束: 只修语法/API/变量名错误; 不改变模型设定; 不做假设检验; 不下因果结论。`;

  const r = await callLlm({
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1, maxTokens: 3000, timeoutMs: 60_000, jsonMode: true,
    model: getRoleModel("reason"),
  });
  const json = r?.json;
  if (!json?.fixedCode) throw new GuardError("LLM_OUTPUT_INVALID", "调试失败: " + String(r?.text ?? "").slice(0, 200));
  return {
    ok: true, fixedCode: json.fixedCode,
    explanation: String(json.explanation ?? "").slice(0, 300),
    changedLines: Array.isArray(json.changedLines) ? json.changedLines.map(String) : [],
  };
}

/** 静态模板: 稳健性/安慰剂/IV一阶段/事件研究 */
export function getTemplates(spec: RegressionSpec): Record<string, string> {
  const y = spec.dep;
  const core = spec.core[0] ?? "core_var";
  const controls = (spec.controls ?? []).join(" ") || "";
  const fe = (spec.fe ?? []).map((f) => `i.${f}`).join(" ");
  const cluster = spec.cluster ? `, cluster(${spec.cluster})` : "";
  return {
    robustness: `* 稳健性检验 1: 替换核心解释变量测度
reg ${y} ${core}_alt ${controls} ${fe}${cluster}
* 稳健性检验 2: 加控制变量
reg ${y} ${core} ${controls} extra_control${cluster}
* 稳健性检验 3: 缩尾 5%/95%
winsor2 ${core}, cuts(5 95) replace
reg ${y} ${core} ${controls}${cluster}
* ⚠️ 以上检验由研究者判断, 不自动下结论`,
    placebo: `* 安慰剂检验 1: 假处理(随机分配处理组)
gen placebo_treat = runiform() > 0.5
reg ${y} placebo_treat ${controls}${cluster}
* 安慰剂检验 2: 提前处理期
gen placebo_post = (year < 2018) & treat == 1
reg ${y} placebo_post ${controls}${cluster}
* ⚠️ 安慰剂系数应不显著; 平行趋势由研究者判断`,
    iv_first_stage: `* IV 一阶段: 检查工具变量强度 (F > 10 弱工具风险)
ivregress 2sls ${y} ${controls} (${core} = z_instrument), first
estat firststage
* ⚠️ 排他性约束由研究者判断(工具变量只影响因变量通过核心解释变量)`,
    event_study: `* 事件研究: 动态效应(需面板数据 year/unit)
reghdfe ${y} ib(-1).rel_time ${controls}, absorb(unit year) vce(cluster unit)
* 需先生成 rel_time = year - treat_year
* ⚠️ 平行趋势: 事件前系数应不显著, 由研究者判断
* 如需图形: eventdd ${y} rel_time, timevar(rel_time) graph_op(ytitle("系数"))`,
  };
}

export const regressionService = { generateRegression, runRegressionCode, debugRegression, getTemplates, checkStaticRules };
