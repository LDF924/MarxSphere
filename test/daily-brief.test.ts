// daily-brief.test.ts — 每日简报的不变量(2026-10-04)
//
// 这套判据是**从观澜/Guanlan 移植的代码**(MIT, 见 THIRD_PARTY_NOTICES.md 第 9 节),
// 对应其 `guanlan/daily_quality.py` / `daily_storylines.py` / `daily.py`。
//
// 为什么要有这个文件: 和之前的 web-read 与 claim-ledger 一样, 这层**失败起来是静默的** ——
//   不抛错, 只是把证据层分错、把时效判成"未知"。后果不是崩溃, 是**用户据此下了错结论**:
//   "今天没有相关消息"(其实是时间判据失效)、"全网都在说"(其实只有一条社区帖)。
//
// 移植过程中实测踩到/必须钉住的几处:
//   ① **Python 生成器语法直译** —— `count(x for x in y)` 在 TS 里是语法错误, 必须 `map`。
//   ② **`new Date("2026年10月4日")` 在 V8 里是 Invalid Date** —— 中文日期不走显式解析就全变 unknown,
//      表现为"日报里一条今天的新闻都没有"。
//   ③ **栏目配额不是美化**: 纯按分数取 top-N 会让底分高的一手来源占满全部位置。
//   ④ **「本期未见」≠「已消退」**: 降温桶很可能只是这期没抓到, 措辞必须留余地。
import { describe, expect, it } from "vitest";
import {
  classifyDailySource, normalizeFreshness, annotateDailyItem, buildSourceHealth,
  isSoftSeo, isSearchEntrypoint, sectionTitle, normalizeTimeWindow, compactText, domainOf,
  stripBoilerplate,
} from "../src/services/daily-quality-service.js";
import { buildDailyStorylines } from "../src/services/daily-storyline-service.js";
import { formatDailyMarkdown, queryOverlapScore, topicMatchStrict, dailyFingerprint } from "../src/services/daily-brief-service.js";
import type { DailyBrief } from "../src/services/daily-brief-service.js";
import type { AnnotatedItem } from "../src/services/daily-quality-service.js";

const NOW = "2026-10-04T12:00:00.000Z";

