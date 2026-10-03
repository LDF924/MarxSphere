// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// opinion-router.ts — 舆情检索的**信源路由**(2026-10-03)
//
// 由来(对照开源项目 观澜/Guanlan 的信源路由, MIT): 本仓的舆情检索此前**没有选源这一步** ——
//   前端只发 `query/days/limit`, 服务端就把 26 个非 track 源**全跑一遍**
//   (实测 `OpinionSearchPanel` 的入参里根本没有 sources/categories)。
//   后果不是"错", 是**浪费且噪声大**: 查"政策原文"也去跑 arXiv 与 ScienceDirect,
//   查"学者怎么看"也去跑微博热搜。周期一长还得靠熔断兜底。
//
// ═══ 与观澜的差别(不是照抄) ═══
//   观澜的路由表是给它自己的 50 个域名 + 36 个 scope 用的, 那些域名我们大多没有。
//   所以这里**只移植方法**, 数据换成我们自己这 28 个源的:
//     · 意图 → 优先信源(按 category 与具体 id 两级)
//     · 每条源带 authority / sample / freshness 三个价值分, 说明它**适合干什么**
//     · 明确写出"不作主要依据"的源 —— 这条比"推荐什么"更重要
//
// ⚠ 路由是**软**的: 它只决定"先跑哪些", 不禁止其他源。质量不足时调用方仍可全跑
//   (`route()` 回 alsoAcceptable 兜底), 与观澜的 fallback_scopes 同一个思路 ——
//   硬收敛会让"冷门主题一条都搜不到", 那比多跑几个源糟得多。
import type { OpinionCategory, OpinionSourceSpec } from "./opinion-sources.js";
import { enabledSources } from "./opinion-sources.js";

/** 研究问题想问哪一类东西 —— 与 opinion-sources 的 category 是**两个维度**:
 *  category 是"这是哪种源", intent 是"用户想要什么证据"。一个源可以服务多个意图。 */
export type OpinionIntent =
  | "policy"        // 政策怎么说(原文、法规、通知)
  | "official_data" // 官方数据(统计、公报)
  | "academic"      // 学界怎么评
  | "news_event"    // 发生了什么
  | "public_opinion"// 公众怎么议(注意: 是样本, 不是事实)
  | "tech_dev";     // 技术/开发者视角

export interface RoutePlan {
  query: string;
  /** 主要意图(按命中强度排序, 最多 2 个) */
  primary: OpinionIntent[];
  secondary: OpinionIntent[];
  /** 建议先跑的源 id —— 前端/服务据此传 `ids` */
  preferredSourceIds: string[];
  /** 一句话说清"为什么这样选", 直接显示给用户 */
  reason: string;
  /** 明确不作主要依据的源类别 —— 与"推荐什么"同等重要 */
  avoidAsPrimary: string[];
  /** 路由不确定时为 true —— 调用方应退回"全跑" */
  lowConfidence: boolean;
}

/** 意图判定词表。命中即计分, 取分最高的两个。
 *
 *  ⚠ 词表刻意**短而准**, 不照抄观澜那份几百词的长表: 它那份里混了大量具体产品/事件名
 *    (「充装站」「yd/t」「住房公积金贷款」…), 那是给它的品牌监测场景调出来的,
 *    放在通用科研检索里只会误伤。这里只保留**跨领域稳定**的学科信号词。
 */
const INTENT_TERMS: Record<OpinionIntent, readonly string[]> = {
  policy: [
    "政策", "法规", "条例", "通知", "办法", "意见", "规定", "规划", "纲要", "方案",
    "国务院", "部委", "中央", "印发", "征求意见", "试点", "监管", "备案", "合规",
    "一号文件", "十五五", "十四五", "全会", "精神",
  ],
  official_data: [
    "统计", "数据", "年鉴", "公报", "普查", "指标", "增速", "总量", "调查数据",
    "国家统计局", "海关总署", "人民银行",
  ],
  academic: [
    "研究", "论文", "文献", "综述", "理论", "实证", "机制", "效应", "模型",
    "学者", "学派", "范式", "方法论", "学科", "学术", "检验", "回归", "因果",
  ],
  news_event: [
    "事件", "通报", "回应", "事故", "最新", "进展", "发生", "近日", "曝光",
    "调查", "处罚", "争议", "风波",
  ],
  public_opinion: [
    "舆情", "民意", "舆论", "网友", "热议", "口碑", "评价", "怎么看", "吵", "抵制",
    "热搜", "刷屏", "吐槽", "支持还是反对",
  ],
  tech_dev: [
    "算法", "模型", "代码", "开源", "框架", "架构", "开发", "技术路线", "工程",
    "部署", "训练", "推理", "API",
  ],
};

/** 意图 → 优先的源类别; 顺序即优先级 */
const INTENT_TO_CATEGORIES: Record<OpinionIntent, OpinionCategory[]> = {
  policy: ["official", "news"],
  official_data: ["official", "news"],
  academic: ["academic"],
  news_event: ["news", "official"],
  public_opinion: ["social", "news"],
  tech_dev: ["news", "academic"],
};

