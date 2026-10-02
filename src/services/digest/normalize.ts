// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// normalize.ts — 研究速递的入库归一化(去重键 + 出版日 + 作者 + 中文标记)
//
// 单独成文件是因为**这三件事全是纯函数**, 而它们正好对应 Respal 实测踩到的三个坑
// (见 migrations/174 头注释)。纯函数的另一个好处: 能直接单测, 不必起库。

/** 标题归一化 —— 去标点/空白/大小写, 用于跨源判重。
 *
 *  中文不做分词、不做繁简转换: 繁体与简体是**不同的标题**, 强行归一会在
 *  "同一篇文章的两个版本"与"两篇不同文章"之间做错判断, 而后者更贵。
 *  全角/半角标点统一去掉即可覆盖绝大多数跨源差异。 */
export function normalizeTitle(title: string): string {
  return String(title || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")   // 标点与符号(含全角)
    .replace(/\s+/g, "");
}

/** DOI 归一化 —— 去掉 URL 前缀、转小写。
 *
 *  真实数据里 doi 有四种写法:
 *    `https://doi.org/10.1/x` / `http://dx.doi.org/10.1/x` / `doi:10.1/x` / `10.1/x`
 *  不归一的话, 同一篇文献从 OpenAlex 与 Crossref 各来一次就是两行。 */
export function normalizeDoi(doi: string | null | undefined): string {
  const s = String(doi || "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .trim();
}

/** 出版日归一化 —— 四种格式 → Date, 解析不出返回 null。
 *
 *  ⚠ **绝不在解析失败时回退到 now()**。那会把"出版方没给出版日"变成
 *  "今天出版的", 排序与展示同时失真 —— opinion-sources.ts 里新华网 RSS
 *  那条教训(「故意不填 now() 冒充」)是同一个判断。
 *
 *  四种格式来自 Respal 实测的混用现状:
 *    · `YYYY-MM-DD`(最多, 其中大量是中文刊的占位值 `2026-01-01`)
 *    · RFC-2822 带时区 `Wed, 30 Sep 2026 00:00:00 -0400`
 *    · ISO-8601 `2026-10-01T14:00:00Z`
 *    · 纯年份 `2026`
 */
export function parsePublished(raw: string | null | undefined): Date | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  // 纯年份: 只有"某年"这个精度, 落成 1 月 1 日。这是**有损**的, 所以由调用方
  // 决定要不要 —— 这里给 Date 是因为展示层要排序; 精度丢失在 UI 上按"仅年份"呈现。
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    return y >= 1000 && y <= 2999 ? new Date(Date.UTC(y, 0, 1)) : null;
  }
  // YYYY-MM / YYYY-MM-DD (不含时区) —— 按 UTC 解释, 避免本地时区把日期拨到前一天
  const ymd = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (ymd) {
    const [, y, mo, d] = ymd;
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d || "1")));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // RFC-2822 与 ISO-8601 都交给 Date 解析(两者 Date 都认), 但要防住
  // "Date 把无效串当有效"的情况: 解析后再确认原串里确实有年份
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  if (!/\d{4}/.test(s)) return null;
  return parsed;
}

/** 中文作者名修正 —— 把 OpenAlex/arXiv 的西方语序还原成中文语序。
 *
 *  实测数据(2026-10-02 抓 OpenAlex 中文刊条目):
 *    `勇 谭`   → 谭勇      (名1字 + 姓1字)
 *    `连华 周` → 周连华    (名2字 + 姓1字)
 *    `茜 王`   → 王茜      (名1字 + 姓1字)
 *  即这些源把中文名按**西方语序「名 姓」**输出, 而中文应写作「姓名」。
 *
 *  两种修法, 按"哪一段是姓"分:
 *    · 末段是常见单字姓 → **翻转**      (`勇 谭` → `谭勇`)
 *    · 首段是常见单字姓 → **只去空格**  (`张 伟` → `张伟`, 本来就是中文语序, 只是被拆开了)
 *    · 其余 → **原样返回**              (复姓/三字名/西文名一律不猜)
 *
 *  为什么不做更激进的还原: 猜错一个真名的代价(学术场景里挂错作者)高于少修一个。
 */
const SINGLE_CHAR_SURNAMES = new Set(
  "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳唐罗薛伍余米贝姚孟顾尹江钟卢高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公"
);

