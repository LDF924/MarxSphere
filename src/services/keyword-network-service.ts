// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// keyword-network-service.ts — 关键词共现聚类图谱(中文一张 / 英文一张)
//
// 由来: 旧平台有「研究主题中文关键词共现聚类图谱」与「研究主题英文关键词共现聚类图谱」
//   两张图(底层表 graph_nodes_edges_clusters), 本仓只有 mermaid 流程图/思维导图
//   (agent-editor-tools.ts 的 editor_chart_code), 缺"从一批文献现算研究主题结构"这一步。
//   这里把它补成**纯算法**: 输入 `{title, text}[]`(或一组关键词+文档), 输出前端直接可渲染的
//   nodes/edges/clusters。不碰数据库、不碰文件系统 —— 取语料交给调用方(见 loadLibraryDocs)。
//
// 每一步都对应一个"看着能跑、结论其实是假的"的坑:
//   ① **中文分词**。本仓既有的做法是 `text.match(/[一-龥]{2,6}/g)`(academic-research-service
//      frontierReport) —— 连续汉字按 2~6 一刀切, 切出来是 `资本的增殖` `研究中的` 这类含虚词
//      的片段。这类片段进了图谱就是节点, 而它们没有任何语义。这里换成无词典的四步:
//        (a) 按虚词(的/了/着…)与标点把汉字串**切成段** —— 含虚词的伪词连候选都形不成;
//        (b) 段内取 2~6-gram 当"候选词";
//        (c) **最大覆盖剪枝**: 短形式的计数几乎被某个更长候选吃光 → 丢掉(`乡村治` `村振兴`);
//        (d) 按**语料级词频**筛一遍, 再用**最大概率切分**(DP + unigram 模型)切出词流 ——
//            不用「能长就长」的贪心: 一个一次性长片段就能把它里面的真词全吃掉。
//      **这是无词典方案, 不是词典级分词**, 三条边界都在测试里钉着:
//        · `目的` 这类含虚词的真词会被切断(虚词表只收"不会长在实词内部"的字);
//        · 未进词表的字整段丢掉(代价记在 TokenStream.uncoveredChars);
//        · 词表必须**整批文档一起建**(tokenizeZhDocs), 逐篇建会让长片段把真词顶掉;
//          建完再按「文档 → 句子」切回段, 否则滑动窗口会跨过两篇论文、乃至被逗号切断;
//        · 切分**按词频打分**(DP), 不是「能长就长」的贪心 —— 后者遇到一个一次性长片段
//          就会把里面的真词整个吃掉(实测 `土地流转是乡村治理的关键环节` 被切成
//          `土地流转是乡` + `村治理的关`)。
//      拿这一点换掉的是"高频伪词霸榜"。
//      已知残留: 少数跨词碎片(如 `改变` `要求` `支撑` `格局`)会留到词表里, 靠默认 minCount=2
//      兜 —— 它们出现两三次、又短又不黏, 而真正的主题词出现得多得多; 而抬高 minCount 会让
//      吸收它们的长词一起掉出词表, 碎片反而更明显(这条边界在测试里钉着)。
//   ② **边权不能用裸共现次数**。裸计数下 `经济发展` 与 `社会` 这种"哪儿都出现"的词对会把
//      整张图连成一片, 结构全被淹没。默认 Jaccard(交并比), 另给 NPMI(归一化互信息)与 count;
//      测试里有一条锁死"高频泛词的边权必须低于强关联词对, 即使裸计数相同"。
//   ③ **社区发现要真做**。本仓 package.json 没有 graph 库, 所以自己实现 Louvain
//      (模块度增量贪心 + 分层收缩), 且带**固定种子**的确定性洗牌 —— 同一输入两次必须给出
//      同一张图, 否则前后端没法比对、缓存全废。
//   ④ **中英文分开**。分词规则与停用词表不同, 混一张图里中文节点会把英文节点挤掉;
//      buildBilingualNetworks 各自跑完整流程(旧平台那两张图就是这个形态)。
//
// 词汇: window(窗口) = 段内连续 windowSize 个词的片段; 边的共现强度由"含这两词的窗口数"
//   与"含各词的窗口数"算出(见 buildCooccurrence 的口径说明)。
import { literatureService } from "./literature-service.js";

export type Lang = "zh" | "en";
export type EdgeMeasure = "jaccard" | "pmi" | "count";

export interface KeywordDoc {
  id?: string;
  title?: string;
  text: string;
}

export interface KeywordNode {
  id: string;
  label: string;
  weight: number;   // 词频, 前端按它决定点大小
  cluster: number;  // 社区 id, 与 clusters[].id 对应
  lang: Lang;
}

export interface KeywordEdge {
  source: string;
  target: string;
  weight: number;   // 关联强度(口径见 measure), 前端按它决定连线粗细
  count: number;    // 裸共现窗口数 —— 只作展示, 不参与结构判断
}

export interface KeywordCluster {
  id: number;
  label: string;
  size: number;
  keywords: string[];
}

export interface KeywordNetwork {
  lang: Lang;
  nodes: KeywordNode[];
  edges: KeywordEdge[];
  clusters: KeywordCluster[];
  measure: EdgeMeasure;
  windowSize: number;
  docCount: number;
  /** 抛掉了什么(前端要能说清"图里只有 60 个词"): 孤立点 / 低频词 / 被截的边 */
  dropped: { isolated: number; rare: number; edges: number };
}