/**
 * 意图 → 具体优先源 id。
 *
 * 这里才是路由真正**准**的地方: "政策" 精确到 `gov-cn-policy`(原文接口) 与
 * `gov-cn-search`(站内检索), 而不是笼统的"official 这一类"。
 */
const INTENT_TO_SOURCE_IDS: Record<OpinionIntent, string[]> = {
  policy: ["gov-cn-policy", "gov-cn-search", "people-politics", "xinhua-politics", "chinanews-theory"],
  official_data: ["gov-cn-policy", "gov-cn-search", "chinanews-scroll"],
  academic: ["arxiv-cs-cy", "arxiv-econ-gn", "osf-socarxiv", "sd-china-economic-review", "sd-world-development", "sd-rural-studies"],
  news_event: ["chinanews-scroll", "chinanews-society", "people-society", "jiemian", "xinhua-politics"],
  public_opinion: ["weibo-hot", "chinanews-society", "people-opinion"],
  tech_dev: ["arxiv-cs-cy", "arxiv-cs-si", "sspai", "chinanews-scroll"],
};

/**
 * 每个源的**用途画像**。三个分值各说一件事, 不合成一个总分 ——
 * 合成会把"权威但陈旧"和"新鲜但不可靠"变成同一个数, 那正是研究者最需要区分的。
 *   authority: 作为**事实依据**的可信度
 *   sample:    作为**公众观点样本**的价值
 *   freshness: 追踪**新进展**的价值
 */
const SOURCE_PROFILE: Record<string, { authority: number; sample: number; freshness: number; bestFor: string; notFor: string }> = {
  "gov-cn-policy": { authority: 0.95, sample: 0.05, freshness: 0.7, bestFor: "政策原文、法规条文的**一手依据**", notFor: "用它判断社会反响 —— 它只代表官方表述" },
  "gov-cn-search": { authority: 0.9, sample: 0.05, freshness: 0.6, bestFor: "按关键词找政府站内文件", notFor: "同上; 检索结果需点回原文核对" },
  "xinhua-politics": { authority: 0.85, sample: 0.15, freshness: 0.75, bestFor: "权威报道与官方叙事的第一轮", notFor: "不宜脱离来源身份单独下结论" },
  "people-politics": { authority: 0.85, sample: 0.15, freshness: 0.4, bestFor: "官方舆论场的**基调**", notFor: "该 RSS 发布时间冻结在 2025-06, **不能当近两日增量用**" },
  "people-opinion": { authority: 0.7, sample: 0.45, freshness: 0.4, bestFor: "党媒评论观点", notFor: "评论版是**立场表达**, 不是民意抽样" },
  "chinanews-scroll": { authority: 0.7, sample: 0.3, freshness: 0.8, bestFor: "事件性新闻的快速覆盖", notFor: "滚动流噪声大, 需按关键词筛" },
  "chinanews-theory": { authority: 0.65, sample: 0.4, freshness: 0.5, bestFor: "理论宣传文章", notFor: "不是学术论文, 引用需谨慎" },
  jiemian: { authority: 0.65, sample: 0.4, freshness: 0.8, bestFor: "财经与产业快讯", notFor: "商业媒体有自身议程" },
  sspai: { authority: 0.5, sample: 0.55, freshness: 0.7, bestFor: "工具与效率类实操经验", notFor: "个人博客性质, 不作事实依据" },
  "weibo-hot": { authority: 0.15, sample: 0.9, freshness: 0.95, bestFor: "**公众注意力**的样本(此刻大家在议什么)", notFor: "热搜热度是平台机制产物, 绝不等于事实或民意分布" },
  "arxiv-cs-cy": { authority: 0.75, sample: 0.1, freshness: 0.85, bestFor: "计算机领域预印本(未同行评审)", notFor: "预印本未审, 引用需注明" },
  "arxiv-econ-gn": { authority: 0.75, sample: 0.1, freshness: 0.85, bestFor: "经济学预印本", notFor: "同上" },
  "arxiv-cs-si": { authority: 0.75, sample: 0.1, freshness: 0.85, bestFor: "信息系统方向预印本", notFor: "同上" },
  "osf-socarxiv": { authority: 0.75, sample: 0.1, freshness: 0.8, bestFor: "社会科学预印本", notFor: "同上" },
  "sd-world-development": { authority: 0.9, sample: 0.05, freshness: 0.75, bestFor: "发展研究领域同行评审期刊", notFor: "英文文献, 中国议题覆盖有限" },
  "sd-rural-studies": { authority: 0.9, sample: 0.05, freshness: 0.75, bestFor: "农村研究期刊", notFor: "同上" },
  "sd-land-use-policy": { authority: 0.9, sample: 0.05, freshness: 0.75, bestFor: "土地政策期刊", notFor: "同上" },
  "sd-political-geography": { authority: 0.9, sample: 0.05, freshness: 0.75, bestFor: "政治地理期刊", notFor: "同上" },
  "sd-gov-info-quarterly": { authority: 0.9, sample: 0.05, freshness: 0.75, bestFor: "政府信息研究期刊", notFor: "同上" },
  "sd-china-economic-review": { authority: 0.9, sample: 0.05, freshness: 0.75, bestFor: "中国经济评论期刊", notFor: "同上" },
  "web-search": { authority: 0.4, sample: 0.4, freshness: 0.7, bestFor: "兜底: 上面都不覆盖时用", notFor: "通用检索**不定来源**, 引用前必须点回原站核对" },
};

