/**
 * keyword-network.test.ts — 关键词共现聚类图谱。
 *
 * 这个文件盯四件事, 每件都对应一种**不报错的造假方式**:
 *
 *   ① **分词**: 中文不能切出含虚词的伪词(`资本的增殖`), 也不能留下跨词边界的碎片
 *      (`乡村治` `村振兴`)。无词典方案会静默地给出这两种垃圾 —— 图上照样有点有线,
 *      只是每个点都没有语义, 而界面看不出来。
 *   ② **边权**: 裸共现次数会把"哪儿都出现的泛词"连成一片。这里构造一对"计数相同、
 *      关联强度天差地别"的词对, 断言关联强度能分开 —— 同时断言 count 口径**分不开**
 *      (对照组), 否则说明这条断言根本没在测边权口径。
 *   ③ **聚类**: 社区发现要**真**做 —— 断言模块度为正(比"全在一簇"更有结构)、两个话题的簇
 *      互相不串、同一输入两次逐字节一致(带种子的确定性), 以及空图/无边图不崩。
 *   ④ **中英分开**: 中文语料走中文管线时英文词不该冒出来, 反过来也一样。
 */
import { describe, it, expect } from "vitest";
import {
  zhRuns, zhCandidates, absorbByLongerForms, zhTokenStream, tokenizeZhCorpus, enTokenStream, tokenStream,
  extractKeywords, extractCorpusKeywords, splitSegments, lemmatizeEn, stopwordsFor, detectCorpusLang,
  buildCooccurrence, jaccard, npmi, edgeWeight, PAIR_KEY,
  detectCommunities, modularityOf, buildAdjacency, seededRng,
  buildKeywordNetwork, buildBilingualNetworks, buildNetworkFromKeywords,
} from "../src/services/keyword-network-service.js";

