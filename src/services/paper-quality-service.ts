// paper-quality-service.ts — 论文质量检查 5 大能力（S56-S60）
// 概念一致性校验 / 引文准确性核查 / 逻辑自洽性检查 / 学术不端风险提示 / 格式规范适配
// 复用: LLM + 检索；专属算法: 概念歧义检测 / 引文匹配 / 循环论证检测 / 重合度计算 / 格式规则库
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";

// ═══ 1. 概念一致性校验 ═══
// LLM 识别内涵不一致 + 专属算法: 易混淆概念库（预设对照表）+ 术语变体检测
export async function conceptConsistencyCheck(text: string, opts: { model?: string } = {}) {
  // 专属算法: 易混淆概念对照库（马理论领域常见混淆对）
  const CONFUSABLE_PAIRS: Array<{ a: string; b: string; diff: string }> = [
    { a: "异化", b: "物化", diff: "异化指主体活动的产物反过来支配主体；物化指人与人的关系表现为物与物的关系，侧重对象化结果" },
    { a: "国家", b: "政府", diff: "国家是阶级统治的总体机器（含军队/立法/行政）；政府只是国家的行政机关，二者是整体与部分关系" },
    { a: "资本", b: "资金", diff: "资本是能带来剩余价值的价值（社会关系）；资金只是货币形态的要素，不必然包含剥削关系" },
    { a: "市民社会", b: "公民社会", diff: "市民社会（bürgerliche Gesellschaft）在马恩语境指物质生活关系总和；公民社会是当代政治学概念，侧重公共领域" },
    { a: "剩余价值", b: "利润", diff: "剩余价值是雇佣工人创造而被资本家无偿占有的价值；利润是剩余价值的转化形式（含成本利润率视角）" },
    { a: "商品拜物教", b: "货币拜物教", diff: "商品拜物教指商品关系掩盖人与人的关系；货币拜物教是其发展形态，货币成为崇拜对象" },
  ];
  const confusedUsed: Array<{ pair: string; diff: string }> = [];
  for (const p of CONFUSABLE_PAIRS) {
    const hasA = text.includes(p.a);
    const hasB = text.includes(p.b);
    if (hasA && hasB) {
      // 检查是否在同一段落混用（疑似混淆）
      const paras = text.split(/\n+/).filter((para) => para.includes(p.a) && para.includes(p.b));
      if (paras.length > 0) {
        confusedUsed.push({ pair: `${p.a} / ${p.b}`, diff: p.diff });
      }
    }
  }

  const prompt = `你是学术审校专家。请对以下论文文本做概念一致性校验：
1. 识别同一概念前后内涵不一致的地方
2. 识别偷换概念的问题
3. 提示易混淆概念的差异（如 异化/物化、国家/政府）
输出 JSON：{"inconsistencies":[{"concept":"概念","location":"位置","before":"前文内涵","after":"后文内涵","issue":"问题描述"}],"confusions":[{"concepts":"易混概念对","usage":"文中用法","suggestion":"区分建议"}]}

论文文本：
${text.substring(0, 4000)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    inconsistencies: answer?.inconsistencies ?? [],
    confusions: answer?.confusions ?? [],
    algorithmFlags: confusedUsed,
    totalPairs: CONFUSABLE_PAIRS.length,
  };
}

// ═══ 2. 引文准确性核查 ═══
// LLM 核对引文 + 专属算法: 引文模式检测（直接/间接引用规范）+ 引文-文献匹配
export async function citationAccuracyCheck(text: string, referenceList: string, opts: { model?: string } = {}) {
  // 专属算法: 引文模式检测（直接引用必须带引号+页码；间接引用须标注出处）
  const directQuotes = (text.match(/"[^"]{10,}"/g) ?? []).length;
  const quoteMarks = (text.match(/“|”/g) ?? []).length / 2;
  const indirectPatterns = (text.match(/(据|按照|根据|参见|见)\s*[^。]{2,30}(著|文|研究)/g) ?? []).length;
  const citationMarkers = (text.match(/[（(][^）)]{2,30}(19|20)\d{2}[）)]/g) ?? []).length;
  const refCount = referenceList.split(/\n+/).filter((l) => l.trim().length > 5).length;

  const prompt = `你是引文核查专家。请核对以下论文文本的引文：
1. 引文内容与标注文献的一致性（识别断章取义/误引/错标出处）
2. 直接引用与间接引用的规范差异
3. 正文引文与参考文献列表的一一对应
输出 JSON：{"issues":[{"citation":"引文","claimedSource":"标注出处","problem":"问题类型(误引/断章取义/错标出处)","detail":"详情"}],"directQuotes":{"unmarked":["未标注页码的直接引用"]},"mismatches":[{"inText":"正文引文","refList":"对应文献","status":"匹配/缺失/多余"}]}

论文文本：
${text.substring(0, 3000)}

参考文献列表：
${referenceList.substring(0, 1500)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    issues: answer?.issues ?? [],
    mismatches: answer?.mismatches ?? [],
    stats: {
      directQuotes: directQuotes + quoteMarks,
      indirectReferences: indirectPatterns,
      citationMarkers,
      referenceCount: refCount,
      quoteVerdict: quoteMarks > 0 && refCount === 0 ? "有直接引用但无参考文献列表" : "引文标记正常",
    },
  };
}

