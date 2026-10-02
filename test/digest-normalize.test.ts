// 研究速递的归一化纯函数 —— 这三个函数对应 Respal 实测踩到的三个坑(见 migrations/174):
//   ① 去重键(arXiv 的 id 按分类分配, 同一篇入库三次)
//   ② fetched_at 不能为空(NULLS LAST 把中文刊推到底)
//   ③ published 四种格式混用
// 纯函数所以能直接单测, 不必起库。
import { describe, it, expect } from "vitest";
import {
  normalizeTitle, normalizeDoi, parsePublished, plausibleDateFor,
  fixAuthorName, detectLang, abstractFromInvertedIndex, hasSubstance,
  yearFromTitle, isRelevant
} from "../src/services/digest/normalize.js";

describe("normalizeTitle —— 跨源判重的标题键", () => {
  it("大小写与句末标点不影响", () => {
    expect(normalizeTitle("A Study of X")).toBe(normalizeTitle("A study of X."));
  });
  it("中文书名号与全角标点被去掉", () => {
    expect(normalizeTitle("《资本论》研究")).toBe("资本论研究");
    expect(normalizeTitle("劳动价值论，再研究")).toBe("劳动价值论再研究");
  });
  it("空白与换行归一", () => {
    expect(normalizeTitle("A  Study\n of X")).toBe("astudyofx");
  });
});

describe("normalizeDoi —— 四种写法归一(不归一则同一篇从两个源各来一次)", () => {
  it.each([
    ["https://doi.org/10.1/XyZ", "10.1/xyz"],
    ["http://dx.doi.org/10.1/Abc", "10.1/abc"],
    ["doi:10.1/Q", "10.1/q"],
    ["10.1/Plain", "10.1/plain"],
  ])("%s → %s", (input, want) => {
    expect(normalizeDoi(input)).toBe(want);
  });
  it("空值返回空串", () => {
    expect(normalizeDoi(null)).toBe("");
    expect(normalizeDoi(undefined)).toBe("");
  });
});

