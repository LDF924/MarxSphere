// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// aigc-detect-service.ts — AIGC 率检测(文本统计特征 → 0-100 的 AI 生成概率)
//
// 由来(2026-10-01, 从旧项目移植 m2_start_check_ai_rate / execute_m2_detect_ai_rate):
//   本仓此前对 AIGC 只有"降"没有"检测" —— paper-outline-service.ts 的 applyDeAITier
//   能三档改写正文, 但**改写前后到底降了多少, 没有任何东西能量**。用户勾"降AIGC合稿"
//   拿到的是一篇新稿, 只能凭感觉判断; 而"凭感觉"正是这类功能最容易变成摆设的地方。
//
// 为什么是统计特征而不是调一次 LLM:
//   ① 可复现: 同一段文本跑两次必须是同一个分数, 而 LLM 判定有温度与版本漂移;
//   ② 可解释: 用户问"凭什么说我这篇像 AI", 必须能逐项给出数值, 而不是"模型说的";
//   ③ 可离线: 检测本身不该产生 token 成本, 也不该把用户未发表的稿子发到第三方端点。
//   这三点也决定了本文件**不依赖数据库、不依赖网络** —— 见 analyzeAigc 的注释。
//
// ⚠⚠ 锚点是**实测**出来的, 不是教科书抄来的 —— 而且实测推翻了若干想当然的假设。
//   标定集: 人类侧 40 篇真实中文论文(库 source_chunks 按 document_id 聚合后切块,
//   239 个 1400/3600 字样本; 另取 220~620 字的段落切片定短档值域);
//   AI 侧 18 篇由真实模型(deepseek-flash)生成的同题中文学术正文(温度 0.4~1.0)。
//   标定脚本未入库(要连库、要调 LLM), 复现方式见本文件尾注。
//   **实测推翻了五条想当然的假设**, 全部记录在此以免后人再犯:
//     · 困惑度代理(阶数): 2-gram 条件熵几乎无区分度(AUC 0.51), 5 阶升到 0.78。
//       低阶 n-gram 只看得到字的搭配, 而 AI 与人在常用搭配上并无差别。
//       但**阶数不能随样本量自适应** —— 那样长样本取高阶、短样本取低阶,
//       长度就被混进了结论(实测同一篇文章 1200 字与 3000 字会落到不同阶)。最终定 3 阶。
//     · 困惑度代理(方向): 直觉是"模型输出更可预测 ⇒ 熵更低", 实测**相反**
//       (长度配平后 AUC 0.69, AI 更高)。方向按实测写, 不按文献直觉写。
//     · 词汇多样性: 直觉是"AI 用词更单调 ⇒ 多样性低", 实测**相反**(AUC 0.93, AI 更高)。
//       模型在千字篇幅里敢用更多一次性词; 人类学术写作反而反复用同一批术语。
//     · 突发性: 方向符合直觉(AI 句长更均匀, AUC 0.81), 但**绝对值几乎全是负的** ——
//       纯中文句长分布里 σ<μ 是常态, 拿"文献里人类 0.4~0.6"那套阈值会把全部人类稿判成 AI。
//     · 套话密度: 方向对但**区分度最弱**(AUC 0.61)。真实模型并不像模板稿那样堆"综上所述",
//       人类论文里"随着/不断/日益"同样高频。它在总分里权重最低, 这是实测结果不是疏忽。
//
//   归一化锚点(见 CALIB_ZH): 四段折线, 把"人类 p50"钉在 0.4、"AI p50"钉在 0.6,
//   于是分数刻度是可以对着标定集读的 —— 而不是一组凭感觉设的阈值。
//
// ⚠ 能力边界(必须知道, 否则会误用): 这是**启发式筛查**, 不是学术不端判定。
//   · 标定集只有 18 篇 AI 样本且**同源**(单一模型、单一题域) —— 换模型/换学科会漂移。
//     绝对分数别当概率读; 相对比较(diffAigc 看降重前后)才是它的主用途。
//   · 改写/翻译/人工润色过的 AI 文本会被显著低估 —— 本服务测的是"像不像机器写的统计痕迹",
//     不是"是不是机器写的"。这恰好是它与降重配套的原因: 降重改的正是这些痕迹。
//   · 英文侧是**弱标定**(10 个人类块 / 6 篇 AI, 小到方向都测不稳): 方向沿用中文实测,
//     量纲按英文观测值放。英文分数只做相对比较, 不要与中文分数互相比大小。
//   · 短文本(默认 <200 字)统计量不稳 → verdict 返回 insufficient, 不给结论。
//
// 与降重的对接: applyDeAITier() 之后再过一次本服务, 分数应当**下降**(diffAigc 即为此入口)。

/**
 * 特征权重 —— 不是拍脑袋定的: 取样自**实测区分度**(AUC−0.5), 每项保留 0.05 地板,
 * 归一化到 1。地板是为了保住规格要求里的每个特征都参与(即使它单独区分度弱),
 * 但权重本身仍然如实反映"这个特征有多能分辨 AI"。
 * ⚠ 改权重会改变所有历史分数; 改之前请重跑本文件尾注里的标定脚本。
 */
export const AIGC_FEATURE_WEIGHTS = {
  mattr: 0.190,
  paragraph_regularity: 0.162,
  burstiness: 0.137,
  repeat_ngram: 0.105,
  entropy: 0.085,
  four_char: 0.079,
  hapax: 0.073,
  sentence_opening: 0.068,
  punct_interval: 0.054,
  template_phrase: 0.047,
} as const;

export type AigcFeatureKey = keyof typeof AIGC_FEATURE_WEIGHTS;

export interface AigcFeature {
  key: AigcFeatureKey;
  label: string;
  /** 原始测量值(方向由 higherIsAi 决定, 不要直接当分数用) */
  value: number;
  /** 该特征在总分里的权重 */
  weight: number;
  /** 该特征贡献的**分数点**(0-100 口径): 权重 × aiLike × 100, 全部相加 = aiScore */
  contribution: number;
  /** 朝 AI 方向的归一化值 0-1(1 = 最像 AI) */
  aiLike: number;
  /** 实测方向: value 越大越像 AI 时为 true */
  higherIsAi: boolean;
  /** 数据不足时不算分(权重让给其余特征), 而不是按 0 或 0.5 计 */
  applicable: boolean;
  /** 参考锚点(人类中位数 / AI 中位数), 供界面画刻度 */
  anchor: { human: number; ai: number };
  /** 明细(σ/μ/样本数/标定分位等), 供界面展开解释 */
  detail: Record<string, number>;
}

