// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// sentiment-service.ts — 舆情文本的**情感极性 + 立场**分析(纯规则为底, LLM 只做校准)
//
// 由来(2026-10-01): 舆情检索要能回答"这条讨论是正面还是负面""这条是支持还是反对该政策",
//   本仓此前**没有任何情感分析**(全仓 grep 不到 sentiment/情绪极性)。
//
// 为什么**先做规则、LLM 只做可选校准**(而不是直接调模型):
//   ① 研究场景要**可复现**: 同一批语料今天和三个月后必须给出同样的标签, 否则
//      "政策出台后舆论转向"这种结论可能是模型版本变了; 规则判据是写死的表, 可复现。
//   ② 要有**可解释性**: 命中哪几个词才判成负面的, 研究者要能核对(结果里给 hits)。
//      只给一个数字标签的模型输出, 在论文里没法交代编码过程。
//   ③ LLM 不可用时**整条链不能挂** —— 采集/检索/统计是主用途, 情感只是其中一列。
//      所以 LLM 是"给规则结果做二次校准", 失败就原样返回规则结果(不抛错)。
//
// 立场(stance)与极性(sentiment)是**两件事**, 别混:
//   · 极性说的是"这段文字的情绪色彩";
//   · 立场说的是"这段文字对某个主张/政策的态度是支持还是反对"。
//   政策类文本经常"情绪中性但立场鲜明"(`该办法自 2026 年起施行` vs `此举值得肯定`),
//   所以两个判据表分开, 各自有独立的信号词。
//
// 采样与因果的边界(使用时必须知道): 这里算的是**手上这批文本**的分布,
//   不是"公众意见"的分布。RSS 与榜单的选取偏差不在算法里, 在样本里。
import { zhRuns } from "./keyword-network-service.js";
import { callLlm, getLlmEndpoint } from "../ai/llm-common.js";

export type Sentiment = "positive" | "neutral" | "negative";
export type Stance = "support" | "oppose" | "neutral";

/**
 * 中文极性词表(社科/政策语域的常见词)。
 * 值域 [-1, 1]: 越远离 0 表示该词本身越强。
 * 这张表是**判据**, 不是"感觉" —— 改动它会改变历史语料的标签, 所以它放在源码里可 diff。
 */