export function fixAuthorName(name: string): string {
  const s = String(name || "").trim();
  // 只处理「两段纯中文, 至少一段是单字」的形状; 三段及以上与西文名一律不猜
  const m = /^([一-龥]{1,3})\s+([一-龥]{1,3})$/.exec(s);
  if (!m) return s;
  const [, a, b] = m;
  if (SINGLE_CHAR_SURNAMES.has(b) && b.length === 1) return `${b}${a}`;   // 名 姓 → 姓名
  if (SINGLE_CHAR_SURNAMES.has(a) && a.length === 1) return `${a}${b}`;   // 姓名(被拆开) → 姓名
  return s;
}

/** 语言判定 —— 只在能明确判断时给值, 否则空串(不猜)。
 *
 *  ⚠ 判定的主体是**标题, 不是摘要**。初版把标题与摘要拼起来算 CJK 占比,
 *  结果实测翻车: 「云南瓦猫非遗传承的衍化特征研究」是一个纯中文标题, 但它挂在
 *  《澄启学刊》上、摘要 1010 字且是英文 —— 长英文摘要把比例稀释到 0.3 以下,
 *  这条被判成了 `en`。标题是条目的身份载体, 摘要的语种**本来就可以与标题不同**,
 *  拿它当主要依据是错的。
 *
 *  为什么不用源给的 language 字段: OpenAlex 对中文刊的 language **恒为 null**
 *  (实测: 澄启学刊/现代教育与教学创新 多条都是 null), 拿它当依据等于没有。
 *  按字符构成判断反而更准。
 */
export function detectLang(title: string, abstract = ""): "zh" | "en" | "" {
  const t = String(title || "");
  const cjkT = (t.match(/[一-龥]/g) || []).length;
  const latinT = (t.match(/[A-Za-z]/g) || []).length;
  if (cjkT >= 2 && cjkT >= latinT) return "zh";
  if (latinT >= 2 && latinT > cjkT) return "en";
  // 标题里没有字母(纯数字/符号/空白)—— 这时才退到摘要
  const s = String(abstract || "");
  const cjkA = (s.match(/[一-龥]/g) || []).length;
  const latinA = (s.match(/[A-Za-z]/g) || []).length;
  if (cjkA >= 5 && cjkA >= latinA) return "zh";
  if (latinA >= 5) return "en";
  return "";
}

/** OpenAlex 的 abstract_inverted_index → 正常文本。
 *
 *  OpenAlex **不返回摘要原文**, 只给 `{词: [位置...]}` 的倒排索引。
 *  拼回去必须按位置排序, 否则得到一串乱序词 —— 而乱序文本看起来"像摘要",
 *  不会报错, 只会让下游的 LLM 概括出莫名其妙的结果。
 */
export function abstractFromInvertedIndex(idx: Record<string, number[]> | null | undefined): string {
  if (!idx || typeof idx !== "object") return "";
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && p >= 0 && p < 100_000) slots.push([p, word]);
    }
  }
  if (!slots.length) return "";
  slots.sort((a, b) => a[0] - b[0]);
  return slots.map(([, w]) => w).join(" ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** 出版日合理性护栏 —— 明显不可能是真出版日的值一律判为"没有出版日"。
 *
 *  实测到的垃圾值(都是元数据质量问题, 不是解析错误):
 *    · Crossref `2106-06-20` / `2036-02-11` —— 出版社把年份打错
 *    · OpenAlex `2029-05-06` / `2026-12-31` —— 预刊/在线优先的占位日期
 *  上限取"今天 + 1 年": 合法的在线优先(advance online)通常提前几个月,
 *  提前一年以上基本就是脏数据。宁可 published_at 为 NULL(界面显示"日期未详"),
 *  也不要让一张卡片顶着 2036 年出现在"最新论文"里。
 */
export function plausibleDateFor(d: Date | null | undefined): Date | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getUTCFullYear() < 1500) return null;                       // 早于印刷术
  if (d.getTime() > Date.now() + 365 * 86_400_000) return null;     // 未来一年以上
  return d;
}

/** 从标题里抽出**内容本身的年份** —— 期刊动态条目专用。
 *
 *  ⚠ 为什么必须有这个函数: `cjournal_journal_updates.found_at` 是**我们抓到的时刻**,
 *  不是内容的年份。实测(2026-10-02)库里的行全部是最近 46 天抓的, 但标题写的是
 *  「《党政研究》**2021**年重点选题方向」「《马克思主义研究》**2022**年选题导引」——
 *  按 found_at 排序会让 2019~2021 年的旧目录冒到"今日推荐"最上面。
 *
 *  这与 Respal 那个坑是**同型但方向相反**的错: 它缺 fetched_at 导致中文刊沉底,
 *  而只有 fetched_at 又会让旧内容浮顶。两个时刻必须分清:
 *    found_at   = 我们何时抓到(排序的"新鲜度"依据)
 *    publishedAt = 内容自身何时发布(用户判断"这是不是新的"的依据)
 *
 *  取**最后一个**匹配: 标题格式是「【选题26048】C刊|《当代经济研究》2026年度重点选题方向」,
 *  前面的数字可能是选题编号(26048)。`\b` 保证不会匹配到 26048 里的一段。
 */