export type AigcVerdict = "likely_human" | "mixed" | "likely_ai" | "insufficient";

export interface AigcResult {
  aiScore: number;
  verdict: AigcVerdict;
  /** 样本量足够且可用特征够多才为 true; 为 false 时 aiScore 仅供记录, 不该展示成结论 */
  reliable: boolean;
  confidence: number;
  note: string;
  features: AigcFeature[];
  stats: { chars: number; tokens: number; sentences: number; paragraphs: number; lang: "zh" | "en" };
  /** 贡献最大的几条, 直接给界面用的人话解释 */
  topSignals: string[];
}

/** 低于此字数不出结论(统计量在小样本上噪声压过信号) */
const MIN_RELIABLE_CHARS = 200;
/** 段落/逗号间隔这类结构特征需要的最小样本数 */
const MIN_SENTENCES = 3;
const MIN_PARAGRAPHS = 3;
const MIN_PUNCT_MARKS = 6;

const CJK_RE = /[㐀-䶿一-鿿]/;
const CJK_GLOBAL_RE = /[㐀-䶿一-鿿]/g;
// 中英混排: 汉字单字成词, 拉丁词整体成词, 数字保留
const TOKEN_RE = /[㐀-䶿一-鿿]|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+(?:[.,]\d+)*/g;
/** 字符级 token(困惑度代理用): 汉字 / 字母 / 数字, 去标点与空白 */
const CHAR_TOKEN_RE = /[㐀-䶿一-鿿]|[a-z0-9]/g;
const COMMA_RE = /[，,、；;]/;
const PERIOD_RE = /[。．.！!？?]/;
const LETTER_RE = /[A-Za-z]/;
const DIGIT_RE = /[0-9]/;

/**
 * 模板化表达词表 —— 本服务里唯一"人工维护"的部分, 也是最容易腐烂的部分。
 * 只收**成句无信息量**的表达(它们在学术文本里出现本身不代表 AI, 密度高才代表)。
 * ⚠ 实测它区分度最弱(见文件头), 词表加词前先想清楚: 学术论文本来就高频使用这些连接词。
 */
const TEMPLATE_PHRASES_ZH = [
  "首先", "其次", "再次", "然后", "最后", "此外", "另外", "同时", "总之", "综上",
  "综上所述", "总的来说", "值得注意", "需要指出的是", "不可否认", "显而易见",
  "毫无疑问", "众所周知", "随着", "在当今", "在新时代", "起着至关重要的作用",
  "具有重要意义", "发挥重要作用", "重要作用", "重大意义", "提供了有力支撑",
  "奠定了坚实基础", "不可或缺", "至关重要", "日益", "不断", "从某种程度上",
  "换言之", "也就是说", "由此可见", "正因如此", "与此同时", "在此基础上",
  "在此背景下", "具体而言", "具体来说", "简而言之", "一言以蔽之", "广泛关注",
  "深远影响", "全面提升", "有效促进", "深刻变革", "赋予新的内涵",
];
const TEMPLATE_PHRASES_EN = [
  "moreover", "furthermore", "in addition", "additionally", "it is worth noting",
  "notably", "importantly", "significantly", "ultimately", "in conclusion", "to sum up",
  "overall", "on the one hand", "on the other hand", "in today's society",
  "plays a crucial role", "plays a vital role", "has attracted increasing attention",
  "it is undeniable", "it is evident", "in the realm of", "delve into", "underscore",
  "pivotal", "nuanced", "multifaceted", "a testament to", "foster", "facilitate",
  "comprehensive", "profound implications", "in this regard",
];
/** 断续结构(中间可夹内容), 中英各一组 */
const TEMPLATE_PATTERNS_ZH: RegExp[] = [
  /不仅[^。；\n]{0,40}而且/g,
  /一方面[^。；\n]{0,40}另一方面/g,
  /既[^。；\n]{0,20}又[^。；\n]{0,20}/g,
  /随着[^。；\n]{0,30}(的)?(发展|推进|深入|变化|演替)/g,
];
const TEMPLATE_PATTERNS_EN: RegExp[] = [
  /\bnot only\b[^.;\n]{0,60}\bbut also\b/g,
  /\bon the one hand\b[^.;\n]{0,60}\bon the other hand\b/g,
  /\bit is (?:widely|generally|increasingly)\b/g,
];

/** 一个特征的标定信息: 四个分位点 + 方向。分位点来自实测(见文件头)。 */
export interface FeatureCalibration {
  /** 人类侧 p05 / p50 与 AI 侧 p50 / p95 的实测值(未排序, 排序在 normalize 里做) */
  humanP05: number;
  humanP50: number;
  aiP50: number;
  aiP95: number;
  /**
   * **观测值域**(标定集里实际出现过的 min/max)。
   * 短档(200~600 字的段落切片)与长档(1400~4000 字的整节)都测过, 取并集 ——
   * 服务的输入两种长度都会出现, 只按长档定界会把正常短稿误标成越界。
   * 与四个分位点是两回事: 分位点描述"典型位置", 值域描述"我见过什么"。
   * 超出值域 ⇒ 这一项按未定计分(见 mkFeature), 因为它落在标定数据之外。
   * 早先用分位点(人类 p05 .. AI p95)当边界, 结果**一半的正常人类文本**都被标成越界
   * (分位点本来就不是分布的两端), 标记变成噪声 —— 天天亮的标记等于没有标记。
   */
  observedMin: number;
  observedMax: number;
  /** true = 值越大越像 AI */
  higherIsAi: boolean;
  label: string;
}

/**
 * 中文标定表 —— 实测(239 人类块 / 18 AI 篇)。
 * 归一化用四点折线: 人类 p05→0.05, 人类 p50→0.4, AI p50→0.6, AI p95→0.95
 * (线性插值, 两端截断)。四个分位点先按值排序再按方向配目标, 保证函数单调。
 * 这样"人类中位数"落在 0.4、"AI 中位数"落在 0.6 —— 分数刻度是可以对着标定集读的。
 */
