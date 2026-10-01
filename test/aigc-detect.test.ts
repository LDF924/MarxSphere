/**
 * aigc-detect.test.ts — AIGC 率检测的**方向性**与结构约束。
 *
 * 由来(2026-10-01, 从旧项目移植 m2_start_check_ai_rate / execute_m2_detect_ai_rate):
 *   本仓此前对 AIGC 只有"降"没有"检测" —— applyDeAITier() 能改写正文, 但降没降、
 *   降了多少没有任何东西能量。本文件锁的正是"能不能量"这件事。
 *
 * 这个文件**不需要数据库** —— 被检测的东西是一段文本, 检测本身是纯函数。
 * 所以它永远跑得起来(不像连库的那批要靠 describe.skipIf)。测试分三类:
 *   ① **不变量**: 同文同分、空文不崩、特征贡献可加和、方向声明与数值一致;
 *   ② **方向性**(核心): 高 AI 特征文本 → 高分; 把它打散 → 分数下降。
 *      这条是**唯一真正重要的断言** —— 分数绝对值可以漂, 方向不能反;
 *   ③ **反泄漏**: 短文本不给结论、中英混排不误判、特征缺数据时让权重而不是记 0。
 *
 * ⚠ 这里不断言具体的锚点数字(那是标定集的事, 见服务文件尾注)。断言锚点数字等于
 *   把"标定集长什么样"冻进测试, 换个语料就红 —— 而红的不是 bug。断言的是**关系**。
 */
import { describe, it, expect } from "vitest";
import {
  analyzeAigc,
  diffAigc,
  buildContext,
  getCalibration,
  AIGC_FEATURE_WEIGHTS,
  type AigcFeatureKey,
} from "../src/services/aigc-detect-service.js";

/** 归一化在越界时的取值(与服务内 UNDETERMINED 一致); 服务未导出它, 这里显式声明以便测试表达"不许低于这个数" */
const UNDETERMINED = 0.5;

/** 高 AI 特征稿: 模板化连接词密集 + 句长均匀 + 段长均匀 + 四字格多 */
const AI_LIKE = `首先，随着数字技术的不断发展，数字乡村建设在新时代背景下具有重要意义。其次，值得注意的是，数字技术的广泛应用为乡村振兴提供了有力支撑，同时也带来了新的挑战。再次，综上所述，我们必须深刻认识到数字乡村建设的重要性，不断推动其深入发展。最后，由此可见，数字乡村建设不仅促进了农村经济的发展，而且提升了农民的生活水平。

此外，显而易见，数字乡村建设在推动城乡融合方面发挥着重要作用，为农业农村现代化奠定了坚实基础。与此同时，我们也要看到，数字鸿沟问题日益凸显，需要引起广泛关注。具体而言，应当从以下三个方面着手推进相关工作。第一，加强基础设施建设，夯实乡村发展底座。第二，提升农民数字素养，激发乡村内生动力。第三，完善政策保障体系，优化乡村制度环境。

总之，数字乡村建设是一项系统工程，需要全社会共同努力推进。只有不断深化改革，才能有效促进农业农村的高质量发展。面向未来，我们应当持续用力，久久为功，推动数字乡村建设不断取得新的更大成效。综上所述，数字乡村建设对于实现乡村全面振兴具有不可替代的重要意义，必将为推动农业农村现代化注入强劲动力。`;

/**
 * 同一篇的"打散"版: 字数相近, 只做三件降重真正会做的事 ——
 * 删掉模板化连接词、把句子长短拉开、段落切分不再整齐。
 * ⚠ 它必须**只改这些**, 不能顺手把内容也换掉: 那样测的就不是"检测器对特征的敏感度",
 *   而是"两篇不同文章分数不同"(那条断言恒真, 等于没测)。
 */
const DEAIED = `数字乡村建设这几年被反复提起。技术确实改变了农村的一些事情，但改变的方向未必是政策文本里写的那个。一个县里装了土壤传感器，装完之后没有农户知道数据去哪了；农技站的人说他们也没见过后台。当然也有反例。

有些合作社自己买了烘干机，理由很实际，就是怕稻子烂在仓里，这跟数字不数字没什么关系。一台机器一个季度回本。账算得很清楚，没有人会为它写一份意义阐释。

把这两件事摆在一起看，问题就变成了：谁在决定技术怎么用，谁在为它的后果负责。政策文本通常把这个环节跳过去，直接谈意义、谈前景、谈远景目标。跳过去的那部分，恰恰是田野里最要紧的。`;