export const ZH_POLARITY: Record<string, number> = {
  // ── 正面: 成效与评价 ──
  显著成效: 1, 成效显著: 1, 卓有成效: 1, 大有可为: 0.8, 稳步推进: 0.7, 扎实推进: 0.7,
  // `成效` 单列一条(弱正面): 程度词插进 `成效显著` 中间时(`成效极其显著`)那个复合词
  //   整条匹配不上 —— 没有这条兜底, 整句话的极性会掉成 0。扫描器取**最长匹配**,
  //   所以 `成效显著` 完整出现时仍是它胜出, 不会被这条抢走。
  成效: 0.6,
  显著提升: 0.8, 明显改善: 0.8, 持续改善: 0.7, 不断提升: 0.6, 稳步增长: 0.7, 向好: 0.7,
  利好: 0.8, 受益: 0.6, 惠及: 0.7, 普惠: 0.7, 减负: 0.6, 增收: 0.7, 脱贫: 0.7, 致富: 0.8,
  点赞: 0.8, 好评: 0.8, 认可: 0.7, 肯定: 0.7, 赞许: 0.8, 欢迎: 0.6, 拥护: 0.9, 赞同: 0.8,
  支持: 0.7, 赞成: 0.8, 满意: 0.7, 值得肯定: 0.9, 振奋: 0.8, 鼓舞: 0.8, 鼓舞人心: 0.9,
  振奋人心: 0.9, 信心: 0.6, 希望: 0.5, 突破: 0.7, 创新高: 0.8, 超预期: 0.8, 亮点: 0.6,
  繁荣: 0.8, 和谐: 0.7, 稳定: 0.5, 有序: 0.4, 优化: 0.5, 便利: 0.5, 便捷: 0.5,
  暖心: 0.8, 感人: 0.7, 真诚: 0.6, 务实: 0.6, 担当: 0.6, 尽职: 0.5, 有力: 0.5,
  // ── 负面: 问题与批评 ──
  形式主义: -0.9, 官僚主义: -0.9, 走过场: -0.9, 一刀切: -0.9, 层层加码: -0.8,
  形同虚设: -0.9, 不作为: -0.9, 乱作为: -0.9, 懒政: -0.9, 怠政: -0.9, 推诿: -0.8,
  腐败: -1, 贪污: -1, 弄虚作假: -1, 造假: -0.9, 瞒报: -0.9, 失职: -0.9, 滥用职权: -1,
  不满: -0.7, 反对: -0.8, 抵制: -0.8, 抗议: -0.8, 谴责: -0.8, 批评: -0.7, 质疑: -0.5,
  诟病: -0.8, 吐槽: -0.6, 抱怨: -0.7, 愤怒: -0.9, 气愤: -0.8, 失望: -0.8, 遗憾: -0.5,
  担忧: -0.6, 焦虑: -0.7, 恐慌: -0.8, 抵触: -0.7, 反弹: -0.6, 争议: -0.5, 争论: -0.4,
  困境: -0.7, 危机: -0.8, 恶化: -0.8, 下滑: -0.7, 下降: -0.5, 萎缩: -0.7, 亏损: -0.8,
  困难: -0.5, 难题: -0.5, 瓶颈: -0.5, 障碍: -0.5, 隐患: -0.6, 风险: -0.4, 压力: -0.5,
  负担: -0.6, 沉重: -0.6, 拖欠: -0.8, 侵害: -0.9, 损害: -0.8, 侵犯: -0.9, 违规: -0.8,
  违法: -0.9, 处罚: -0.6, 处分: -0.6, 事故: -0.8, 灾难: -0.9, 悲剧: -0.9, 污染: -0.8,
  谣言: -0.8, 谣言四起: -0.9, 不实: -0.6, 失衡: -0.6, 不公平: -0.7, 公正性: 0,
  差距: -0.4, 落后: -0.6, 空心化: -0.7, 撂荒: -0.6, 荒废: -0.7, 破产: -0.9, 失业: -0.8,
  离谱: -0.8, 荒唐: -0.8, 恶劣: -0.9, 严重: -0.5, 尖锐: -0.4, 僵化: -0.7, 固化: -0.6,
  空转: -0.7, 内卷: -0.6, 躺平: -0.6, 摆烂: -0.7, 泡沫: -0.6, 炒作: -0.6,
};

/** 英文极性词表(英文源的题名/摘要用) */
export const EN_POLARITY: Record<string, number> = {
  improvement: 0.7, improve: 0.6, improved: 0.6, success: 0.8, successful: 0.8, benefit: 0.7,
  beneficial: 0.7, gain: 0.6, growth: 0.6, progress: 0.7, support: 0.7, supported: 0.6,
  endorse: 0.8, praise: 0.8, effective: 0.6, promising: 0.6, optimism: 0.7, positive: 0.6,
  decline: -0.7, crisis: -0.8, failure: -0.8, fail: -0.8, risk: -0.4,
  concern: -0.5, criticism: -0.7, criticize: -0.7, protest: -0.8, oppose: -0.8,
  opposition: -0.7, inequality: -0.7, corruption: -1, harm: -0.8, harmful: -0.8,
  threat: -0.7, suffer: -0.8, suffering: -0.8, worse: -0.8, worsen: -0.8,
  poor: -0.6, problem: -0.5, problematic: -0.6, dispute: -0.5, conflict: -0.6,
};

/**
 * 否定词。中文的判据是**否定字**(见 ZH_NEG_CHARS/ZH_NEG_TRAP): 逐字扫 + 陷阱词排除,
 *   而不是拿这张表去做子串 —— 子串匹配会把 `非常`(程度)与 `不仅`(递进)都当成否定。
 *   这张表只剩"检索/展示用"的语义, 英文侧才是真的按它匹配。
 */
export const ZH_NEGATORS = ["不", "没", "没有", "未", "无", "非", "别", "莫", "难以", "并非", "绝非", "谈不上"];
export const EN_NEGATORS = ["no", "not", "never", "without", "lack", "lacks", "hardly", "fail", "fails"];