/** 给一条源取画像(未登记的给中性值, 不编造) */
export function profileOf(sourceId: string) {
  return SOURCE_PROFILE[sourceId] ?? {
    authority: 0.5, sample: 0.5, freshness: 0.5,
    bestFor: "（未登记画像）", notFor: "（未登记画像, 使用前请自行判断）",
  };
}

/** 命中计分: 词出现在 query 里就加该词的长度权重(长词更具体, 更可信) */
function scoreIntents(query: string): Map<OpinionIntent, number> {
  const q = query.toLowerCase();
  const scores = new Map<OpinionIntent, number>();
  for (const [intent, terms] of Object.entries(INTENT_TERMS) as Array<[OpinionIntent, readonly string[]]>) {
    let s = 0;
    for (const t of terms) if (q.includes(t)) s += t.length;
    if (s > 0) scores.set(intent, s);
  }
  return scores;
}

/**
 * 生成路由计划。
 *
 * 判据: 一个源要么被"意图 → 具体 id"直接点名, 要么属于"意图 → 类别"。
 *   点名优先(它更准), 类别补充(它更全)。**不按分数排序后截断** ——
 *   截断掉的那个源可能恰好是这个主题唯一有货的, 而多跑几个源的代价只是几百毫秒。
 */
export function route(query: string): RoutePlan {
  const q = String(query ?? "").trim();
  const all = enabledSources({ includeTrack: true });
  const byId = new Map(all.map((s) => [s.id, s]));

  const scores = scoreIntents(q);
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const primary = ranked.slice(0, 2);
  const secondary = ranked.slice(2, 4);

  // 无信号: 不确定, 让调用方全跑
  if (!primary.length) {
    return {
      query: q,
      primary: [], secondary: [],
      preferredSourceIds: all.filter((s) => !s.track).map((s) => s.id),
      reason: "没识别出明确的研究意图，建议按默认范围全量检索。",
      avoidAsPrimary: [],
      lowConfidence: true,
    };
  }

  const picked: string[] = [];
  const add = (id: string) => {
    // 只收**真实存在且启用**的源 —— 词表里写了但注册表没有的, 静默跳过而不是塞给下游
    if (byId.has(id) && !picked.includes(id)) picked.push(id);
  };
  for (const intent of [...primary, ...secondary]) {
    for (const id of INTENT_TO_SOURCE_IDS[intent]) add(id);
  }
  // 类别补充: 每个命中的类别里, 未被点名的源按 authority+sample 排序补几个
  for (const intent of [...primary, ...secondary]) {
    const cats = INTENT_TO_CATEGORIES[intent];
    const extra = all
      .filter((s) => !picked.includes(s.id) && cats.includes(s.category))
      .sort((a, b) => {
        const pa = profileOf(a.id), pb = profileOf(b.id);
        return (pb.authority + pb.sample) - (pa.authority + pa.sample);
      })
      .slice(0, 3)
      .map((s) => s.id);
    for (const id of extra) add(id);
  }

  const avoid: string[] = [];
  if (primary.includes("policy") || primary.includes("official_data")) {
    avoid.push("微博热搜 —— 它是公众注意力样本，不能作为政策事实的依据");
  }
  if (primary.includes("academic")) {
    avoid.push("社交平台与商业媒体 —— 学术问题应回到同行评审文献");
  }
  if (primary.includes("public_opinion")) {
    avoid.push("官方发布 —— 它反映官方表述，无法回答「公众怎么看」");
  }
  void byId; void q;

  const label: Record<OpinionIntent, string> = {
    policy: "政策", official_data: "官方数据", academic: "学术文献",
    news_event: "事件动态", public_opinion: "公众舆论", tech_dev: "技术视角",
  };
  return {
    query: q,
    primary, secondary,
    preferredSourceIds: picked,
    reason: `识别为「${primary.map((i) => label[i]).join(" + ")}」类问题，优先跑 ${picked.length} 个对应信源`
      + `（其余 ${all.filter((s) => !s.track && !picked.includes(s.id)).length} 个本次不跑）。`,
    avoidAsPrimary: avoid,
    lowConfidence: false,
  };
}

/** 描述一条源的用途画像 —— 给前端"这个源适合问什么"用 */
export function describeSourcePurpose(spec: OpinionSourceSpec) {
  const p = profileOf(spec.id);
  return { id: spec.id, name: spec.name, category: spec.category, ...p };
}

/** 全部已登记画像的源 —— 界面上的"信源矩阵" */
export function sourceMatrix() {
  return enabledSources({ includeTrack: true })
    .map((s) => ({ ...describeSourcePurpose(s), baseUrl: s.baseUrl, enabled: s.enabled }));
}
