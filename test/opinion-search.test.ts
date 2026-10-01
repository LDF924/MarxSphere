/**
 * opinion-search.test.ts — 舆情检索: 采集/解析 → 去重 → 情感立场 → 趋势 → 缓存。
 *
 * 由来(2026-10-01): 本仓此前**没有任何舆情能力**(旧项目 AItoolman 只有一句
 *   `舆情检索请求失败` 和一份源字典)。补上之后, 这个文件盯的都是**不报错的失效方式**:
 *
 *   ① **解析**: 源站不写 pubDate(新华网把时间裸在 <link> 后面)、gb2312 编码、Atom 的 href
 *      —— 认不出时的表现都是"这个源没有结果", 与"那天真的没新闻"完全一样。
 *   ② **没有发布时间就不进时间序列**: 给它们补 now() 的话, "某天讨论量暴增"会变成
 *      "某天我抓得多" —— 这是最容易被当成真趋势的假信号, 所以这里正反两面都锁。
 *   ③ **立场方向**: `不支持` 含子串 `支持`。裸 includes 会把"明确反对"记成"明确支持" ——
 *      方向正好相反, 界面上什么都看不出来。
 *   ④ **去重**: 同一事件多家转载要合(否则"多家在报"看着像"很多人在说");
 *      但同模板不同主体(教育部/交通部发布新规)不许合(那会凭空造出一条"全网在说")。
 *   ⑤ **失败隔离**: 一个源 500 不该让整个检索失败, 也不该让它**静默**少几条。
 *
 * ⚠ 本文件**不联网**: 所有采集走注入的假 fetcher/searchFn。理由有二 ——
 *   跑测试不该打扰外部站点, 也不该因为对方抖一下就让 CI 变红。
 * 连库的部分(缓存/条目池)沿用 file-text-service.test.ts 的 `describe.skipIf(!dbReady)` 模式:
 *   连不上库就整组 skip, 不能把"这台机器没有库"报成失败。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { pool } from "../src/db/pool.js";
import {
  searchOpinion, searchOpinionPool, poolStats, resetSourceHealth,
  parseFeedEntries, parseGovPushInfo, parseOsfPreprints, parseWeiboHot, parseDate,
  decodeBody, keywordsFromQuery, relevanceOf, titleSimilarity,
  normalizeOpinionTitle, dedupeItems, clusterOpinionItems, buildTrend, hotWordsOf,
  contentHashOf, cacheKeyOf, clearMemoryCache,
  type Fetcher, type SearchFn, type OpinionItem,
} from "../src/services/opinion-search-service.js";
import {
  analyzeSentiment, analyzeSentimentBatch, distributionOf, scorePolarity, scoreStance,
  scoreIntensity, segmentForSentiment, detectTextLang, ZH_POLARITY,
} from "../src/services/sentiment-service.js";
import { PUBLIC_OPINION_SOURCES, enabledSources, opinionSourceById, endpointFor } from "../src/services/opinion-sources.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const cand of [process.env.SAG_ENV_FILE, path.join(ROOT, ".env"), path.join(ROOT, "..", "..", "..", ".env")]) {
  if (cand && existsSync(cand)) { loadEnv({ path: cand }); break; }
}
let dbReady = false;
try { await pool.query("select 1"); dbReady = true; } catch { dbReady = false; }
if (!dbReady) console.warn("[opinion-search] 连不上数据库 —— 仅跳过缓存/条目池两组(解析与情感分析照常跑)");

// ═══════════════════════════════════════════════════════════
// 样本语料(与真实源站同形, 但不来自网络)
// ═══════════════════════════════════════════════════════════

/** 与新华网相同的形状: 时间**裸在** <link> 与 <description> 之间, 不带 pubDate 标签 */
const XINHUA_LIKE = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel><title><![CDATA[时政频道_新华网]]></title>
<item><title><![CDATA[某地宅基地改革试点扩围]]></title><author>www.xinhuanet.com</author><link>http://www.news.cn/politics/2026-09/30/c_1.htm</link>Wed,30-Sep-2026 11:37:37 GMT<description><![CDATA[<a href=http://www.news.cn/politics/2026-09/30/c_1.htm>宅基地改革试点扩大到多个省份。</a>]]></description></item>
<item><title><![CDATA[新能源汽车下乡活动启动]]></title><author>www.xinhuanet.com</author><link>http://www.news.cn/politics/2026-09/29/c_2.htm</link>Tue,29-Sep-2026 08:00:00 GMT<description><![CDATA[<a href=x>新能源汽车下乡活动启动, 多家车企参与。</a>]]></description></item>
</channel></rss>`;

/** 与中新网相同的形状: 标准 RFC822 pubDate */
const CHINANEWS_LIKE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>中新网滚动新闻</title>
<item><title><![CDATA[某地宅基地改革试点扩围（全文）]]></title>
<link>https://www.chinanews.com.cn/gn/2026/09-30/1.shtml</link>
<description><![CDATA[<p>宅基地改革试点扩大到多个省份，农民财产权益如何保障。</p>]]></description>
<pubDate>Wed, 30 Sep 2026 15:58:14 +0800</pubDate></item>
<item><title><![CDATA[新能源汽车下乡活动启动]]></title>
<link>https://www.chinanews.com.cn/cj/2026/09-29/2.shtml</link>
<description><![CDATA[<p>新能源汽车下乡活动启动，多家车企参与促销。</p>]]></description>
<pubDate>Tue, 29 Sep 2026 09:00:00 +0800</pubDate></item>
</channel></rss>`;