/** 共现矩阵里的词对 key(与实现同一口径), 测试里手算断言用 */
function pairKeyOf(m: { index: Map<string, number> }, a: string, b: string): number {
  const x = m.index.get(a)!, y = m.index.get(b)!;
  return Math.min(x, y) * PAIR_KEY + Math.max(x, y);
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 分词
// ═══════════════════════════════════════════════════════════════════════════
describe("中文切片 · 虚词必须断开", () => {
  it("`资本的增殖` 切成 资本 / 增殖 —— 含 `的` 的伪词连候选都形不成", () => {
    expect(zhRuns("资本的增殖")).toEqual(["资本", "增殖"]);
  });

  it("虚词是 CJK 字符, 只按「是不是汉字」判断断不开 —— 这条锁住那个判断", () => {
    // 若实现写成 `if (CJK.test(ch)) run += ch`, 这里会得到 ["资本的增殖"] 一整段
    expect(zhRuns("资本的增殖")).toEqual(["资本", "增殖"]);
  });

  it("标点/字母/数字同样断开", () => {
    expect(zhRuns("资本下乡,2024年 GDP 增长")).toEqual(["资本下乡", "年", "增长"]);
  });

  it("只收「不会长在实词内部」的虚词: 为/就/中/及 不断(否则把真词切碎)", () => {
    // 这五个字都**不在** ZH_BREAK 里 —— 它们是 行为/就业/中国/涉及/过程 的一部分
    expect(zhRuns("行为就业中国涉及过程")).toEqual(["行为就业中国涉及过程"]);
    expect(zhRuns("行为，就业")).toEqual(["行为", "就业"]);
  });
});

describe("候选剪枝 · 跨词边界的碎片必须被更长形式吃掉", () => {
  const cands = new Map([["乡村振兴战略", 3], ["村振兴", 3], ["乡村振兴", 3], ["乡村", 5], ["振兴", 3]]);
  const absorbed = absorbByLongerForms(cands, { minLen: 2 });

  it("`村振兴` 只长在 `乡村振兴战略` 里 → 被吸收", () => {
    expect(absorbed.has("村振兴")).toBe(true);
  });

  it("`乡村振兴战略` 自己没有更长的形式 → 保留(不能把好词一起剪掉)", () => {
    expect(absorbed.has("乡村振兴战略")).toBe(false);
  });

  it("★ 吸收者可以比被吸收者长很多 —— 只扫 +1/+2 个字会漏掉这一半", () => {
    // `村振兴` 的真吸收者是 6 字的 `乡村振兴战略`, 差 3 个字。
    // 第一版只扫相邻长度, 于是 `村振兴` 活了、图谱里出现一个不是词的节点。
    const only = new Map([["乡村振兴战略", 3], ["村振兴", 3]]);
    expect(absorbByLongerForms(only, { minLen: 2 }).has("村振兴")).toBe(true);
  });

  it("计数明显更高的短形式不算被吸收(它自己独立出现过)", () => {
    // 乡村 出现 5 次, 乡村振兴 3 次, 乡村振兴战略 3 次 → 5 > 1.2×3 ⇒ 乡村 留下
    expect(absorbed.has("乡村")).toBe(false);
  });

  it("两个互相不包含的碎片都剪不掉 —— 记为已知边界, 靠 minCount 兜", () => {
    // `以` 横跨两个词时会出现这种情况: 乡村振兴战略 与 乡村治理需要 谁都不含谁
    const two = new Map([["乡村振兴战略", 2], ["乡村治理需要", 2]]);
    const a = absorbByLongerForms(two, { minLen: 2 });
    expect(a.has("乡村振兴战略")).toBe(false);
    expect(a.has("乡村治理需要")).toBe(false);
  });
});

describe("中文词流 · 端到端(语料级)", () => {
  const text = "资本的增殖以剩余价值为前提。资本下乡推动乡村治理转型, 乡村振兴战略与乡村治理相互支撑。";
  const s = zhTokenStream(text);
  // 语料只有一句话 —— 用 minCount=2 才谈得上"语料级词表"(单句里除了真词, 全是只出现一次
  // 的长片段; 那些片段在默认 minCount=2 下根本不进词表, 于是不会顶掉真词)
  const tok = tokenizeZhCorpus(zhRuns(text), { minCount: 2 });

  it("切出的词里没有含虚词的伪词", () => {
    for (const w of s.freq.keys()) {
      expect(w.includes("的")).toBe(false);
      expect(w.includes("了")).toBe(false);
    }
  });

  it("★ `乡村治理` 作为整体留下 —— 切分按词频打分, 不是「能长就长」的贪心", () => {
    expect(tok.freq.has("乡村治理")).toBe(true);
  });

  it("跨词边界的碎片不进词表", () => {
    expect(tok.freq.has("乡村治")).toBe(false);
    expect(tok.freq.has("村治理")).toBe(false);
    // `乡村`(3 次)没有被 `乡村治理`(2 次)吃光, 但它被同样的长度约束挡在词表外:
    // 6 字候选里 `乡村治理转型` 计数 1 —— 见下面那条 minCount 用例
  });

  it("★ 语料级 minCount 决定词表: 短文本里 `乡村治理转型` 这类长片段过不了 minCount=2", () => {
    const strict = tokenizeZhCorpus(zhRuns(text), { minCount: 2 });
    expect(strict.freq.has("乡村治理")).toBe(true);
    expect(strict.freq.has("乡村治理转型")).toBe(false);
    expect(strict.vocabSize).toBeLessThan(tokenizeZhCorpus(zhRuns(text), { minCount: 1 }).vocabSize);
  });

  it("停用学术套话(发展/推动/研究这类)不进词流", () => {
    for (const w of ["发展", "推动", "研究", "意义", "作用", "影响"]) expect(s.freq.has(w)).toBe(false);
  });

  it("追加停用词生效", () => {
    const withStop = tokenizeZhCorpus(zhRuns(text), { stopwords: ["乡村治理"] });
    expect(withStop.freq.has("乡村治理")).toBe(false);
  });

  it("未进词表的字被丢掉, 代价记在 uncoveredChars 里(不是静默消失)", () => {
    const odd = tokenizeZhCorpus(zhRuns("乡村振兴綮纛魑魅"));
    expect(odd.uncoveredChars).toBeGreaterThan(0);
  });

  it("minCoverage 抬高会削掉低覆盖率的词(第二道噪声闸)", () => {
    const runs = zhRuns(text);
    expect(tokenizeZhCorpus(runs, { minCoverage: 0.2 }).vocabSize)
      .toBeLessThan(tokenizeZhCorpus(runs, { minCoverage: 0 }).vocabSize);
  });
});

describe("英文分词 · 屈折合并但不做派生合并", () => {
  it("复数/时态合并到同一词干", () => {
    expect(lemmatizeEn("institutions")).toBe("institution");
    expect(lemmatizeEn("analyses")).toBe("analysis");
    expect(lemmatizeEn("governing")).toBe("govern");
    expect(lemmatizeEn("boxes")).toBe("box");
  });

  it("★ 派生词**不**合并: govern 与 governance 是两个概念层次", () => {
    const s = enTokenStream("governance and govern the institutions of governance");
    expect(s.freq.has("governance")).toBe(true);
    expect(s.freq.has("govern")).toBe(true);   // 若误用词干提取器, 这句会挂
  });

  it("停用词与过短的词被滤掉", () => {
    const s = enTokenStream("the study of the rural governance and the paper");
    for (const w of ["the", "study", "of", "paper", "and"]) expect(s.freq.has(w)).toBe(false);
    expect(s.freq.has("rural")).toBe(true);
    expect(s.freq.has("governance")).toBe(true);
  });

  it("缩写点不断句(et al. 后面还接着同一句)", () => {
    const segs = splitSegments("As shown by Smith et al. the rural governance matters. Then it ends.", "en");
    expect(segs.length).toBe(2);
    expect(segs[0]).toContain("the rural governance matters");
  });

  it("中文断句符不参与英文切句(两张表各管一边)", () => {
    expect(splitSegments("First sentence. Second sentence.", "en").length).toBe(2);
    expect(splitSegments("第一句。第二句。", "zh").length).toBe(2);
  });
});

describe("语言判定与停用词表", () => {
  it("纯中文 → zh; 纯英文 → en; 中英混排按 CJK 占比", () => {
    expect(detectCorpusLang("资本下乡与乡村治理")).toBe("zh");
    expect(detectCorpusLang("rural governance and capital")).toBe("en");
    expect(detectCorpusLang("资本下乡 rural governance")).toBe("zh");
  });

  it("★ 两张停用词表互不串用", () => {
    expect(stopwordsFor("zh").has("发展")).toBe(true);
    expect(stopwordsFor("zh").has("the")).toBe(false);
    expect(stopwordsFor("en").has("the")).toBe(true);
    expect(stopwordsFor("en").has("发展")).toBe(false);
  });

  it("追加停用词合并, 不替换内置表", () => {
    const s = stopwordsFor("zh", ["自定义停用词"]);
    expect(s.has("自定义停用词")).toBe(true);
    expect(s.has("发展")).toBe(true);
  });
});

describe("词频入口 · 词云与图谱同一口径", () => {
  it("★ 单文本入口与语料入口同一口径(词云与图谱不会各说各话)", () => {
    const text = "资本下乡推动乡村治理。资本下乡与乡村治理互相支撑, 乡村治理需要资本下乡。";
    // ⚠ minCount 既筛输出**也决定词表**, 所以两边必须传同一个值:
    //   extractKeywords 默认 2, 而 tokenStream 的默认是 1(它要给出完整词频)——
    //   测试里显式对齐, 免得把一个口径差异当成回归。
    const hits = extractKeywords(text, "zh", { topK: 50 });
    const { freq } = tokenStream(text, "zh", { minCount: 2 });
    expect(hits.map((h) => h.word).sort()).toEqual([...freq.keys()].sort());
    for (const h of hits) expect(h.count).toBe(freq.get(h.word));
  });

  it("★ extractKeywords 默认丢掉只出现一次的词(与图谱默认一致)", () => {
    const text = "资本下乡推动乡村治理。资本下乡与乡村治理互相支撑, 乡村治理需要资本下乡。";
    const strict = extractKeywords(text, "zh", { topK: 50 });
    const loose = extractKeywords(text, "zh", { topK: 50, minCount: 1 });
    expect(strict.length).toBeLessThan(loose.length);
    expect(Math.min(...strict.map((h) => h.count))).toBeGreaterThanOrEqual(2);
  });

  it("★ 多文本入口把同一批文档当**一份**语料切, 而不是逐篇切再相加", () => {
    const docs = ZH_DOCS.map((d) => d.text);
    const merged = extractCorpusKeywords(docs, "zh", { topK: 50 });
    const joined = extractKeywords(docs.join("。"), "zh", { topK: 50 });
    expect(merged.map((h) => h.word)).toEqual(joined.map((h) => h.word));
  });

  it("topK 从大往小排", () => {
    const hits = extractKeywords("资本下乡。资本下乡。乡村治理。", "zh", { topK: 5 });
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].count).toBeGreaterThanOrEqual(hits[i].count);
    expect(hits[0].word).toBe("资本下乡");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 共现矩阵与边权
// ═══════════════════════════════════════════════════════════════════════════
describe("共现窗口", () => {
  it("窗口不跨段; 段即句级片段", () => {
    const m = buildCooccurrence([["甲", "乙"], ["丙", "丁"]], 5);
    expect(m.windows).toBe(2);      // 两段各出一个窗口
    expect(m.pairs.size).toBe(2);   // 甲乙、丙丁各一条, 段之间没有边
  });

  it("窗口覆盖整段(末窗口只有 1 个词时不计)", () => {
    const m = buildCooccurrence([["甲", "乙", "丙"]], 2);
    expect(m.windows).toBe(2);      // (甲乙) (乙丙)
  });

  it("★ 同一窗口里重复出现的词只算一次(不被复读词灌水)", () => {
    // 窗口都是长度 2 的: (甲甲) 无效 (甲乙) 有效 (甲甲) 无效 —— 甲乙只共现 1 次, 不是 3 次
    const m = buildCooccurrence([["甲", "甲", "甲", "乙"]], 2);
    const k = pairKeyOf(m, "甲", "乙");
    expect(m.pairs.get(k)).toBe(1);
  });

  it("全同词的窗口不进分母", () => {
    expect(buildCooccurrence([["甲", "甲", "甲"]], 3).windows).toBe(0);
  });

  it("窗口统计口径可手算: 甲乙丙 / 窗宽 2 / 各词窗口频次都是 2", () => {
    const m = buildCooccurrence([["甲", "乙", "丙"]], 2);
    expect([...m.winFreq]).toEqual([1, 2, 1]);
  });
});

describe("边权 = 关联强度, 不是裸频次", () => {
  it("Jaccard 公式: 交集 / 并集", () => {
    expect(jaccard(3, 5, 7)).toBeCloseTo(3 / 9, 10);
    expect(jaccard(0, 3, 4)).toBe(0);
    expect(jaccard(5, 5, 5)).toBe(1);       // 完全共现
  });

  it("NPMI: 完全共现 → 1, 独立 → 0", () => {
    expect(npmi(10, 10, 10, 100)).toBeCloseTo(1, 6);
    expect(Math.abs(npmi(1, 10, 10, 100))).toBeLessThan(1e-9);
  });

  it("★ 核心判据: 裸计数相同的两对词, 关联强度必须分开", () => {
    // 甲/乙都很泛(各出现 200 个窗口), 共现 50 次 → Jaccard 50/350 ≈ 0.143
    // 丙/丁都很专(各出现 55 个窗口), 共现 50 次 → Jaccard 50/60 ≈ 0.833
    const generic = jaccard(50, 200, 200);
    const specific = jaccard(50, 55, 55);
    expect(generic).toBeLessThan(specific);
    expect(generic / specific).toBeLessThan(0.25);      // 相差 5 倍以上
    // 对照组: count 口径下两者**完全相等** —— 说明这条断言真的在测边权口径。
    // 把 measure 默认值改成 count, 上面那句就挂。
    expect(edgeWeight("count", 50, 200, 200, 1000)).toBe(edgeWeight("count", 50, 55, 55, 1000));
  });

  it("edgeWeight 三档口径各自对上", () => {
    expect(edgeWeight("jaccard", 3, 5, 7, 100)).toBeCloseTo(jaccard(3, 5, 7), 10);
    expect(edgeWeight("pmi", 3, 5, 7, 100)).toBeCloseTo(npmi(3, 5, 7, 100), 10);
    expect(edgeWeight("count", 3, 5, 7, 100)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 社区发现
// ═══════════════════════════════════════════════════════════════════════════
describe("Louvain 社区发现", () => {
  /** 两个三角形, 中间只有一条细边 —— 教科书式的两个社区 */
  const edges: Array<[number, number, number]> = [
    [0, 1, 1], [1, 2, 1], [0, 2, 1],
    [3, 4, 1], [4, 5, 1], [3, 5, 1],
    [2, 3, 0.05],
  ];

  it("两个三角形被分成两簇", () => {
    const r = detectCommunities(6, edges, { seed: 1 });
    expect(r.count).toBe(2);
    expect(r.labels[0]).toBe(r.labels[1]);
    expect(r.labels[1]).toBe(r.labels[2]);
    expect(r.labels[3]).toBe(r.labels[4]);
    expect(r.labels[4]).toBe(r.labels[5]);
    expect(r.labels[0]).not.toBe(r.labels[3]);
  });

  it("模块度为正 —— 聚类确实比「全在一簇」更有结构", () => {
    expect(detectCommunities(6, edges, { seed: 1 }).modularity).toBeGreaterThan(0.3);
  });

  it("★ 同一输入两次结果逐字节一致(带种子的确定性)", () => {
    const many: Array<[number, number, number]> = [];
    for (let i = 0; i < 20; i++) many.push([i, (i + 1) % 20, 1], [i, (i + 3) % 20, 0.7], [i, (i + 7) % 20, 0.4]);
    const a = detectCommunities(20, many, { seed: 7 });
    const b = detectCommunities(20, many, { seed: 7 });
    expect(a.labels).toEqual(b.labels);
    expect(a.modularity).toBe(b.modularity);
  });

  it("不同种子允许给出不同划分 —— 说明洗牌真的接上了(不是没生效)", () => {
    const many: Array<[number, number, number]> = [];
    for (let i = 0; i < 24; i++) many.push([i, (i + 5) % 24, 1], [i, (i + 9) % 24, 0.9], [i, (i + 13) % 24, 0.5]);
    const outs = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => detectCommunities(24, many, { seed: s }).labels.join(",")));
    expect(outs.size).toBeGreaterThan(1);
  });

  it("社区 id 按簇大小降序、并列取最小成员下标(可复现, 不是内部编号)", () => {
    const r = detectCommunities(6, edges, { seed: 1 });
    const sizes = new Map<number, number>();
    for (const l of r.labels) sizes.set(l, (sizes.get(l) ?? 0) + 1);
    expect(sizes.get(0)).toBe(3);
    expect(sizes.get(1)).toBe(3);
  });

  it("分辨率调大 → 切得更碎(参数真的接到了目标函数上)", () => {
    const clique: Array<[number, number, number]> = [];
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) clique.push([i, j, 1]);
    const coarse = detectCommunities(8, clique, { resolution: 0.2, seed: 3 });
    const fine = detectCommunities(8, clique, { resolution: 3, seed: 3 });
    expect(fine.count).toBeGreaterThan(coarse.count);
    expect(fine.count).toBeGreaterThan(1);
  });

  it("边界: 空图 / 无边图 / 单点不崩", () => {
    expect(detectCommunities(0, []).count).toBe(0);
    const noEdge = detectCommunities(4, []);
    expect(noEdge.labels).toEqual([0, 1, 2, 3]);   // 各自一簇
    expect(noEdge.modularity).toBe(0);
    expect(detectCommunities(1, []).labels).toEqual([0]);
  });

  it("零/负权重不是边", () => {
    expect(buildAdjacency(2, [[0, 1, 0]])[0].size).toBe(0);
    expect(buildAdjacency(2, [[0, 1, -1]])[0].size).toBe(0);
  });

  it("★ 模块度公式自证: 全在一簇 ≈ 0, 与「没有划分」等价", () => {
    const adj = buildAdjacency(4, [[0, 1, 1], [1, 2, 0.2], [2, 3, 1]]);
    expect(modularityOf(4, adj, [0, 0, 0, 0])).toBeCloseTo(0, 6);
    // 同一张图按两个三角形切开 → 明显为正
    expect(modularityOf(4, adj, [0, 0, 1, 1])).toBeGreaterThan(0.2);
  });

  it("seededRng 同种子同序列, 值域 [0,1)", () => {
    const a = seededRng(42), b = seededRng(42);
    for (let i = 0; i < 20; i++) {
      const x = a(), y = b();
      expect(x).toBe(y);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 端到端图谱
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 三个话题、共 10 篇文档、措辞各不相同 —— 刻意做成"真实语料"的样子: 短句、每篇换说法、
 * 术语反复出现。
 * (用逐字相同的模板造语料时词表会被"模板胶水长片段"占满 —— 那是模板的锅不是分词的锅,
 *  会让测试去测一个不存在的场景。)
 */
const ZH_DOCS = [
  "乡村振兴战略以乡村治理为基础。资本下乡改变乡村治理格局。土地流转是乡村治理的关键环节。",
  "资本下乡与土地流转相互促进, 乡村治理因此转型。乡村振兴战略要求资本下乡规范有序。",
  "土地流转推动乡村振兴战略落地。乡村治理需要资本下乡与土地流转协同。",
  "乡村振兴战略与乡村治理一体推进。资本下乡改变土地流转方式。",
  "数字经济以数据要素为核心。平台经济依赖数据要素流动。产业组织形态因数字经济而变。",
  "数据要素驱动平台经济扩张。数字经济重塑产业组织。平台经济是数字经济的重要形态。",
  "产业组织变革源于数据要素的重新配置。数字经济与平台经济互为支撑。",
  "共同富裕要求收入分配制度更加公平。收入分配差距制约共同富裕进程。分配格局由分配制度决定。",
  "收入分配制度改革推进共同富裕。分配格局的调整依赖收入分配制度。共同富裕是分配制度的目标。",
  "分配制度与收入分配差距直接相关。共同富裕需要缩小收入分配差距。",
].map((text, i) => ({ id: `d${i}`, text }));

/**
 * 测试用的口径。minCount=3 是因为这份语料只有 10 篇 —— 生产默认是 2, 而语料越小越该抬高阈值:
 * 长片段(`乡村治理格局`)与小语料里"凑巧出现两次"的字组合(`与乡村`)在此一并被挡住。
 */
const ZH_OPTS = { minCount: 3, maxNodes: 60 } as const;

describe("图谱组装", () => {
  const net = buildKeywordNetwork(ZH_DOCS, "zh", ZH_OPTS);

  it("节点字段齐全、id 唯一、标签就是词本身", () => {
    expect(net.nodes.length).toBeGreaterThan(8);
    expect(new Set(net.nodes.map((n) => n.id)).size).toBe(net.nodes.length);
    for (const n of net.nodes) {
      expect(n.lang).toBe("zh");
      expect(n.weight).toBeGreaterThanOrEqual(ZH_OPTS.minCount);
      expect(n.cluster).toBeGreaterThanOrEqual(0);
      expect(n.label).toBe(n.id);
    }
  });

  it("★ 每条边的两端都在节点表里(前端渲染不会遇到悬空引用)", () => {
    const ids = new Set(net.nodes.map((n) => n.id));
    for (const e of net.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it("★ 每个节点的 cluster 都能在 clusters 里找到, size 与成员数一致, id 从 0 连续", () => {
    const sizeOf = new Map<number, number>();
    for (const n of net.nodes) sizeOf.set(n.cluster, (sizeOf.get(n.cluster) ?? 0) + 1);
    expect(net.clusters.length).toBe(sizeOf.size);
    for (const c of net.clusters) {
      expect(sizeOf.get(c.id)).toBe(c.size);
      expect(c.keywords.length).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
    expect(net.clusters.map((c) => c.id)).toEqual(net.clusters.map((_, i) => i));
  });

  it("词频不达标的长尾词被记在 dropped.rare 里, 不是悄悄消失", () => {
    const loose = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, minCount: 1 });
    expect(loose.dropped.rare).toBeGreaterThan(0);
    expect(loose.nodes.length).toBeGreaterThan(net.nodes.length);
  });

  it("maxNodes 是硬上限, 被截掉的数量进了 dropped", () => {
    const small = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, maxNodes: 5 });
    expect(small.nodes.length).toBeLessThanOrEqual(5);
    expect(small.dropped.rare + small.dropped.isolated).toBeGreaterThan(0);
  });

  it("topEdges 是硬上限, 被截掉的边数进了 dropped.edges", () => {
    const few = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, topEdges: 3 });
    expect(few.edges.length).toBeLessThanOrEqual(3);
    expect(few.dropped.edges).toBeGreaterThan(0);
  });

  it("孤立点不进图(没有边的词占着位置却不给信息)", () => {
    const loner = "碳达峰碳中和。碳达峰碳中和。碳达峰碳中和。";
    const withLoner = buildKeywordNetwork([...ZH_DOCS, { id: "x", text: loner }], "zh", ZH_OPTS);
    expect(withLoner.dropped.isolated).toBeGreaterThan(0);
    expect(withLoner.nodes.length).toBeLessThanOrEqual(net.nodes.length + 1);
  });

  it("★ 三个话题在结构上分开: 同话题的词同簇, 不同话题不同簇", () => {
    const clusterOf = (w: string) => net.nodes.find((n) => n.id === w)?.cluster;
    const groups = {
      乡村: ["乡村治理", "乡村振兴战略", "资本下乡", "土地流转"].map(clusterOf),
      // 平台经济/数据要素属于数字经济那个圈层 —— 它们与数字经济同簇才是对的
      数字: ["数字经济", "产业组织", "平台经济", "数据要素"].map(clusterOf),
      分配: ["共同富裕", "收入分配差距", "收入分配制度"].map(clusterOf),
    };

    for (const [topic, cls] of Object.entries(groups)) {
      expect(cls.every((c) => c !== undefined), `${topic} 的核心词都得进图`).toBe(true);
      expect(new Set(cls).size, `${topic} 的核心词应当同簇`).toBe(1);
    }
    // 三个话题簇两两不同
    expect(new Set(Object.values(groups).map((c) => c[0]!)).size).toBe(3);
  });

  it("★ 对着图算出的模块度为正(聚类不是在乱分)", () => {
    const idOf = new Map(net.nodes.map((n, i) => [n.id, i]));
    const tuple: Array<[number, number, number]> = net.edges.map((e) => [idOf.get(e.source)!, idOf.get(e.target)!, e.weight]);
    const q = modularityOf(net.nodes.length, buildAdjacency(net.nodes.length, tuple), net.nodes.map((n) => n.cluster));
    expect(q).toBeGreaterThan(0.3);
  });

  it("同一输入两次结果完全一致(JSON 逐字节)", () => {
    expect(JSON.stringify(buildKeywordNetwork(ZH_DOCS, "zh", ZH_OPTS)))
      .toBe(JSON.stringify(buildKeywordNetwork(ZH_DOCS, "zh", ZH_OPTS)));
  });

  it("空语料不崩, 给出空图", () => {
    const empty = buildKeywordNetwork([], "zh");
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.clusters).toEqual([]);
    expect(empty.docCount).toBe(0);
  });

  it("只有一篇文档也能出图(不要求跨文档共现)", () => {
    const one = buildKeywordNetwork([ZH_DOCS[0]], "zh", { minCount: 1 });
    expect(one.docCount).toBe(1);
    expect(one.edges.length).toBeGreaterThan(0);
  });

  it("★ 不传 measure 时默认是关联强度(jaccard), **不是**裸共现次数", () => {
    // 这条盯的是**默认值**。上面那条显式传了 measure, 默认值改成 count 它照样绿 ——
    // 反向验证时正是这里漏了一格(实测: 把默认值改成 count, 整组用例仍然全绿)。
    expect(net.measure).toBe("jaccard");
    const cnt = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, measure: "count" });
    for (const e of cnt.edges) expect(Number.isInteger(e.weight)).toBe(true);
    // 同一张图的边权分布口径不同: jaccard 落在 (0,1], count 是整数计数
    expect(net.edges.every((e) => e.weight > 0 && e.weight <= 1)).toBe(true);
    expect(net.edges[0].weight).not.toBe(cnt.edges[0].weight);
  });

  it("NPMI 口径: 比独立还差的词对(权重 ≤ 0)不进图", () => {
    const neg = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, measure: "pmi" });
    expect(neg.edges.length).toBeGreaterThan(0);
    for (const e of neg.edges) expect(e.weight).toBeGreaterThan(0);
  });

  it("★ 候选长度上限收紧后真的生效(长词与依赖它的剪枝一起变化)", () => {
    const long = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, maxTermLength: 6 });
    const short = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, maxTermLength: 4 });
    expect(short.nodes.every((n) => n.id.length <= 4)).toBe(true);
    expect(long.nodes.some((n) => n.id.length > 4)).toBe(true);
  });

  it("★ 切分后再剪一轮: `格局` 被 `分配格局` 吃掉(它只长在后者里面)", () => {
    // 第一轮剪枝用的是**候选重叠计数**(`分配格局` 出现 2 次时 `格局` 也记 2 次), 分不开谁是谁;
    // 切分之后 `格局` 的字数全部来自 `分配格局`, 两者最终词频相等, 那条判据才成立。
    // 少这一轮, 图里就会留下 `格局` `分配` 这类碎片 —— 它们进簇标签只会让人看不懂。
    const loose = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, minCount: 2 });
    expect(loose.nodes.some((n) => n.id === "分配格局")).toBe(true);
    expect(loose.nodes.some((n) => n.id === "格局")).toBe(false);
  });

  it("★ 已知边界: 更长形式被 minCount 挡掉时, 它里面的碎片会露出来", () => {
    // minCount=3 时 `分配格局`(2 次)进不了词表, 于是没有谁能吸收 `格局`。
    // 这是无词典方案的固有代价 —— 词表越小, 长形式越少, 碎片越容易活。
    // 生产默认 minCount=2(语料越大阈值越该抬), 这条把边界如实钉在这里, 别让它悄悄漂移。
    expect(net.nodes.some((n) => n.id === "格局")).toBe(true);
    const withStop = buildKeywordNetwork(ZH_DOCS, "zh", { ...ZH_OPTS, stopwords: ["格局"] });
    expect(withStop.nodes.some((n) => n.id === "格局")).toBe(false);
  });
});