describe("parsePublished —— 四种格式 → Date", () => {
  it("YYYY-MM-DD 按 UTC 解释(避免本地时区把日期拨到前一天)", () => {
    expect(parsePublished("2026-09-25")!.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });
  it("ISO-8601 带时区", () => {
    expect(parsePublished("2026-10-01T14:00:00Z")!.toISOString()).toBe("2026-10-01T14:00:00.000Z");
  });
  it("纯年份 → 该年 1 月 1 日", () => {
    expect(parsePublished("2026")!.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
  it("RFC-2822 可解析", () => {
    expect(parsePublished("Wed, 30 Sep 2026 00:00:00 -0400")).not.toBeNull();
  });
  it("解析不出返回 null —— **绝不回退 now()**(那会把'没给出版日'变成'今天出版')", () => {
    expect(parsePublished("不知道")).toBeNull();
    expect(parsePublished("")).toBeNull();
    expect(parsePublished(null)).toBeNull();
  });
});

describe("plausibleDateFor —— 元数据垃圾日期护栏", () => {
  it("拦截未来一年以上(实测 Crossref 有 2106/2036, OpenAlex 有 2029)", () => {
    expect(plausibleDateFor(new Date("2106-06-20"))).toBeNull();
    expect(plausibleDateFor(new Date("2036-02-11"))).toBeNull();
  });
  it("拦截早于印刷术的年份", () => {
    expect(plausibleDateFor(new Date("1200-01-01"))).toBeNull();
  });
  it("保留合法的在线优先(提前几个月)", () => {
    const soon = new Date(Date.now() + 60 * 86_400_000);
    expect(plausibleDateFor(soon)).not.toBeNull();
  });
  it("null 进 null 出", () => {
    expect(plausibleDateFor(null)).toBeNull();
  });
});

describe("fixAuthorName —— 中文名西方语序还原", () => {
  it("名 姓 → 姓名(实测 OpenAlex 给的就是这个顺序)", () => {
    expect(fixAuthorName("勇 谭")).toBe("谭勇");
    expect(fixAuthorName("连华 周")).toBe("周连华");
    expect(fixAuthorName("茜 王")).toBe("王茜");
  });
  it("中文语序但被空格拆开 → 只去空格", () => {
    expect(fixAuthorName("张 伟")).toBe("张伟");
    expect(fixAuthorName("谭 勇")).toBe("谭勇");
  });
  it("西文名与三字段不动(猜错真名的代价高于少修一个)", () => {
    expect(fixAuthorName("John Smith")).toBe("John Smith");
    expect(fixAuthorName("阿 里木")).toBe("阿 里木");
    expect(fixAuthorName("王小明")).toBe("王小明");
  });
});

describe("detectLang —— 判据是标题而非摘要", () => {
  it("纯中文标题判 zh, 即使摘要很长且是英文", () => {
    // 实测翻车案例: 《澄启学刊》的「云南瓦猫非遗传承的衍化特征研究」
    // 摘要 1010 字符全英文, 初版把标题+摘要拼起来算比例 → 误判成 en
    expect(detectLang("云南瓦猫非遗传承的衍化特征研究", "x".repeat(1010))).toBe("zh");
  });
  it("英文标题判 en", () => {
    expect(detectLang("Local Government Behavior and Growth")).toBe("en");
  });
  it("空返回空串(不猜)", () => {
    expect(detectLang("")).toBe("");
  });
});

describe("abstractFromInvertedIndex —— OpenAlex 的倒排索引还原", () => {
  it("按位置排序拼回", () => {
    expect(abstractFromInvertedIndex({ world: [1], Hello: [0] })).toBe("Hello world");
  });
  it("空安全", () => {
    expect(abstractFromInvertedIndex(null)).toBe("");
    expect(abstractFromInvertedIndex({})).toBe("");
  });
});

describe("yearFromTitle —— 期刊动态的内容年份", () => {
  it("从标题取最后一个年份(前面的可能是选题编号)", () => {
    expect(yearFromTitle("【选题26048】C刊|《当代经济研究》2026年度重点选题方向")).toBe(2026);
    expect(yearFromTitle("《党政研究》2021年重点选题方向&投稿须知")).toBe(2021);
  });
  it("没有年份返回 null", () => {
    expect(yearFromTitle("《社会科学家》目录")).toBeNull();
  });
});

describe("isRelevant —— 相关性门槛(Respal 完全没有这道门)", () => {
  it("中文整串命中", () => {
    expect(isRelevant("政治经济学", "中国特色社会主义政治经济学研究")).toBe(true);
  });
  it("挡住实测的噪声条目", () => {
    expect(isRelevant("政治经济学", "第七章 內地的離婚法律及程序")).toBe(false);
    expect(isRelevant("政治经济学", "Clausius Scientific Press (CSP) 克劳修斯科学出版社 外文学术期刊")).toBe(false);
    expect(isRelevant("地方政府行为", "云南瓦猫非遗传承的衍化特征研究")).toBe(false);
  });
  it("拉丁主题要求所有实词都出现(AND 而非 OR)", () => {
    expect(isRelevant("rural governance", "Rural governance and accountability")).toBe(true);
    expect(isRelevant("rural governance", "Rural Development in Africa")).toBe(false);
  });
});

describe("hasSubstance —— 有内容的判定", () => {
  it("有中文概括即算有内容", () => {
    expect(hasSubstance({ cnSummary: "这是一段足够长的中文概括内容" })).toBe(true);
  });
  it("截断的出版日污染摘要不算内容(Respal 的 paperHasContent 同款判断)", () => {
    expect(hasSubstance({ abstract: `Publication date${"x".repeat(120)}` })).toBe(false);
  });
  it("全空为 false", () => {
    expect(hasSubstance({})).toBe(false);
  });
});