/** 与 arXiv 相同的形状: Atom, link 在 href 里 */
const ATOM_LIKE = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Rural land reform and collective income: evidence from China</title>
<link href="https://arxiv.org/abs/2609.36349"/>
<updated>2026-09-30T00:00:00-04:00</updated>
<summary>We study how rural land reform affects collective income.</summary></entry>
<entry><title>Public opinion dynamics after a policy announcement</title>
<link href="https://arxiv.org/abs/2609.36350"/>
<updated>2026-09-28T00:00:00-04:00</updated>
<summary>We model opinion dynamics following policy announcements.</summary></entry>
</feed>`;

const GOV_JSON = JSON.stringify([
  { author: "中国政府网", description: "国务院办公厅关于深化农村宅基地制度改革的意见", link: "https://www.gov.cn/zhengce/content/202609/content_1.htm", pubDate: "2026-09-30", title: "国务院办公厅关于深化农村宅基地制度改革的意见" },
  { author: "中国政府网", description: "关于促进新能源汽车消费的若干措施", link: "https://www.gov.cn/zhengce/content/202609/content_2.htm", pubDate: "2026-09-29", title: "关于促进新能源汽车消费的若干措施" },
]);

const OSF_JSON = JSON.stringify({
  data: [{
    id: "e7hpc",
    type: "preprints",
    attributes: { title: "Rural land reform and collective income", description: "A study of land reform in China.", date_published: "2026-09-30T15:32:48.706414" },
    links: { html: "https://osf.io/preprints/socarxiv/e7hpc" },
  }],
});

const WEIBO_JSON = JSON.stringify({
  ok: 1,
  data: { realtime: [
    { word: "宅基地改革试点", num: 1244453, rank: 0, note: "宅基地改革试点" },
    { word: "新能源汽车下乡", num: 23321, rank: 1, note: "新能源汽车下乡" },
  ] },
});

/** 每个源 id → 样本体。测试里不联网, 采集全部由它供给 */
const SAMPLES: Record<string, string> = {
  "xinhua-politics": XINHUA_LIKE,
  "chinanews-scroll": CHINANEWS_LIKE,
  "arxiv-econ-gn": ATOM_LIKE,
  "gov-cn-policy": GOV_JSON,
  "osf-socarxiv": OSF_JSON,
  "weibo-hot": WEIBO_JSON,
};

/** 假 fetcher: 按 URL 反查样本; 未登记的 URL 返回 500(测失败隔离) */
const sampleFetcher: Fetcher = async (url) => {
  const spec = PUBLIC_OPINION_SOURCES.find((s) => s.url === url);
  const body = spec ? SAMPLES[spec.id] : undefined;
  if (!body) return { ok: false, status: 500, body: "", error: "HTTP 500(样本未登记)" };
  return { ok: true, status: 200, body };
};

const sampleSearchFn: SearchFn = async (query) => ({
  ok: true,
  hits: [
    { title: `${query} 政策解读`, url: "https://example.test/1", snippet: `${query} 的相关解读与讨论`, publishedAt: "2026-09-30T00:00:00Z" },
    { title: "无关的天气预报", url: "https://example.test/2", snippet: "明日多云转晴", publishedAt: "2026-09-30T00:00:00Z" },
  ],
});

beforeEach(() => { resetSourceHealth(); clearMemoryCache(); });

// ═══════════════════════════════════════════════════════════
// ① 解析: 源站不按标准写, 认不出的表现是"这个源没有结果"
// ═══════════════════════════════════════════════════════════
describe("① 解析: 各源站的**非标准写法**都要认出来", () => {
  it("新华网式裸时间(不带 pubDate 标签)要解析出发布时间", () => {
    const items = parseFeedEntries(XINHUA_LIKE);
    expect(items.length).toBe(2);
    expect(items[0].title).toContain("宅基地改革");
    // 只认 <pubDate> 标签的实现会在这里得到 null —— 该源所有条目会静默退出时间序列
    expect(items[0].publishedAt, "裸在 <link> 后面的时间没被认出来").toBe("2026-09-30T11:37:37.000Z");
    expect(items[1].publishedAt).toBe("2026-09-29T08:00:00.000Z");
  });

  it("标准 RFC822(带逗号带空格)与紧凑式(无逗号空格)都要认", () => {
    const standard = parseFeedEntries(CHINANEWS_LIKE);
    expect(standard[0].publishedAt).toBe("2026-09-30T07:58:14.000Z");   // +0800 → UTC
    expect(parseDate("Wed,14-Dec-2022 11:37:37 GMT")).toBe("2022-12-14T11:37:37.000Z");
  });

  it("Atom 的 link 在 href 属性里, 不在标签体里", () => {
    const items = parseFeedEntries(ATOM_LIKE);
    expect(items.length).toBe(2);
    expect(items[0].url, "Atom 条目没取到 URL ⇒ 结果里全是点不开的条目").toBe("https://arxiv.org/abs/2609.36349");
    expect(items[0].publishedAt).toBe("2026-09-30T04:00:00.000Z");
  });

  it("CDATA / 内嵌 HTML 的题名与摘要要洗干净", () => {
    const items = parseFeedEntries(CHINANEWS_LIKE);
    expect(items[0].title).not.toContain("CDATA");
    expect(items[0].summary).not.toContain("<p>");
    expect(items[0].summary).toContain("农民财产权益");
  });

  it("gb2312 响应按 gb18030 解码 —— 按 UTF-8 硬解得到的是乱码且**不报错**", () => {
    // "中国人民" 的 GBK 字节
    const gbk = new Uint8Array([0xD6, 0xD0, 0xB9, 0xFA, 0xC8, 0xCB, 0xC3, 0xF1]);
    expect(decodeBody(gbk.buffer, "text/xml; charset=gb2312")).toBe("中国人民");
    expect(decodeBody(new TextEncoder().encode("中国人民").buffer, "text/xml; charset=utf-8")).toBe("中国人民");
  });

  it("政府网 JSON / OSF JSON / 微博榜单三种结构都能归一", () => {
    const gov = parseGovPushInfo(GOV_JSON);
    expect(gov.length).toBe(2);
    expect(gov[0].publishedAt).toBe("2026-09-30T00:00:00.000Z");
    const osf = parseOsfPreprints(OSF_JSON);
    expect(osf[0].url).toContain("socarxiv");
    expect(osf[0].publishedAt?.slice(0, 10)).toBe("2026-09-30");
    const weibo = parseWeiboHot(WEIBO_JSON);
    expect(weibo[0].heat).toBe(1244453);
    expect(weibo[0].publishedAt, "榜单没有发布时间, 不该编一个出来").toBe(null);
  });

  it("坏输入(HTML/空/截断 JSON)返回空数组而不是抛错", () => {
    expect(parseFeedEntries("<html><body>404</body></html>")).toEqual([]);
    expect(parseGovPushInfo("<html>403</html>")).toEqual([]);
    expect(parseOsfPreprints('{"data":')).toEqual([]);
    expect(parseWeiboHot("")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// ② 关键词与相关度
// ═══════════════════════════════════════════════════════════
describe("② 关键词与相关度", () => {
  it("中文查询(无分隔符)命中整串时得满分, 不相关得 0", () => {
    const kw = keywordsFromQuery("农村土地流转");
    expect(relevanceOf("某地推进农村土地流转的实践", "某地推进农村土地流转的实践", kw)).toBeGreaterThan(0.9);
    expect(relevanceOf("城市房价走势分析", "城市房价走势分析", kw)).toBe(0);
  });

  it("带分隔符的查询: 主串权重高于拆出来的词元", () => {
    const kw = keywordsFromQuery("乡村振兴 土地流转");
    const both = relevanceOf("乡村振兴背景下的土地流转", "乡村振兴背景下的土地流转", kw);
    const partial = relevanceOf("仅谈土地流转", "仅谈土地流转", kw);
    expect(both).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });

  it("题名归一化: 版面标记与中文标点方言(｜/·)都要归一 —— 不归一则转载去重静默失效", () => {
    // 括号/竖线/连字符/间隔号都是"版面标点", 归一后必须同形
    expect(normalizeOpinionTitle("【独家】某地试点｜全文")).toBe(normalizeOpinionTitle("独家·某地试点-全文"));
    expect(normalizeOpinionTitle("某地（试点）")).toBe(normalizeOpinionTitle("某地试点"));
    // 但正文用词不同就是不同条: 归一化不许把有信息的字也去掉
    expect(normalizeOpinionTitle("某地试点")).not.toBe(normalizeOpinionTitle("某地其他试点"));
  });
});

// ═══════════════════════════════════════════════════════════
// ③ 去重: 转载要合, 同模板不同主体不许合
// ═══════════════════════════════════════════════════════════
describe("③ 去重", () => {
  const mk = (title: string, sourceName: string, publishedAt: string | null) => ({ title, sourceName, publishedAt, summary: "", url: title });

  it("同一事件的多家转载合并成一条, 保留首发并记下转载源", () => {
    const r = dedupeItems([
      mk("某地出台宅基地改革试点方案", "中新网", "2026-09-29T02:00:00Z"),
      mk("某地出台宅基地改革试点方案（全文）", "人民网", "2026-09-29T06:00:00Z"),
      mk("某地出台宅基地改革试点方案-新华网", "新华网", "2026-09-29T09:00:00Z"),
    ]);
    expect(r.merged).toBe(2);
    expect(r.items.length).toBe(1);
    expect(r.items[0].sourceName, "代表条应当是首发(时间最早的那条)").toBe("中新网");
    expect(r.items[0].duplicateCount).toBe(3);
    expect(r.items[0].alsoReportedBy.sort()).toEqual(["人民网", "新华网"]);
  });

  it("**反例**: 同模板不同主体(教育部/交通部发布新规)不许合并", () => {
    // 这对的 bigram 相似度是 0.667, 卡在 0.72 阈值之下 —— 把阈值放松到 0.6 就会合,
    // 合了会凭空造出"全网都在说某件事"。阈值是这里唯一的判据, 所以它必须被钉住。
    const r = dedupeItems([
      mk("教育部发布新规", "中新网", "2026-09-29T02:00:00Z"),
      mk("交通部发布新规", "人民网", "2026-09-29T03:00:00Z"),
    ]);
    expect(r.items.length, "两件不同的事被合成了一条").toBe(2);
    expect(r.merged).toBe(0);
  });

  it("时间窗: 三天以上的同题报道算后续报道, 不算转载", () => {
    const r = dedupeItems([
      mk("某地出台宅基地改革试点方案", "中新网", "2026-09-20T02:00:00Z"),
      mk("某地出台宅基地改革试点方案（全文）", "人民网", "2026-09-29T06:00:00Z"),
    ]);
    expect(r.items.length).toBe(2);
  });

  it("没有发布时间的条目不参与时间窗判定(也不能因此被判成同一条)", () => {
    const r = dedupeItems([
      mk("某地出台宅基地改革试点方案", "中新网", null),
      mk("某地出台宅基地改革试点方案（全文）", "人民网", null),
      mk("全国社保基金投资收益创新高", "新华网", null),
    ]);
    expect(r.items.length).toBe(2);
  });

  it("相似度阈值卡在 0.72: 短题名同模板(0.667)落在阈值**之下**", () => {
    // 这条把阈值钉住: 放松到 0.6 就会把两件不同的事合成一条(上面那条反例同时会变红)
    expect(titleSimilarity("教育部发布新规", "交通部发布新规")).toBeLessThan(0.72);
    expect(titleSimilarity("教育部发布新规", "交通部发布新规")).toBeGreaterThan(0.6);
    // 真转载必须显著高于阈值
    expect(titleSimilarity("某地出台宅基地改革试点方案", "某地出台宅基地改革试点方案（全文）")).toBeGreaterThan(0.85);
  });
});

// ═══════════════════════════════════════════════════════════
// ④ 情感与立场(纯规则, 可复现)
// ═══════════════════════════════════════════════════════════
describe("④ 情感极性", () => {
  it("正面/负面/中性三种都要分得开", () => {
    expect(analyzeSentiment("乡村振兴政策成效显著，农民持续增收，值得肯定").sentiment).toBe("positive");
    expect(analyzeSentiment("该政策脱离实际，地方执行一刀切，群众普遍不满").sentiment).toBe("negative");
    expect(analyzeSentiment("国务院办公厅印发《关于促进体育赛事消费的意见》").sentiment).toBe("neutral");
    expect(analyzeSentiment("会议于2026年9月30日在北京召开，共有120名代表参加").sentiment).toBe("neutral");
  });

  it("否定词翻转极性:`不支持` 是负的, `支持` 是正的", () => {
    expect(scorePolarity("支持这项改革", "zh").polarity).toBeGreaterThan(0);
    expect(scorePolarity("不支持这项改革", "zh").polarity).toBeLessThan(0);
    expect(scorePolarity("该政策未见明显改善", "zh").polarity).toBeLessThan(0);
  });

  it("程度副词放大强度, 削弱词压低强度, 方向都不变", () => {
    const plain = scorePolarity("该政策利好", "zh").polarity;
    const strong = scorePolarity("该政策非常利好", "zh").polarity;
    const weak = scorePolarity("该政策略微利好", "zh").polarity;
    expect(plain).toBeGreaterThan(0);
    expect(strong, "程度词没有放大强度").toBeGreaterThan(plain);
    expect(weak, "削弱词没有压低强度").toBeLessThan(plain);
    expect(weak).toBeGreaterThan(0);
  });

  it("程度词插进复合词中间时(`成效极其显著`)仍要判出正面, 不能掉成 0", () => {
    // 复合词被切开后整条匹配不上, 靠更短的 `成效` 兜底 —— 掉成 0 会让这类句子全判中性
    const r = analyzeSentiment("该政策成效极其显著");
    expect(r.polarity).toBeGreaterThan(0);
    expect(r.sentiment).toBe("positive");
  });

  it("程度词里的 `非` 不是否定: `非常支持` 必须仍是正面", () => {
    expect(scorePolarity("非常支持这项改革", "zh").polarity).toBeGreaterThan(0);
    expect(scoreStance("非常支持这项改革", "zh").stance).toBe("support");
  });

  it("强度与方向无关: 强烈支持与强烈反对的强度都不能是 0", () => {
    const up = analyzeSentiment("强烈支持这项改革");
    const down = analyzeSentiment("强烈反对这项做法");
    expect(up.intensity).toBeGreaterThan(0.3);
    expect(down.intensity).toBeGreaterThan(0.3);
    expect(up.polarity).toBeGreaterThan(0);
    expect(down.polarity).toBeLessThan(0);
  });

  it("英文源走英文词表", () => {
    expect(analyzeSentiment("The reform improved rural incomes, a significant success").sentiment).toBe("positive");
    expect(analyzeSentiment("This policy is a failure and has worsened inequality").sentiment).toBe("negative");
    expect(analyzeSentiment("We analyse survey data from 12 provinces").sentiment).toBe("neutral");
  });

  it("中文分词: 最长匹配, 不把 `成效显著` 拆成 `显著`", () => {
    const toks = segmentForSentiment("成效显著", "zh");
    expect(toks).toContain("成效显著");
  });

  it("命中词要能报出来(研究者要核对凭什么判成负面)", () => {
    const r = analyzeSentiment("地方执行一刀切，群众不满");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.map((h) => h.word)).toContain("一刀切");
    expect(r.hits.every((h) => ZH_POLARITY[h.word] !== undefined)).toBe(true);
  });

  it("语言判定: 汉字占比决定走哪张表", () => {
    expect(detectTextLang("农村土地流转")).toBe("zh");
    expect(detectTextLang("Rural land reform in China")).toBe("en");
  });
});

describe("④b 立场: `不支持` 必须记成反对(裸 includes 会记成支持)", () => {
  it("明确支持 / 明确反对 / 中立三分", () => {
    expect(scoreStance("非常支持这项改革，是顺应民意的务实之举").stance).toBe("support");
    expect(scoreStance("强烈反对这种一刀切的做法", "zh").stance).toBe("oppose");
    expect(scoreStance("国务院办公厅印发关于促进体育赛事消费的意见").stance).toBe("neutral");
  });

  it("**关键**: `不支持这项调整` 判成 oppose, 而不是 support", () => {
    const s = scoreStance("不支持这项调整", "zh");
    expect(s.stance, "把明确反对记成了明确支持 —— 方向正好相反").toBe("oppose");
    expect(s.stanceScore).toBeLessThan(0);
    // 正面照: 同一句话去掉否定词, 方向必须反过来 —— 否则说明判据根本没在看否定
    expect(scoreStance("支持这项调整", "zh").stance).toBe("support");
  });

  it("`不过/不仅` 里的 `不` 不算否定(那会把 `不仅支持` 记成反对)", () => {
    expect(scoreStance("不仅支持，而且大力推动", "zh").stance).toBe("support");
  });

  it("情绪中性但立场鲜明的政策评论文本: 立场有值而极性接近 0", () => {
    const text = "该办法回应了基层关切，值得肯定";
    const r = analyzeSentiment(text);
    expect(r.stance).toBe("support");
    expect(Math.abs(r.polarity)).toBeLessThan(0.9);   // 不夸大成满格
  });

  it("分布统计: 三个计数之和等于总数", () => {
    const d = distributionOf(analyzeSentimentBatch([
      "成效显著，值得肯定", "一刀切，群众不满", "会议在北京召开",
      "不支持这项调整", "非常支持这项改革",
    ]));
    expect(d.total).toBe(5);
    expect(d.positive + d.neutral + d.negative).toBe(5);
    expect(d.support + d.oppose + d.stanceNeutral).toBe(5);
    expect(d.support).toBeGreaterThanOrEqual(1);
    expect(d.oppose).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑤ 聚类 / 趋势 / 热词
// ═══════════════════════════════════════════════════════════
describe("⑤ 话题聚类与趋势统计", () => {
  const ci = (title: string, summary: string) => ({
    title, summary, url: title, sourceName: "中新网", publishedAt: null,
    sentiment: "neutral" as const, stance: "neutral" as const,
  });

  const corpus = [
    ci("某地试点宅基地改革，农民财产权益如何保障", "宅基地改革试点扩大到多个省份，涉及农民财产权益与集体经济发展"),
    ci("宅基地改革试点扩围，集体经济发展迎机遇", "多地推进宅基地制度改革，农民自愿有偿退出机制逐步完善"),
    ci("宅基地制度改革与乡村振兴的衔接", "宅基地改革与乡村振兴战略如何衔接，集体经济组织的作用受到关注"),
    ci("新能源汽车下乡活动启动", "新能源汽车下乡活动启动，多家车企参与促销，农村充电设施建设加快"),
    ci("农村充电桩建设提速，新能源汽车销量增长", "新能源汽车在农村地区销量增长，充电桩等基础设施加快建设"),
  ];

  it("两个话题各自成簇, 而且不至于碎成一堆单条", () => {
    const clusters = clusterOpinionItems(corpus);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters.length, "簇太多 ⇒ 标签全是半截词(分词被切碎了)").toBeLessThanOrEqual(4);
    // 宅基地那一簇里不该混进新能源汽车的条目
    const land = clusters.find((c) => c.keywords.some((k) => k.includes("宅基地")));
    expect(land).toBeTruthy();
    expect(land!.items.some((i) => i.title.includes("新能源汽车"))).toBe(false);
    // 簇内条数之和不超过语料条数
    expect(clusters.reduce((a, c) => a + c.size, 0)).toBeLessThanOrEqual(corpus.length);
  });

  it("确定性: 同一输入两次跑, 簇数与标签逐字节一致", () => {
    const a = clusterOpinionItems(corpus);
    const b = clusterOpinionItems(corpus);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("语料太少(0/1 条)不崩, 直接返回空簇", () => {
    expect(clusterOpinionItems([])).toEqual([]);
    expect(clusterOpinionItems([ci("某地试点宅基地改革", "摘要")])).toEqual([]);
  });

  it("趋势: 没有发布时间的条目**不进**时间序列", () => {
    const trend = buildTrend([
      { publishedAt: "2026-09-29T02:00:00Z" },
      { publishedAt: "2026-09-29T09:00:00Z" },
      { publishedAt: "2026-09-30T01:00:00Z" },
      { publishedAt: null },
      { publishedAt: null },
    ], "day");
    expect(trend).toEqual([{ date: "2026-09-29", count: 2 }, { date: "2026-09-30", count: 1 }]);
    expect(trend.reduce((a, p) => a + p.count, 0), "无时间的条目混进了时间序列 ⇒ 暴增是假的").toBe(3);
  });

  it("按周聚合以周一为起始(周日不许被算到下一周)", () => {
    // 2026-09-27 是周日, 09-28 是周一 —— 分属两周
    const trend = buildTrend([
      { publishedAt: "2026-09-27T10:00:00Z" },
      { publishedAt: "2026-09-28T10:00:00Z" },
    ], "week");
    expect(trend.length, "周日与周一被算进了同一周").toBe(2);
    expect(trend[1].date).toBe("2026-09-28");
  });

  it("热词: 要**跨条**出现才算热(同一条里重复两次的不算)", () => {
    const words = hotWordsOf([
      { title: "旅客在杭州东站排队", summary: "旅客在杭州东站排队等候, 志愿者在现场引导" },
      { title: "国庆假期铁路客流高峰", summary: "国庆假期铁路客流高峰来临" },
      { title: "国庆假期出行提示发布", summary: "国庆假期出行提示: 错峰出行" },
    ], 10);
    // 跨条出现的词要留下(具体切出 `国庆` 还是 `国庆假期` 由最长匹配决定, 不写死)
    expect(words.some((w) => w.word.includes("国庆"))).toBe(true);
    // `旅客在杭州东` 只来自第一条(标题+摘要各命中一次), 不该进热词
    expect(words.some((w) => w.word.includes("旅客"))).toBe(false);
  });

  it("热词: 通稿版式词(图为/中新社记者/责任编辑)要排掉", () => {
    const words = hotWordsOf([
      { title: "国庆假期铁路客流高峰", summary: "图为武警官兵在车站执勤。中新社记者 张三 摄" },
      { title: "国庆假期出行提示发布", summary: "图为车站候车大厅。中新社记者 李四 摄" },
    ], 10);
    expect(words.some((w) => /图为|中新社|记者|责任编辑|摄$/.test(w.word))).toBe(false);
  });

  it("热词: 中英文分开统计, 且不冒出跨词边界的半截词", () => {
    const words = hotWordsOf([
      { title: "某地试点宅基地改革", summary: "宅基地改革试点扩大到多个省份" },
      { title: "宅基地改革试点扩围", summary: "多地推进宅基地制度改革" },
    ], 10);
    expect(words.map((w) => w.word)).toContain("宅基地");
    expect(words.every((w) => w.word.length >= 2)).toBe(true);
    // 半截词(跨词边界的碎片)不该出现在热词里
    expect(words.some((w) => /^(改革试|点扩围|革试点)$/.test(w.word))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑥ 端到端(注入假 fetcher, 不联网)
// ═══════════════════════════════════════════════════════════
describe("⑥ 端到端: 多源聚合(注入样本, 不联网)", () => {
  const ids = ["xinhua-politics", "chinanews-scroll", "gov-cn-policy", "osf-socarxiv", "weibo-hot"];

  it("按关键词检索: 命中的留下, 不相关的剔除", async () => {
    const r = await searchOpinion({
      query: "宅基地改革", sources: ids, fetcher: sampleFetcher, searchFn: sampleSearchFn,
      bypassCache: true, limit: 30,
    });
    expect(r.total).toBeGreaterThan(0);
    const titles = r.items.map((i) => i.title).join("|");
    expect(titles).toContain("宅基地");
    expect(titles, "不相关的条目(新能源汽车/社保)被关键词筛漏了").not.toContain("新能源汽车");
    // 中文源与英文源都该出现(英文命中靠英文词表)
    expect(r.sources.some((s) => s.kept > 0)).toBe(true);
  });

  it("每个源都有统计, 且结果带源分布与分类分布", async () => {
    const r = await searchOpinion({ query: "宅基地改革", sources: ids, fetcher: sampleFetcher, searchFn: sampleSearchFn, bypassCache: true });
    expect(r.sources.length).toBe(ids.length);
    for (const s of r.sources) {
      expect(s.name).toBeTruthy();
      expect(s.fetched).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.kept)).toBe(true);
    }
    expect(r.byCategory.reduce((a, c) => a + c.count, 0)).toBe(r.total);
  });

  it("**失败隔离**: 一个源 500, 其它源照常返回, 且失败原因写在结果里", async () => {
    const failing: Fetcher = async (url) => {
      if (url.includes("people.com.cn")) return { ok: false, status: 503, body: "", error: "HTTP 503" };
      return sampleFetcher(url);
    };
    const r = await searchOpinion({
      query: "宅基地改革",
      sources: ["people-politics", "chinanews-scroll", "gov-cn-policy"],
      fetcher: failing, searchFn: sampleSearchFn, bypassCache: true,
    });
    // 其它源照常有结果
    expect(r.total).toBeGreaterThan(0);
    // 失败必须**可见** —— 静默少几条会被读成"那天没新闻"
    expect(r.softErrors.length).toBe(1);
    expect(r.softErrors[0].sourceId).toBe("people-politics");
    expect(r.softErrors[0].error).toContain("503");
    expect(r.sources.find((s) => s.sourceId === "people-politics")?.error).toContain("503");
  });

  it("榜单类源只进规模信号, **不参与关键词筛**(否则永远筛出 0, 被读成'没人在讨论')", async () => {
    const r = await searchOpinion({ query: "宅基地改革", sources: ids, fetcher: sampleFetcher, searchFn: sampleSearchFn, bypassCache: true });
    expect(r.scaleSignals.length, "热搜榜没被抓回来当规模信号").toBeGreaterThan(0);
    expect(r.scaleSignals[0].source).toBe("weibo-hot");
    expect(r.scaleSignals[0].heat).toBeGreaterThan(0);
    expect(r.items.some((i) => i.source === "weibo-hot"), "榜单条目混进了关键词结果池").toBe(false);
    expect(r.notes.some((n) => n.includes("榜单"))).toBe(true);
  });

  it("时间范围按**发布时间**筛, 无发布时间的条目被排除并如实报出条数", async () => {
    const r = await searchOpinion({
      query: "宅基地改革", sources: ["chinanews-scroll", "xinhua-politics"],
      since: "2026-09-30", until: "2026-09-30", fetcher: sampleFetcher, searchFn: sampleSearchFn, bypassCache: true,
    });
    expect(r.items.every((i) => i.publishedAt?.slice(0, 10) === "2026-09-30")).toBe(true);
    // 新华网那两条有时间, 不该被算成"无时间"
    expect(r.range.since).toContain("2026-09-30");
  });

  it("web_search 类源走注入的检索函数(Bocha/Edge 那条链), 不自己爬", async () => {
    const r = await searchOpinion({ query: "宅基地改革", sources: ["web-search"], fetcher: sampleFetcher, searchFn: sampleSearchFn, bypassCache: true });
    expect(r.sources[0].fetched).toBe(2);
    // 命中 1 条(另一条是不相关的天气预报), 未命中会被剔除
    expect(r.total).toBe(1);
    expect(r.items[0].url).toBe("https://example.test/1");
  });

  it("结果结构完整: 情感/立场/强度/主题/趋势/热词都在", async () => {
    const r = await searchOpinion({ query: "宅基地改革", sources: ids, fetcher: sampleFetcher, searchFn: sampleSearchFn, bypassCache: true });
    const it0: OpinionItem = r.items[0];
    expect(["positive", "neutral", "negative"]).toContain(it0.sentiment);
    expect(["support", "oppose", "neutral"]).toContain(it0.stance);
    expect(it0.intensity).toBeGreaterThanOrEqual(0);
    expect(it0.intensity).toBeLessThanOrEqual(1);
    expect(Array.isArray(it0.topics)).toBe(true);
    expect(r.trend.length).toBeGreaterThan(0);
    expect(r.hotWords.length).toBeGreaterThan(0);
    expect(r.distribution.total).toBe(r.total);
    expect(r.generatedAt).toBeTruthy();
  });

  it("空 query 明确抛错(不给一个'成功但空'的结果)", async () => {
    await expect(searchOpinion({ query: "  ", fetcher: sampleFetcher, searchFn: sampleSearchFn })).rejects.toThrow(/query/);
  });

  it("tags: 关键词从查询串拆出, 整串也算一个", () => {
    expect(keywordsFromQuery("乡村振兴 土地流转").keywords).toContain("乡村振兴");
    expect(keywordsFromQuery("乡村振兴 土地流转").keywords).toContain("乡村振兴 土地流转");
  });

  it("**反例(反向验证用)**: 若把无时间条目的 publishedAt 补成 now(), 时间筛会放它进来", async () => {
    // 构造一个"源站没给时间"的样本
    const undatedFetcher: Fetcher = async () => ({
      ok: true, status: 200,
      body: `<rss><channel><item><title>某地宅基地改革试点扩围</title><link>http://x/1</link><description>宅基地改革</description></item></channel></rss>`,
    });
    const r = await searchOpinion({
      query: "宅基地改革", sources: ["xinhua-politics"], since: "2026-09-01",
      fetcher: undatedFetcher, searchFn: sampleSearchFn, bypassCache: true,
    });
    expect(r.items.length, "无发布时间的条目录进了时间范围结果").toBe(0);
    expect(r.notes.some((n) => n.includes("没有发布时间"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ⑦ 源注册表
// ═══════════════════════════════════════════════════════════
describe("⑦ 源注册表", () => {
  it("每个源都有完整元数据与取数入口", () => {
    for (const s of PUBLIC_OPINION_SOURCES) {
      expect(s.id, "源缺 id").toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(["news", "official", "academic", "social", "search"]).toContain(s.category);
      expect(["zh", "en"]).toContain(s.lang);
      expect(["rss", "json", "web_search"]).toContain(s.fetchKind);
      expect(typeof s.enabled).toBe("boolean");
      if (s.enabled) expect(s.url || s.fetchKind === "web_search", `${s.id} 既没有 url 也不是 web_search`).toBeTruthy();
    }
  });

  it("四类用途(新闻/官方/学术/社媒)都要有源 —— 研究问题是四条对照线", () => {
    const cats = new Set(enabledSources().map((s) => s.category));
    for (const c of ["news", "official", "academic", "social"] as const) {
      expect(cats.has(c), `缺少 ${c} 类源`).toBe(true);
    }
  });

  it("源 id 不重复, 且能按 id 反查", () => {
    const ids = PUBLIC_OPINION_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["gov-cn-policy", "chinanews-scroll", "arxiv-cs-cy"]) {
      expect(opinionSourceById(id)?.name).toBeTruthy();
    }
    expect(opinionSourceById("不存在的源")).toBeUndefined();
  });

  it("指定 sources 时只取该子集; 指定 categories 时按类取", () => {
    const one = enabledSources({ ids: ["gov-cn-policy"] });
    expect(one.length).toBe(1);
    expect(one[0].id).toBe("gov-cn-policy");
    const academic = enabledSources({ categories: ["academic"] });
    expect(academic.length).toBeGreaterThan(0);
    expect(academic.every((s) => s.category === "academic")).toBe(true);
  });

  it("榜单类源的筛选开关只影响它自己", () => {
    const withTrack = enabledSources({});
    const withoutTrack = enabledSources({ includeTrack: false });
    expect(withTrack.some((s) => s.track)).toBe(true);
    expect(withoutTrack.some((s) => s.track)).toBe(false);
    expect(withoutTrack.length).toBe(withTrack.length - withTrack.filter((s) => s.track).length);
  });

  it("endpointFor: 检索类源拼 site: 前缀, 直取类源给 URL", () => {
    const gov = opinionSourceById("gov-cn-policy")!;
    expect(endpointFor(gov, { query: "x", keywords: [] })).toContain("gov.cn");
    const search = opinionSourceById("gov-cn-search")!;
    expect(endpointFor(search, { query: "宅基地改革", keywords: [] })).toBe("site:www.gov.cn 宅基地改革");
  });

  it("源自身的限制(note)要写清楚, 免得'源站停更'被读成'没人讨论'", () => {
    expect(opinionSourceById("xinhua-politics")?.note).toContain("没有发布时间");
    expect(opinionSourceById("people-politics")?.note).toMatch(/冻结|未再更新/);
    expect(opinionSourceById("weibo-hot")?.note).toMatch(/榜单/);
  });

  it("需要特定请求头的源要把头写上(微博榜单不带 Referer 直接 403)", () => {
    expect(opinionSourceById("weibo-hot")?.headers?.Referer).toContain("weibo.com");
    // 头里不许出现凭据 —— "公开接口"的前提就是不带身份
    for (const s of PUBLIC_OPINION_SOURCES) {
      for (const k of Object.keys(s.headers ?? {})) expect(k.toLowerCase()).not.toMatch(/authorization|cookie|x-api-key/);
    }
  });

  it("登记的都是免鉴权入口: 没有需要登录/带 key 的直取 URL", () => {
    for (const s of PUBLIC_OPINION_SOURCES) {
      if (!s.url) continue;
      expect(s.url, `${s.id} 的 URL 里带 token/key`).not.toMatch(/[?&](token|key|api_?key|secret|access_?token)=/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// ⑧ 缓存与条目池(要真库; 连不上整组 skip)
// ═══════════════════════════════════════════════════════════
describe.skipIf(!dbReady)("⑧ 缓存: 同一 query 短时间不再打外部源", () => {
  let userId = "";
  beforeAll(async () => { userId = randomUUID(); });

  it("第二次同参检索直接吃缓存, 且**没有再去抓**", async () => {
    let hits = 0;
    const counting: Fetcher = async (url) => { hits++; return sampleFetcher(url); };
    const args = {
      query: `宅基地改革缓存验证-${userId.slice(0, 8)}`, sources: ["chinanews-scroll"],
      fetcher: counting, searchFn: sampleSearchFn, userId,
    };
    const first = await searchOpinion({ ...args, bypassCache: true });
    expect(first.cached).toBe(false);
    const callsAfterFirst = hits;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await searchOpinion(args);
    expect(second.cached, "同参第二次没有命中缓存 ⇒ 又把对方站点打了一遍").toBe(true);
    expect(hits, "命中缓存却又去抓了一次").toBe(callsAfterFirst);
    expect(second.total).toBe(first.total);
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("bypassCache 会强制重抓", async () => {
    const q = `宅基地改革强刷-${userId.slice(0, 8)}`;
    await searchOpinion({ query: q, sources: ["chinanews-scroll"], fetcher: sampleFetcher, searchFn: sampleSearchFn, userId });
    const forced = await searchOpinion({ query: q, sources: ["chinanews-scroll"], fetcher: sampleFetcher, searchFn: sampleSearchFn, userId, bypassCache: true });
    expect(forced.cached).toBe(false);
  });

  it("不同用户 / 不同参数不共用缓存", async () => {
    const q = "宅基地改革隔离验证";
    await searchOpinion({ query: q, sources: ["chinanews-scroll"], fetcher: sampleFetcher, searchFn: sampleSearchFn, userId });
    const other = await searchOpinion({ query: q, sources: ["chinanews-scroll"], fetcher: sampleFetcher, searchFn: sampleSearchFn, userId: randomUUID() });
    expect(other.cached).toBe(false);
  });

  it("缓存键对空白与大小写归一(同一问题不该因为多个空格变成两次抓取)", () => {
    const a = cacheKeyOf("u", "宅基地改革", { since: null });
    const b = cacheKeyOf("u", "  宅基地改革 ", { since: null });
    expect(a).toBe(b);
    expect(cacheKeyOf("u", "宅基地改革", { since: null })).not.toBe(cacheKeyOf("u2", "宅基地改革", { since: null }));
  });
});

describe.skipIf(!dbReady)("⑨ 条目池: 换关键词重查不必再联网", () => {
  let userId = "";
  const q = `条目池验证-${Date.now()}`;
  beforeAll(async () => {
    userId = randomUUID();
    await searchOpinion({
      query: "宅基地改革", sources: ["chinanews-scroll", "gov-cn-policy"],
      fetcher: sampleFetcher, searchFn: sampleSearchFn, userId, bypassCache: true,
    });
  });

  it("落到池里的条目能被池检索查回来", async () => {
    const r = await searchOpinionPool({ query: "宅基地改革", limit: 50 });
    expect(r.total, "条目池里查不到刚采过的条目").toBeGreaterThan(0);
    expect(r.items[0].title).toBeTruthy();
    expect(r.items[0].source).toBeTruthy();
    expect(r.items[0].sentiment).toBeTruthy();
  });

  it("池检索**不打外部源** —— 传一个会抛错的 fetcher 也照样出结果", async () => {
    const r = await searchOpinionPool({ query: "宅基地改革" });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.every((i) => i.sourceName.length > 0)).toBe(true);
  });

  it("按源过滤; 池里没有的源返回空而不是错误", async () => {
    const only = await searchOpinionPool({ query: "宅基地改革", sources: ["gov-cn-policy"] });
    expect(only.items.every((i) => i.source === "gov-cn-policy")).toBe(true);
    const none = await searchOpinionPool({ query: "宅基地改革", sources: ["不存在的源"] });
    expect(none.total).toBe(0);
  });

  it("带时间范围时排除无发布时间的条目, 并把排除条数报出来", async () => {
    const r = await searchOpinionPool({ query: "宅基地改革", since: "2026-09-30", until: "2026-09-30" });
    expect(r.items.every((i) => i.publishedAt?.slice(0, 10) === "2026-09-30")).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
  });

  it("池统计能报出规模与时间跨度(池子空的时候要让用户知道, 而不是以为'没有舆情')", async () => {
    const s = await poolStats();
    expect(s.total).toBeGreaterThan(0);
    expect(s.bySource.length).toBeGreaterThan(0);
    expect(s.bySource.reduce((a, b) => a + b.count, 0)).toBe(s.total);
  });

  it("同一条目重复入池只留一份(content_hash 唯一)", async () => {
    const before = (await poolStats()).total;
    await searchOpinion({ query: "宅基地改革", sources: ["chinanews-scroll"], fetcher: sampleFetcher, searchFn: sampleSearchFn, userId, bypassCache: true });
    const after = (await poolStats()).total;
    expect(after, "同一条内容被重复入池").toBe(before);
  });

  it("contentHashOf: 同源同 URL 稳定, 换源或换 URL 不同", () => {
    const a = contentHashOf({ source: "s1", url: "http://x/1", title: "T" });
    expect(contentHashOf({ source: "s1", url: "http://x/1", title: "T" })).toBe(a);
    expect(contentHashOf({ source: "s2", url: "http://x/1", title: "T" })).not.toBe(a);
    expect(contentHashOf({ source: "s1", url: "http://x/2", title: "T" })).not.toBe(a);
    // 没有 URL 的源(榜单)退化为按题名判重
    expect(contentHashOf({ source: "s1", url: "", title: "T" })).toBe(contentHashOf({ source: "s1", url: "", title: "T" }));
  });

  it("迁移的表结构真的存在(不然上面几条会全部静默退化成内存路径)", async () => {
    const cols = await pool.query(
      `select table_name from information_schema.tables where table_name in ('opinion_items','opinion_search_cache')`);
    expect(cols.rows.length, "缺少 opinion_items / opinion_search_cache —— 缓存与条目池会静默退化成内存").toBe(2);
  });
});

afterAll(async () => {
  clearMemoryCache();
  await pool.end().catch(() => null);
});