export function yearFromTitle(title: string): number | null {
  const s = String(title || "");
  const matches = [...s.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  const valid = matches.filter((y) => y >= 2000 && y <= 2035);
  return valid.length ? valid[valid.length - 1] : null;
}

/** 相关性门槛 —— 主题必须**真的出现在标题里**, 否则丢弃。
 *
 *  ⚠ 为什么必须有这道门: Respal 的速递**没有任何相关性过滤**, 它的「今日推荐」
 *  就是 `ORDER BY fetched_at DESC` 的原始抓取结果(见报告 §4.5)。
 *  实测本仓接入 Crossref 后同样的问题立刻出现 —— 查「政治经济学」返回的是:
 *     · 「第七章 內地的離婚法律及程序」(婚姻法书籍章节)
 *     · 「CHAPTER 12 Aochi Washio 青地鷲雄」(日本战犯传记)
 *     · 「Clausius Scientific Press (CSP) 克劳修斯科学出版社 外文学术期刊」(出版社自我宣传页)
 *  这三条挂到任何一位政治经济学研究者面前都是噪声。
 *
 *  判据分两套:
 *   · 中文主题: 标题含整串即通过; 否则按 **2-gram 覆盖率** ≥ 0.6 放行
 *     (「中国特色社会主义政治经济学」含整串 → 直接过; 「政治与经济」只中 2 个 gram → 不放)
 *   · 拉丁主题: **所有实词都要出现**(AND 而非 OR) —— OR 会让 "rural governance"
 *     匹配到任何含 rural 的文章
 *
 *  只查标题不查摘要: 摘要里出现主题词的门槛太松(一篇讲别的的文章在引言里
 *  提一句主题词就会通过)。标题是条目对自身主题的承诺。
 */
export function isRelevant(topic: string, title: string, abstract = ""): boolean {
  const t = String(topic || "").trim().toLowerCase();
  if (!t) return true;
  const titleL = String(title || "").toLowerCase();
  const absL = String(abstract || "").toLowerCase();
  if (!titleL) return false;

  if (/[一-龥]/.test(t)) {
    if (titleL.includes(t)) return true;
    const grams = cjkBigrams(t);
    if (!grams.length) return true;
    // 命中标题的 gram 数; 摘要里的命中折算半票(避免完全漏掉改写过的标题)
    const hit = grams.filter((g) => titleL.includes(g)).length
      + grams.filter((g) => !titleL.includes(g) && absL.includes(g)).length * 0.5;
    return hit / grams.length >= 0.6;
  }

  const words = t.split(/[\s,，、]+/).filter((w) => w.length >= 3);
  if (!words.length) return true;
  return words.every((w) => titleL.includes(w) || absL.includes(w));
}

/** 中文 2-gram(只取汉字, 跳过标点与空白) */
function cjkBigrams(s: string): string[] {
  const chars = [...s].filter((c) => /[一-龥]/.test(c));
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 条目是否有实质内容 —— 照 Respal 的 paperHasContent 门槛, 但**放宽**。
 *
 *  Respal 原式: `cn_summary.length > 10 || (abstract.length > 100 && !abstract.startsWith("Publication date"))`
 *  其中「Publication date…」是出版社 HTML/XML 的典型措辞(抓串了才会以它开头)。
 *  这里保留这个判断 —— 它是真实踩坑, 不是臆想。
 *
 *  放宽点的理由: 纯年份/无摘要的条目如果被判定为"无内容", 用户就永远看不到
 *  某本中文刊的新目录了。所以只要**有标题 + 有 URL** 就放行, 只是标记低信息量。
 */
export function hasSubstance(input: { cnSummary?: string; abstract?: string }): boolean {
  const cn = String(input.cnSummary || "").trim();
  const ab = String(input.abstract || "").trim();
  if (cn.length > 10) return true;
  if (ab.length > 100 && !/^Publication date/i.test(ab)) return true;
  return false;
}