/** 程度副词 —— 放大/削弱区间内的极性强度 */
export const ZH_INTENSIFIERS: Record<string, number> = {
  极其: 1.8, 极度: 1.8, 非常: 1.6, 十分: 1.5, 特别: 1.4, 格外: 1.4, 尤其: 1.3, 更加: 1.3,
  越发: 1.3, 愈发: 1.3, 严重: 1.6, 大幅: 1.5, 显著: 1.4, 明显: 1.3, 持续: 1.2, 不断: 1.2,
  稍微: 0.6, 略微: 0.6, 有些: 0.7, 有点: 0.7, 略显: 0.7, 轻度: 0.6,
  // 表态语里最常用来加强力度的几个词: 没有它们时"强烈支持"与"支持"的强度一模一样,
  //   而强度列正是用来区分"随口一提"与"坚决表态"的
  强烈: 1.6, 坚决: 1.7, 大力: 1.5, 全力: 1.6, 高度: 1.4, 极为: 1.7, 深表: 1.4,
};
export const EN_INTENSIFIERS: Record<string, number> = {
  very: 1.5, extremely: 1.8, highly: 1.5, greatly: 1.5, significantly: 1.5, sharply: 1.5,
  slightly: 0.6, somewhat: 0.7, mildly: 0.6,
};

/** 立场信号词(支持/反对)。与极性表刻意分开: 政策文本常"情绪中性但立场鲜明" */
export const ZH_STANCE_SUPPORT = [
  "支持", "赞成", "拥护", "赞同", "肯定", "点赞", "好评", "民心所向", "深得人心", "众望所归",
  "值得肯定", "必要之举", "顺势而为", "顺应民意", "回应关切", "利好", "惠及", "落到实处",
  "扎实推进", "有力举措", "务实之举", "破题", "及时纠偏", "积极信号",
];
export const ZH_STANCE_OPPOSE = [
  "反对", "抵制", "抗议", "质疑", "批评", "谴责", "不满", "诟病", "反弹", "抵触", "吐槽",
  "荒唐", "离谱", "形同虚设", "一刀切", "走过场", "脱离实际", "不接地气", "与民争利",
  "难以落地", "治标不治本", "换汤不换药", "名不副实", "言过其实", "回应缺失",
];
export const EN_STANCE_SUPPORT = ["support", "supports", "endorse", "back", "backs", "favor", "favors", "approve", "praise"];
export const EN_STANCE_OPPOSE = ["oppose", "opposes", "opposition", "protest", "protestors", "criticize", "criticism", "condemn", "reject", "rejects", "dispute"];

export interface SentimentResult {
  polarity: number;        // [-1, 1]
  sentiment: Sentiment;
  stance: Stance;
  stanceScore: number;     // [-1, 1]
  intensity: number;       // [0, 1] 情绪强度(与极性方向无关)
  method: "rule" | "llm";
  /** 命中的情感词(带符号) —— 研究者要能核对"凭什么判成负面" */
  hits: Array<{ word: string; value: number }>;
  /** 立场判据命中的词 —— 与 hits 分开, 免得把情绪词误读成立场证据 */
  stanceHits: string[];
}

/** 文本的语言判定: 汉字占比 > 15% 视为中文 */
export function detectTextLang(text: string): "zh" | "en" {
  const chars = text.replace(/\s/g, "");
  if (!chars) return "zh";
  const cjk = (chars.match(/[一-鿿]/g) || []).length;
  return cjk / chars.length > 0.15 ? "zh" : "en";
}

/** 否定/程度副词的管辖窗口(以"词"为单位) —— 中文里 3 个词足够覆盖 `并不是十分让人满意` */
const WINDOW = 3;

/**
 * 把一段文本切成"可匹配单元": 中文按**词表**最长匹配, 英文按单词, 其余字符只是分隔。
 *
 * ⚠ 它是**词表切分器, 不是通用的情感分析入口**: 只认得表里列出的完整词条, 未登录词一律
 *   逐字吐出 —— `成效极其显著` 会变成 `成|效|极其|显著`, 于是 `成效显著` 这一条匹配不上。
 *   所以 scorePolarity 走的是"直接在原文里扫表 + 前置窗口", 不用它; 它留给
 *   "想看这句话被切成哪些已知词"(调试/展示判据)的场景。
 */
