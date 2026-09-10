// 冒烟: 14 个 AI 助手按钮 → 后端执行路径, 逐条实测(真 LLM 调用, 串行避免打爆端点)
// 用法: npx tsx scripts/smoke-editor-ai.ts [仅跑指定 id, 逗号分隔]
import { rewriteText, checkFulltext, generateTitleAbstract, formatReferences } from "../src/services/editor-service.js";

const DOC = `数字经济赋能共同富裕的机制与路径研究

摘要: 本文基于 2011-2022 年中国省级面板数据, 采用固定效应模型考察数字经济对共同富裕的影响及其作用机制。研究发现, 数字经济显著提升了共同富裕水平, 且该效应在中西部地区更为明显。

一、引言
共同富裕是社会主义的本质要求。既有研究多从收入分配角度切入, 但较少关注数字技术带来的结构性变化。本文试图回答: 数字经济通过何种机制影响共同富裕?

二、研究设计
2.1 变量测度
被解释变量为共同富裕指数(采用熵值法测度)。核心解释变量为数字经济发展水平。控制变量包括人均GDP、产业结构、城镇化率。
2.2 模型设定
本文构建如下面板固定效应模型: 共同富裕指数 = α + β*数字经济 + γ*控制变量 + 个体固定效应 + 时间固定效应 + ε。

三、实证结果
回归结果显示, 数字经济的系数为 0.237, 在 1% 水平上显著。这说明数字经济发展显著促进共同富裕。分区域看, 中西部地区效应更强(0.312), 东部地区较弱(0.145)。

四、机制分析
本文认为, 数字经济可能通过促进就业和提升公共服务可及性来推动共同富裕。但这一机制尚未充分检验。

五、结论与政策建议
第一, 大力发展数字经济。第二, 重视区域差异。第三, 完善数字基础设施。

参考文献
[1] 张三. 数字经济与收入分配[J]. 经济研究, 2021(3).
[2] 李四. 共同富裕的理论内涵[J]. 中国社会科学, 2022.
[3] 王五. 数字鸿沟问题研究[J]. 管理世界, 2020(8).
[4] 赵六. 区域协调发展研究[J]. 数量经济技术经济研究, 2019(5).`;

type Row = { id: string; label: string; run: () => Promise<{ ok: boolean; chars: number; sample: string; detail: string }> };

const brief = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