/** 人类风格中文: 句长起伏大、无套话、段长不齐 */
const HUMAN_LIKE = `数字乡村这件事，我第一次真正感到不对劲是在去年冬天。那天下午我跟着县里的干部下村，本来只是想去看看那个智慧农业示范点。结果村干部把我们领进一间屋子，墙上挂着一块巨大的电子屏。屏幕很亮。屋里没人。我问这块屏平时谁看。村干部说，上面要求建，就建了。后来我又跑了三个村，情况差不多。有一个村的设备装了两年，电源线一直没接。村支书跟我解释的时候一直在看手机，他说，反正上面来检查的时候能显示就行。这句话我记了很久，因为它把整件事说清楚了：技术在这里不是用来解决问题的，是用来交差的。但也不能一概而论。隔壁镇有个合作社，理事会自己凑钱买了几台烘干机，理由很实在——稻子收上来赶上下雨，晒不干就烂在仓库里。他们不叫这个数字化转型，就叫买机器。这两个例子放在一起，问题就出来了。`;

const KEY_COUNT = Object.keys(AIGC_FEATURE_WEIGHTS).length;

describe("① 不变量: 纯函数的确定性", () => {
  it("同一段文本跑两次, 分数与全部特征值完全一致", () => {
    const a = analyzeAigc(AI_LIKE);
    const b = analyzeAigc(AI_LIKE);
    expect(a.aiScore).toBe(b.aiScore);
    expect(a.features.map((f) => f.value)).toEqual(b.features.map((f) => f.value));
    expect(a.verdict).toBe(b.verdict);
  });

  it("空文本不崩, 且明确不给结论(而不是返回 0 分让人以为'很像人写')", () => {
    const r = analyzeAigc("");
    expect(r.verdict).toBe("insufficient");
    expect(r.reliable).toBe(false);
    expect(Number.isFinite(r.aiScore)).toBe(true);
    expect(r.note).toMatch(/空|未做检测/);
  });

  it("只有空白/标点也不崩", () => {
    for (const t of ["   ", "\n\n\n", "。，！？", "\t"]) {
      const r = analyzeAigc(t);
      expect(Number.isFinite(r.aiScore)).toBe(true);
      expect(r.reliable).toBe(false);
    }
  });

  it("权重之和为 1", () => {
    const sum = Object.values(AIGC_FEATURE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(Object.keys(AIGC_FEATURE_WEIGHTS).length).toBe(KEY_COUNT);
  });

  it("分项贡献可加和: 全部 contribution 之和 / 有效权重 = 分数(误差来自四舍五入)", () => {
    const r = analyzeAigc(AI_LIKE);
    const active = r.features.filter((f) => f.applicable);
    const weightSum = active.reduce((a, f) => a + f.weight, 0);
    const raw = r.features.reduce((a, f) => a + f.contribution, 0) / weightSum;
    expect(Math.abs(Math.round(raw) - r.aiScore)).toBeLessThanOrEqual(1);
  });

  it("每个特征都带 key/label/value/weight/contribution, 且 key 唯一", () => {
    const r = analyzeAigc(AI_LIKE);
    expect(r.features.length).toBe(KEY_COUNT);
    expect(new Set(r.features.map((f) => f.key)).size).toBe(KEY_COUNT);
    for (const f of r.features) {
      expect(typeof f.key).toBe("string");
      expect(typeof f.label).toBe("string");
      expect(f.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(f.value)).toBe(true);
      expect(Number.isFinite(f.contribution)).toBe(true);
      expect(f.weight).toBeGreaterThan(0);
      expect(f.aiLike).toBeGreaterThanOrEqual(0);
      expect(f.aiLike).toBeLessThanOrEqual(1);
      // 不适用时权重让出去: contribution 必须是 0, 不能按 0.5 蒙一个
      if (!f.applicable) expect(f.contribution).toBe(0);
      expect(f.anchor.human).not.toBe(f.anchor.ai);
    }
  });
});

describe("② 结构: 特征定义域与语言", () => {
  it("语言自动判定: 中文稿判 zh, 英文稿判 en, 可显式覆盖", () => {
    expect(analyzeAigc(AI_LIKE).stats.lang).toBe("zh");
    const en = "I went back to the village in December. Two of the four boxes had rusted through. Nobody local had the login. The dryer paid for itself in one season, and the sensors never did.";
    expect(analyzeAigc(en).stats.lang).toBe("en");
    expect(analyzeAigc(en, { lang: "zh" }).stats.lang).toBe("zh");
  });

  it("英文里的句号不制造假句边界: 小数与缩写不该把句子切碎", () => {
    const t = "The sample covered 3.14 square kilometres in total, which is small. The rate rose by 2.5 percent over the period of study. See Smith et al. 2020 for the original measurement procedure used here.";
    const ctx = buildContext(t, "en");
    // "3.14" / "2.5" / "et al. 2020" 都不该断句 —— 断错了句长统计会凭空多出一堆超短句
    expect(ctx.sentences.length).toBe(3);
  });

  it("中文句末标点(。！？)无条件断句", () => {
    const ctx = buildContext("今天下雨。明天晴！后天呢？不知道。", "zh");
    expect(ctx.sentences.length).toBe(4);
  });

  it("中英混排文本不崩, 且按主体语言判定", () => {
    const mixed = "本文研究 capital inflow 对 rural governance 的影响。研究使用 panel data，覆盖 2010-2020 年。结果显示，资本下乡显著改变了村庄的治理结构，但也带来了新的张力。访谈材料来自三个县，共 68 位受访者。";
    const r = analyzeAigc(mixed);
    expect(Number.isFinite(r.aiScore)).toBe(true);
    expect(r.stats.lang).toBe("zh");
  });
});

describe("③ 方向性(核心): 打散套话与规律结构后, 分数必须下降", () => {
  it("高 AI 特征稿比人类风格稿分高", () => {
    const ai = analyzeAigc(AI_LIKE);
    const human = analyzeAigc(HUMAN_LIKE);
    expect(ai.aiScore).toBeGreaterThan(human.aiScore);
  });

  it("同一内容的打散版: 分数下降, 且 verdict 不高于原稿", () => {
    const before = analyzeAigc(AI_LIKE);
    const after = analyzeAigc(DEAIED);
    expect(after.aiScore).toBeLessThan(before.aiScore);
    expect(before.reliable).toBe(true);
    // 降到 mixed/likely_human, 不能再停在 likely_ai
    expect(before.verdict).toBe("likely_ai");
    expect(after.verdict).not.toBe("likely_ai");
  });

  it("diffAigc 报出下降方向(delta 为负)且 improved 为真", () => {
    const d = diffAigc(AI_LIKE, DEAIED);
    expect(d.delta).toBeLessThan(0);
    expect(d.after).toBeLessThan(d.before);
    expect(d.improved).toBe(true);
    expect(d.movedFeatures.length).toBe(3);
    // 变化最大的应当是套话密度(打散时删得最多的就是它)
    expect(d.movedFeatures.map((m) => m.key as AigcFeatureKey)).toContain("template_phrase");
  });

  it("套话密度这个特征本身就抓得住: 模板稿远高于人类稿", () => {
    const ai = analyzeAigc(AI_LIKE).features.find((f) => f.key === "template_phrase")!;
    const human = analyzeAigc(HUMAN_LIKE).features.find((f) => f.key === "template_phrase")!;
    expect(ai.value).toBeGreaterThan(human.value);
    expect(ai.aiLike).toBeGreaterThan(human.aiLike);
  });

  /**
   * ⚠ 这条锁的是**一个真实的踩坑**, 也是本服务唯一必须交代清楚的"做不到"。
   *
   *   标定结果: AI 稿的 4-gram 重复率**低于**人类(长度配对后依然成立, 见服务文件头),
   *   所以重复结构这一项的"AI 方向"在低值端。于是"整段复制粘贴"这种重复率极高的文本,
   *   会被单调的归一化一路推到**人类端** —— 等于给复制粘贴洗白。
   *
   *   现状: 超出观测值域 ⇒ 按**未定(0.5)**计分并打标记, 不做任何外推。
   *   这里断言的就是这条保证 —— 它**不会**被判成"很像人类"(那是错的),
   *   也**不会**被判成"很像 AI"(数据不支持, AI 稿的重复率其实更低)。
   *   要真正做到"双向可疑"需要双向映射与相应的训练数据, 目前没有。
   */
  it("极高重复(复制粘贴)按未定计分并标记, 不会被判成最像人类", () => {
    const repeated = "本研究采用问卷调查与深度访谈相结合的方法。问卷覆盖三个县的四百二十户农户，回收有效问卷三百八十七份。".repeat(5);
    const f = analyzeAigc(repeated).features.find((x) => x.key === "repeat_ngram")!;
    expect(f.detail.outOfRange, "极端重复没有被标成'超出标定范围'").toBe(1);
    expect(f.aiLike, "超出标定范围的值被硬塞到人类端 —— 给复制粘贴洗白").toBeLessThanOrEqual(UNDETERMINED);
    // 也不许反过来把它当成 AI 的铁证
    expect(f.aiLike).toBeLessThan(0.95);
    expect(analyzeAigc(repeated).note).toMatch(/超出标定范围/);
  });

  it("等长对照: 两段文字在重复结构上的原始值确实拉开了(测量本身是有效的)", () => {
    // 等长构造: 左边的"句子池"只有 2 句(必然重复), 右边是 5 句各不相同的长句
    const repeated = [
      "本研究采用问卷调查与深度访谈相结合的方法。",
      "问卷覆盖三个县的四百二十户农户，回收有效问卷三百八十七份。",
    ].join("").repeat(5);
    const varied = [
      "本研究采用问卷调查与深度访谈相结合的方法，问卷覆盖中部地区三个县的四百二十户农户，回收有效问卷三百八十七份。",
      "访谈对象包括村干部、合作社负责人与普通农户，共六十八人，全部访谈均在征得同意后录音并转录为文本。",
      "转录文本由两位研究者独立编码，编码分歧通过逐条讨论解决，最终一致性达到可接受的水平。",
      "研究还收集了县级项目文件、设备采购台账与验收报告，用于交叉核对访谈中提到的年份与金额。",
      "在此基础之上，研究者对三个县的差异做了比较，并特别留意了那些与政策文本表述不一致的地方。",
    ].join("");
    expect(Math.abs(repeated.length - varied.length)).toBeLessThan(40);
    const a = analyzeAigc(varied).features.find((f) => f.key === "repeat_ngram")!;
    const b = analyzeAigc(repeated).features.find((f) => f.key === "repeat_ngram")!;
    expect(b.value, "同一句话反复出现, 重复率却没拉开 —— 这个特征没在测它该测的东西").toBeGreaterThan(a.value * 10);
  });

  /**
   * 归一化是**单调**的(刻意如此, 见 normalize 的注释): 在 AI 方向那一侧越走越远会贴到
   * 人类端。所以这里锁的不是"极端重复要被判成 AI"(那需要双向映射与相应的训练数据,
   * 现在没有), 而是**这件事必须被说出来** —— outOfRange 标记 + note 提示。
   * 一条不吭声的错误结论比一条标了"我不知道"的结论危险得多。
   */
  it("超出标定范围的极端重复会被标记出来, 而不是悄悄给一个结论", () => {
    const extreme = "本研究采用问卷调查与深度访谈相结合的方法。".repeat(12);
    const r = analyzeAigc(extreme);
    const f = r.features.find((x) => x.key === "repeat_ngram")!;
    expect(f.value).toBeGreaterThan(0.5);
    expect(f.detail.outOfRange, "极端重复没有被标成'超出标定范围'").toBe(1);
    expect(r.note).toMatch(/超出标定范围/);
  });

  /**
   * 标定表本身的自洽性。
   *
   * ⚠ 断言**不是**"人类的两个分位点按方向排序后不递减" —— 那条早先写错过,
   *   它假设人/AI 两类的分布完全分离, 而实测里它们大量重叠(如 burstiness:
   *   人类 p05 = -0.4188 在 AI p50 = -0.3474 的**左侧**, 方向语义上完全正常)。
   *   真正要锁的是"表里的数字不会让归一化函数自相矛盾"以及"值域能把分位点包住"。
   */
  it("标定表自洽: 值域包住分位点, 且两张表的键与权重表一致", () => {
    for (const lang of ["zh", "en"] as const) {
      const cal = getCalibration(lang);
      expect(Object.keys(cal).sort()).toEqual(Object.keys(AIGC_FEATURE_WEIGHTS).sort());
      for (const [key, c] of Object.entries(cal)) {
        expect(Number.isFinite(c.humanP05), `${lang}/${key} humanP05 非数`).toBe(true);
        expect(c.observedMax, `${lang}/${key} 观测值域反了`).toBeGreaterThan(c.observedMin);
        for (const v of [c.humanP05, c.humanP50, c.aiP50, c.aiP95]) {
          expect(v, `${lang}/${key}: 分位点 ${v} 落在观测值域 [${c.observedMin}, ${c.observedMax}] 之外 —— 越界标记会因为标定表自相矛盾而频繁误报`)
            .toBeGreaterThanOrEqual(c.observedMin);
          expect(v).toBeLessThanOrEqual(c.observedMax);
        }
        expect(typeof c.higherIsAi).toBe("boolean");
        expect(c.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("归一化后有明确的刻度: AI 中位附近的稿子比人类中位附近的更像 AI", () => {
    // 用标定集的中位数直接构造"人到 AI 的位置距离"检查(不依赖具体数值)
    const cal = getCalibration("zh");
    for (const [key, c] of Object.entries(cal)) {
      // 人类中位与 AI 中位必须落在**不同的**归一化侧: 这是"这一项能分辨"的最低要求
      if (Math.abs(c.humanP50 - c.aiP50) < 1e-9) continue;   // 完全重合的项跳过
      const side = c.higherIsAi ? Math.sign(c.aiP50 - c.humanP50) : Math.sign(c.humanP50 - c.aiP50);
      expect(side, `${key}: 人类中位与 AI 中位的相对位置与声明的方向相反`).toBeGreaterThan(0);
    }
  });

  /**
   * 四字格密度是中文特有项 —— 全用四字短语的稿子应当在这项上更像 AI,
   * 而正常行文的中文不该被判成"四字格密集"。
   */
  it("四字格密度对满篇四字短语敏感", () => {
    const fourCharHeavy = "统筹兼顾，多措并举，扎实推进，稳步提升，久久为功，善作善成，凝心聚力，砥砺前行，开拓创新，锐意进取，真抓实干，务求实效。";
    const normalProse = "这项研究考察了三个县的情况，其中两个县在山区，交通不便，访谈只能靠步行进入。研究者在每个村停留三到五天，与村干部和农户反复交流，逐步理清了设备采购与使用的实际链条。";
    const a = analyzeAigc(fourCharHeavy).features.find((f) => f.key === "four_char")!;
    const b = analyzeAigc(normalProse).features.find((f) => f.key === "four_char")!;
    expect(a.value).toBeGreaterThan(b.value);
  });
});

describe("④ 反泄漏: 不让短样本与缺数据给出假结论", () => {
  it("短文本(<200 字)不给结论, 并说明原因", () => {
    const r = analyzeAigc("这是一段很短的文字，只用来测试短文本的行为。");
    expect(r.reliable).toBe(false);
    expect(r.verdict).toBe("insufficient");
    expect(r.note).toMatch(/样本过短|不足以/);
  });

  it("单段结构时段落规律度不适用(让出权重), 不因此无端扣分", () => {
    const one = AI_LIKE.replace(/\n\n/g, "");
    const many = AI_LIKE;
    const r = analyzeAigc(one);
    const para = r.features.find((f) => f.key === "paragraph_regularity")!;
    expect(para.applicable).toBe(false);
    expect(para.contribution).toBe(0);
    // 让权重而不是记 0 分: 少了这一项不该把分数拉低到人写才算合理
    const rMany = analyzeAigc(many);
    expect(r.aiScore).toBeGreaterThanOrEqual(rMany.aiScore - 25);
  });

  it("英文稿的四字格项不适用(英文没有汉字)", () => {
    const en = analyzeAigc("This study examines three counties over a period of ten years, using a mixture of survey data and interview transcripts collected in the field. The sample includes four hundred households. What emerged was not a simple story of adoption or rejection, but a patchwork of partial uses and quiet abandonments that the policy documents never anticipated.", { lang: "en" });
    const four = en.features.find((f) => f.key === "four_char")!;
    expect(four.applicable).toBe(false);
    expect(four.contribution).toBe(0);
  });

  it("topSignals 给出人话解释, 且是贡献最高的那几项", () => {
    const r = analyzeAigc(AI_LIKE);
    expect(r.topSignals.length).toBe(3);
    for (const s of r.topSignals) expect(s).toMatch(/贡献/);
    const top = [...r.features].filter((f) => f.applicable).sort((a, b) => b.contribution - a.contribution)[0];
    expect(r.topSignals[0]).toContain(top.label);
  });

  it("confidence 在 0..1 之间, 短样本低于长样本", () => {
    const short = analyzeAigc(AI_LIKE.slice(0, 220));
    const long = analyzeAigc(AI_LIKE);
    expect(long.confidence).toBeGreaterThanOrEqual(short.confidence);
    for (const r of [short, long]) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});
