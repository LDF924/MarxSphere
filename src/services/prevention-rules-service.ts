// prevention-rules-service.ts — V391(P1-6): 错误模式 → 预防规则自动化
// 用户踩反馈 / 评测失败 → LLM 归因 → 生成预防规则（注入后续执行上下文, 防止同类错误复发）
import { pool } from "../db/pool.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

export interface PreventionRule {
  id: number;
  category: string;
  pattern: string;
  rule: string;
  source: string;
  hitCount: number;
  enabled: boolean;
  createdAt: Date;
}

/** 错误分类关键词 */
const CATEGORY_KEYWORDS: Array<{ category: string; keywords: string[] }> = [
  { category: "relevance", keywords: ["无关", "跑题", "不相关", "不对题", "离题"] },
  { category: "accuracy", keywords: ["错误", "不准确", "错", "误导", "事实"] },
  { category: "completeness", keywords: ["不完整", "缺失", "漏了", "少", "不全", "没答全"] },
  { category: "citation", keywords: ["引用", "来源", "出处", "文献", "注释"] },
  { category: "format", keywords: ["格式", "排版", "表格", "公式", "乱"] },
];

/** 关键词归因（快路径） + LLM 归因（生成可执行规则） */
export async function attributeError(input: {
  query: string;
  answer?: string;
  note?: string;
  source: "user_down" | "eval_failure";
}): Promise<{ category: string; pattern: string; rule: string } | null> {
  const text = `${input.query} ${input.note || ""}`;
  // 1. 关键词快路径分类
  let category = "unknown";
  for (const c of CATEGORY_KEYWORDS) {
    if (c.keywords.some((k) => text.includes(k))) { category = c.category; break; }
  }
  // 2. LLM 归因生成规则
  try {
    const model = resolveModelAlias(getRoleModel("plan"));
    const r = await callLlm({
      model,
      messages: [{
        role: "user",
        content: `你是错误归因分析器。用户对以下回答不满意（或评测失败），请归因并给出可执行的预防规则。
问题: ${input.query}
原回答摘要: ${(input.answer || "").substring(0, 300)}
用户反馈/失败信息: ${input.note || "（未注明）"}
只返回 JSON: {"category":"relevance|accuracy|completeness|citation|format|unknown","pattern":"问题关键词或类型(≤10字)","rule":"下次回答同类问题必须怎么做(≤50字, 可执行)"}`,
      }],
      temperature: 0.1, maxTokens: 300,
    });
    const parsed = JSON.parse((r?.text ?? "").trim().replace(/```json|```/g, ""));
    return {
      category: parsed.category || category,
      pattern: String(parsed.pattern || input.query.substring(0, 10)),
      rule: String(parsed.rule || "回答同类问题前先明确用户真实需求"),
    };
  } catch {
    return { category, pattern: input.query.substring(0, 10), rule: "回答同类问题前先明确用户真实需求并核实事实" };
  }
}

/** 生成并保存预防规则（去重: 同 pattern 累加 hit_count） */
export async function createPreventionRule(input: {
  category: string;
  pattern: string;
  rule: string;
  source: "user_down" | "eval_failure" | "manual";
}): Promise<PreventionRule> {
  // 去重: pattern（query 指纹）已唯一 → 命中累加
  const dup = await pool.query(
    "select id from prevention_rules where pattern = $1 and enabled limit 1",
    [input.pattern]
  );
  if (dup.rows.length > 0) {
    await pool.query("update prevention_rules set hit_count = hit_count + 1, rule = $2 where id = $1",
      [dup.rows[0].id, input.rule]);
    return getRule(Number(dup.rows[0].id)) as Promise<PreventionRule>;
  }
  const r = await pool.query(
    `insert into prevention_rules (category, pattern, rule, source) values ($1,$2,$3,$4) returning *`,
    [input.category, input.pattern, input.rule, input.source]
  );
  return mapRow(r.rows[0]);
}

/** 一键流程: 踩反馈/失败 → 归因 → 落库预防规则（同一 query 去重: 累加命中不重复创建） */
export async function recordAndAttribute(input: {
  query: string;
  answer?: string;
  note?: string;
  source: "user_down" | "eval_failure";
}): Promise<PreventionRule | null> {
  // 按 query 指纹去重（同问题反复踩 → 累加命中, 不产生重复规则）
  const qFp = input.query.replace(/[\s，。；：、！？（）"'「」【】\n\r]/g, "").substring(0, 20);
  const existing = await pool.query(
    "select id from prevention_rules where pattern = $1 and enabled limit 1",
    [qFp]
  );
  if (existing.rows.length > 0) {
    await pool.query("update prevention_rules set hit_count = hit_count + 1 where id = $1", [existing.rows[0].id]);
    return getRule(Number(existing.rows[0].id)) as Promise<PreventionRule>;
  }
  const attr = await attributeError(input);
  if (!attr) return null;
  return createPreventionRule({ ...attr, pattern: qFp, source: input.source });
}

/** 加载生效预防规则（注入 Agent 执行上下文） */
export async function loadActiveRules(limit = 20): Promise<string> {
  const r = await pool.query(
    "select category, pattern, rule, hit_count from prevention_rules where enabled order by hit_count desc, created_at desc limit $1",
    [limit]
  );
  if (r.rows.length === 0) return "";
  return "【防错规则(历史踩坑)】\n" + r.rows.map((x) => `- [${x.category}] ${x.pattern}: ${x.rule}（命中${x.hit_count}次）`).join("\n");
}

/** 命中计数（Agent 按规则执行后调用） */
export async function hitRule(ruleId: number): Promise<void> {
  await pool.query("update prevention_rules set hit_count = hit_count + 1 where id = $1", [ruleId]);
}

export async function listRules(): Promise<PreventionRule[]> {
  const r = await pool.query("select * from prevention_rules order by hit_count desc, created_at desc limit 100");
  return r.rows.map(mapRow);
}

export async function toggleRule(ruleId: number, enabled: boolean): Promise<void> {
  await pool.query("update prevention_rules set enabled = $2 where id = $1", [ruleId, enabled]);
}

async function getRule(ruleId: number): Promise<PreventionRule | null> {
  const r = await pool.query("select * from prevention_rules where id = $1", [ruleId]);
  return r.rows.length > 0 ? mapRow(r.rows[0]) : null;
}

function mapRow(row: any): PreventionRule {
  return {
    id: Number(row.id),
    category: row.category,
    pattern: row.pattern,
    rule: row.rule,
    source: row.source,
    hitCount: Number(row.hit_count),
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

export const preventionRulesService = {
  attributeError,
  createPreventionRule,
  recordAndAttribute,
  loadActiveRules,
  hitRule,
  listRules,
  toggleRule,
};