export function segmentForSentiment(text: string, lang: "zh" | "en"): string[] {
  if (lang === "en") return (text.toLowerCase().match(/[a-z][a-z'-]*/g) || []);
  const vocab = new Set<string>([
    ...Object.keys(ZH_POLARITY), ...ZH_NEGATORS, ...Object.keys(ZH_INTENSIFIERS),
    ...ZH_STANCE_SUPPORT, ...ZH_STANCE_OPPOSE,
  ]);
  const maxLen = Math.max(...[...vocab].map((w) => w.length));
  const out: string[] = [];
  for (const run of zhRuns(text)) {
    let i = 0;
    while (i < run.length) {
      let matched = "";
      // 最长匹配: `成效显著` 必须整体命中, 不能被 `显著` 抢先
      for (let n = Math.min(maxLen, run.length - i); n >= 1; n--) {
        const cand = run.slice(i, i + n);
        if (vocab.has(cand)) { matched = cand; break; }
      }
      if (matched) { out.push(matched); i += matched.length; } else { out.push(run[i]); i += 1; }
    }
  }
  return out;
}

/**
 * 极性打分。规则链: 命中词 → 前置否定翻转 → 程度词放大 → 求和归一。
 * 归一用 `sum / (sum + 3)`: 小文本不会被单个词打成满格, 长文本多个同向词才逼近 1。
 *
 * 中文**直接扫原文**, 不用分词结果 —— 分词器只认得词表里的完整词条, `成效极其显著`
 *   会被切成 `成|效|极其|显著`, 于是 `成效显著` 这一条根本匹配不上(实测极性恒 0)。
 *   看法是"命中位置 + 前方 4 个汉字窗口", 对否定与程度词都够用, 且不依赖分词质量。
 */
export function scorePolarity(text: string, lang = detectTextLang(text)): {
  polarity: number; hits: Array<{ word: string; value: number }>;
} {
  const src = text ?? "";
  const hits: Array<{ word: string; value: number }> = [];
  let sum = 0;

  if (lang === "en") {
    const tokens = src.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
    for (let i = 0; i < tokens.length; i++) {
      const raw = EN_POLARITY[tokens[i]];
      if (raw === undefined) continue;
      let factor = 1, flips = 0;
      for (let j = Math.max(0, i - WINDOW); j < i; j++) {
        if (EN_NEGATORS.includes(tokens[j])) flips++;
        const f = EN_INTENSIFIERS[tokens[j]];
        if (f !== undefined) factor *= f;
      }
      const value = applyWindow(raw, factor, flips);
      sum += value;
      hits.push({ word: tokens[i], value });
    }
  } else {
    // 表按长度倒序: `成效显著` 先于 `显著` 命中, 免得长词的价值被短词顶掉
    const words = Object.keys(ZH_POLARITY).sort((a, b) => b.length - a.length);
    const window = 4;   // 中文 4 字够覆盖 `成效极其显著`(命中词前 3 字就是程度词)
    let from = 0;
    for (;;) {
      let at = -1, word = "";
      for (const w of words) {
        const i = src.indexOf(w, from);
        if (i !== -1 && (at === -1 || i < at || (i === at && w.length > word.length))) { at = i; word = w; }
      }
      if (at === -1) break;
      const before = src.slice(Math.max(0, at - window), at);
      let factor = 1;
      for (const [w, f] of Object.entries(ZH_INTENSIFIERS)) if (before.includes(w)) factor *= f;
      const value = applyWindow(ZH_POLARITY[word], factor, countNegations(before));
      sum += value;
      hits.push({ word, value });
      from = at + word.length;
    }
  }

  const polarity = sum / (Math.abs(sum) + 3);
  return { polarity: Math.round(polarity * 1000) / 1000, hits };
}

/** 程度词系数收敛在 [0.5, 2.5] —— 不收敛的话连写三个 `非常` 会把单个词推到 3 倍以上 */
function applyWindow(raw: number, factor: number, flips: number): number {
  const f = Math.max(0.5, Math.min(2.5, factor));
  const v = raw * f;
  return Math.round((flips % 2 === 1 ? -v : v) * 1000) / 1000;
}

/** 一段前缀里的否定次数(中文): 与 stance 侧同一套陷阱词, 免得 `不仅`/`非常` 被当成否定 */
function countNegations(before: string): number {
  let n = 0;
  for (let i = 0; i < before.length; i++) {
    if (!ZH_NEG_CHARS.has(before[i])) continue;
    // 陷阱词看**前一字 + 本字**与**本字 + 后一字**两个窗口: `非常` 里的 `非`(程度词) 与
    //   `并不支持` 里的 `不`(真否定) 只有后者才算 —— 漏了这一步会把 `非常支持` 记成反对。
    const prevPair = before.slice(Math.max(0, i - 1), i + 1);
    const nextPair = before.slice(i, i + 2);
    if (ZH_NEG_TRAP.has(prevPair) || ZH_NEG_TRAP.has(nextPair)) continue;
    n++;
  }
  for (const w of ZH_NEG_WORDS) if (before.includes(w)) n++;   // `难以`/`无法` 这类两字否定
  return n;
}

/**
 * 立场词前是否有否定。**这一步不能省**: 立场表是子串匹配, `不支持` 里含 `支持`,
 *   直接 includes 会把"明确反对"记成"明确支持" —— 方向正好相反, 而且看不出来。
 * 中文否定判据看命中位置**前 3 个字**; `不过/不仅/不但` 这类"不 X"不是否定, 单独排除。
 */
const ZH_NEG_CHARS = new Set(["不", "没", "未", "无", "非", "别", "莫"]);
const ZH_NEG_WORDS = ["难以", "并非", "绝非", "谈不上", "无法", "不能"];
const ZH_NEG_TRAP = new Set(["不过", "不仅", "不只", "不但", "不再", "不同", "不断", "不少", "不幸", "不久", "不乏", "非常"]);

function isNegatedBefore(hay: string, index: number, lang: "zh" | "en"): boolean {
  if (index <= 0) return false;
  if (lang === "en") {
    const pre = hay.slice(0, index).trimEnd();
    const tail = pre.match(/[a-z']+(\s+[a-z']+)?$/)?.[0] || "";
    return /(^|\s)(no|not|never|without|lack|lacks|hardly|fail|fails|refuse|refuses|reject|rejects)(\s|$)/.test(tail + " ");
  }
  const pre = hay.slice(Math.max(0, index - 3), index);
  if (ZH_NEG_TRAP.has(pre.slice(-2))) return false;
  const last = pre.slice(-1);
  if (ZH_NEG_CHARS.has(last)) return true;
  return ZH_NEG_WORDS.some((w) => pre.endsWith(w));
}

/** 统计一个立场词在文中**未被否定**的出现次数 */
function countStanceHits(hay: string, word: string, lang: "zh" | "en"): number {
  let from = 0, n = 0;
  for (;;) {
    const i = hay.indexOf(word, from);
    if (i < 0) break;
    if (!isNegatedBefore(hay, i, lang)) n++;
    from = i + word.length;
  }
  return n;
}

/**
 * 立场打分。只看立场表命中, **不掺极性** —— 掺进去的话"批评"A 用"支持"B 会互相抵消,
 * 而它们其实是两条不同方向的表态。两者独立统计后, 谁多谁赢。
 * `不支持` 记成反对(否定翻转, 见 isNegatedBefore), 这是这一版相对"裸 includes"的关键差别。
 */
export function scoreStance(text: string, lang = detectTextLang(text)): {
  stanceScore: number; stance: Stance; stanceHits: string[];
} {
  const support = lang === "en" ? EN_STANCE_SUPPORT : ZH_STANCE_SUPPORT;
  const oppose = lang === "en" ? EN_STANCE_OPPOSE : ZH_STANCE_OPPOSE;
  const hay = lang === "en" ? (text ?? "").toLowerCase() : (text ?? "");
  const stanceHits: string[] = [];
  let pos = 0, neg = 0;
  for (const w of support) {
    const all = countAll(hay, w);
    if (all === 0) continue;
    const affirmed = countStanceHits(hay, w, lang);
    if (affirmed > 0) { pos += affirmed; stanceHits.push(w); }
    // `不支持` 里的 `支持`: 那一次出现被否定 → 计入反对侧
    if (all > affirmed) { neg += all - affirmed; stanceHits.push(`非${w}`); }
  }
  for (const w of oppose) {
    const all = countAll(hay, w);
    if (all === 0) continue;
    const affirmed = countStanceHits(hay, w, lang);
    // `不反对` 同理记成支持侧 —— 双重否定在表态语里确实表达倾向
    if (affirmed > 0) { neg += affirmed; stanceHits.push(w); }
    if (all > affirmed) { pos += all - affirmed; stanceHits.push(`非${w}`); }
  }
  const total = pos + neg;
  // 净表态占比: 10 个支持 + 0 个反对 → 1; 各 1 个 → 0(真中立)
  const stanceScore = total === 0 ? 0 : (pos - neg) / total;
  const stance: Stance = stanceScore >= 0.2 ? "support" : stanceScore <= -0.2 ? "oppose" : "neutral";
  return { stanceScore, stance, stanceHits };
}

function countAll(hay: string, word: string): number {
  let from = 0, n = 0;
  for (;;) {
    const i = hay.indexOf(word, from);
    if (i < 0) break;
    n++;
    from = i + word.length;
  }
  return n;
}

/**
 * 情绪强度。**与极性方向无关**: `强烈反对` 与 `强烈支持` 的强度一样高。
 * 组成: 情感词量 + 程度词加成 + 标点强调(!!!/(?)/引号)。
 */
export function scoreIntensity(text: string, hits: Array<{ word: string; value: number }>, lang: "zh" | "en"): number {
  const magnitude = hits.reduce((a, h) => a + Math.abs(h.value), 0);
  const base = magnitude / (magnitude + 2.5);                       // 0..1, 词越多越接近 1
  const bang = Math.min(0.2, (text.match(/[!！]/g) || []).length * 0.07);
  const amp = Math.min(0.15, (text.match(/[?？]{2,}|[!！]{2,}/g) || []).length * 0.08);
  const quoted = lang === "zh" && /[“”"「」]/.test(text) ? 0.05 : 0;
  const intensCount = (lang === "en" ? text.toLowerCase().match(/\b(very|extremely|highly|sharply)\b/g) : text.match(/极其|极度|非常|十分|严重|大幅/g)) || [];
  const boost = Math.min(0.25, intensCount.length * 0.08);
  return Math.round(Math.min(1, base + bang + amp + quoted + boost) * 1000) / 1000;
}

/** 单条文本的情感+立场(纯规则路径, 永远可用) */
export function analyzeSentiment(text: string): SentimentResult {
  const lang = detectTextLang(text ?? "");
  const { polarity, hits } = scorePolarity(text ?? "", lang);
  const { stanceScore, stance, stanceHits } = scoreStance(text ?? "", lang);
  const intensity = scoreIntensity(text ?? "", hits, lang);
  // 阈值 ±0.15: 单个中性词不会把文本推成正/负 —— |polarity| < 0.15 一律中性
  const sentiment: Sentiment = polarity >= 0.15 ? "positive" : polarity <= -0.15 ? "negative" : "neutral";
  return { polarity, sentiment, stance, stanceScore, intensity, method: "rule", hits, stanceHits };
}

/** 对一批文本做规则分析(统计用) */
export function analyzeSentimentBatch(texts: string[]): SentimentResult[] {
  return texts.map((t) => analyzeSentiment(t ?? ""));
}

export interface SentimentDistribution {
  total: number;
  positive: number; neutral: number; negative: number;
  support: number; oppose: number; stanceNeutral: number;
  /** 平均极性 / 平均强度(强度只看非中性项, 否则被大量中性文本稀释成 0) */
  meanPolarity: number;
  meanIntensity: number;
}

export function distributionOf(results: SentimentResult[]): SentimentDistribution {
  const d: SentimentDistribution = {
    total: results.length, positive: 0, neutral: 0, negative: 0,
    support: 0, oppose: 0, stanceNeutral: 0, meanPolarity: 0, meanIntensity: 0,
  };
  if (!results.length) return d;
  let pol = 0, inten = 0, intenN = 0;
  for (const r of results) {
    d[r.sentiment] += 1;
    if (r.stance === "support") d.support += 1;
    else if (r.stance === "oppose") d.oppose += 1;
    else d.stanceNeutral += 1;
    pol += r.polarity;
    if (r.sentiment !== "neutral") { inten += r.intensity; intenN += 1; }
  }
  d.meanPolarity = Math.round((pol / results.length) * 1000) / 1000;
  d.meanIntensity = intenN ? Math.round((inten / intenN) * 1000) / 1000 : 0;
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM 校准(可选, 永远有规则兜底)
// ═══════════════════════════════════════════════════════════════════════════

const LLM_PROMPT = `你在为社科研究做舆情文本编码。对每条编号文本给出:
- sentiment: positive/neutral/negative(文本自身的情绪色彩)
- stance: support/oppose/neutral(文本对该政策/主张的表态方向; 无明确表态填 neutral)
- intensity: 0-1 的情绪强度
只输出 JSON: {"items":[{"i":编号,"sentiment":"...","stance":"...","intensity":0.0}]}
不要解释。研究用途, 判不准时宁可给 neutral。`;

/**
 * 用 LLM 校准一批文本的编码。
 *
 * 失败语义(重要): **任何一步失败都返回规则结果**, 不抛错、不返回空。
 *   调用方拿到的东西恒定可用 —— 情感列不该成为整条检索链的单点故障。
 * 返回里 `calibrated` 说明到底校准成了几条, 界面/报告要如实展示(不能默认"已用 AI")。
 */
export async function calibrateWithLlm(
  texts: string[],
  ruleResults?: SentimentResult[],
): Promise<{ results: SentimentResult[]; calibrated: number; error?: string }> {
  const base = ruleResults ?? analyzeSentimentBatch(texts);
  if (!texts.length) return { results: base, calibrated: 0 };
  const ep = getLlmEndpoint();
  if (!ep.key) return { results: base, calibrated: 0, error: "未配置 LLM(缺 key) — 使用规则结果" };

  // 分批: 一次 12 条, 单条截断 400 字。截断是**故意的**: 编码看的是题名+摘要的基调,
  //   全文进 prompt 只会烧 token 并放大"某一句话"的权重。
  const BATCH = 12;
  let calibrated = 0;
  const results = base.map((r) => ({ ...r }));
  for (let start = 0; start < texts.length; start += BATCH) {
    const chunk = texts.slice(start, start + BATCH);
    const body = chunk.map((t, i) => `${i + 1}. ${String(t ?? "").slice(0, 400).replace(/\n/g, " ")}`).join("\n");
    try {
      const r = await callLlm({
        url: ep.url, key: ep.key, model: ep.model,
        messages: [{ role: "user", content: `${LLM_PROMPT}\n\n${body}` }],
        temperature: 0, maxTokens: 900, timeoutMs: 45_000,
        policy: "background",   // 校准失败有规则兜底, 不该按前台链路重试占配额
        jsonMode: true,
      });
      if (!r || r.error || !r.text) continue;
      const parsed = r.json ?? safeJson(r.text);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      for (const it of items) {
        const idx = start + (Number(it?.i) || 0) - 1;
        if (idx < start || idx >= start + chunk.length || !results[idx]) continue;
        const s = String(it.sentiment || "").toLowerCase();
        const st = String(it.stance || "").toLowerCase();
        if (["positive", "neutral", "negative"].includes(s)) results[idx].sentiment = s as Sentiment;
        if (["support", "oppose", "neutral"].includes(st)) results[idx].stance = st as Stance;
        const inten = Number(it.intensity);
        if (Number.isFinite(inten)) results[idx].intensity = Math.max(0, Math.min(1, inten));
        results[idx].method = "llm";
        calibrated++;
      }
    } catch {
      // 单批失败只影响这一批 —— 后续批次继续(网络/限流常是瞬时的)
      continue;
    }
  }
  return { results, calibrated, error: calibrated === 0 ? "LLM 校准未返回可用结果 — 使用规则结果" : undefined };
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { /* 落下去抠 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export const sentimentService = {
  analyzeSentiment, analyzeSentimentBatch, distributionOf,
  scorePolarity, scoreStance, scoreIntensity, segmentForSentiment, detectTextLang,
  calibrateWithLlm,
  // 判据表(前端/研究复现用): 编码过程要能被人核对
  ZH_POLARITY, EN_POLARITY, ZH_INTENSIFIERS, EN_INTENSIFIERS,
  ZH_STANCE_SUPPORT, ZH_STANCE_OPPOSE, EN_STANCE_SUPPORT, EN_STANCE_OPPOSE,
};