describe("中英文两张图分开", () => {
  const docs = [
    { text: "乡村振兴战略与乡村治理相互支撑。资本下乡推动乡村治理转型。The rural governance and rural capital are linked." },
    { text: "乡村治理需要乡村振兴战略。Rural governance depends on rural institutions and rural capital." },
  ];
  const { zh, en } = buildBilingualNetworks(docs, { minCount: 1 });

  it("中文图里全是中文节点", () => {
    expect(zh.lang).toBe("zh");
    expect(zh.nodes.length).toBeGreaterThan(0);
    for (const n of zh.nodes) expect(/[A-Za-z]/.test(n.id)).toBe(false);
  });

  it("★ 英文图里全是英文节点, 且真的走了英文管线(rural 已词形还原)", () => {
    expect(en.lang).toBe("en");
    expect(en.nodes.length).toBeGreaterThan(0);
    for (const n of en.nodes) expect(/[一-鿿]/.test(n.id)).toBe(false);
    expect(en.nodes.some((n) => n.id === "rural")).toBe(true);
  });

  it("两张图的词表互不相交", () => {
    const zhIds = new Set(zh.nodes.map((n) => n.id));
    for (const n of en.nodes) expect(zhIds.has(n.id)).toBe(false);
  });

  it("只有英文语料时, 中文图是空的(不硬凑)", () => {
    const only = buildBilingualNetworks([{ text: "Rural governance and capital accumulation." }], { minCount: 1 });
    expect(only.zh.nodes.length).toBe(0);
    expect(only.en.nodes.length).toBeGreaterThan(0);
  });
});

describe("关键词入口(只有词、没有正文)", () => {
  it("★ 同一文档的关键词之间才有边; 跨文档不算共现", () => {
    const net = buildNetworkFromKeywords([
      { docId: "a", keywords: ["资本下乡", "乡村治理"] },
      { docId: "b", keywords: ["资本下乡", "乡村治理"] },
    ], "zh", { minCount: 1, maxTermLength: 4 });
    expect(net.edges.length).toBeGreaterThan(0);
    expect(net.docCount).toBe(2);
  });

  it("各自文档只有一个关键词 → 无边 → 空图(不硬连)", () => {
    const net = buildNetworkFromKeywords([
      { docId: "a", keywords: ["资本下乡"] },
      { docId: "b", keywords: ["乡村治理"] },
    ], "zh", { minCount: 1 });
    expect(net.edges).toEqual([]);
    expect(net.nodes).toEqual([]);
  });
});