export interface NetworkOptions {
  /** 窗口大小(词)。默认 5 */
  windowSize?: number;
  /** 边权口径。默认 jaccard */
  measure?: EdgeMeasure;
  /** 入图最大节点数(按词频取前 N)。默认 60 */
  maxNodes?: number;
  /** 入图最大边数(按权重取前 N)。默认 400 */
  topEdges?: number;
  /** 词频低于此不进图。默认 2(小语料显式给 1) */
  minCount?: number;
  /** 词长下限(中文按字、英文按字母)。默认中文 2 / 英文 3 */
  minTermLength?: number;
  /**
   * 候选词的最大长度。默认中文 6(词表里真的会出现 `乡村振兴战略` 这种 6 字词 ——
   * 这是无词典方案唯一能得到长词的方式, 砍到 4 就把最像"主题"的词扔了)。
   * 英文按空格切词, 用不到这项。
   */
  maxTermLength?: number;
  /**
   * 中文候选词的字符覆盖率下限(`词长 × 词频 ÷ 汉字总数`), 默认 0(不启用)。
   * 调大 → 只留"占篇幅大"的词; 大语料上可以当第二道噪声闸, 但它会一并削掉
   * 真正短小精悍的概念, 所以默认不开。
   */
  minCoverage?: number;
  /** 社区发现分辨率: >1 切得更碎, <1 并得更狠。默认 1 */
  resolution?: number;
  /** 随机种子(同种子同结果)。默认 20261001 */
  seed?: number;
  /** 追加停用词(与内置表合并) */
  stopwords?: string[];
  /** clusters[].keywords 列几个词。默认 8 */
  clusterKeywords?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 语言判定与切段
// ═══════════════════════════════════════════════════════════════════════════

/** CJK 统一表意文字(含扩展 A / 兼容区) */
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * 断句符。中文的**逗号/顿号不断句** —— 一个句子就是一个窗口范围。
 *
 * ⚠ 这是窗口的实际边界, 不是"顺便断一下": 词流最终按**句子**重组(见 buildKeywordNetwork),
 *   句内可以跨逗号共现, 句外不行。按汉字串(`zhRuns`)当窗口单元会让逗号变成硬边界 ——
 *   `资本下乡，乡村治理` 这种两个词被逗号隔开的情况永远连不起来, 图是空的还不报错(实测)。
 * 英文句点要求后面跟空白, 避开 `et al.` 之外的大多数缩写; 常见学术缩写再单独放行。
 */
const ABBREV = new Set(["et", "al", "e.g", "i.e", "vs", "fig", "eq", "no", "ref", "cf", "ca", "resp", "pp"]);
const SENT_END_ZH = /[。！？；\n\r]+/;
const SENT_END_EN = /([.!?;]+)(?=\s|$)/;

export function splitSegments(text: string, lang: Lang): string[] {
  if (lang === "zh") return text.split(SENT_END_ZH).filter((s) => s.trim().length > 0);
  const out: string[] = [];
  const parts = text.split(SENT_END_EN);
  let buf = "";
  for (let i = 0; i < parts.length; i++) {
    // split 带捕获组: 偶数下标是正文, 奇数下标是分隔符
    if (i % 2 === 1) {
      const trimmed = buf.trim().toLowerCase();
      const last = trimmed.split(/\s+/).pop() ?? "";
      if (ABBREV.has(last) || ABBREV.has(last.replace(/\.$/, "")) || last.length <= 1) {
        buf += parts[i];        // 缩写点: 不算句末, 原样还回去
      } else {
        out.push(buf);
        buf = "";
      }
    } else {
      buf += parts[i];
    }
  }
  if (buf.trim()) out.push(buf);
  return out.filter((s) => s.trim().length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. 停用词表
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 断段用的虚词(单字)。**只收"几乎不可能长在实词内部"的字** —— 这比停用词表更要紧:
 * 停用词表只能整词匹配, 而 `资本的增殖` 不等于任何停用词, 必须从**切分**上断掉。
 * 反例(所以**不**收): 为(行为/认为)、就(就业)、在(存在)、中(中国/中心)、及(涉及)、
 * 过(过程) —— 它们既是虚词又是实词的一部分, 断在这里会把真词切碎。
 */
const ZH_BREAK = new Set("的了着吗呢吧啊呀嘛嗯啦哦之于矣焉哉".split(""));

/**
 * 中文停用词。前半虚词/代词, 后半是**通用学术套话** —— 它们在每篇里都出现, 进图谱只会变成
 * 连到所有人的枢纽节点(旧平台那张图糊成一团, 主要就是这类词干的)。
 */
const ZH_STOP = new Set([
  "我们", "你们", "他们", "它们", "自己", "什么", "怎么", "怎样", "为什么", "如何",
  "这个", "那个", "这些", "那些", "这里", "那里", "这样", "那样", "各种", "各个",
  "以及", "或者", "但是", "然而", "因此", "所以", "而且", "并且", "如果", "虽然",
  "因为", "由于", "为了", "对于", "关于", "基于", "随着", "通过", "根据", "按照",
  "其中", "之间", "之后", "之前", "之一", "以上", "以下", "上述", "下列", "一般",
  "可以", "需要", "应该", "必须", "能够", "具有", "进行", "成为", "作为", "存在",
  "不是", "没有", "就是", "而是", "还有", "只有", "只是", "不仅", "不但", "不断",
  "研究", "论文", "本文", "文中", "文章", "作者", "问题", "方法", "结果", "发现",
  "分析", "探讨", "论述", "阐述", "指出", "认为", "表明", "显示", "说明", "提出",
  "意义", "作用", "影响", "关系", "情况", "方面", "过程", "内容", "特点", "特征",
  "重要", "主要", "基本", "具体", "进一步", "逐步", "始终", "同时", "此外", "另外",
  "首先", "其次", "最后", "总之", "综上", "目前", "当前", "一定", "十分", "非常",
  "比较", "更加", "越来越", "得到", "实现", "促进", "推动", "形成", "发展", "提高",
  "加强", "完善", "有效", "充分", "积极", "相关", "有关", "一切", "所有", "任何",
  "其他", "其它", "部分", "整体", "全局", "水平", "角度", "层面", "领域", "视角",
  // ⚠ 构词成分: 最大覆盖剪枝**削不掉**它们 —— `主义` 长在 `马克思主义` 与 `社会主义` 里,
  //   两个更长形式各自贡献计数, 它自己也有一定频次, 于是活下来变成"连到所有政治词的枢纽"。
  //   对这类词只能点名(它们在任何一篇论文里都不承载信息)。
  "主义", "思想", "理论", "制度", "体系", "机制", "模式", "结构", "功能", "元素",
  "现象", "事物", "概念", "范畴", "命题", "逻辑", "价值", "观念", "意识", "行为",
  "历史", "社会", "国家", "世界", "时代", "阶段", "时期", "条件", "因素", "基础",
]);

/** 英文停用词(功能词 + 学术套话) */
const EN_STOP = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "as", "at", "by",
  "for", "from", "in", "into", "of", "on", "onto", "to", "with", "without", "within",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done",
  "have", "has", "had", "having", "will", "would", "shall", "should", "can", "could",
  "may", "might", "must", "not", "no", "nor", "only", "also", "such", "this", "that",
  "these", "those", "it", "its", "they", "them", "their", "there", "here", "we", "our",
  "you", "your", "he", "she", "his", "her", "who", "whom", "which", "what", "when",
  "where", "why", "how", "all", "any", "both", "each", "few", "more", "most", "much",
  "many", "some", "other", "others", "another", "same", "own", "very", "too", "just",
  "about", "above", "after", "again", "against", "among", "around", "because", "before",
  "below", "between", "during", "through", "under", "until", "while", "however",
  "therefore", "thus", "moreover", "furthermore", "although", "though", "yet", "still",
  "paper", "study", "research", "article", "author", "authors", "results", "result",
  "method", "methods", "analysis", "approach", "finding", "findings", "conclusion",
  "conclusions", "discussion", "introduction", "based", "using", "used", "use", "propose",
  "proposed", "presents", "present", "show", "shows", "shown", "argue", "argues",
  "suggest", "suggests", "significant", "significantly", "important", "main", "major",
  "new", "novel", "different", "various", "several", "first", "second", "third", "finally",
  "et", "al", "eg", "ie", "cf", "vs", "etc", "fig", "eq", "ref", "vol", "pp",
]);

export function stopwordsFor(lang: Lang, extra: string[] = []): Set<string> {
  const base = lang === "zh" ? ZH_STOP : EN_STOP;
  if (extra.length === 0) return base;
  const merged = new Set(base);
  for (const w of extra) {
    const t = w.trim();
    if (t) merged.add(lang === "zh" ? t : t.toLowerCase());
  }
  return merged;
}

/**
 * 英文词形还原(**只做屈折**, 不做派生)。
 *
 * 屈折(复数/时态/比较级)对"是不是同一个概念"没有信息量, 不合并会让 `institution` 与
 * `institutions` 各占一个节点 —— 图看着两倍词、其实一个话题。派生**不合并**: `govern` 与
 * `governance` 保持两个节点, 那是不同的概念层次, 合并会把"治理"与"统治"糊在一起。
 * 不规则形查表(analysis/hypothesis/criterion 这类学术高频词靠规则拼不回来)。
 */
const EN_IRREGULAR: Record<string, string> = {
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", analyses: "analysis", hypotheses: "hypothesis",
  theses: "thesis", crises: "crisis", criteria: "criterion", phenomena: "phenomenon",
  indices: "index", matrices: "matrix", vertices: "vertex", appendices: "appendix",
  nuclei: "nucleus", stimuli: "stimulus", curricula: "curriculum", strata: "stratum",
  alumni: "alumnus", better: "good", best: "good", worse: "bad", worst: "bad",
};

export function lemmatizeEn(raw: string): string {
  const w = raw.toLowerCase();
  if (EN_IRREGULAR[w]) return EN_IRREGULAR[w];
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is")) return w;
  if (w.endsWith("s")) return w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) {
    const stem = w.slice(0, -3);
    return /([bdfglmnprt])\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (w.endsWith("ed") && w.length > 4) {
    const stem = w.slice(0, -2);
    return /([bdfglmnprt])\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════
// C. 中文: 段 → 候选 → 剪枝 → 最大匹配
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 汉字串切片: 按**虚词**、标点、字母数字断开, 得到连续的纯汉字段。
 * 段边界就是"候选词不可能跨过"的边界 —— `资本的增殖` 会先被切成 资本 / 增殖 两段,
 * 于是含 `的` 的伪词连候选都形不成。
 *
 * ⚠ `的` 本身是 CJK 字符, 所以这里必须显式查 ZH_BREAK —— 只按"是不是汉字"判断是断不开的。
 */
export function zhRuns(text: string): string[] {
  const runs: string[] = [];
  let run = "";
  for (const ch of text) {
    if (CJK.test(ch) && !ZH_BREAK.has(ch)) { run += ch; continue; }
    if (run) { runs.push(run); run = ""; }
    // 虚词与标点一样只是"断开": 断开处不产出任何候选, 虚词自己也不成为词
  }
  if (run) runs.push(run);
  return runs;
}

/**
 * 候选 n-gram 及其频次。返回的**不是词** —— 里面必然混着跨词边界的碎片
 * (`乡村治` `村治理` `村振兴`), 由 absorbByLongerForms 剪掉。
 */
export function zhCandidates(runs: string[], minLen = 2, maxLen = 6): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (let n = minLen; n <= maxLen; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** 单字频次 —— "字符覆盖率"判据的分母 */
export function zhUnigramTotal(runs: string[]): number {
  let total = 0;
  for (const run of runs) total += run.length;
  return total;
}

/**
 * **最大覆盖剪枝**: 一个短形式如果"几乎总是"长在某个更长的候选里, 它就不是独立的词。
 *
 *   count(短) ≤ ratio × count(长)  →  丢掉短形式
 *
 * 为什么用"计数比"而不是 PMI 那种内聚度: **它是规模无关的**。内聚度看着更"有原理", 但实测
 * (见 git 历史里那一版)长片段的 PMI 恒为正且随长度单调上涨 —— `与乡村治理相` 能比 `乡村` 高出
 * 8 个数量级, 阈值根本定不出来。计数比没这个问题: `乡村治` 只要总是出现在 `乡村治理` 里,
 * 两者的计数就相等, 与语料多大无关。
 *
 * ⚠ "更长"必须扫**所有**更长的候选, 不能只扫 +1/+2 个字: `村振兴` 的真实吸收者是 6 字的
 *   `乡村振兴战略`, 差 3 个字; 只扫相邻长度时它活了(实测), 图谱里于是留下跨词边界的碎片。
 * ⚠ 它**只能削不能立**: `村振兴` 与 `乡村治` 谁都不包含谁, 互相削不掉 —— 但两者各自都被
 *   `乡村振兴战略` / `乡村治理` 削掉, 所以只要候选长度上限够用就没事。上限(默认 6)不够时
 *   会出现"两个碎片互为最长形式"的局面, 这时靠 minCount 与字符覆盖率兜。
 */
export function absorbByLongerForms(
  counts: Map<string, number>,
  opts: { minLen?: number; ratio?: number } = {},
): Set<string> {
  const minLen = opts.minLen ?? 2;
  const ratio = opts.ratio ?? 1.2;
  const absorbed = new Set<string>();
  for (const [t, ct] of counts) {
    if (t.length <= minLen) continue;          // 最短形式没有被吸收的余地
    for (let ls = t.length - 1; ls >= minLen; ls--) {
      for (let off = 0; off + ls <= t.length; off++) {
        const sub = t.slice(off, off + ls);
        const cs = counts.get(sub);
        if (cs !== undefined && cs <= ratio * ct) absorbed.add(sub);
      }
    }
  }
  return absorbed;
}

/**
 * **最大概率切分**(动态规划), 不是"能长就长"的贪心匹配。
 *
 * 为什么不能用贪心最长匹配: 词表里只要有一个长的一次性片段, 它就会把里面的真词整个吃掉 ——
 * 实测 `土地流转是乡村治理的关键环节` 被切成了 `土地流转是乡` + `村治理的关`, 而 `乡村治理`
 * 从头到尾没出现(它在语料里出现 5 次)。贪心对**词表质量**没有任何要求, 于是词表差一点,
 * 输出就全崩。
 *
 * 目标函数: 最大化 Σ log(词频)。跳过未登录字要付 `log(0.5)` 的代价 ——
 * 这个代价不能设得太大(否则算法宁可拿一次性长片段糊住整句), 也不能太小
 * (否则真词会被拆散)。0.5 对应"这里的字有一半概率是生词", 实测能分开那两种情况。
 *
 * 与 jieba 一类分词器用的是同一套 unigram 模型, 区别只是词表是从语料现统计出来的。
 */
export function maxProbSegmentation(
  run: string,
  vocab: Map<string, number>,
  maxLen: number,
  skipPenalty = Math.log(0.5),
): { words: string[]; skipped: number } {
  const n = run.length;
  if (n === 0) return { words: [], skipped: 0 };
  const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY);
  const from = new Int32Array(n + 1);
  const isSkip = new Uint8Array(n + 1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    // ① 跳过一个未登录字
    let bs = best[i - 1] + skipPenalty;
    best[i] = bs; from[i] = i - 1; isSkip[i] = 1;
    // ② 以 i 结尾、长度 2..maxLen 的登录词
    for (let len = 2; len <= maxLen && len <= i; len++) {
      const w = run.slice(i - len, i);
      const c = vocab.get(w);
      if (c === undefined) continue;
      const score = best[i - len] + Math.log(c);
      if (score > bs) { bs = score; best[i] = score; from[i] = i - len; isSkip[i] = 0; }
    }
  }
  const words: string[] = [];
  let skipped = 0;
  for (let i = n; i > 0;) {
    const prev = from[i];
    if (isSkip[i]) skipped++;
    else words.push(run.slice(prev, i));
    i = prev;
  }
  return { words: words.reverse(), skipped };
}

export interface TokenStream {
  /** 按段切好的词流(段 = 句子级片段, 窗口不跨段) */
  segments: string[][];
  /** 词频(按最大概率切分重算, 不是候选 n-gram 的计数) */
  freq: Map<string, number>;
  /** 词表大小(剪枝后), 便于调用方判断语料是否够 */
  vocabSize: number;
  /** 词表没覆盖到的汉字数 —— 未登录词被整段丢掉的代价, 调用方要能看见 */
  uncoveredChars: number;
}

/**
 * 文本 → 句子 → 汉字切片。**窗口单元是句子**, 不是汉字串 ——
 * 逗号/顿号不是边界(句内可以跨逗号共现), 只有 。！？；换行 才是。
 * 空的句子(整句没有汉字, 比如中英混排里的英文句)直接丢掉: 它不承载任何中文词。
 */
export function zhSentenceRuns(text: string): string[][] {
  return splitSegments(text, "zh")
    .map((s) => zhRuns(s))
    .filter((rs) => rs.length > 0);
}

/**
 * 中文语料的**分词阶段**(整批文档一起做)。
 *
 * ⚠ 必须整批一起做, 不能逐篇独立切: 候选计数、最大覆盖剪枝、"哪些字没被词表覆盖"全是
 *   **语料级**统计。逐篇做时每篇只有几个候选, 剪枝判定退化 —— 实测逐篇切出来的词表被
 *   "模板胶水长片段"(`乡村治理转型` `为乡村治理提`)占满, 而 `乡村治理` 反而进不去。
 *
 * 三步: 切片 → n-gram 候选 + 最大覆盖剪枝 → 最大概率切分。
 * 顺序上**先按 minCount 滤词表再切分**很关键: 低频长片段不参与匹配, 于是
 * `乡村治理转型`(计数少)不会把 `乡村治理`(计数多)顶掉 —— 这正是逐篇分词最容易出错的地方。
 */
export function tokenizeZhCorpus(runs: string[], opts: {
  minTermLength?: number; maxTermLength?: number; minCount?: number; stopwords?: string[]; minCoverage?: number;
} = {}): { segments: string[][]; freq: Map<string, number>; vocabSize: number; candidateCount: number; uncoveredChars: number } {
  const minLen = opts.minTermLength ?? 2;
  const candMax = opts.maxTermLength ?? 6;
  const minCount = Math.max(1, opts.minCount ?? 1);
  const minCoverage = opts.minCoverage ?? 0;
  const stop = stopwordsFor("zh", opts.stopwords ?? []);
  const cands = zhCandidates(runs, minLen, candMax);
  const absorbed = absorbByLongerForms(cands, { minLen });
  const totalChars = zhUnigramTotal(runs);
  let established = 0;                     // 过了剪枝与停用词、但还没按频次筛的候选数
  const vocab = new Map<string, number>(); // 词 → 语料级候选频次(DP 切分的打分依据)
  for (const [t, c] of cands) {
    if (absorbed.has(t) || stop.has(t)) continue;
    if (t.length * c < minCoverage * totalChars) continue;
    established++;
    if (c >= minCount) vocab.set(t, c);
  }
  // 切分 → 再剪一轮 → 再切分。为什么要第二轮: 候选阶段的计数是**重叠计数**
  //   (`分配格局` 出现 3 次会让 `格局` 也记 3 次, 两者计数相同甚至倒挂), 于是第一轮吸收
  //   判据分不开谁是谁。切完之后 `格局` 的真实词频全部来自 `分配格局`, 两者的**最终词频**
  //   相等 —— 这时同一条判据就成立了。实测: 少这一轮, 图里会留下 `格局` `分配` 这类碎片。
  let segments: string[][] = [];
  let freq = new Map<string, number>();
  let uncovered = 0;
  for (let round = 0; round < 4; round++) {
    uncovered = 0;
    segments = [];
    for (const run of runs) {
      const r = maxProbSegmentation(run, vocab, candMax);
      uncovered += r.skipped;
      segments.push(r.words);
    }
    freq = new Map<string, number>();
    for (const seg of segments) for (const t of seg) freq.set(t, (freq.get(t) ?? 0) + 1);
    // 只拿"词表里还有的"参与判定; 被吃掉的词留在 vocab 里当打分依据, 但不再参与吸收比较,
    // 否则第二轮会把"已经不在词表里的词"再判一次, 结果不稳定
    let dropped = 0;
    const counts = new Map([...freq].filter(([t]) => vocab.has(t)));
    for (const t of absorbedByFinalCounts(counts, minLen)) {
      if (vocab.delete(t)) dropped++;
    }
    if (dropped === 0) break;
  }
  return { segments, freq, vocabSize: vocab.size, candidateCount: established, uncoveredChars: uncovered };
}

/**
 * 第二轮吸收: 直接用**切分后的真实词频**再跑一次同一条判据(短形式的计数几乎被更长形式吃光)。
 * 与候选阶段那条的区别只在"用哪个计数" —— 这里用的是切分结果, 所以不会再被重叠计数带偏。
 */
function absorbedByFinalCounts(counts: Map<string, number>, minLen: number): Set<string> {
  const absorbed = new Set<string>();
  for (const [t, ct] of counts) {
    if (t.length <= minLen) continue;
    for (let ls = t.length - 1; ls >= minLen; ls--) {
      for (let off = 0; off + ls <= t.length; off++) {
        const sub = t.slice(off, off + ls);
        const cs = counts.get(sub);
        if (cs !== undefined && cs <= 1.2 * ct) absorbed.add(sub);
      }
    }
  }
  return absorbed;
}

/**
 * 一批中文文档 → 各自的词流 + 全局词频。**整批一起建词表**, 再按"文档 → 句子"切回段。
 *
 * ⚠ 切回时必须**逐句**累加切片条数, 不能靠 `flat(2)` 之类的一把展平: 空句子会被 flat 折叠掉,
 *   于是切片总数对不上、游标错位(实测: `tok.segments[cursor] is not iterable`)。
 */
export function tokenizeZhDocs(texts: string[], opts: {
  minTermLength?: number; maxTermLength?: number; minCount?: number; stopwords?: string[]; minCoverage?: number;
} = {}): { byDoc: string[][]; freq: Map<string, number>; vocabSize: number; candidateCount: number; uncoveredChars: number } {
  const perDoc = texts.map((t) => zhSentenceRuns(t ?? ""));
  const flat: string[] = [];
  for (const sentences of perDoc) for (const rs of sentences) flat.push(...rs);
  const tok = tokenizeZhCorpus(flat, opts);
  const byDoc: string[][] = [];
  let cursor = 0;
  for (const sentences of perDoc) {
    const words: string[] = [];
    for (const rs of sentences) {
      for (let k = 0; k < rs.length; k++) {
        for (const w of tok.segments[cursor]) words.push(w);
        cursor++;
      }
    }
    byDoc.push(words);
  }
  return { byDoc, freq: tok.freq, vocabSize: tok.vocabSize, candidateCount: tok.candidateCount, uncoveredChars: tok.uncoveredChars };
}

/**
 * 单段文本的中文分词(便捷入口)。
 * ⚠ 它把"这一整段"当语料 —— 见 tokenizeZhCorpus 的说明: 语料级统计在长文本上才有意义。
 *   批量场景请用 tokenizeZhCorpus。
 */
export function zhTokenStream(text: string, opts: Parameters<typeof tokenizeZhCorpus>[1] = {}) {
  const sentences = zhSentenceRuns(text);
  const runs: string[] = [];
  for (const rs of sentences) runs.push(...rs);
  const tok = tokenizeZhCorpus(runs, opts);
  // 按**句子**分组返回段(与 buildKeywordNetwork 的窗口单元一致)
  const segments: string[][] = [];
  let cursor = 0;
  for (const rs of sentences) {
    const words: string[] = [];
    for (let k = 0; k < rs.length; k++) {
      for (const w of tok.segments[cursor]) words.push(w);
      cursor++;
    }
    segments.push(words);
  }
  return { segments, freq: tok.freq, vocabSize: tok.vocabSize, candidateCount: tok.candidateCount, uncoveredChars: tok.uncoveredChars };
}

/** 英文完整词流: 切段 → 切词 → 停用词 → 词形还原 → 词频 */
export function enTokenStream(text: string, opts: {
  minTermLength?: number; stopwords?: string[];
} = {}): TokenStream {
  const minLen = opts.minTermLength ?? 3;
  const stop = stopwordsFor("en", opts.stopwords ?? []);
  const freq = new Map<string, number>();
  const segments: string[][] = [];
  for (const seg of splitSegments(text, "en")) {
    const toks: string[] = [];
    for (const raw0 of seg.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? []) {
      const raw = raw0.replace(/['’-]+$/, "");
      if (raw.length < minLen || stop.has(raw)) continue;
      const lemma = lemmatizeEn(raw);
      if (lemma.length < minLen || stop.has(lemma)) continue;
      toks.push(lemma);
    }
    if (toks.length === 0) continue;
    segments.push(toks);
    for (const t of toks) freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return { segments, freq, vocabSize: freq.size, uncoveredChars: 0 };
}

/**
 * 按语言收词流。英文逐篇独立即可(没有"语料级词表"这件事); 中文要整批一起见 tokenizeZhCorpus。
 * `minCount` 只对中文有作用(它决定词表), 英文忽略。
 */
export function tokenStream(text: string, lang: Lang, opts: {
  minTermLength?: number; maxTermLength?: number; stopwords?: string[]; minCoverage?: number; minCount?: number;
} = {}): TokenStream {
  return lang === "zh"
    ? zhTokenStream(text, opts)
    : enTokenStream(text, { minTermLength: opts.minTermLength, stopwords: opts.stopwords });
}

export interface KeywordHit { word: string; count: number }

/**
 * 词频表(词云与图谱共用同一个入口)。
 * 两边必须同一口径, 否则词云里最大的词在图谱里找不到, 用户会当 bug 报。
 */
export function extractKeywords(
  text: string,
  lang: Lang,
  opts: { topK?: number; minCount?: number; stopwords?: string[]; minTermLength?: number; maxTermLength?: number; minCoverage?: number } = {},
): KeywordHit[] {
  const topK = Math.max(1, opts.topK ?? 100);
  const minCount = Math.max(1, opts.minCount ?? 2);
  const { freq } = tokenStream(text, lang, {
    minTermLength: opts.minTermLength, maxTermLength: opts.maxTermLength,
    stopwords: opts.stopwords, minCoverage: opts.minCoverage,
    // 同一个 minCount 既筛输出也筛词表 —— 两处若不同口径, 单文本入口与语料入口会给出不同的词
    minCount,
  });
  return [...freq.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, topK);
}

/**
 * 多篇文本合成一份词频表(词云的主要入口)。
 * ⚠ 必须整批一起统计 —— 逐篇统计再相加会得到同样的词频, 但**词表**会不一样(每篇各自决定
 *   哪些片段算词), 于是同一个词在不同篇里写法不同、被拆成好几个条目。
 */
export function extractCorpusKeywords(
  texts: string[],
  lang: Lang,
  opts: { topK?: number; minCount?: number; stopwords?: string[]; minTermLength?: number; maxTermLength?: number; minCoverage?: number } = {},
): KeywordHit[] {
  const topK = Math.max(1, opts.topK ?? 100);
  // ⚠ minCount 默认 2, 与 buildKeywordNetwork 一致 —— 它不只是"过滤输出", 还决定**词表**:
  //   放进只出现一次的候选后, 一次性的长片段会把真词挤掉(实测: `乡村治理` 被切散成 `乡村`+`治理`)。
  const minCount = Math.max(1, opts.minCount ?? 2);
  const freq = new Map<string, number>();
  if (lang === "zh") {
    const r = tokenizeZhDocs(texts, {
      minTermLength: opts.minTermLength, maxTermLength: opts.maxTermLength, minCount,
      stopwords: opts.stopwords, minCoverage: opts.minCoverage,
    });
    for (const [t, c] of r.freq) freq.set(t, c);
  } else {
    const minLen = opts.minTermLength ?? 3;
    for (const text of texts) {
      for (const [t, c] of enTokenStream(text ?? "", { minTermLength: minLen, stopwords: opts.stopwords }).freq) {
        freq.set(t, (freq.get(t) ?? 0) + c);
      }
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= minCount)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, topK);
}

// ═══════════════════════════════════════════════════════════════════════════
// D. 共现矩阵
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 词对 key 的基数: 2^22 ≈ 419 万词上限, 单 key ≤ 1.76e13 仍在安全整数内。
 * ⚠ 超过这个基数两个词对会撞同一个 key(静默的错边), 所以 idOf 里显式兜底。
 */
export const PAIR_KEY = 1 << 22;
const PAIR_K = PAIR_KEY;

export interface CooccurrenceMatrix {
  /** 参与统计的词, 与下标一一对应 */
  terms: string[];
  index: Map<string, number>;
  /** 含该词的窗口数 */
  winFreq: number[];
  /** 窗口总数(只计"至少含两个不同词"的窗口) */
  windows: number;
  /** 词对共现窗口数, key = min*K + max */
  pairs: Map<number, number>;
}

/**
 * 滑动窗口共现统计。口径写死(共现次数至少有三种算法, 不写死就没法比对):
 *   · 窗口**不跨段**(段由 splitSegments 给出), 大小固定 windowSize, 步长 1;
 *   · 一个窗口里同一个词出现两次只算一次 —— 免得窗口被复读词灌水;
 *   · 只统计"至少含两个**不同**词"的窗口; 全同词的窗口对关联强度没有贡献, 算进分母只会
 *     把所有概率一起压低。
 * 复杂度 O(段长 × windowSize²), 默认窗口 5 时每窗 ≤ 10 个词对。
 */
export function buildCooccurrence(segments: string[][], windowSize: number): CooccurrenceMatrix {
  const index = new Map<string, number>();
  const terms: string[] = [];
  const winFreq: number[] = [];
  const pairs = new Map<number, number>();
  let windows = 0;
  const size = Math.max(1, Math.min(50, Math.floor(windowSize)));

  const idOf = (t: string): number => {
    let i = index.get(t);
    if (i === undefined) {
      // 撞上 key 基数会让两对不相干的词共用一条边 —— 报出来而不是静默错边
      if (terms.length >= PAIR_K) throw new Error(`共现矩阵词数超上限(${PAIR_K}), 请调小 maxNodes`);
      i = terms.length; index.set(t, i); terms.push(t); winFreq.push(0);
    }
    return i;
  };

  for (const tokens of segments) {
    if (tokens.length < 2) continue;
    for (let s = 0; s < tokens.length; s++) {
      const win = new Set<string>();
      for (let i = s; i < Math.min(s + size, tokens.length); i++) win.add(tokens[i]);
      if (win.size < 2) continue;
      windows++;
      const ids = [...win].map(idOf).sort((a, b) => a - b);
      for (const id of ids) winFreq[id]++;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const k = ids[i] * PAIR_K + ids[j];
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
        }
      }
    }
  }
  return { terms, index, winFreq, windows, pairs };
}

// ═══════════════════════════════════════════════════════════════════════════
// E. 边权: 关联强度(不是裸频次)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Jaccard = |A∩B| / |A∪B|, 值域 (0,1]。
 * 选它做默认: 没有阈值参数、低频词对不会爆出天文数字, 而且**自带对高频词的惩罚** ——
 * `发展` 这种词自己就占掉分母的大半, 于是连不出一片(裸计数正好相反)。
 */
export function jaccard(pairWin: number, aWin: number, bWin: number): number {
  const union = aWin + bWin - pairWin;
  return union <= 0 ? 0 : pairWin / union;
}

/**
 * NPMI = PMI / −ln p(a,b), 值域 [−1,1]。
 * 用归一化的原因: 裸 PMI 偏爱低频词对(只共现过一次的词对 PMI 可以高过天天一起出现的高频词对),
 * 排序会被噪声主宰。+1 = 一个出现另一个必出现, 0 = 独立, −1 = 从不同时出现。
 */
export function npmi(pairWin: number, aWin: number, bWin: number, windows: number): number {
  if (pairWin <= 0 || windows <= 0 || aWin <= 0 || bWin <= 0) return 0;
  const pab = pairWin / windows;
  const pmi = Math.log(pab / ((aWin / windows) * (bWin / windows)));
  const denom = -Math.log(pab);
  return denom <= 0 ? 0 : Math.max(-1, Math.min(1, pmi / denom));
}

export function edgeWeight(measure: EdgeMeasure, pairWin: number, aWin: number, bWin: number, windows: number): number {
  if (measure === "count") return pairWin;
  if (measure === "pmi") return npmi(pairWin, aWin, bWin, windows);
  return jaccard(pairWin, aWin, bWin);
}

// ═══════════════════════════════════════════════════════════════════════════
// F. 社区发现: Louvain(自己实现, 不引依赖)
// ═══════════════════════════════════════════════════════════════════════════

/** 确定性伪随机(mulberry32): 同一 seed 同一张图 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 邻接表: adj[i] = (邻居 → 权重)。i 自己那项是自环(分层收缩时产生的社区内部权重) */
export type Adjacency = Array<Map<number, number>>;

export function buildAdjacency(n: number, edges: Array<[number, number, number]>): Adjacency {
  const adj: Adjacency = Array.from({ length: n }, () => new Map<number, number>());
  for (const [a, b, w] of edges) {
    if (a < 0 || b < 0 || a >= n || b >= n || !(w > 0)) continue;
    adj[a].set(b, (adj[a].get(b) ?? 0) + w);
    if (a !== b) adj[b].set(a, (adj[b].get(a) ?? 0) + w);
  }
  return adj;
}

/** 加权度(自环计两次 —— 与模块度公式 A_ii=2w 的口径一致) */
function weightedDegrees(adj: Adjacency): Float64Array {
  const k = new Float64Array(adj.length);
  for (let i = 0; i < adj.length; i++) {
    let s = 0;
    for (const [j, w] of adj[i]) s += j === i ? 2 * w : w;
    k[i] = s;
  }
  return k;
}

/**
 * Louvain 单层: 每个节点贪心搬去能让模块度增量最大的邻居社区。
 *
 * 增量 ∝ k_i,in − resolution · Σ_tot(c) · k_i / (2m) (与候选社区无关的常数项比较时省掉)。
 * 第二项是**惩罚**: 社区已经很大(Σ_tot 大)时再塞节点要付出代价 —— 没有它, 所有节点会一起
 * 滚进同一个巨型社区(去掉后实测就是一颗大球)。
 */
function louvainLevel(adj: Adjacency, resolution: number, rng: () => number, maxPasses: number): Int32Array {
  const n = adj.length;
  const comm = new Int32Array(n);
  if (n === 0) return comm;
  for (let i = 0; i < n; i++) comm[i] = i;
  const k = weightedDegrees(adj);
  let m2 = 0;
  for (let i = 0; i < n; i++) m2 += k[i];
  if (m2 <= 0) return comm;
  const tot = new Float64Array(n);
  for (let i = 0; i < n; i++) tot[i] = k[i];

  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = 0;
    for (const i of order) {
      const ci = comm[i];
      tot[ci] -= k[i];
      const neigh = new Map<number, number>();
      for (const [j, w] of adj[i]) neigh.set(comm[j], (neigh.get(comm[j]) ?? 0) + w);
      let bestC = ci;
      let bestGain = (neigh.get(ci) ?? 0) - resolution * tot[ci] * k[i] / m2;
      for (const [c, w] of neigh) {
        if (c === ci) continue;
        const gain = w - resolution * tot[c] * k[i] / m2;
        if (gain > bestGain + 1e-12) { bestGain = gain; bestC = c; }
      }
      tot[bestC] += k[i];
      if (bestC !== ci) { comm[i] = bestC; moved++; }
    }
    if (moved === 0) break;
  }
  return comm;
}

/** 收缩一层: 同社区的超点合并(社区内部权重原样累加, 于是变成自环) */
function aggregate(adj: Adjacency, comm: Int32Array, nComm: number): Adjacency {
  const out: Adjacency = Array.from({ length: nComm }, () => new Map<number, number>());
  for (let i = 0; i < adj.length; i++) {
    for (const [j, w] of adj[i]) {
      const a = comm[i];
      const b = comm[j];
      out[a].set(b, (out[a].get(b) ?? 0) + w);
    }
  }
  return out;
}

export interface CommunityResult {
  labels: number[];   // 每个节点 → 社区 id(0..count-1)
  count: number;
  levels: number;
  modularity: number;
}

/**
 * Louvain 全流程: 反复「单层划分 → 收缩」直到社区数不再减少, 再回填到原始节点。
 * 社区 id 按「簇大小降序、并列取最小成员下标」重排 —— 不重排的话 id 是内部编号,
 * 换个 seed 就变, 前端缓存与前后端对比全废。
 */
export function detectCommunities(
  n: number,
  edges: Array<[number, number, number]>,
  opts: { resolution?: number; seed?: number; maxPasses?: number; maxLevels?: number } = {},
): CommunityResult {
  if (n <= 0) return { labels: [], count: 0, levels: 0, modularity: 0 };
  const resolution = opts.resolution ?? 1;
  const rng = seededRng(opts.seed ?? 20261001);
  const maxPasses = opts.maxPasses ?? 60;
  const maxLevels = opts.maxLevels ?? 12;
  const adj0 = buildAdjacency(n, edges);
  let adj = adj0;
  const labels = Array.from({ length: n }, (_, i) => i);
  let levels = 0;

  for (let lv = 0; lv < maxLevels; lv++) {
    if (adj.length === 0) break;
    const comm = louvainLevel(adj, resolution, rng, maxPasses);
    let nComm = 0;
    for (const c of comm) if (c + 1 > nComm) nComm = c + 1;
    for (let i = 0; i < n; i++) labels[i] = comm[labels[i]];
    levels++;
    if (nComm >= adj.length) break;
    adj = aggregate(adj, comm, nComm);
  }

  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (!members.has(l)) members.set(l, []);
    members.get(l)!.push(i);
  }
  const ordered = [...members.entries()].sort((a, b) =>
    b[1].length - a[1].length || Math.min(...a[1]) - Math.min(...b[1]));
  const remap = new Map<number, number>();
  ordered.forEach(([l], newId) => remap.set(l, newId));
  for (let i = 0; i < n; i++) labels[i] = remap.get(labels[i])!;

  return { labels, count: ordered.length, levels, modularity: modularityOf(n, adj0, labels) };
}

/**
 * 模块度 Q(加权、无向): Q = Σ_c [ Σ_in(c)/(2m) − (Σ_tot(c)/(2m))² ]。
 * 只用于**验证**聚类确实比"全在一簇"更有结构(测试断言 Q 明显为正), 不参与聚类过程 ——
 * Louvain 走的是增量式目标, 两者口径要分开写才对得上。
 */
export function modularityOf(n: number, adj: Adjacency, labels: number[]): number {
  let m2 = 0;
  const k = weightedDegrees(adj);
  for (let i = 0; i < n; i++) m2 += k[i];
  if (m2 <= 0) return 0;
  const totSum = new Map<number, number>();
  const inSum = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    totSum.set(c, (totSum.get(c) ?? 0) + k[i]);
    for (const [j, w] of adj[i]) {
      if (labels[j] === c) inSum.set(c, (inSum.get(c) ?? 0) + (i === j ? 2 * w : w));
    }
  }
  let q = 0;
  for (const [c, tot] of totSum) {
    q += (inSum.get(c) ?? 0) / m2 - Math.pow(tot / m2, 2);
  }
  return q;
}

// ═══════════════════════════════════════════════════════════════════════════
// G. 组装图谱
// ═══════════════════════════════════════════════════════════════════════════

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * 一批文档 → 一张共现聚类图谱。
 *
 * 流程: 分词(按 lang 选管线) → 跨文档词频 → 取前 maxNodes → 窗口共现 → 关联强度当边权
 *      → 取前 topEdges → 丢孤立点 → Louvain 社区发现 → 组装。
 *
 * ⚠ 丢弃是**有记录**的(结果里的 dropped): 前端要能说明"图里只有 60 个词",
 *   而不是让人以为这就是语料的全部。
 */
export function buildKeywordNetwork(
  docs: KeywordDoc[],
  lang: Lang,
  options: NetworkOptions = {},
): KeywordNetwork {
  const windowSize = Math.max(1, Math.min(20, Math.floor(options.windowSize ?? 5)));
  const measure = options.measure ?? "jaccard";
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 60));
  const topEdges = Math.max(0, Math.floor(options.topEdges ?? 400));
  const minCount = Math.max(1, options.minCount ?? 2);
  const minLen = options.minTermLength ?? (lang === "zh" ? 2 : 3);
  const maxTermLength = options.maxTermLength ?? (lang === "zh" ? 6 : 1);
  const seed = options.seed ?? 20261001;
  const resolution = options.resolution ?? 1;
  const clusterKeywords = Math.max(1, options.clusterKeywords ?? 8);

  // ① 收词流。段不跨文档 —— 窗口更不能跨文档, 那是两篇论文。
  const segments: string[][] = [];
  const freq = new Map<string, number>();
  let docCount = 0;
  let zhCandidateCount = 0;

  if (lang === "zh") {
    // 中文整批一起建词表(候选计数与最大覆盖剪枝是语料级统计), 再按"文档 → 句子"切回段:
    // 句内可以跨逗号共现, 句间与文档间不行。
    const tok = tokenizeZhDocs(docs.map((d) => d.text ?? ""), {
      minTermLength: minLen, maxTermLength, minCount,
      stopwords: options.stopwords, minCoverage: options.minCoverage,
    });
    for (const words of tok.byDoc) {
      if (words.length === 0) continue;   // 纯英文/空文档: 不进中文图
      docCount++;
      segments.push(words);
    }
    for (const [t, c] of tok.freq) freq.set(t, c);
    zhCandidateCount = tok.candidateCount;
  } else {
    for (const doc of docs) {
      const stream = enTokenStream(doc.text ?? "", { minTermLength: minLen, stopwords: options.stopwords });
      if (stream.segments.length === 0) continue;
      docCount++;
      segments.push(...stream.segments);
      for (const [t, c] of stream.freq) freq.set(t, (freq.get(t) ?? 0) + c);
    }
  }

  // ② 词频排序取前 maxNodes
  const ranked = [...freq.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // 中文语料的 dropped.rare 由分词阶段直接给出(候选进过词表但频次不达标);
  // 英文逐篇切, 词表本身就是全量, 用"全量词数 − 达标词数"算, 两个口径在这里对齐。
  const rare = lang === "zh" ? Math.max(0, zhCandidateCount - ranked.length) : freq.size - ranked.length;
  const keptTerms = new Set(ranked.slice(0, maxNodes).map(([t]) => t));

  // ③ 窗口共现(只为留下的词算边)
  const matrix = buildCooccurrence(segments, windowSize);

  interface RawEdge { a: string; b: string; w: number; c: number }
  const rawEdges: RawEdge[] = [];
  for (const [key, count] of matrix.pairs) {
    const a = Math.floor(key / PAIR_K);
    const b = key % PAIR_K;
    const ta = matrix.terms[a];
    const tb = matrix.terms[b];
    if (!keptTerms.has(ta) || !keptTerms.has(tb)) continue;
    const w = edgeWeight(measure, count, matrix.winFreq[a], matrix.winFreq[b], matrix.windows);
    if (!(w > 0)) continue;   // NPMI 可能 ≤ 0(比独立还差) —— 那不是关联, 不进图
    rawEdges.push({ a: ta, b: tb, w, c: count });
  }
  rawEdges.sort((x, y) => y.w - x.w || y.c - x.c || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  const keptEdges = rawEdges.slice(0, topEdges);

  // ④ 丢孤立点(没有边的词在图里只是一粒没有信息的散点; 它的词频在词云里看得更清楚)
  const nodeTerms = [...new Set(keptEdges.flatMap((e) => [e.a, e.b]))]
    .sort((a, b) => (freq.get(b)! - freq.get(a)!) || a.localeCompare(b));
  const nodeId = new Map<string, number>();
  nodeTerms.forEach((t, i) => nodeId.set(t, i));
  const isolated = keptTerms.size - nodeTerms.length;

  // ⑤ 社区发现 + 组装
  const edgeTuples: Array<[number, number, number]> = keptEdges.map((e) => [nodeId.get(e.a)!, nodeId.get(e.b)!, e.w]);
  const community = detectCommunities(nodeTerms.length, edgeTuples, { resolution, seed });

  const nodes: KeywordNode[] = nodeTerms.map((t, i) => ({
    id: t,
    label: t,
    weight: freq.get(t) ?? 0,
    cluster: community.labels[i],
    lang,
  }));
  const edges: KeywordEdge[] = keptEdges.map((e) => ({
    source: e.a, target: e.b, weight: round6(e.w), count: e.c,
  }));

  const byCluster = new Map<number, KeywordNode[]>();
  for (const node of nodes) {
    if (!byCluster.has(node.cluster)) byCluster.set(node.cluster, []);
    byCluster.get(node.cluster)!.push(node);
  }
  const clusters: KeywordCluster[] = [...byCluster.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, members]) => {
      const sorted = [...members].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
      const kws = sorted.slice(0, clusterKeywords).map((m) => m.id);
      return { id, label: kws.slice(0, 3).join(" / "), size: members.length, keywords: kws };
    });

  return {
    lang, nodes, edges, clusters, measure, windowSize, docCount,
    dropped: { isolated: Math.max(0, isolated), rare: Math.max(0, rare), edges: rawEdges.length - keptEdges.length },
  };
}