describe("来源分层(观澜 daily_quality 移植)", () => {
  it("政策原文是 A 层、进 official 栏目", () => {
    const p = classifyDailySource({ title: "关于加强农村宅基地管理的通知", url: "https://www.moa.gov.cn/x/1.html", evidenceRole: "government" });
    expect(p.sourceTier).toBe("A");
    expect(p.section).toBe("official");
    // 边界必须一路带出去 —— 层级分对了但没人告诉读者"这代表不了外部评价", 等于白分
    expect(p.boundary).toContain("不代表外部评价");
  });

  it("同行评审归 A/学术栏目, 预印本归 B 且明写未审(本仓新增的一档)", () => {
    const peer = classifyDailySource({ title: "土地流转的产权逻辑", url: "https://www.sciencedirect.com/a", evidenceRole: "research_primary" });
    expect(peer.section).toBe("academic");
    expect(peer.sourceTier).toBe("A");
    const pre = classifyDailySource({ title: "Rural land transfer and capital", url: "https://arxiv.org/abs/1", evidenceRole: "preprint_record" });
    expect(pre.section).toBe("academic");
    expect(pre.sourceTier).toBe("B");
    expect(pre.boundary).toContain("未经同行评审");
  });

  it("社区样本归 C 且带「不能外推」的边界", () => {
    const c = classifyDailySource({ title: "关于这个政策的几点疑问", url: "https://www.zhihu.com/question/1" });
    expect(c.sourceTier).toBe("C");
    expect(c.section).toBe("community");
    expect(c.boundary).toContain("外推");
  });

  it("认不出来的通用网页归 D —— **宁可算弱, 不要算进正文**", () => {
    const d = classifyDailySource({ title: "某地农村调查随笔", url: "https://some-personal-blog.example.com/post/1" });
    expect(d.sourceTier).toBe("D");
    expect(d.riskTags).toContain("weak_lead");
  });

  it("软 SEO 站与标题党判 D(回归: 这两类最容易被当成本地媒体报道)", () => {
    expect(isSoftSeo({ title: "正常的调查报道", url: "https://baijiahao.baidu.com/s?id=1" })).toBe(true);
    expect(isSoftSeo({ title: "终于有人把乡村振兴全解析讲透了", url: "https://random.example.com/a" })).toBe(true);
    // 反过来不能误伤: 正常标题 + 正常域名不该被判软文
    expect(isSoftSeo({ title: "县域城乡融合发展的实践逻辑", url: "https://www.thepaper.cn/newsDetail_1" })).toBe(false);
  });

  it("风险/合规议题单独进 trust 栏目, 不论原本是 A 还是 B", () => {
    const a = classifyDailySource({ title: "数据出境安全评估办法", url: "https://www.gov.cn/zhengce/1", evidenceRole: "government" });
    expect(a.section).toBe("trust");
    const b = classifyDailySource({ title: "某平台数据合规问题引发讨论", url: "https://www.thepaper.cn/newsDetail_2" });
    expect(b.section).toBe("trust");
  });

  /**
   * ⚠ 这两条是**移植时按本仓语境改过的地方**, 实测撞出来的:
   *   原文的词表是品牌监测口径 —— 命中「安全」或「数据」即判 trust。
   *   放到通用检索上立刻失真: 「国庆长假自驾出行 怎么开才安全」被判成风险材料,
   *   整个 trust 栏目被日常新闻占满, 真正该看的合规材料反而被埋掉。
   *   判据改成"一个强词, 或两个不同弱词"。
   */
  it("单个常见词不足以判成风险议题(回归: 「自驾出行怎么开才安全」曾被判 trust)", () => {
    const r = classifyDailySource({ title: "国庆长假自驾出行 怎么开才安全", url: "https://www.baidu.com/s?wd=1" });
    expect(r.section, "「安全」单独出现就判风险 —— 这条栏目会被日常新闻占满").not.toBe("trust");
  });

  it("真合规材料照旧命中(隐私+数据两个弱词, 或一个强词)", () => {
    const weak = classifyDailySource({ title: "某平台隐私与数据管理引发讨论", url: "https://www.thepaper.cn/a1" });
    expect(weak.section).toBe("trust");
    const strong = classifyDailySource({ title: "关于个人信息保护的规定", url: "https://example.org/a" });
    expect(strong.section).toBe("trust");
  });

  it("域名解析去 www 与端口", () => {
    expect(domainOf("https://www.example.com:8443/a/b")).toBe("example.com");
    expect(domainOf("not a url")).toBe("");
  });

  /**
   * ⚠ 这一条钉住一处**静默降级**(2026-10-04 实测): 热榜的 15 个榜 id(`zhihu`/`weibo`…)
   *   与舆情源画像表的 21 个键(`weibo-hot`/`gov-cn-policy`…)只有一个重合。只按 id 查画像时,
   *   14 个榜会拿到中性默认值 0.5 —— **不报错**, 只是"热榜权威度低"这条价值永远不生效。
   *   而热榜的权威 0.15 / 样本 0.9 正是"注意力样本不是事实"这句口径在打分上的落点。
   */
  it("热榜的显示名能命中源画像(回归: 14 个榜曾静默拿到中性 0.5)", () => {
    const weibo = classifyDailySource({ title: "某事上热搜", url: "https://s.weibo.com/x", source: "微博热搜", sourceId: "weibo" });
    // 微博热搜：权威 0.15 / 样本 0.9 —— 若退化成 0.5/0.5, 说明画像没查到
    expect(weibo.authorityScore, "画像没命中 —— 落到了中性默认值").toBeLessThan(0.3);
    expect(weibo.sampleValue).toBeGreaterThan(0.6);

    const gov = classifyDailySource({ title: "关于某项工作的意见", url: "https://www.gov.cn/zhengce/1", source: "中国政府网", sourceId: "gov-cn-policy" });
    expect(gov.authorityScore).toBeGreaterThan(0.8);
  });
});

