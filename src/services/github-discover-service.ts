// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// github-discover-service.ts — GitHub 需求直通检索
// 自然语言需求 → 意图判断（LLM 优先/正则兜底）→ 多词×多scope 并行检索 → 汇总去重排序
// 可选 Claude Code 智能筛选（noTools 模式，复用 ai-execute-service）
import { aiSettingsService } from "./ai-settings-service.js";
import { externalSourcesService } from "./external-sources-service.js";
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";

export interface DiscoverIntent {
  searchTerms: string[];
  scopes: Array<"repositories" | "issues" | "users">;
  category: string;
}

export interface DiscoverItem {
  repo: string;
  name: string;
  description: string;
  stars: number;
  language: string;
  updatedAt: string;
  url: string;
  matchedTerm: string;
  scope: string;
}

export interface DiscoverResult {
  intent: DiscoverIntent;
  items: DiscoverItem[];
  rateLimited: boolean;
  mode: "api" | "claude";
  analysis?: string;
  tookMs: number;
}

// ─── 中文→英文兜底映射表（LLM 不可用时用）───
const FALLBACK_TRANSLATIONS: Array<[RegExp, string]> = [
  [/三农|农业农村|农业农村/, "agriculture rural"],
  [/土地流转|资本下乡|工商资本/, "rural land"],
  [/乡村振兴/, "rural revitalization"],
  [/数据.*分析|分析.*数据/, "data analysis"],
  [/文本.*挖掘|语料/, "text mining corpus"],
  [/知识图谱|图谱/, "knowledge graph"],
  [/马克思主义|马理论/, "marxism"],
  [/资本/, "capital"],
  [/论文|文献/, "paper literature"],
  [/检索|搜索/, "search"],
  [/可视化/, "visualization"],
  [/学习/, "learning"],
  [/爬虫|抓取/, "crawler"],
  [/模型/, "model"],
  [/统计|实证/, "statistics empirical"],
  [/政策/, "policy"]
];

const STOP_WORDS = new Set([
  "我想", "我要", "想要", "希望", "找", "找到", "寻找", "一个", "一些", "那种", "这类",
  "可以", "能够", "帮我", "用于", "用来", "支持", "请问", "如何", "怎么", "什么", "领域",
  "需求", "工具", "开源", "代码", "项目", "仓库", "的", "和", "以及", "或者", "然后", "能"
]);

// ─── 正则快路径意图判断（零成本，LLM 不可用时兜底）───
function regexInterpret(need: string): DiscoverIntent {
  const chineseWords = need.match(/[一-龥]{2,18}/g) ?? [];
  const englishWords = need.match(/[a-zA-Z]{2,20}/g) ?? [];
  const terms: string[] = [];

  for (const word of chineseWords) {
    // 停用词过滤 + 长句拆词（取 2-6 字的关键子串）
    if (STOP_WORDS.has(word)) continue;
    if (word.length <= 6) {
      terms.push(word);
    } else {
      // 长词拆成 3-4 字滑动窗口
      const pieces = new Set<string>();
      for (let i = 0; i + 3 <= word.length; i += 2) {
        const piece = word.slice(i, i + 4);
        if (piece.length >= 3 && !STOP_WORDS.has(piece)) pieces.add(piece);
      }
      terms.push(...Array.from(pieces).slice(0, 3));
    }
  }
  for (const word of englishWords) terms.push(word.toLowerCase());

  // 兜底翻译
  for (const [re, en] of FALLBACK_TRANSLATIONS) {
    if (re.test(need) && !terms.some((t) => en.split(" ")[0] === t)) terms.push(en);
  }

  const categoryMatch = need.match(/[一-龥]{2,6}(?:领域|方向|分析|研究|工具|技能)/);
  const category = categoryMatch ? categoryMatch[0].replace(/领域|方向$/, "") : "通用";

  return {
    searchTerms: Array.from(new Set(terms)).filter(Boolean).slice(0, 6),
    scopes: need.includes("人") || need.includes("作者") || need.includes("大神") ? ["users", "repositories"] : ["repositories", "issues"],
    category
  };
}

// ─── LLM 意图判断（有远程 LLM 时用，输出中文+英文搜索词）───
async function llmInterpret(need: string): Promise<DiscoverIntent | null> {
  try {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) return null;
    // V381: 收敛到统一 LLM 入口（原裸 fetch + settings 端点）
    const r = await callLlm({
      url: `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`,
      key: settings.llmApiKey,
      model: settings.llmModel,
      temperature: 0.1,
      jsonMode: true,
      messages: [
        {
          role: "system",
          content: "你是 GitHub 搜索关键词规划器。把用户的需求转化为适合 GitHub 搜索的 JSON。必须输出 JSON，格式：{\"search_terms\": [\"中文词1\", \"英文翻译1\", \"中文词2\", \"英文翻译2\"...], \"scopes\": [\"repositories\"], \"category\": \"结果类别\"}。要求：4-6 个搜索词（中文原词 + 领域术语优先的英文对应词，如 土地流转→land transfer、资本下乡→capital going to countryside、三农→agriculture rural）；scopes 从 repositories/issues/users 中选 1-2 个；category 用 6 字内中文概括。"
        },
        { role: "user", content: need }
      ]
    });
    const parsed = r?.json as { search_terms?: string[]; scopes?: string[]; category?: string } | null;
    if (!parsed || !Array.isArray(parsed.search_terms) || parsed.search_terms.length === 0) return null;
    const validScopes = ["repositories", "issues", "users"];
    return {
      searchTerms: parsed.search_terms.filter((t: unknown) => typeof t === "string" && t.trim()).slice(0, 8),
      scopes: (parsed.scopes ?? ["repositories"]).filter((s) => validScopes.includes(s)) as DiscoverIntent["scopes"],
      category: String(parsed.category ?? "通用").slice(0, 6)
    };
  } catch {
    return null;
  }
}

