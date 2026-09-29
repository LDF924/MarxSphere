// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
/**
 * proposal-service.ts — 开题报告 / 基金申报 / 伦理审查 / 预注册。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 由来(2026-09-26 全流程审计): 这四件事平台**后端零实现**。
 *
 * 站内仅有的提及全是**提示文案**, 且都指向用户本机的技能包:
 *   · `scenario-guides.ts:48` 「预注册研究方案」 —— 让用户自己去找 research-proposal 技能;
 *   · `scenario-guides.ts:413` 「伦理披露检查」 —— 同上;
 *   · 开题与基金申报**连提示都没有**。
 * 而 `research-exec-engine` 的 phase5 只覆盖"已有正文之后"的事 ——
 * 项目**开始之前**要交的那几份材料, 平台一样都不出。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么单独一个服务而不是给 `paper-outline-service` 加 kind:
 *   那边是"论文要件"(摘要/关键词/结论/讨论) —— 短、单块、附在正文上;
 *   这里是"项目文书" —— 长、多节、有自己的递交流程, 且**在研究开始之前**就要有。
 *   塞在一起会让边界的 kind 表越来越长, 而两类的输入也完全不同
 *   (要件吃正文, 文书吃研究设计)。
 *
 * ⚠ **落库口径**: 结果写进 `research_nodes` 的 `proposal` 节点(多份文稿装在同一个节点里,
 *   按 kind 分键)。为什么不分节点: 节点是按"阶段"分的, 而这四份是同一阶段
 *   (研究开始前)的四种材料, 拆开会让节点表里多出四个只写一次、之后再没改动的键。
 *
 * ⚠ **不生成"审稿意见式的评价"**: 基金申报那节写的是**申请书正文**, 不是"评审意见"。
 *   平台上另有审稿能力, 那是给别人看稿用的, 与这里不是一回事。
 */
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm } from "../ai/llm-common.js";

export type ProposalKind = "proposal" | "grant" | "ethics" | "prereg";

export interface ProposalSection {
  /** 小节标题(受理方按它核对材料完整性) */
  title: string;
  /** 这一节要写什么 —— 直接进 prompt */
  spec: string;
  /** 篇幅要求(字) */
  words?: string;
}

export interface ProposalSpec {
  key: ProposalKind;
  cn: string;
  /** 这类材料通常交给谁 —— 影响语气与详略 */
  audience: string;
  /** 固定节次。**顺序即提交顺序**, 不是随意排的 */
  sections: ProposalSection[];
  /** 这类材料特有的总要求 */
  extra?: string;
}

/**
 * 四类文书的固定结构。
 *
 * 节次取自**真实表格**的顺序, 不是自己编的 —— 用户拿去就要对着表格填,
 * 顺序错了会让人怀疑整个工具。所以每一类都按受理方的材料清单排。
 */
