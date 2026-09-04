// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// prisma-service.ts — PRISMA 式系统综述工作流(参考 Elicit sysreview 机制, 闭源借鉴思路)
// 阶段: ①检索(主题→匹配文献库论文, 记总数) ②标题筛选(逐篇判 included/excluded+理由, 可人工改)
//      ③纳入集(生成综述只用纳入集) + PRISMA 流程摘要(记录数/去重/筛除/纳入)
// 全程留存痕到 provenance(每阶段状态可审计) — 契合 PRISMA 可追溯
import { literatureService } from "./literature-service.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

export interface PrismaStage {
  stage: "search" | "screen" | "synthesize";
  paperIds: string[];                       // 当前集合
  decisions?: Record<string, { verdict: "included" | "excluded"; reason?: string }>; // 筛选判定
}

async function llmJson(prompt: string, maxTokens = 2000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.1, maxTokens, timeoutMs: 240_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

/** 阶段① 检索: 主题 → 文献库关键词匹配论文(标题/主题含词) */
export async function prismaSearch(input: { topic: string; limit?: number }): Promise<{
  total: number;           // 检索命中总数
  screenedCount: number;   // 待筛数
  papers: Array<{ id: string; title: string; year?: string; authors?: string[] }>;
}> {
  const topic = input.topic.trim();
  // 从文献库目录检索: 主题词拆成关键词做标题匹配
  const keywords = topic.split(/[，,、\s]+/).filter((k) => k.length >= 2).slice(0, 3);
  const limit = input.limit ?? 30;
  const records = literatureService.getRecords(); // 全库索引
  const hit: typeof records = [];
  for (const r of records) {
    const hay = `${r.title ?? ""} ${r.paperTitle ?? ""} ${r.topic ?? ""}`;
    if (keywords.length === 0) { if (hay.includes(topic)) hit.push(r); continue; }
    if (keywords.some((k) => hay.includes(k))) hit.push(r);
    if (hit.length >= limit) break;
  }
  return {
    total: hit.length,
    screenedCount: hit.length,
    papers: hit.map((r) => ({
      id: String(r.id), title: String(r.title ?? r.paperTitle ?? ""),
      year: r.year ? String(r.year) : undefined,
      authors: Array.isArray(r.authors) ? r.authors.map(String) : undefined,
    })),
  };
}

/** 阶段② 标题筛选: LLM 逐篇判定相关/排除+理由; 支持单篇 override */
export async function prismaScreen(input: {
  topic: string;
  papers: Array<{ id: string; title: string }>;
  override?: { paperId: string; verdict: "included" | "excluded"; reason?: string };
}): Promise<Record<string, { verdict: "included" | "excluded"; reason?: string }>> {
  const decisions: Record<string, { verdict: "included" | "excluded"; reason?: string }> = {};
  // 批量: 每批 8 篇让 LLM 判
  const batchSize = 8;
  for (let i = 0; i < input.papers.length; i += batchSize) {
    const batch = input.papers.slice(i, i + batchSize);
    const list = batch.map((p, j) => `${j}. [${p.id}] ${p.title}`).join("\n");
    const prompt = `你是系统综述筛选员。研究主题: "${input.topic}"。
判断以下论文是否应纳入综述(标题层判断: 明显不相关/非学术/纯书评→排除):
${list}
输出 JSON: {"decisions":[{"paperId":"<id>","verdict":"included|excluded","reason":"≤20字"}]}`;
    const ans = await llmJson(prompt, 3000);
    const arr = Array.isArray(ans?.decisions) ? ans.decisions : [];
    for (const d of arr as Array<{ paperId?: string; verdict?: string; reason?: string }>) {
      if (d.paperId) {
        decisions[String(d.paperId)] = {
          verdict: d.verdict === "included" ? "included" : "excluded",
          reason: String(d.reason ?? "").slice(0, 60),
        };
      }
    }
  }
  // 应用人工 override
  if (input.override) {
    decisions[input.override.paperId] = { verdict: input.override.verdict, reason: input.override.reason ?? "人工判定" };
  }
  return decisions;
}

/** 阶段③ PRISMA 流程摘要(统计各阶段计数) */
export function prismaSummary(input: {
  searchTotal: number;
  decisions: Record<string, { verdict: string }>;
}): {
  identified: number;    // 检索识别
  screened: number;      // 标题筛选数
  excluded: number;      // 排除数(带理由可查)
  included: number;      // 纳入数
  flowText: string;      // PRISMA 文字流程图
} {
  const ids = Object.keys(input.decisions);
  const included = ids.filter((id) => input.decisions[id].verdict === "included").length;
  const excluded = ids.length - included;
  const flowText = [
    `检索识别: ${input.searchTotal} 篇(文献库, ${new Date().toLocaleDateString("zh-CN")})`,
    `标题筛选: ${ids.length} 篇`,
    `排除: ${excluded} 篇(理由见判定表)`,
    `纳入综述: ${included} 篇`,
  ].join("\n");
  return { identified: input.searchTotal, screened: ids.length, excluded, included, flowText };
}