// ═══ 3. 逻辑自洽性检查 ═══
// LLM 识别逻辑问题 + 专属算法: 循环论证关键词检测 + 矛盾标记词检测
export async function logicConsistencyCheck(text: string, opts: { model?: string } = {}) {
  // 专属算法: 循环论证/矛盾信号词检测
  const circularPatterns = [
    { pattern: /因为.*所以.*因为|正因为.*才.*正因为/g, type: "循环论证" },
    { pattern: /A就是A|等于自身|自证/g, type: "同义反复" },
    { pattern: /既然.*那么.*既然/g, type: "循环推理" },
  ];
  const contradictionPatterns = [
    { pattern: /虽然.*但是.*然而.*但是/g, type: "转折矛盾" },
    { pattern: /既.*又.*既不.*又不/g, type: "自相矛盾" },
  ];
  const algorithmFlags: Array<{ text: string; type: string }> = [];
  for (const { pattern, type } of circularPatterns) {
    const m = text.match(pattern);
    if (m) algorithmFlags.push({ text: m[0], type });
  }
  for (const { pattern, type } of contradictionPatterns) {
    const m = text.match(pattern);
    if (m) algorithmFlags.push({ text: m[0], type });
  }

  const prompt = `你是逻辑审校专家。请检查以下论文文本的逻辑自洽性：
1. 逻辑矛盾（前后结论冲突）
2. 循环论证（用结论证明前提）
3. 论据不支撑论点
4. 推理跳跃（缺中间环节）
输出 JSON：{"contradictions":[{"position":"位置","claim1":"前文论断","claim2":"后文论断","issue":"矛盾描述"}],"circular":[{"argument":"循环论证处","detail":"问题"}],"weakPoints":[{"claim":"论点","evidence":"论据","gap":"不支撑原因"}],"jumps":[{"from":"推理起点","to":"推理终点","missing":"缺失环节"}]}

论文文本：
${text.substring(0, 4000)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    contradictions: answer?.contradictions ?? [],
    circular: answer?.circular ?? [],
    weakPoints: answer?.weakPoints ?? [],
    jumps: answer?.jumps ?? [],
    algorithmFlags,
  };
}

// ═══ 4. 学术不端风险提示 ═══
// 专属算法: 重合度计算（N-gram 相似度）+ 无标注转述检测 + LLM 补充
export async function plagiarismRiskCheck(text: string, sourceText: string, opts: { model?: string } = {}) {
  // 专属算法: N-gram 重合度（文本 vs 源文本，6-gram 指纹）
  const ngrams = (t: string, n: number): Set<string> => {
    const cleaned = t.replace(/\s+/g, "").replace(/[，。；：！？、""''（）《》—…]/g, "");
    const set = new Set<string>();
    for (let i = 0; i <= cleaned.length - n; i++) set.add(cleaned.slice(i, i + n));
    return set;
  };
  const gramsA = ngrams(text, 6);
  const gramsB = ngrams(sourceText, 6);
  let overlap = 0;
  for (const g of gramsA) if (gramsB.has(g)) overlap++;
  const overlapRatio = gramsA.size > 0 ? overlap / gramsA.size : 0;

  // 大段重合片段定位
  const longMatches: Array<{ segment: string }> = [];
  const cleanedA = text.replace(/\s+/g, "");
  const cleanedB = sourceText.replace(/\s+/g, "");
  for (let i = 0; i < cleanedA.length - 20; i++) {
    const window = cleanedA.slice(i, i + 20);
    if (cleanedB.includes(window)) {
      longMatches.push({ segment: window });
      i += 15; // 跳步
    }
    if (longMatches.length >= 5) break;
  }

  // 未标注出处的转述检测（文本中引用标记较少的段落）
  const paras = text.split(/\n+/).filter((p) => p.trim().length > 40);
  const unmarkedParas = paras.filter((p) => !/[（(][^）)]{2,}(19|20)\d{2}[）)]/.test(p) && !/\[[0-9]+\]/.test(p));

  const prompt = `你是学术诚信审查专家。请检查以下论文文本的学术不端风险：
1. 未标注出处的转述（需要补充引文的位置）
2. 大段重合表述（疑似抄袭）
3. 不当引用（引用不规范）
输出 JSON：{"risks":[{"position":"位置","type":"未标注转述|大段重合|不当引用","detail":"详情","suggestion":"修改建议"}],"citationNeeded":["需要补充引文的位置"]}

论文文本：
${text.substring(0, 3000)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    overlapRatio: Math.round(overlapRatio * 1000) / 1000,
    overlapVerdict: overlapRatio > 0.5 ? `高风险重合（${(overlapRatio * 100).toFixed(1)}%）——大段与源文本重合` : overlapRatio > 0.2 ? `中风险（${(overlapRatio * 100).toFixed(1)}%）——存在重合片段` : `低风险（${(overlapRatio * 100).toFixed(1)}%）`,
    longMatches,
    unmarkedParagraphs: unmarkedParas.slice(0, 3),
    risks: answer?.risks ?? [],
    citationNeeded: answer?.citationNeeded ?? [],
  };
}