/** 中英文两张图一次算完 —— 旧平台那两张图就是这个形态(各自分词/停用词/聚类) */
export function buildBilingualNetworks(
  docs: KeywordDoc[],
  options: NetworkOptions = {},
): { zh: KeywordNetwork; en: KeywordNetwork } {
  return {
    zh: buildKeywordNetwork(docs, "zh", options),
    en: buildKeywordNetwork(docs, "en", options),
  };
}

/** 语料语言自动判定(给"我只有一堆文本"的调用方): 按 CJK 字符占比 */
export function detectCorpusLang(text: string): Lang {
  const cjk = (text.match(/[㐀-䶿一-鿿]/g) ?? []).length;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0) return "en";
  if (letters === 0) return "zh";
  return cjk / (cjk + letters) >= 0.2 ? "zh" : "en";
}

/**
 * 只有关键词、没有正文的入口: 一组 `{keywords, docId}`。
 * 每个 docId 的关键词合成**一段** —— 这样窗口不跨文档, 只有同一文档内的关键词才算共现,
 * 与"用正文算"的语义一致。
 *
 * ⚠ 分隔符必须用逗号, 不能用句号: 句号是**断段符**, 用它拼出来的每个关键词各自成段,
 *   于是段内只有一个词、窗口恒为空, 整张图一条边都没有(实测踩过 —— 图是空的, 不报错)。
 */