describe("时效分层(观澜 daily_quality 移植)", () => {
  it("中文日期写得出来(回归: `new Date('2026年10月4日')` 在 V8 是 Invalid Date)", () => {
    const r = normalizeFreshness("2026年10月4日", { generatedAt: NOW, timeWindow: "3d" });
    expect(r.freshness, "中文日期没解析出来 —— 多半是又走了 Date 构造而不是显式正则").toBe("today");
    expect(r.days).toBe(0);
  });

  it("中文带空格的日期同样解析(回归: 「2026 年 10 月 4 日」)", () => {
    const r = normalizeFreshness("2026 年 10 月 4 日", { generatedAt: NOW, timeWindow: "3d" });
    expect(r.freshness).toBe("today");
  });

  it("各级时间桶按天数落位", () => {
    expect(normalizeFreshness("2026-10-01", { generatedAt: NOW, timeWindow: "7d" }).freshness).toBe("recent_3d");
    expect(normalizeFreshness("2026-09-29", { generatedAt: NOW, timeWindow: "7d" }).freshness).toBe("recent_7d");
    expect(normalizeFreshness("2026-08-01", { generatedAt: NOW, timeWindow: "7d" }).freshness).toBe("background");
  });

  it("**没有时间就是 unknown** —— 绝不补成今天(这是最容易被当成真实趋势的假信号)", () => {
    const r = normalizeFreshness("", { generatedAt: NOW, timeWindow: "3d", text: "某地推进土地流转" });
    expect(r.freshness).toBe("unknown");
    expect(r.days).toBeNull();
  });

  it("只有文字里**明说**相对时间才兜底", () => {
    expect(normalizeFreshness("", { generatedAt: NOW, timeWindow: "3d", text: "昨天发布的文件" }).freshness).toBe("recent_3d");
    expect(normalizeFreshness("", { generatedAt: NOW, timeWindow: "3d", text: "刚刚发布" }).freshness).toBe("today");
  });

  it("today 时间窗下, 非今天的不算落在窗内", () => {
    const r = normalizeFreshness("2026-09-29", { generatedAt: NOW, timeWindow: "today" });
    expect(r.inWindow).toBe(false);
  });

  it("时间窗非法值退回 3d", () => {
    expect(normalizeTimeWindow("本月")).toBe("3d");
    expect(normalizeTimeWindow("7d")).toBe("7d");
  });
});

describe("来源健康度(采编自检)", () => {
  it("只有 A 层没有 B 层时明确警告「不能代表全网」", () => {
    const items = [
      annotateDailyItem({ title: "通知一", url: "https://www.gov.cn/a", evidenceRole: "government" }, { generatedAt: NOW }),
      annotateDailyItem({ title: "通知二", url: "https://www.moa.gov.cn/b", evidenceRole: "government" }, { generatedAt: NOW }),
    ];
    const h = buildSourceHealth(items, [], { timeWindow: "3d" });
    expect(h.warnings.join(" ")).toContain("不能代表全网");
  });

  it("D 层混进正文时要警告", () => {
    const items = [annotateDailyItem({ title: "随笔", url: "https://blog.example.org/a" }, { generatedAt: NOW })];
    expect(buildSourceHealth(items, [], { timeWindow: "3d" }).warnings.join(" ")).toContain("D 层");
  });

  it("时间未知占比过半要警告, 且提示别用「最新」这种措辞", () => {
    const items = [
      annotateDailyItem({ title: "甲", url: "https://www.thepaper.cn/1" }, { generatedAt: NOW }),
      annotateDailyItem({ title: "乙", url: "https://www.thepaper.cn/2" }, { generatedAt: NOW }),
    ];
    expect(buildSourceHealth(items, [], { timeWindow: "3d" }).warnings.join(" ")).toContain("时间未知占比偏高");
  });
});