export const PROPOSAL_SPECS: readonly ProposalSpec[] = Object.freeze([
  {
    key: "proposal",
    cn: "开题报告",
    audience: "导师与开题答辩组",
    sections: [
      { title: "一、选题依据与研究意义", spec: "从现实问题与学术空白两方面说明为什么要做这个题。要能看出问题是怎么被提出来的, 而不是直接给结论。", words: "600-900" },
      { title: "二、国内外研究现状述评", spec: "按**学术脉络**梳理(不是按文献罗列): 已有研究解决了什么、留下了什么缺口、本文补哪一个。要具体到观点与分歧。", words: "1200-1800" },
      { title: "三、研究问题与研究假设", spec: "把研究问题写成可回答的具体问题; 若有假设, 逐条编号(H1/H2…), 每条都必须是可检验的。", words: "400-600" },
      { title: "四、研究内容与研究方法", spec: "研究内容分点列出; 方法要与研究问题**一一对应** —— 说明每种方法回答的是哪个问题。", words: "800-1200" },
      { title: "五、研究设计与技术路线", spec: "数据来源/样本/变量/分析策略。技术路线用文字描述清楚流程(不画图)。", words: "600-900" },
      { title: "六、进度安排", spec: "按阶段列时间与任务。要与前面的研究内容对得上, 不能是通用模板。", words: "300-500" },
      { title: "七、预期成果与创新点", spec: "成果形式(论文/报告/数据库等)与创新点。创新点要说清**相对于第二部分的哪个缺口**。", words: "300-500" },
    ],
    extra: "开题报告是**说服别人这个题值得做**, 不是展示已完成了什么。语气要论证而非汇报。",
  },
  {
    key: "grant",
    cn: "基金申报书",
    audience: "基金评审专家",
    sections: [
      { title: "一、立项依据", spec: "研究意义 + 国内外研究现状 + 本课题的研究价值。评审最看这一段, 要写实。", words: "1500-2500" },
      { title: "二、研究内容、目标与拟解决的关键问题", spec: "研究内容分点; 研究目标要可考核; 关键问题要说清难在哪、为什么绕不过去。", words: "800-1200" },
      { title: "三、研究方案及可行性分析", spec: "方法、技术路线、实验/调研方案; 可行性要有依据(前期基础/数据可得/方法成熟)。", words: "1000-1500" },
      { title: "四、特色与创新之处", spec: "**相对于已有研究**的新意。不要写「首次」「填补空白」这类没有依据的话 —— 评审最反感。", words: "400-600" },
      { title: "五、研究基础与工作条件", spec: "前期成果、团队、数据与设备条件。要与前面的方案对得上。", words: "400-600" },
      { title: "六、经费预算说明", spec: "按支出科目列出并说明依据。**不编具体金额**, 只写科目与用途(金额由申请人按单位口径填)。", words: "300-500" },
      { title: "七、预期成果", spec: "成果形式与数量。要与研究内容匹配, 不虚报。", words: "200-400" },
    ],
    extra: "这是**申请书正文**, 不是评审意见。用申请人的第一人称口径写。评审专家最反感两件事: 没有依据的「首次/填补空白」, 以及与方案对不上的进度与预算。",
  },
  {
    key: "ethics",
    cn: "伦理审查材料",
    audience: "单位伦理委员会",
    sections: [
      { title: "一、研究目的与必要性", spec: "说清研究要回答什么问题、为什么必须涉及人或敏感数据。", words: "300-500" },
      { title: "二、研究对象与招募方式", spec: "对象范围、样本量、纳入与排除标准、招募途径。**涉及弱势群体要专门说明保护措施**。", words: "500-800" },
      { title: "三、知情同意", spec: "如何告知、何时获取、是否书面、未成年人等如何取得监护人同意。", words: "300-500" },
      { title: "四、风险与收益评估", spec: "分身体/心理/社会/经济四类风险逐条评估; 说明最小化风险的措施与预期收益。", words: "400-600" },
      { title: "五、隐私保护与数据管理", spec: "去标识化方式、存储位置与期限、谁能接触、共享与销毁安排。", words: "300-500" },
      { title: "六、伦理问题与应对", spec: "逐条列出本研究的伦理风险点与对应措施(如敏感问题跳答、退出机制)。", words: "300-500" },
      { title: "七、利益冲突声明", spec: "有无利益冲突及其处置。无则明确写「无」。", words: "100-200" },
    ],
    extra: "伦理材料要**具体到可核查**。写「保护隐私」没有用, 要写清去标识化怎么做、数据存哪、存多久。涉及弱势群体时必须单独成段说明保护措施。",
  },
  {
    key: "prereg",
    cn: "预注册方案",
    audience: "预注册平台 / 期刊",
    sections: [
      { title: "一、研究问题与假设", spec: "逐条编号列出。**预注册要求假设在见数据之前就固定下来**, 所以措辞要可检验、不含模糊词。", words: "400-600" },
      { title: "二、研究设计", spec: "设计类型、分组、条件、操纵或干预。要具体到别人能照做。", words: "500-800" },
      { title: "三、样本与数据来源", spec: "总体、抽样方式、计划样本量、**样本量依据**(功效分析或经验规则)。", words: "400-600" },
      { title: "四、变量与测量", spec: "自变量/因变量/控制变量各自的操作化定义与测量工具(含量表来源与信度)。", words: "500-800" },
      { title: "五、分析计划", spec: "按假设逐条写分析策略与判据。**必须写明什么结果算支持、什么算不支持**。", words: "600-900" },
      { title: "六、排除标准与数据清理", spec: "哪些样本会被排除、依据是什么、在分析前还是分析后。", words: "200-400" },
      { title: "七、已知局限", spec: "在设计层面就承认的局限, 以及为什么接受它们。", words: "200-400" },
    ],
    extra: "预注册的核心是**把决策写在见数据之前**。凡是「看情况」「视结果而定」的写法都要具体化 —— 这正是预注册要防的东西。",
  },
]);

export function getSpec(kind: string): ProposalSpec | undefined {
  return PROPOSAL_SPECS.find((s) => s.key === kind);
}

export interface ProposalInput {
  kind: string;
  /** 研究主题/课题名 */
  topic: string;
  /** 研究设计摘要(方法/样本/数据源), 来自 design 节点 */
  design?: string;
  /** 文献基础摘要, 来自素材/文献矩阵 */
  literature?: string;
  /** 研究证据摘要(假设台账/发现), 来自 research-evidence-service */
  evidence?: string;
  /** 学科/领域 */
  discipline?: string;
  /** 其他要求(申请人补充) */
  requirements?: string;
  model?: string;
}