const CALIB_ZH: Record<AigcFeatureKey, FeatureCalibration> = {
  // 困惑度代理(3 阶字符条件熵, bit): **实测方向反了** —— AI 更高(AUC 0.69)。
  // 与直觉(模型输出更可预测 ⇒ 熵更低)相反; 在 1500~4000 字的学术正文上, 模型用词反而
  // 比人类更分散。方向按实测写, 不按文献直觉写。
  entropy: { humanP05: 0.6552, humanP50: 0.8627, aiP50: 0.9319, aiP95: 1.1535, higherIsAi: true, observedMin: 0.2883, observedMax: 1.3799, label: "用词可预测性(困惑度代理)" },
  // 句长 (σ-μ)/(σ+μ): AI 更低(句子更均匀) —— 方向与直觉一致, 但绝对值全为负
  burstiness: { humanP05: -0.4188, humanP50: -0.2158, aiP50: -0.3474, aiP95: -0.2164, higherIsAi: false, observedMin: -0.837, observedMax: 0.3365, label: "句长起伏(突发性)" },
  // MATTR: 实测 AI 更高(见文件头, 与直觉相反)
  mattr: { humanP05: 0.6109, humanP50: 0.704, aiP50: 0.77, aiP95: 0.7974, higherIsAi: true, observedMin: 0.3723, observedMax: 0.8936, label: "词汇多样性(MATTR)" },
  // hapax 比值(观测/随机基线): AI 更低 —— 用词被反复固定复用
  hapax: { humanP05: 2.1583, humanP50: 2.2661, aiP50: 2.2308, aiP95: 2.3294, higherIsAi: false, observedMin: 2.0472, observedMax: 2.5893, label: "低频词占比(hapax)" },
  // 4-gram 重复率: 实测 AI 更低(模型比人类更少整句复用)
  repeat_ngram: { humanP05: 0.0468, humanP50: 0.1036, aiP50: 0.0742, aiP95: 0.1, higherIsAi: false, observedMin: 0, observedMax: 0.5013, label: "重复结构(4-gram)" },
  // 套话密度(每 100 token): AI 更高, 但区分度最弱
  template_phrase: { humanP05: 0, humanP50: 0.2838, aiP50: 0.3381, aiP95: 0.6267, higherIsAi: true, observedMin: 0, observedMax: 1.5228, label: "套话/连接词密度" },
  // 句首 3-gram 撞车比例: AI 更高
  sentence_opening: { humanP05: 0, humanP50: 0.125, aiP50: 0.1932, aiP95: 0.2821, higherIsAi: true, observedMin: 0, observedMax: 0.75, label: "句首重复" },
  // 标点间隔变异系数: 实测 AI 更低(节奏更稳)
  punct_interval: { humanP05: 0.5328, humanP50: 0.6839, aiP50: 0.6585, aiP95: 0.7273, higherIsAi: false, observedMin: 0.2156, observedMax: 4.0023, label: "标点间隔规律度" },
  // 四字格密度: AI 更高
  four_char: { humanP05: 0, humanP50: 0.0378, aiP50: 0.0517, aiP95: 0.0735, higherIsAi: true, observedMin: 0, observedMax: 0.2222, label: "四字格密度" },
  // 段长变异系数: 实测 AI 更低(段长更齐) —— 区分度第二高
  paragraph_regularity: { humanP05: 0.3531, humanP50: 0.7838, aiP50: 0.3116, aiP95: 0.8241, higherIsAi: false, observedMin: 0.02, observedMax: 1.6911, label: "段落结构规律度" },
};

/**
 * 英文标定表。
 * ⚠ **弱标定**: 英文侧只有 10 个人类块(库里的非中文切片)与 6 篇 AI 生成样本 ——
 *   样本量小到**方向都测不稳**(多个特征的实测方向与中文侧相反或完全重合)。
 *   因此这里的取值规则是: **方向沿用中文侧**(模型输出的统计机制不随语言改变,
 *   而中文侧是 239/18 的实测), **量纲按英文实测值放**, 重合到无法分辨的特征
 *   (两端中位数贴在一起)给出一个平坦区间, 让它在总里近乎不起作用而不是乱投票。
 *   英文分数只做**相对比较**(降重前后), 不要与中文分数互相比大小。
 */
const CALIB_EN: Record<AigcFeatureKey, FeatureCalibration> = {
  // 与中文同向(英文实测也支持 AI 更高)
  entropy: { humanP05: 0.79, humanP50: 0.91, aiP50: 1.3, aiP95: 1.38, higherIsAi: true, observedMin: 0.28, observedMax: 1.45, label: "用词可预测性(困惑度代理)" },
  burstiness: { humanP05: -0.49, humanP50: -0.36, aiP50: -0.42, aiP95: -0.21, higherIsAi: false, observedMin: -0.85, observedMax: 0.35, label: "句长起伏(突发性)" },
  mattr: { humanP05: 0.56, humanP50: 0.65, aiP50: 0.74, aiP95: 0.82, higherIsAi: true, observedMin: 0.37, observedMax: 0.9, label: "词汇多样性(MATTR)" },
  repeat_ngram: { humanP05: 0.039, humanP50: 0.06, aiP50: 0.019, aiP95: 0.0046, higherIsAi: false, observedMin: 0, observedMax: 0.3, label: "重复结构(3-gram)" },
  // 英文实测: 人类 -0.485/-0.357, AI -0.377/-0.215 —— 两段重叠严重, 区间给平一些
  paragraph_regularity: { humanP05: 0.35, humanP50: 0.7, aiP50: 0.55, aiP95: 0.9, higherIsAi: false, observedMin: 0.02, observedMax: 1.95, label: "段落结构规律度" },
  // 以下四项英文样本上方向测反或重合, 沿用中文方向 + 英文量纲
  hapax: { humanP05: 2.42, humanP50: 2.48, aiP50: 2.56, aiP95: 2.62, higherIsAi: true, observedMin: 2.02, observedMax: 2.75, label: "低频词占比(hapax)" },
  template_phrase: { humanP05: 0, humanP50: 0.27, aiP50: 0.45, aiP95: 0.9, higherIsAi: true, observedMin: 0, observedMax: 1.55, label: "套话/连接词密度" },
  sentence_opening: { humanP05: 0, humanP50: 0.02, aiP50: 0.06, aiP95: 0.16, higherIsAi: true, observedMin: 0, observedMax: 0.8, label: "句首重复" },
  punct_interval: { humanP05: 0.9, humanP50: 0.85, aiP50: 0.8, aiP95: 0.72, higherIsAi: false, observedMin: 0.2, observedMax: 2, label: "标点间隔规律度" },
  // 英文没有汉字, 恒为 N/A(权重让给其余特征)
  four_char: { humanP05: 0, humanP50: 0.038, aiP50: 0.052, aiP95: 0.074, higherIsAi: true, observedMin: 0, observedMax: 0.23, label: "四字格密度" },
};