describe("主线聚类(观澜 daily_storylines 移植)", () => {
  const mk = (title: string, url: string, origin = "opinion"): AnnotatedItem =>
    annotateDailyItem(
      { title, url, origin, source: "澎湃新闻", evidenceRole: "fresh_news", publishedAt: "2026-10-04T01:00:00Z" },
      { generatedAt: NOW, timeWindow: "3d" }
    );

  it("同事件的条目聚成一条线, 无关的不聚", () => {
    const lines = buildDailyStorylines(
      [
        mk("工商资本下乡的规范路径", "https://www.thepaper.cn/a1"),
        mk("工商资本下乡的规范路径探讨", "https://www.thepaper.cn/a2"),
        mk("某地遭遇极端天气", "https://www.thepaper.cn/b1"),
      ],
      [],
      { query: "", limit: 10 }
    );
    expect(lines.length).toBe(2);
    const merged = lines.find((l) => l.evidenceItems.length > 1);
    expect(merged, "同事件的标题没聚到一起 —— 先看 _storyline_key 的实词切分").toBeTruthy();
  });

  it("query 自身的词不参与簇键(否则所有条目聚成一条)", () => {
    const lines = buildDailyStorylines(
      [mk("乡村振兴 政策解读", "https://www.thepaper.cn/c1"), mk("乡村振兴 资金投入", "https://www.thepaper.cn/c2")],
      [],
      { query: "乡村振兴", limit: 10 }
    );
    expect(lines.length, "query 词没被排除 —— 整份简报会塌成一条主线").toBe(2);
  });

  it("风险线排前面, 且给出「今日核验」而不是「暂不动作」", () => {
    const lines = buildDailyStorylines(
      [
        mk("某平台用户数据泄露引发合规争议", "https://www.thepaper.cn/d1"),
        mk("某地推广特色农产品", "https://www.thepaper.cn/e1"),
      ],
      [],
      { query: "", limit: 10 }
    );
    expect(lines[0].riskLevel).toBe("high");
    expect(lines[0].recommendedAction).toBe("今日核验");
    expect(lines.at(-1)!.riskLevel).not.toBe("high");
  });

  it("只有 D 层证据时置信度是 low(不假装有把握)", () => {
    const lines = buildDailyStorylines(
      [annotateDailyItem({ title: "随手记", url: "https://blog.example.org/x" }, { generatedAt: NOW })],
      [],
      { query: "", limit: 10 }
    );
    expect(lines[0].confidence).toBe("low");
  });

  /**
   * ⚠ 这一条是**移植时按本仓语境改过的地方**(实测撞出来的):
   *   原文里「安全」单独出现即判 security 风险。放到通用检索上,
   *   「国庆长假自驾出行 怎么开才安全」被判 high risk 并排到简报首位,
   *   还生成了「优先核验风险线「自驾出行怎么开才安全」」这种荒谬的下一步。
   */
  it("单凭「安全」二字不判风险(回归: 日常新闻曾被判 high risk)", () => {
    const lines = buildDailyStorylines(
      // 用可识别的媒体域名 —— 否则这条线会因 D 层规则(「认不出的网页归弱线索」)判 medium,
      // 那条规则是对的, 但它会掩盖这里真正要测的东西
      [annotateDailyItem({ title: "国庆长假自驾出行 怎么开才安全", url: "https://www.thepaper.cn/newsDetail_9" }, { generatedAt: NOW })],
      [],
      { query: "", limit: 10 }
    );
    expect(lines[0].riskFlags, "「安全」两个字就触发了 security 风险标记").not.toContain("security");
    expect(lines[0].riskLevel).toBe("low");
  });

  it("真安全议题照旧命中(强词「数据泄露」「漏洞」一个就够)", () => {
    const lines = buildDailyStorylines(
      [annotateDailyItem({ title: "某平台数据泄露事件调查", url: "https://www.thepaper.cn/g1" }, { generatedAt: NOW })],
      [],
      { query: "", limit: 10 }
    );
    expect(lines[0].riskFlags).toContain("security");
    expect(lines[0].riskLevel).toBe("high");
  });

  /**
   * ⚠ 这条是本仓实测挖出来的**最大一处误报源**(2026-10-04):
   *   中文主流站的摘要几乎全都以「©…版权所有。未经许可, 请勿转载」结尾。
   *   不剥样板的话, compliance 的强词「版权」会把**整个 B 层媒体**判成合规风险,
   *   风险管理退化成"每条都是风险" —— 而一个恒真的判据等于没有判据。
   */
  it("摘要尾部的版权样板不触发合规风险(回归: 一条亚运会新闻曾被判 high risk)", () => {
    const lines = buildDailyStorylines(
      [annotateDailyItem({
        title: "如何评价亚运会中国代表团 169 金 89 银 83 铜收官",
        summary: "中国队创境外参加亚运会最佳战绩。©2026 中央广播电视总台版权所有。未经许可, 请勿转载使用。",
        url: "https://www.thepaper.cn/h1",
      }, { generatedAt: NOW })],
      [],
      { query: "", limit: 10 }
    );
    expect(lines[0].riskFlags, "页脚样板被判成了材料本身的风险").not.toContain("compliance");
    expect(lines[0].riskLevel).toBe("low");
  });

  it("样板剥离是按句切, 不误伤同段的真内容", () => {
    const s = stripBoilerplate("本文讨论数据合规问题。版权所有, 未经许可请勿转载。");
    expect(s).toContain("数据合规");
    expect(s).not.toContain("请勿转载");
  });

  it("来源层分布逐级统计(A/B/C/D 各自的条数)", () => {
    const lines = buildDailyStorylines(
      [
        mk("同一件事的媒体报道一", "https://www.thepaper.cn/f1"),
        mk("同一件事的媒体报道二", "https://news.qq.com/f2"),
      ],
      [],
      { query: "", limit: 10 }
    );
    expect(lines[0].sourceSpread.tierCounts.B).toBe(2);
    expect(lines[0].sourceSpread.domainCount).toBe(2);
  });
});