const cases: Row[] = [
  // ── 全文检查 4 ──
  { id: "logic_check", label: "全文逻辑检查", run: async () => { const r = await checkFulltext(DOC, "logic"); const f = r.checks[0]?.findings ?? []; return { ok: r.checks.length > 0 && r.modeName === "全文逻辑检查", chars: f.join("").length, sample: brief(f[0], 200), detail: `modeName=${r.modeName} findings=${f.length}` }; } },
  { id: "section_coherence_check", label: "章节衔接检查", run: async () => { const r = await checkFulltext(DOC, "cohesion"); const f = r.checks[0]?.findings ?? []; return { ok: r.checks.length > 0 && r.modeName === "章节衔接检查", chars: f.join("").length, sample: brief(f[0], 200), detail: `modeName=${r.modeName} findings=${f.length}` }; } },
  { id: "variable_method_conclusion_check", label: "变量-方法-结论一致性", run: async () => { const r = await checkFulltext(DOC, "consistency"); const f = r.checks[0]?.findings ?? []; return { ok: r.checks.length > 0 && r.modeName === "变量-方法-结论一致性", chars: f.join("").length, sample: brief(f[0], 200), detail: `modeName=${r.modeName} findings=${f.length}` }; } },
  { id: "submission_check", label: "投稿前检查", run: async () => { const r = await checkFulltext(DOC, "submission"); const f = r.checks[0]?.findings ?? []; return { ok: r.checks.length > 0 && r.modeName === "投稿前检查", chars: f.join("").length, sample: brief(f[0], 200), detail: `modeName=${r.modeName} findings=${f.length}` }; } },

  // ── 选区修改 5(送真实 mode + 上下文) ──
  { id: "academic_polish", label: "学术润色", run: async () => { const r = await rewriteText("polish", "共同富裕是社会主义的本质要求。既有研究多从收入分配角度切入, 但较少关注数字技术带来的结构性变化。", "上下文: 本文研究数字经济与共同富裕。"); return { ok: r.text.length > 20 && r.text !== "", chars: r.text.length, sample: brief(r.text, 200), detail: "带上下文改写" }; } },
  { id: "reduce_ai_tone", label: "减少模板化表达", run: async () => { const r = await rewriteText("de-template", "本文认为, 数字经济可能通过促进就业和提升公共服务可及性来推动共同富裕。但这一机制尚未充分检验。"); return { ok: r.text.length > 20, chars: r.text.length, sample: brief(r.text, 200), detail: "去模板" }; } },
  { id: "compress_redundancy", label: "压缩冗余", run: async () => { const r = await rewriteText("condense", "共同富裕是社会主义的本质要求。共同富裕也是中国式现代化的重要特征。共同富裕的实现需要长期努力, 需要全社会共同奋斗, 需要制度保障。"); return { ok: r.text.length > 5 && r.text.length < 100, chars: r.text.length, sample: brief(r.text, 200), detail: "应短于原文 108 字" }; } },
  { id: "expand_argument", label: "扩展论证", run: async () => { const r = await rewriteText("expand", "数字经济可能通过促进就业来推动共同富裕。"); return { ok: r.text.length > 20, chars: r.text.length, sample: brief(r.text, 200), detail: "应长于原文 20 字" }; } },
  { id: "proofread", label: "校对标点", run: async () => { const r = await rewriteText("proofread", "本文的样本区间是2011-2022年，研究方法采用固定效应模型（FE），结果显示系数为0.237"); return { ok: r.text.length > 5, chars: r.text.length, sample: brief(r.text, 200), detail: "错标点修正" }; } },

  // ── 题名摘要 3 ──
  { id: "title_optimize", label: "优化论文标题", run: async () => { const r = await generateTitleAbstract(DOC, "title"); return { ok: !!r.title && !r.abstract && !r.keywords.length, chars: r.title.length, sample: brief([r.title, ...(r.alternatives ?? [])].join(" | "), 240), detail: `title=${!!r.title} abstract=${!!r.abstract} keywords=${r.keywords.length} (应只出标题)` }; } },
  { id: "abstract_optimize", label: "优化摘要", run: async () => { const r = await generateTitleAbstract(DOC, "abstract"); return { ok: !!r.abstract && !r.title && !r.keywords.length, chars: r.abstract.length, sample: brief(r.abstract, 240), detail: `abstract=${!!r.abstract} title=${!!r.title} issues=${(r.issues ?? []).length} (应只出摘要)` }; } },
  { id: "keywords_generate", label: "提取关键词", run: async () => { const r = await generateTitleAbstract(DOC, "keywords"); return { ok: r.keywords.length >= 3 && !r.title && !r.abstract, chars: r.keywords.join("/").length, sample: brief(r.keywords.join(" / "), 200), detail: `keywords=${r.keywords.length} title=${!!r.title} (应只出关键词)` }; } },

  // ── 引用格式 2 ──
  { id: "citation_consistency_check", label: "引用一致性检查", run: async () => { const r = await formatReferences(DOC, "consistency"); return { ok: r.fixes.length > 0, chars: r.fixes.join("").length, sample: brief(r.fixes.join(" ‖ "), 240), detail: `fixes=${r.fixes.length} stats=${JSON.stringify(r.stats ?? {})} text=${r.text ? "有" : "空"}(一致性检查不应输出正文)` }; } },
  { id: "format_check", label: "格式与语言检查", run: async () => { const r = await formatReferences(DOC, "format"); return { ok: r.fixes.length > 0 || !!r.text, chars: (r.text + r.fixes.join("")).length, sample: brief(r.fixes.join(" ‖ "), 240), detail: `fixes=${r.fixes.length} text=${r.text.length}字(应输出规范化文献列表)` }; } },
];

const only = process.argv[2]?.split(",").map((s) => s.trim()).filter(Boolean);
const list = only?.length ? cases.filter((c) => only.includes(c.id)) : cases;

const results: Array<{ id: string; label: string; ok: boolean; ms: number; chars: number; sample: string; detail: string; err?: string }> = [];
for (const c of list) {
  const t0 = Date.now();
  process.stderr.write(`▶ ${c.label} ... `);
  try {
    const r = await c.run();
    const ms = Date.now() - t0;
    results.push({ id: c.id, label: c.label, ok: r.ok, ms, chars: r.chars, sample: r.sample, detail: r.detail });
    process.stderr.write(`${r.ok ? "PASS" : "FAIL"} ${ms}ms\n`);
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ id: c.id, label: c.label, ok: false, ms, chars: 0, sample: "", detail: "", err: e instanceof Error ? e.message : String(e) });
    process.stderr.write(`ERROR ${ms}ms\n`);
  }
}

console.log(JSON.stringify(results, null, 2));
const passed = results.filter((r) => r.ok).length;
console.error(`\n═══ ${passed}/${results.length} PASS ═══`);
for (const r of results.filter((x) => !x.ok)) console.error(`FAIL ${r.id}: ${r.err ?? r.detail}`);