export interface ProposalResult { ok: boolean; kind: string; title: string; content: string; error?: string }

/**
 * 生成一份文书。
 *
 * ⚠ **逐节生成而不是一次出全文**: 七节加起来 4000-8000 字, 一次性输出会撞 maxTokens,
 *   而且模型会为了"写完整"把后面几节草草收尾(实测那几节明显更空)。
 *   逐节的代价是多次调用, 但每节都能写实; 而且**某一节失败不影响其它节** ——
 *   这对一份要交的材料很重要: 宁可少一节让人补, 也不要整篇拿不到。
 */
export async function generateProposal(input: ProposalInput): Promise<ProposalResult> {
  const spec = getSpec(input.kind);
  if (!spec) return { ok: false, kind: String(input.kind), title: "", content: "", error: `未知的文书类型: ${input.kind}` };
  const ep = getLlmEndpoint({ model: input.model || getRoleModel("editor") });
  const topic = String(input.topic ?? "").trim();
  if (!topic) return { ok: false, kind: spec.key, title: spec.cn, content: "", error: "缺少研究主题" };

  const ctx = [
    `【研究主题】${topic}`,
    input.discipline ? `【学科领域】${input.discipline}` : "",
    input.design ? `【研究设计(方法/样本/数据源)】\n${String(input.design).slice(0, 3000)}` : "",
    input.literature ? `【文献基础】\n${String(input.literature).slice(0, 4000)}` : "",
    input.evidence ? `【已有研究证据(假设台账/发现)】\n${String(input.evidence).slice(0, 3000)}` : "",
    input.requirements ? `【申请人补充要求】\n${String(input.requirements).slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n\n");

  const parts: string[] = [`# ${spec.cn}`, "", `> 面向：${spec.audience}`, ""];
  if (spec.extra) parts.push(`> 口径要求：${spec.extra}`, "");
  const failures: string[] = [];

  for (const sec of spec.sections) {
    const r = await generateSection(ep, spec, sec, ctx, topic).catch((e) => {
      failures.push(`${sec.title}: ${String((e as Error).message ?? e).slice(0, 80)}`);
      return "";
    });
    if (r) parts.push(`## ${sec.title}`, "", r, "");
    else parts.push(`## ${sec.title}`, "", "_(本节未能生成, 请手工补写)_", "");
  }

  return {
    ok: true,
    kind: spec.key,
    title: spec.cn,
    content: parts.join("\n").trimEnd() + "\n",
    ...(failures.length ? { error: `部分小节未生成 —— ${failures.join("；")}` } : {}),
  };
}

async function generateSection(
  ep: { url: string; key: string; model: string },
  spec: ProposalSpec,
  sec: ProposalSection,
  ctx: string,
  topic: string,
): Promise<string> {
  const prompt = `你是人文社科研究方法的写作专家。现在要写一份「${spec.cn}」中的一节, 读者是${spec.audience}。

${ctx}

【本次要写的这一节】${sec.title}
【这一节要写什么】${sec.spec}
【篇幅】${sec.words ?? "400-600"} 字

要求:
1. **只写这一节**, 不要重复其它小节的内容, 不要写"综上所述"这类与别节呼应的收尾;
2. 有【研究设计】【文献基础】【研究证据】可依据时必须与之**一致** —— 不得另编数据、样本量或文献;
   依据不足的地方**宁可写得概括**, 也不要编造具体数字与文献;
3. ${spec.extra ?? ""}
4. 直接输出这一节的正文 markdown(不要标题、不要代码块围栏、不要任何解释)。`;

  const r = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5, maxTokens: 3000, timeoutMs: 240_000,
  });
  const text = String(r?.text ?? "").replace(/^```(markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!text) throw new Error("LLM 无响应");
  return text;
}

/**
 * 把四份文书拼成一份可导出的合集。
 *
 * 只导出**已生成的** —— 没生成过的类型不占位(空标题会让受理方以为"写了但没内容")。
 */
export function proposalsToMarkdown(all: Record<string, { content?: string } | undefined>, projectTitle = ""): string {
  const order: ProposalKind[] = ["proposal", "grant", "ethics", "prereg"];
  const lines = [`# ${projectTitle || "研究项目"} · 申报与审查材料`, ""];
  let n = 0;
  for (const k of order) {
    const c = String(all?.[k]?.content ?? "").trim();
    if (!c) continue;
    n++;
    lines.push(c, "", "---", "");
  }
  if (!n) return "";
  return lines.join("\n").trimEnd() + "\n";
}