describe("选稿与渲染的接口约束", () => {
  it("搜索入口页不是线索", () => {
    expect(isSearchEntrypoint({ title: "乡村振兴 - 百度搜索", url: "https://www.baidu.com/s?wd=x", summary: "搜索入口" })).toBe(true);
    expect(isSearchEntrypoint({ title: "乡村振兴的实践", url: "https://www.thepaper.cn/a" })).toBe(false);
  });

  it("指纹优先按规范化 URL(同页不同锚点算一条)", () => {
    const a = dailyFingerprint("标题", "https://www.thepaper.cn/a/", "澎湃");
    const b = dailyFingerprint("另一个标题", "https://www.thepaper.cn/a", "澎湃");
    expect(a).toBe(b);
  });

  it("中文 query 的重叠分不是恒 0(回归: 无分隔符的整句会被切成 0 个词)", () => {
    expect(queryOverlapScore("乡村振兴", "关于乡村振兴的若干意见")).toBeGreaterThan(0);
    expect(topicMatchStrict("乡村振兴", "乡村振兴战略实施情况")).toBe(true);
  });

  it("栏目标题与文本紧凑化", () => {
    expect(sectionTitle("academic")).toBe("学术与预印本");
    // 紧凑化用于包含判断: 标点与空白都不该影响「工商资本下乡」与「工商资本, 下乡」的匹配
    expect(compactText("工商资本, 下乡")).toBe("工商资本下乡");
  });

  it("Markdown 渲染带上三层边界: 事实锚点 / 证据锚点 / 采编自检", () => {
    const brief = {
      schemaVersion: "daily_report_v1", title: "乡村振兴", query: "乡村振兴", mode: "query_daily",
      generatedAt: NOW, timeWindow: "3d", edition: "research", routePlan: null, diagnostics: {},
      sourceMix: {}, originMix: {}, tierMix: { A: 1 }, candidateCount: 3, itemCount: 1,
      highlights: ["某地发布实施意见"], items: [], overflowItems: [], overflowCount: 0,
      sections: [{ key: "official", title: "一手动态", summary: "只放可核验的一手入口", items: [{
        title: "关于乡村振兴的实施意见", url: "https://www.gov.cn/a", summary: "提出五项举措",
        source: "中国政府网", origin: "opinion", evidenceRole: "government",
        sourceTier: "A", sourceTierLabel: "A 一手/官方/监管", sourceSection: "official",
        freshness: "today", freshnessLabel: "今天", freshnessDays: 0, freshnessInWindow: true,
        freshnessEvidence: "2026-10-04", riskTags: [],
        sourceProfile: { boundary: "官方口径, 不代表外部评价" },
      }] }],
      storylines: [], editorialDecisions: [],
      sourceHealth: { tierCounts: { A: 1 }, mainTierCounts: { A: 1 }, freshnessCounts: { today: 1 }, mainFreshnessCounts: { today: 1 }, sectionCounts: { official: 1 }, timeWindow: "3d", weakLeadCount: 0, mainWeakLeadCount: 0, todayCount: 1, unknownTimeCount: 0, warnings: ["主正文缺少 B 层外部媒体/产业/开发者来源, 不能代表全网情况。"] },
      editorialHealth: { status: "warn", coverage: { official: 1 }, warnings: ["主正文缺少 B 层外部媒体/产业/开发者来源, 不能代表全网情况。"] },
      boundaries: ["热榜热度是平台机制产物, 只说明当下注意力"], nextSteps: ["把最相关的原文归档"],
      historyDelta: { enabled: false, compareDays: 0, recordsChecked: 0, newStorylines: [], continuedStorylines: [], cooledStorylines: [], persistentRisks: [] },
      boundary: "简报是公开信号与证据入口, 不是最终判断",
    } as unknown as DailyBrief;
    const md = formatDailyMarkdown(brief);
    expect(md).toContain("**事实锚点**: 提出五项举措");
    expect(md).toContain("**今天的边界**: 官方口径");
    expect(md).toContain("## 采编自检");
    expect(md).toContain("不能代表全网情况");
    // 采编自检必须在正文之后 —— 放前面读者先读免责声明, 放后面才是"读完再看看哪里不牢"
    expect(md.indexOf("## 采编自检")).toBeGreaterThan(md.indexOf("## 今日重点"));
  });
});