function calibOf(key: AigcFeatureKey, lang: "zh" | "en"): FeatureCalibration {
  return lang === "zh" ? CALIB_ZH[key] : CALIB_EN[key];
}

/**
 * 导出标定表(只读快照) —— 让测试能断言"标定表与实测一致", 也让将来的界面能画出
 * 每个特征的刻度(人类中位/AI 中位在哪)。**不要**拿它当可变配置去改: 改标定意味着
 * 重新跑一遍文件尾注里的标定流程, 而不是在运行时调参。
 */
export function getCalibration(lang: "zh" | "en" = "zh"): Record<AigcFeatureKey, FeatureCalibration> {
  const src = lang === "zh" ? CALIB_ZH : CALIB_EN;
  return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, { ...v }])) as Record<AigcFeatureKey, FeatureCalibration>;
}

// ─── 基础统计 ───

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 样本标准差(n-1); 单元素返回 0 */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** 变异系数 σ/μ —— 段长/间隔规律度都用它(量纲无关, 可直接跨文本比较) */
function cv(xs: number[]): number {
  const m = mean(xs);
  return m > 0 ? stdev(xs) / m : 0;
}

/** 滞后 1 自相关: 相邻句长是否"平滑漂移" */
function lag1Correlation(xs: number[]): number {
  if (xs.length < 4) return 0;
  const a = xs.slice(0, -1);
  const b = xs.slice(1);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** 香农熵(bit) */
function shannon(counts: Map<string, number>, total: number): number {
  if (total <= 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function tally(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function tokenize(text: string): string[] {
  return [...text.toLowerCase().matchAll(TOKEN_RE)].map((m) => m[0]);
}

/** 字符级 token —— 困惑度代理的输入(标点/空白剔除, 否则标点会把熵抬上去) */
function charTokens(text: string): string[] {
  return [...text.toLowerCase().matchAll(CHAR_TOKEN_RE)].map((m) => m[0]);
}

/**
 * 断句。
 *
 * ⚠ 英文的 `.` 只在**后面跟空白且下一句以大写/CJK 开头**时才算句末 ——
 *   否则 "3.14" 与 "et al. 2020" 会被切成两句, 制造一堆"超短句",
 *   burstiness(权重第二高)直接虚高。用 lookbehind 表达, 不往文本里插标记字符。
 */
const SENTENCE_BOUNDARY = new RegExp(
  // 中文句末: 。！？ 后无条件断, 允许跟一个收尾引号/括号
  "(?<=[。！？][”’\"')）】]?)" +
  // 英文句末: .!? 后跟空白, 且下一句以大写/引号/括号/CJK 开头才算断
  "|(?<=[.!?][”’\"')\\]]?)(?=[ \\t]+[A-Z“”‘’\"'（(【\\[]|[㐀-䶿一-鿿])" +
  // 行尾的 .!? 也算句末(否则最后一句永远并进前一句)
  "|(?<=[.!?][”’\"')\\]]?)[ \\t]*$",
);

function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    for (const piece of line.split(SENTENCE_BOUNDARY)) {
      const t = piece.trim();
      if (t && tokenize(t).length > 0) out.push(t);
    }
  }
  return out;
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => tokenize(p).length > 0);
}

/** 按标点切分句(含逗号顿号) —— 四字格密度用这个口径 */
function splitClauses(text: string): string[] {
  return text.split(/[，,。.、；;：:！!？?…—\n]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 标点间隔: 沿文本扫描, 记录每个逗号/句号前已累积了多少 token, 再取相邻间隔。
 * 这是"逗号/句号间隔的规律度"的字面实现 —— 直接量"标点多久出现一次", 而不是
 * 量"分句有多长"(两者在纯中文里接近, 但中英混排时差别很大)。
 */
function punctIntervals(text: string): { comma: number[]; period: number[] } {
  const comma: number[] = [];
  const period: number[] = [];
  let cursor = -1;       // 上一个标点处的 token 位置
  let tokens = 0;
  let inWord = false;
  const emit = (arr: number[]) => {
    if (cursor >= 0 && tokens - cursor > 0) arr.push(tokens - cursor);
    cursor = tokens;
  };
  for (const ch of text) {
    if (CJK_RE.test(ch) || DIGIT_RE.test(ch)) { tokens++; inWord = false; continue; }
    if (LETTER_RE.test(ch)) { if (!inWord) { tokens++; inWord = true; } continue; }
    inWord = false;
    if (COMMA_RE.test(ch)) emit(comma);
    else if (PERIOD_RE.test(ch)) emit(period);
  }
  return { comma, period };
}

/** 长度无关的 TTR: 滑动窗口取平均(窗口 100 token; 样本不足则退化为整体 TTR) */
function mattr(tokens: string[], window = 100): { value: number; window: number } {
  if (tokens.length === 0) return { value: 0, window: 0 };
  const w = Math.min(window, tokens.length);
  if (tokens.length <= w) {
    return { value: new Set(tokens).size / tokens.length, window: tokens.length };
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i + w <= tokens.length; i++) {
    sum += new Set(tokens.slice(i, i + w)).size / w;
    n++;
  }
  return { value: n ? sum / n : 0, window: w };
}

/**
 * n 阶字符条件熵 H(next | 前 n 字) —— **困惑度代理**。
 * H 越低 = 下一个字越可预测 = 越像模型输出; perplexity = 2^H。
 *
 * 只看"有重复出现的上下文"(n < 2 的上下文没有条件分布可言, 不计入,
 * 否则一次性的罕见上下文会把熵拉高, 掩盖真正的信号)。
 */
function conditionalEntropy(chars: string[], order: number): { h: number; observations: number } {
  if (chars.length <= order) return { h: 0, observations: 0 };
  const ctx = new Map<string, Map<string, number>>();
  for (let i = 0; i + order < chars.length; i++) {
    const key = chars.slice(i, i + order).join("");
    let m = ctx.get(key);
    if (!m) { m = new Map(); ctx.set(key, m); }
    const nx = chars[i + order];
    m.set(nx, (m.get(nx) ?? 0) + 1);
  }
  let observations = 0;
  let h = 0;
  for (const m of ctx.values()) {
    let n = 0;
    for (const v of m.values()) n += v;
    if (n < 2) continue;
    let e = 0;
    for (const v of m.values()) { const p = v / n; e -= p * Math.log2(p); }
    h += e * n;
    observations += n;
  }
  return { h: observations ? h / observations : 0, observations };
}

/** 词表命中计数 —— 只统计"命中了几种"与"总共命中几次" */
function countHits(text: string, phrases: readonly string[], patterns: readonly RegExp[]): { hits: number; kinds: number } {
  let hits = 0;
  let kinds = 0;
  for (const p of phrases) {
    const n = text.split(p).length - 1;
    if (n > 0) { hits += n; kinds++; }
  }
  for (const re of patterns) {
    const n = [...text.matchAll(re)].length;
    if (n > 0) { hits += n; kinds++; }
  }
  return { hits, kinds };
}

// ─── 特征计算 ───

export interface AigcAnalysisContext {
  text: string;
  lang: "zh" | "en";
  tokens: string[];
  chars: string[];
  sentences: string[];
  paragraphs: string[];
  clauses: string[];
  punct: { comma: number[]; period: number[] };
}

/** 构造分析上下文(导出以便调用方复用分词结果与自查) */
export function buildContext(text: string, lang?: "auto" | "zh" | "en"): AigcAnalysisContext {
  const src = String(text ?? "");
  const cjk = src.match(CJK_GLOBAL_RE)?.length ?? 0;
  const latin = src.match(/[A-Za-z]+/g)?.length ?? 0;
  // 语言判定会影响锚点与分词口径, 判错的代价是分数整体偏移 —— 所以给出显式覆盖入口
  const detected: "zh" | "en" = lang && lang !== "auto" ? lang : cjk >= Math.max(4, latin * 0.6) ? "zh" : "en";
  const normalized = src.replace(/\r\n?/g, "\n");
  return {
    text: normalized,
    lang: detected,
    tokens: tokenize(normalized),
    chars: charTokens(normalized),
    sentences: splitSentences(normalized),
    paragraphs: splitParagraphs(normalized),
    clauses: splitClauses(normalized),
    punct: punctIntervals(normalized),
  };
}

/**
 * 朝 AI 方向归一化: 四段折线(人类 p05/p50、AI p50/p95 四个结点 → 0.05/0.4/0.6/0.95)。
 *
 * ⚠ 这里有两组**不同**的边界, 早先把它们混为一谈, 两个方向都错过:
 *   · **四个分位点**(humanP05..aiP95)是折线的结点, 描述"典型位置";
 *   · **观测值域**(observedMin/Max)才是"我见过什么"的边界。
 *   值落在结点之外、但仍在值域之内(比如模板短语计数天然从 0 起, 而 p05 恰好是 0)是**正常**的,
 *   应当钳到最近的端点分。只有超出**值域**才算"标定数据之外的取值"。
 *   混用会让"模板密度为 0"这种最常见的人写特征被判成越界(实测一半人类文本中招)。
 *
 * 越界时**分方向处理**(两种错法都踩过, 记录在此):
 *   · 越过**靠 AI 的那一端** → 钳到 AI 端。朝"更像 AI"越走越远本来就该更像 AI;
 *     早先一律给 0.5, 于是"低重复"(AI 方向在低值端)这种明确信号被抹平。
 *   · 越过**靠人类的那一端** → 0.5(未定)。这类越界往往**不是**"更像人", 典型是重复结构:
 *     AI 方向在低值端, 于是"整段复制粘贴"会被一路推到人类端 —— 可它既不是正常人类写作,
 *     也不在校准集里(AI 稿的重复率其实更低)。给它人类端等分等于给复制粘贴洗白。
 */
function normalize(key: AigcFeatureKey, value: number, lang: "zh" | "en"): number {
  const c = calibOf(key, lang);
  const vals = [c.humanP05, c.humanP50, c.aiP50, c.aiP95].sort((a, b) => a - b);
  // targets[i] 与 vals[i] 一一对应(都按值升序): 值落在哪一段, 就给对应的分数
  const targets = c.higherIsAi ? [0.05, 0.4, 0.6, 0.95] : [0.95, 0.6, 0.4, 0.05];
  const aiEnd = c.higherIsAi ? targets[3] : targets[0];
  if (value < c.observedMin) return c.higherIsAi ? UNDETERMINED : aiEnd;
  if (value > c.observedMax) return c.higherIsAi ? aiEnd : UNDETERMINED;
  // 值域之内: 四段折线, 结点两端各自钳到端点分
  if (value <= vals[0]) return targets[0];
  if (value >= vals[vals.length - 1]) return targets[targets.length - 1];
  for (let i = 1; i < vals.length; i++) {
    if (value <= vals[i]) {
      const span = vals[i] - vals[i - 1];
      const t = span > 0 ? (value - vals[i - 1]) / span : 0;
      return targets[i - 1] + t * (targets[i] - targets[i - 1]);
    }
  }
  return UNDETERMINED;
}

/** 越界且无法判定时的取值(见 normalize) —— 不是"中性", 是"我不知道" */
const UNDETERMINED = 0.5;

/**
 * 该特征值是否落在**标定数据之外**。
 * 用 observedMin/observedMax(实测出现过的极值)而不是分位点 —— 见 FeatureCalibration 的注释。
 * 这个标记宁可少亮也不要多亮: 标错一次的用户会学会忽略它。
 */
function isOutOfRange(key: AigcFeatureKey, value: number, lang: "zh" | "en"): boolean {
  const c = calibOf(key, lang);
  return value < c.observedMin || value > c.observedMax;
}

/**
 * 装配一个特征。
 *
 * 越界(超出实测值域)时由 normalize 决定取值: 朝 AI 那端钳到 AI 端, 朝人类那端给 0.5(未定)。
 * 两种越界都标 detail.outOfRange, 供界面/调用方判断"这一项不在我标定过的范围内"。
 * 详见 normalize 的注释 —— 那里记录了"一律给 0.5"与"一律钳到人类端"两种错法。
 */
function mkFeature(
  key: AigcFeatureKey,
  raw: number,
  lang: "zh" | "en",
  opts: { applicable?: boolean; detail?: Record<string, number> } = {},
): AigcFeature {
  const c = calibOf(key, lang);
  const applicable = opts.applicable !== false;
  const aiLike = applicable ? normalize(key, raw, lang) : 0;
  const weight = AIGC_FEATURE_WEIGHTS[key];
  const detail: Record<string, number> = { ...(opts.detail ?? {}) };
  if (applicable && isOutOfRange(key, raw, lang)) detail.outOfRange = 1;
  return {
    key,
    label: c.label,
    value: Number.isFinite(raw) ? Number(raw.toFixed(4)) : 0,
    weight,
    contribution: applicable ? Number((weight * aiLike * 100).toFixed(2)) : 0,
    aiLike: Number(aiLike.toFixed(4)),
    higherIsAi: c.higherIsAi,
    applicable,
    anchor: { human: c.humanP50, ai: c.aiP50 },
    detail,
  };
}

/**
 * 困惑度代理 —— **固定 3 阶**字符条件熵 H(next | 前 3 字), perplexity = 2^H。
 * H 越低 = 下一个字越可预测 = 越像模型输出。
 *
 * ⚠ 阶数必须固定, 不能"数据够就自动升阶"。踩过: 早先写成自适应(样本长就上 5 阶),
 *   结果同一篇文章 1200 字取 4 阶、3000 字取 5 阶 —— 实测 5 阶熵中位数比 3 阶低一半
 *   (0.073 vs 0.194), 于是短样本被系统性判得比长样本"更像人类", AI 方向都反了。
 *   **凡是靠"样本量够不够"切换公式的做法, 都会把长度混进结论里。**
 *
 * 只统计**重复出现过的上下文**(n < 2 的上下文没有条件分布可言; 计入的话
 * 一次性罕见上下文会把熵抬高, 掩盖真正的信号), 并报出观测数供调用方判断可信度。
 */
const ENTROPY_ORDER = 3;

function featureEntropy(ctx: AigcAnalysisContext): AigcFeature {
  const { h, observations } = conditionalEntropy(ctx.chars, ENTROPY_ORDER);
  const uni = tally(ctx.chars);
  return mkFeature("entropy", h, ctx.lang, {
    applicable: ctx.chars.length >= 150 && observations >= 40 * ENTROPY_ORDER,
    detail: {
      order: ENTROPY_ORDER,
      charTokens: ctx.chars.length,
      charSetSize: uni.size,
      observations,
      unigramEntropy: Number(shannon(uni, ctx.chars.length).toFixed(3)),
      perplexityProxy: Number(Math.pow(2, h).toFixed(2)),
      normalizedEntropy: Number((h / Math.log2(Math.max(2, uni.size))).toFixed(3)),
    },
  });
}

/** 2. 突发性: 句长 (σ-μ)/(σ+μ)。μ=0(极短文本)时取 0 —— 不是"最像 AI" */
function featureBurstiness(ctx: AigcAnalysisContext): AigcFeature {
  const lens = ctx.sentences.map((s) => tokenize(s).length).filter((n) => n > 0);
  const m = mean(lens);
  const sd = stdev(lens);
  const burst = m > 0 ? (sd - m) / (sd + m) : 0;
  const modeShare = lens.length ? Math.max(...tally(lens.map(String)).values()) / lens.length : 0;
  return mkFeature("burstiness", burst, ctx.lang, {
    applicable: lens.length >= MIN_SENTENCES,
    detail: {
      sentences: lens.length,
      meanLen: Number(m.toFixed(2)),
      sdLen: Number(sd.toFixed(2)),
      cv: Number(cv(lens).toFixed(3)),
      lag1: Number(lag1Correlation(lens).toFixed(3)),
      modeShare: Number(modeShare.toFixed(3)),
      minLen: lens.length ? Math.min(...lens) : 0,
      maxLen: lens.length ? Math.max(...lens) : 0,
    },
  });
}

/** 3a. 词汇多样性 MATTR */
function featureMattr(ctx: AigcAnalysisContext): AigcFeature {
  const { value, window } = mattr(ctx.tokens);
  return mkFeature("mattr", value, ctx.lang, {
    applicable: ctx.tokens.length >= 50,
    detail: { tokens: ctx.tokens.length, window, types: new Set(ctx.tokens).size },
  });
}

/** 3b. hapax legomena —— **按随机基线归一化**。
 *
 * 朴素的"只出现一次的词型占比"随文本长度单调下滑(实测人类: 400 字 0.71 → 5000 字 0.41),
 * 于是同一篇文章从 400 字扩写到 5000 字, 分数会凭空变化 —— 那是长度效应, 不是写作风格。
 * 这里改成观测值 / 随机基线: 把每个词型按它的词频当作独立抽取的概率, 期望的"一次词"占比
 *   E = Σ_i (1-p_i)^(N-1)
 * 就是"在打乱词序之后, 这个文本本来该有多少一次性词"。观测远低于期望 = 用词被反复固定
 * 复用(机器痕迹); 比值 >1 = 用词比随机还分散。该比值对长度基本不敏感。 */
function featureHapax(ctx: AigcAnalysisContext): AigcFeature {
  const t = tally(ctx.tokens);
  const types = t.size;
  const N = ctx.tokens.length;
  let once = 0;
  let expected = 0;
  for (const c of t.values()) {
    if (c === 1) once++;
    const p = c / N;
    expected += Math.pow(1 - p, N - 1);
  }
  const ratio = expected > 0 ? once / expected : 0;
  return mkFeature("hapax", ratio, ctx.lang, {
    applicable: types >= 40 && N >= 100,
    detail: {
      types,
      tokens: N,
      hapax: once,
      expectedHapax: Number(expected.toFixed(1)),
      rawRatio: Number((types ? once / types : 0).toFixed(4)),
    },
  });
}

/** 4. 重复 n-gram 率(中文按字 4-gram, 英文按词 3-gram) */
function featureRepeatNgram(ctx: AigcAnalysisContext): AigcFeature {
  const n = ctx.lang === "zh" ? 4 : 3;
  const tokens = ctx.tokens;
  let rate = 0;
  if (tokens.length >= n + 1) {
    const grams: string[] = [];
    for (let i = 0; i + n <= tokens.length; i++) grams.push(tokens.slice(i, i + n).join(" "));
    rate = 1 - new Set(grams).size / grams.length;
  }
  return mkFeature("repeat_ngram", rate, ctx.lang, {
    applicable: tokens.length >= n * 8,
    detail: { n, tokens: tokens.length },
  });
}

/** 5. 套话/连接词密度(每 100 token 命中次数) */
function featureTemplate(ctx: AigcAnalysisContext): AigcFeature {
  const phrases = ctx.lang === "zh" ? TEMPLATE_PHRASES_ZH : TEMPLATE_PHRASES_EN;
  const patterns = ctx.lang === "zh" ? TEMPLATE_PATTERNS_ZH : TEMPLATE_PATTERNS_EN;
  const { hits, kinds } = countHits(ctx.text, phrases, patterns);
  const density = ctx.tokens.length ? (hits / ctx.tokens.length) * 100 : 0;
  return mkFeature("template_phrase", density, ctx.lang, {
    applicable: ctx.tokens.length >= 40,
    detail: { hits, kinds, tokens: ctx.tokens.length },
  });
}

/** 6a. 标点间隔规律度: 相邻逗号(不足时用全部标点)之间 token 数的变异系数 */
function featurePunctInterval(ctx: AigcAnalysisContext): AigcFeature {
  const { comma, period } = ctx.punct;
  const all = [...comma, ...period];
  const useComma = comma.length >= MIN_PUNCT_MARKS;
  const value = cv(useComma ? comma : all);
  const punctCount = (ctx.text.match(/[，,。.、；;：:！!？?…—]/g) ?? []).length;
  return mkFeature("punct_interval", value, ctx.lang, {
    applicable: (useComma ? comma.length : all.length) >= MIN_PUNCT_MARKS,
    detail: {
      commas: comma.length,
      periods: period.length,
      meanInterval: Number(mean(useComma ? comma : all).toFixed(2)),
      periodCv: Number(cv(period).toFixed(3)),
      punctPer100: ctx.tokens.length ? Number(((punctCount / ctx.tokens.length) * 100).toFixed(1)) : 0,
    },
  });
}

/** 6b. 四字格密度: 恰好 4 个汉字且无其他字符的分句占比(中文特有的"整齐感") */
function featureFourChar(ctx: AigcAnalysisContext): AigcFeature {
  const segs = ctx.clauses.filter((s) => CJK_RE.test(s));
  if (!segs.length) {
    return mkFeature("four_char", 0, ctx.lang, { applicable: false, detail: { segments: 0, fourCharSegments: 0 } });
  }
  let four = 0;
  for (const s of segs) {
    const zh = s.match(CJK_GLOBAL_RE)?.length ?? 0;
    if (zh === 4 && s.replace(CJK_GLOBAL_RE, "").trim().length === 0) four++;
  }
  return mkFeature("four_char", four / segs.length, ctx.lang, {
    applicable: segs.length >= MIN_PUNCT_MARKS,
    detail: { segments: segs.length, fourCharSegments: four },
  });
}

/** 7. 段落结构规律度: 段长变异系数(明细里再给首句长度分布) */
function featureParagraph(ctx: AigcAnalysisContext): AigcFeature {
  const lens = ctx.paragraphs.map((p) => tokenize(p).length);
  const firstLens = ctx.paragraphs
    .map((p) => splitSentences(p)[0] ?? "")
    .map((s) => tokenize(s).length)
    .filter((n) => n > 0);
  return mkFeature("paragraph_regularity", cv(lens), ctx.lang, {
    applicable: lens.length >= MIN_PARAGRAPHS,
    detail: {
      paragraphs: lens.length,
      meanLen: Number(mean(lens).toFixed(2)),
      firstSentenceCv: Number(cv(firstLens).toFixed(3)),
      minLen: lens.length ? Math.min(...lens) : 0,
      maxLen: lens.length ? Math.max(...lens) : 0,
    },
  });
}

/** 5(锐化)。句首重复: 撞车的句首 3-gram 占比 —— "首先…/其次…/此外…" 的机器指纹 */
function featureSentenceOpening(ctx: AigcAnalysisContext): AigcFeature {
  const opens = ctx.sentences.map((s) => tokenize(s).slice(0, 3).join(" ")).filter((s) => s.length > 0);
  if (opens.length < MIN_SENTENCES) {
    return mkFeature("sentence_opening", 0, ctx.lang, { applicable: false, detail: { sentences: opens.length, distinctOpenings: 0, collided: 0 } });
  }
  const t = tally(opens);
  const collided = opens.filter((o) => (t.get(o) ?? 0) > 1).length;
  return mkFeature("sentence_opening", collided / opens.length, ctx.lang, {
    detail: { sentences: opens.length, distinctOpenings: t.size, collided },
  });
}

/** 固定顺序 —— 界面按此顺序呈现, 也是权重表的顺序(权重降序) */
const FEATURE_ORDER: AigcFeatureKey[] = [
  "mattr", "paragraph_regularity", "burstiness", "entropy", "repeat_ngram",
  "four_char", "sentence_opening", "punct_interval", "hapax", "template_phrase",
];

function verdictOf(score: number, reliable: boolean): AigcVerdict {
  if (!reliable) return "insufficient";
  if (score >= 65) return "likely_ai";
  if (score <= 35) return "likely_human";
  return "mixed";
}

/**
 * AIGC 率检测主入口 —— **纯函数**: 不连库、不发网络请求、不调 LLM、不读环境变量。
 *
 * @param text 待检测文本(中英均可, 语言自动判定)
 * @param opts.lang 强制语言(默认 auto); 混排文本判定错时用
 */
export function analyzeAigc(text: string, opts: { lang?: "auto" | "zh" | "en" } = {}): AigcResult {
  const ctx = buildContext(text, opts.lang);
  const all: AigcFeature[] = [
    featureMattr(ctx),
    featureParagraph(ctx),
    featureBurstiness(ctx),
    featureEntropy(ctx),
    featureRepeatNgram(ctx),
    featureFourChar(ctx),
    featureSentenceOpening(ctx),
    featurePunctInterval(ctx),
    featureHapax(ctx),
    featureTemplate(ctx),
  ];
  const features = FEATURE_ORDER.map((k) => all.find((f) => f.key === k)!);

  // 数据不足的特征**让出权重**, 而不是按 0 或 0.5 计 ——
  // 否则"只有一段话"的文章会因为"段落结构没法算"而无条件丢 16 分。
  const active = features.filter((f) => f.applicable);
  const weightSum = active.reduce((a, f) => a + f.weight, 0);
  const rawScore = weightSum > 0 ? features.reduce((a, f) => a + f.contribution, 0) / weightSum : 0;
  const chars = ctx.text.replace(/\s/g, "").length;
  const reliable = chars >= MIN_RELIABLE_CHARS && active.length >= 6;
  const aiScore = Math.round(clamp01(rawScore / 100) * 100);
  const confidence = Number(
    clamp01(Math.min(chars / 600, active.length / FEATURE_ORDER.length) * (reliable ? 1 : 0.4)).toFixed(2),
  );

  const topSignals = [...active]
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((f) => `${f.label}: ${f.value}（人类中位 ${f.anchor.human} / AI 中位 ${f.anchor.ai}, 贡献 ${f.contribution} 分）`);
  /** 超出标定范围的特征 —— 见 mkFeature 的注释, 这是它唯一能给的诚实交代 */
  const outOfRange = active.filter((f) => f.detail.outOfRange === 1);
  // 只列前两项: 一条 note 报七八个特征名会变成噪声, 反而没人看
  const outOfRangeNote = outOfRange.length
    ? `有 ${outOfRange.length} 项超出标定范围(${outOfRange.slice(0, 2).map((f) => f.label).join("、")}${outOfRange.length > 2 ? " 等" : ""}), 这些项按"未定"计分`
    : "";

  const note = chars === 0
    ? "文本为空, 未做检测"
    : !reliable && chars < MIN_RELIABLE_CHARS
      ? `样本过短(${chars} 字 < ${MIN_RELIABLE_CHARS} 字), 统计量不稳定, 不给结论`
      : !reliable
        ? `可用特征仅 ${active.length} 项, 不足以给出结论`
        : outOfRangeNote;

  return {
    aiScore,
    verdict: verdictOf(aiScore, reliable),
    reliable,
    confidence,
    note,
    features,
    stats: {
      chars,
      tokens: ctx.tokens.length,
      sentences: ctx.sentences.length,
      paragraphs: ctx.paragraphs.length,
      lang: ctx.lang,
    },
    topSignals,
  };
}

export interface AigcDiff {
  before: number;
  after: number;
  /** after − before: 负数 = 降下来了(降重生效的方向) */
  delta: number;
  verdictBefore: AigcVerdict;
  verdictAfter: AigcVerdict;
  /** 分数下降(或持平)且两侧都可用时为 true */
  improved: boolean;
  /** 变化最大的三项特征, 回答"到底改动了什么" */
  movedFeatures: Array<{ key: AigcFeatureKey; label: string; before: number; after: number; delta: number }>;
}

/**
 * 降重前后对比 —— applyDeAITier() 的配套入口。
 * 存在的意义: "降 AIGC 合稿"执行完只丢给用户一篇新稿, 用户无法知道它到底降没降。
 */
export function diffAigc(before: string, after: string, opts: { lang?: "auto" | "zh" | "en" } = {}): AigcDiff {
  const a = analyzeAigc(before, opts);
  const b = analyzeAigc(after, opts);
  const byKey = new Map(a.features.map((f) => [f.key, f]));
  const movedFeatures = b.features
    .map((f) => {
      const prev = byKey.get(f.key);
      const beforeVal = prev?.applicable ? prev.aiLike : f.aiLike;
      return { key: f.key, label: f.label, before: beforeVal, after: f.aiLike, delta: Number((f.aiLike - beforeVal).toFixed(4)) };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 3);
  return {
    before: a.aiScore,
    after: b.aiScore,
    delta: b.aiScore - a.aiScore,
    verdictBefore: a.verdict,
    verdictAfter: b.verdict,
    improved: a.reliable && b.reliable && b.aiScore <= a.aiScore,
    movedFeatures,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 尾注: 锚点是怎么来的(复现方式)
//
// 标定集两份:
//   人类侧 —— 库里 40 篇真实中文论文
//     select document_id, string_agg(content, E'\n\n' order by rank, id) from source_chunks
//      where content ~ '[一-鿿]' group by document_id having sum(char_length(content)) between 2500 and 14000
//     按空行切成 1400 字与 3600 字两档 → 239 个样本块
//   AI 侧 —— 让真实模型(deepseek-flash)就同一批题目写中文学术正文
//     温度 0.4~1.0、长度 1.5k~4.9k 字 → 18 篇
// 对每个特征计算 AUC(高值/低值两个方向都算, 取更优者), 并按
//   人类 p05/p50、AI p50/p95 取四个分位点写进 CALIB_ZH。
// 权重按 max(AUC-0.5, 0.05) 归一化得到 AIGC_FEATURE_WEIGHTS。
//
// 标定脚本没有入库(它要连库、要调 LLM、成本与运行时间都不适合放进单测)。
// 要重标定时, 按上面两段 SQL/生成方式造数据, 把 features 值 dump 出来算 AUC 与分位点即可。
// 复现的判据看 test/aigc-detect.test.ts: 它断言的是**方向**(标定集上 AI 分高于人类分)
//   与**单调性**(打散套话与结构后分数下降), 而不是某一组精确的锚点数字。
// ─────────────────────────────────────────────────────────────────────────────