export function buildNetworkFromKeywords(
  groups: Array<{ keywords: string[]; docId?: string }>,
  lang: Lang,
  options: NetworkOptions = {},
): KeywordNetwork {
  const docs: KeywordDoc[] = groups.map((g, i) => ({
    id: g.docId ?? `doc-${i}`,
    text: g.keywords.join("，"),
  }));
  return buildKeywordNetwork(docs, lang, options);
}

// ═══════════════════════════════════════════════════════════════════════════
// H. 取语料(唯一碰外部数据的一层)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从文献库取一批文档。文献库是文件系统形态(kb/journal/{主题}/Markdown/...),
 * `literatureService.getDetail().originalText` 已是剥掉 frontmatter 的正文。
 *
 * ⚠ 只取 limit 篇、每篇截 charsPerDoc 字 —— 全量读进来是几十 MB, 而共现统计对篇数早已饱和
 *   (再多只会让高频泛词更泛), 默认 80 篇 × 6000 字。
 */
export function loadLibraryDocs(opts: {
  topic?: string; keyword?: string; limit?: number; charsPerDoc?: number;
} = {}): KeywordDoc[] {
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 500);
  const chars = opts.charsPerDoc ?? 6000;
  const list = literatureService.list({ topic: opts.topic, keyword: opts.keyword, page: 1, pageSize: limit });
  const docs: KeywordDoc[] = [];
  for (const item of list.items) {
    const detail = literatureService.getDetail(item.id);
    const text = (detail?.originalText || detail?.summary || detail?.originalExcerpt || "").trim();
    if (!text) continue;
    docs.push({
      id: item.id,
      title: item.paperTitle || item.title,
      text: text.length > chars ? text.slice(0, chars) : text,
    });
  }
  return docs;
}

/** 主题 → 图谱的一步到位入口(路由/Agent 直接用这个) */
export function networkForTopic(topic: string, options: NetworkOptions & { limit?: number } = {}):
  { zh: KeywordNetwork; en: KeywordNetwork; docCount: number } {
  const docs = loadLibraryDocs({ topic, limit: options.limit });
  const { zh, en } = buildBilingualNetworks(docs, options);
  return { zh, en, docCount: docs.length };
}