export async function interpretNeed(need: string): Promise<DiscoverIntent> {
  const llm = await llmInterpret(need);
  return llm ?? regexInterpret(need);
}

// ─── 主检索流程 ───
export async function discoverGitHub(input: {
  need: string;
  mode: "api" | "claude";
  perSource?: number;
}): Promise<DiscoverResult> {
  const startedAt = Date.now();
  const perSource = Math.min(input.perSource ?? 5, 10);
  const intent = await interpretNeed(input.need);
  const rateLimited = false;

  // 词 × scope 并行（限制总量，避免打爆匿名配额）
  const searchTerms = intent.searchTerms.slice(0, 4);
  const scopes = intent.scopes.slice(0, 2);
  const tasks = searchTerms.flatMap((term) =>
    scopes.map((scope) => ({ term, scope }))
  ).slice(0, 8);

  const results = await Promise.allSettled(
    tasks.map(({ term, scope }) =>
      externalSourcesService.searchGitHub({ query: term, scope, perPage: perSource })
    )
  );

  // 汇总去重（按 repo full_name），限流检测
  const byRepo = new Map<string, DiscoverItem & { hitCount: number }>();
  let sawRateLimit = false;
  results.forEach((r, idx) => {
    if (r.status !== "fulfilled") return;
    const res = r.value;
    if (res.error?.includes("限流")) sawRateLimit = true;
    const term = tasks[idx]?.term ?? "";
    for (const item of res.items) {
      const raw = item as Record<string, unknown>;
      const repo = String(raw.name ?? raw.repo ?? "");
      if (!repo) continue;
      const existing = byRepo.get(repo);
      const entry: DiscoverItem & { hitCount: number } = {
        repo,
        name: String(raw.name ?? ""),
        description: String(raw.description ?? ""),
        stars: Number(raw.stars ?? 0),
        language: String(raw.language ?? ""),
        updatedAt: String(raw.updated_at ?? ""),
        url: String(raw.url ?? ""),
        matchedTerm: term,
        scope: tasks[idx]?.scope ?? "repositories",
        hitCount: (existing?.hitCount ?? 0) + 1
      };
      byRepo.set(repo, entry);
    }
  });

  // 排序：stars 降序 × 命中词数加权
  const items = Array.from(byRepo.values())
    .sort((a, b) => (b.stars * (1 + Math.log1p(b.hitCount))) - (a.stars * (1 + Math.log1p(a.hitCount))))
    .slice(0, 12)
    .map(({ hitCount, ...rest }) => rest);

  const result: DiscoverResult = {
    intent,
    items,
    rateLimited: sawRateLimit,
    mode: input.mode,
    tookMs: Date.now() - startedAt
  };

  // Claude Code 智能筛选
  if (input.mode === "claude" && items.length > 0) {
    try {
      const candidateText = items.map((item, i) =>
        `${i + 1}. ${item.repo} | ⭐${item.stars} | ${item.language} | ${item.description.slice(0, 150)}`
      ).join("\n");
      const prompt = `用户需求：${input.need}

以下是 GitHub 搜索到的候选开源项目（已按热度排序）：
${candidateText}

请：1) 从这些候选中筛选出最符合用户需求的 3-5 个；2) 对每个推荐给出 1-2 句中文理由（为什么匹配需求）；3) 如果候选都不太合适，明确说明并建议更好的搜索方向。用中文回答，简洁。`;
      // 2026-08-07 LLM API 直调智能筛选（替代 Claude CLI，模型用 reason 角色）
      // V381: 收敛到统一 LLM 入口
      try {
        const model = resolveModelAlias(getRoleModel("reason"));
        const llmRes = await callLlm({
          model, messages: [{ role: "user", content: prompt }],
          temperature: 0.2, maxTokens: 2000,
        });
        result.analysis = llmRes?.text || "LLM 筛选失败：无响应";
      } catch (error) {
        result.analysis = `LLM 筛选失败：${error instanceof Error ? error.message : String(error)}`;
      }
    } catch (error) {
      result.analysis = `LLM 筛选失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  result.tookMs = Date.now() - startedAt;
  return result;
}

export const githubDiscoverService = {
  interpretNeed,
  discoverGitHub
};