// ═══ 5. 格式规范适配 ═══
// 专属算法: 格式规则库（期刊/高校/通用模板）+ LLM 生成适配报告
export async function formatAdaptation(text: string, target: string, opts: { model?: string } = {}) {
  // 专属算法: 格式规则库
  const FORMAT_RULES: Record<string, { rules: string[] }> = {
    "期刊论文": { rules: ["标题层级：一、→（一）→1.→（1）", "字体：正文宋体小四", "行距：1.5倍", "参考文献：GB/T 7714", "摘要：150-300字", "关键词：3-5个"] },
    "学位论文": { rules: ["标题层级：第X章→1.1→1.1.1", "字体：正文宋体小四", "行距：1.5倍（或固定值20磅）", "脚注：页下注", "参考文献：GB/T 7714", "摘要：500-800字（博士）/300-500字（硕士）"] },
    "党校期刊": { rules: ["标题层级：一、→（一）→1.", "字体：正文仿宋/宋体", "行距：1.5倍", "参考文献：GB/T 7714", "篇幅：5000-10000字"] },
    "高校学报": { rules: ["标题层级：一、→（一）→1.", "字体：正文宋体五号", "行距：固定值", "参考文献：GB/T 7714", "摘要：150-200字"] },
  };
  const rules = FORMAT_RULES[target] ?? FORMAT_RULES["期刊论文"];

  // 检测文本中的标题层级（判断是否符合目标规则）
  const headings: Array<{ level: string; text: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+[\.．]\d+[\.．]\d+|\d+[\.．]\d+|第[一二三四五六七八九十]+章|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+[\.．])\s*(.+)/);
    if (m) headings.push({ level: m[1], text: m[2].substring(0, 30) });
  }

  const prompt = `你是格式规范专家。请将以下论文文本适配为「${target}」格式要求：
【格式规则】${rules.rules.join("；")}

要求：
1. 调整标题层级（按规则）
2. 统一格式（字体/行距/脚注/参考文献）
3. 输出格式适配说明
输出 JSON：{"adaptedText":"适配后的文本","adjustments":[{"aspect":"调整项","from":"原文","to":"调整后"}],"formatNotes":"格式说明","headingIssues":["标题层级问题"]}

论文文本：
${text.substring(0, 3000)}`;

  const answer = await llmJson(prompt, opts.model);
  return {
    target,
    rules,
    detectedHeadings: headings,
    adaptedText: answer?.adaptedText ?? "",
    adjustments: answer?.adjustments ?? [],
    formatNotes: answer?.formatNotes ?? "",
    headingIssues: answer?.headingIssues ?? [],
  };
}

export const paperQualityService = {
  conceptConsistencyCheck,
  citationAccuracyCheck,
  logicConsistencyCheck,
  plagiarismRiskCheck,
  formatAdaptation,
};

// ═══ 工具函数 ═══

async function llmJson(prompt: string, modelOverride?: string, maxTokens = 4000): Promise<any | null> {
  const ep = getLlmEndpoint({ model: modelOverride || getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url,
    key: ep.key,
    model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON，不要其他文字。" }],
    temperature: 0.2,
    maxTokens,
    timeoutMs: 180_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}
