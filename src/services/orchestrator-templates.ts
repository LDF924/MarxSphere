// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/orchestrator-templates.ts — V415: 内置编排模板
//
// 由来(2026-09-12 用户指出「工作流只有一个, 没有完整反映 MarxSphere 的所有科研能力」):
//   旧画布把五阶段写死成 makeNodes() 的唯一形态, 用户改不了也存不下, 更看不到其它研究范式。
//   这里把平台上已有的科研能力组织成多条**可编辑的起点** —— 模板不是死的, 选中后就是普通
//   画布, 用户随意增删节点/连线/改参数, 存成自己的图。
//
// 模板与能力的对应: 每个节点的 capabilityId 指向 capability-registry 的条目
//   (tool:<工具名> 或 <工作台能力 id>); 未登记的节点退化为 LLM 生成节点。
import type { MetaSkillDef } from "./meta-skill-runtime.js";

export interface OrchestratorTemplate {
  id: string;
  name: string;
  description: string;
  /** 适用场景(前端模板卡片上的一行提示) */
  scenario: string;
  /** 预估成本量级: light(几次 LLM) / medium(十余次) / heavy(多轮长文) */
  cost: "light" | "medium" | "heavy";
  graph: {
    id: string;
    name: string;
    description: string;
    nodes: Array<{ id: string; capabilityId?: string; title: string; params?: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string }>;
  };
}

/** 顺序连边的小工具 — 模板里大量出现, 手写 edges 数组易错 */
function chain(ids: string[]): Array<{ source: string; target: string }> {
  const out: Array<{ source: string; target: string }> = [];
  for (let i = 0; i + 1 < ids.length; i++) out.push({ source: ids[i], target: ids[i + 1] });
  return out;
}

export const ORCHESTRATOR_TEMPLATES: OrchestratorTemplate[] = [
  // ① 标准五阶段(旧的唯一形态, 现在只是候选之一)
  {
    id: "tpl_five_stage",
    name: "标准五阶段论文",
    description: "信息录入 → 科研架构 → 素材准备 → 文本创作 → 合稿定稿",
    scenario: "从零写一篇完整的政策/理论分析论文",
    cost: "heavy",
    graph: {
      id: "five-stage", name: "标准五阶段论文",
      description: "经典论文生产线: 先定题, 再搭骨架, 再备料, 再写正文, 最后合稿",
      nodes: [
        { id: "intake", capabilityId: "io:clarify", title: "信息录入(澄清主题/对象/方法)" },
        { id: "analyze", capabilityId: "tool:llm_write", title: "科研架构", params: { topic: "为题目《{{outputs.intake}}》设计 5 章详细论证架构, 每章给标题与要点", length: "中" } },
        { id: "materials", capabilityId: "tool:sag_search", title: "素材检索", params: { query: "{{outputs.intake}}", topK: 20 } },
        { id: "material_plan", capabilityId: "tool:llm_write", title: "素材消化与分配", params: { topic: "把检索结果映射到各章节, 标出每章可用素材与缺口:\n{{outputs.materials}}", length: "长" } },
        { id: "draft", capabilityId: "tool:llm_write", title: "章节正文创作", params: { topic: "按架构逐章撰写正文(每章 800 字以上, 带论证与出处):\n架构: {{outputs.analyze}}\n素材: {{outputs.material_plan}}", length: "长" } },
        { id: "gate", capabilityId: "io:quality-gate", title: "定稿前质量门", params: { criteria: "1) 各章齐备且有小标题; 2) 关键论断有依据标注; 3) 有引言与结论; 4) 无空话套话。", text: "{{outputs.draft}}" } },
      ],
      edges: chain(["intake", "analyze", "materials", "material_plan", "draft", "gate"]),
    },
  },

  // ② 文献综述(与既有 MetaSkill 试点同源, 这里给画布形态)
  {
    id: "tpl_lit_review",
    name: "文献综述流水线",
    description: "澄清范围 → 检索 → 综述生成 → 引用检查门(不过则返工重写)",
    scenario: "写一篇有学术脉络的综述, 而不是观点堆砌",
    cost: "medium",
    graph: {
      id: "lit-review", name: "文献综述流水线",
      description: "检索 → 综述 → 引用门(不合格自动走返工备胎)",
      nodes: [
        { id: "clarify", capabilityId: "io:clarify", title: "澄清综述范围" },
        { id: "retrieve", capabilityId: "tool:sag_search", title: "检索文献素材", params: { query: "{{outputs.clarify}}", topK: 8 } },
        { id: "draft", capabilityId: "tool:llm_write", title: "按脉络生成综述", params: { topic: "综述主题: {{outputs.clarify}}\n素材:\n{{outputs.retrieve}}\n\n按 研究缘起→发展脉络→学派分歧→研究共识→现存不足 组织, 每个观点带作者/年份标注。", length: "长" } },
        { id: "citation_gate", capabilityId: "io:quality-gate", title: "引用检查门", params: { criteria: "1) 关键论断都有作者或年份标注; 2) 不含无法核实的具体页码; 3) 呈现脉络而非堆砌。", text: "{{outputs.draft}}" } },
        { id: "retry_writing", capabilityId: "tool:llm_write", title: "返工: 补引用标注", params: { topic: "上一稿引用标注不足, 请重写并给每个论断补 (作者, 年份):\n{{outputs.draft}}", length: "长" } },
      ],
      edges: chain(["clarify", "retrieve", "draft", "citation_gate"]),
    },
  },

  // ③ 概念溯源
  {
    id: "tpl_concept_trace",
    name: "概念溯源",
    description: "检索定义与出处 → 语义演变溯源 → 概念分析撰写",
    scenario: "厘清一个术语在马克思主义理论中的来龙去脉",
    cost: "light",
    graph: {
      id: "concept-trace", name: "概念溯源",
      description: "从定义检索到语义演变的完整链路",
      nodes: [
        { id: "clarify", capabilityId: "io:clarify", title: "确认要溯源的概念" },
        { id: "trace", capabilityId: "tool:concept_trace", title: "概念溯源(平台算法)", params: { concept: "{{outputs.clarify}}" } },
        { id: "retrieve", capabilityId: "tool:sag_search", title: "补充检索经典文本依据", params: { query: "{{outputs.clarify}} 经典文本 原著依据", topK: 10 } },
        { id: "write", capabilityId: "tool:llm_write", title: "撰写概念分析", params: { topic: "基于溯源结果与经典文本, 写一篇概念分析(定义→演变→当代用法→争议):\n溯源: {{outputs.trace}}\n文本: {{outputs.retrieve}}", length: "长" } },
      ],
      edges: chain(["clarify", "trace", "retrieve", "write"]),
    },
  },

  // ④ 实证全链
  {
    id: "tpl_empirical",
    name: "实证研究全链",
    description: "问卷识别 → 数据版本 → 信效度 → 统计/回归 → 图表",
    scenario: "有问卷数据, 要从清洗一路做到出图",
    cost: "medium",
    graph: {
      id: "empirical", name: "实证研究全链",
      description: "对齐实证研究台的面板操作顺序, 结果全部落回实证库",
      nodes: [
        { id: "clarify", capabilityId: "io:clarify", title: "确认数据与假设" },
        { id: "reliability", capabilityId: "emp:reliability", title: "信效度检验" },
        { id: "describe", capabilityId: "stat:run", title: "描述统计", params: { method: "describe" } },
        { id: "crosstab", capabilityId: "stat:run", title: "交叉表", params: { method: "crosstab" } },
        { id: "regression", capabilityId: "emp:regression", title: "回归分析" },
        { id: "viz", capabilityId: "viz:render", title: "结果可视化", params: { prompt: "把回归系数与显著性画成分组柱状图, 标注 ***/**/*" } },
      ],
      edges: chain(["clarify", "reliability", "describe", "crosstab", "regression", "viz"]),
    },
  },

  // ⑤ 投稿全链
  {
    id: "tpl_submission",
    name: "投稿全链(写→审→修→格式)",
    description: "正文 → 质量评审 → 按意见修改 → 引文核验 → 格式评测",
    scenario: "稿件快投出去前的自检闭环",
    cost: "medium",
    graph: {
      id: "submission", name: "投稿全链",
      description: "审稿意见驱动返工: 评审不过走修改节点",
      nodes: [
        { id: "source", capabilityId: "io:clarify", title: "粘贴待投稿件" },
        { id: "review", capabilityId: "review:paper", title: "论文质量评审" },
        { id: "revise", capabilityId: "tool:llm_write", title: "按审稿意见修改", params: { topic: "按下面审稿意见逐条修改稿件(保留原意, 不回避问题):\n意见: {{outputs.review}}\n原稿: {{outputs.source}}", length: "长" } },
        { id: "citation", capabilityId: "citation:verify", title: "引文核验" },
        { id: "format", capabilityId: "format:eval", title: "格式智能评测" },
      ],
      edges: chain(["source", "review", "revise", "citation", "format"]),
    },
  },

  // ⑥ 经典文本研究
  {
    id: "tpl_classical",
    name: "经典文本研究",
    description: "概念溯源 → 论证拆解 → 互文对照 → 版本校勘 → 综合阐释",
    scenario: "读经典原著做文本细读(五场景并联)",
    cost: "medium",
    graph: {
      id: "classical", name: "经典文本研究",
      description: "四个分析视角从同一份原文出发并联, 最后综合",
      nodes: [
        { id: "source", capabilityId: "io:clarify", title: "录入原文段落/篇目" },
        { id: "concept", capabilityId: "classical:concept-trace", title: "概念溯源" },
        { id: "argument", capabilityId: "classical:argument-structure", title: "论证拆解" },
        { id: "intertext", capabilityId: "classical:intertextual", title: "互文对照" },
        { id: "collation", capabilityId: "classical:collation", title: "版本校勘" },
        { id: "synthesize", capabilityId: "tool:llm_write", title: "综合阐释", params: { topic: "综合四个视角的结果, 写一篇文本阐释:\n概念: {{outputs.concept}}\n论证: {{outputs.argument}}\n互文: {{outputs.intertext}}\n校勘: {{outputs.collation}}", length: "长" } },
      ],
      // 四个视角并联(都只依赖 source), 最后汇入综合节点 —— 这就是"边决定执行计划"的直观例子
      edges: [
        { source: "source", target: "concept" },
        { source: "source", target: "argument" },
        { source: "source", target: "intertext" },
        { source: "source", target: "collation" },
        { source: "concept", target: "synthesize" },
        { source: "argument", target: "synthesize" },
        { source: "intertext", target: "synthesize" },
        { source: "collation", target: "synthesize" },
      ],
    },
  },

  // ⑦ 学术脉络研究
  {
    id: "tpl_academic_map",
    name: "学术脉络研究",
    description: "学派脉络 → 观点对比 → 争鸣还原 → 学者谱系 → 前沿研判 → 综述",
    scenario: "摸清一个研究领域的版图与分歧",
    cost: "medium",
    graph: {
      id: "academic-map", name: "学术脉络研究",
      description: "五路学术分析并联后综合成领域综述",
      nodes: [
        { id: "source", capabilityId: "io:clarify", title: "确认研究领域" },
        { id: "school", capabilityId: "academic:school", title: "学派脉络" },
        { id: "views", capabilityId: "academic:view-comparison", title: "观点对比" },
        { id: "debate", capabilityId: "academic:debate", title: "争鸣还原" },
        { id: "scholar", capabilityId: "academic:scholar", title: "学者谱系" },
        { id: "frontier", capabilityId: "academic:frontier", title: "学科前沿" },
        { id: "survey", capabilityId: "tool:llm_write", title: "领域综述", params: { topic: "综合五路分析, 写领域综述:\n学派: {{outputs.school}}\n观点: {{outputs.views}}\n争鸣: {{outputs.debate}}\n谱系: {{outputs.scholar}}\n前沿: {{outputs.frontier}}", length: "长" } },
      ],
      edges: [
        { source: "source", target: "school" },
        { source: "source", target: "views" },
        { source: "source", target: "debate" },
        { source: "source", target: "scholar" },
        { source: "source", target: "frontier" },
        { source: "school", target: "survey" },
        { source: "views", target: "survey" },
        { source: "debate", target: "survey" },
        { source: "scholar", target: "survey" },
        { source: "frontier", target: "survey" },
      ],
    },
  },

  // ⑧ 选题与投稿策略(政经C刊方法论)
  {
    id: "tpl_cjournal",
    name: "政经C刊选题",
    description: "四步法选题 → 期刊匹配 → 编辑校验 → 论证补全",
    scenario: "面向 C 刊的选题打磨与投稿策略",
    cost: "light",
    graph: {
      id: "cjournal", name: "政经C刊选题",
      description: "选题方法论落地: 先立题, 再挑刊, 再按编辑标准自查",
      nodes: [
        { id: "source", capabilityId: "io:clarify", title: "确认研究兴趣与积累" },
        { id: "topic", capabilityId: "cjournal:topic", title: "选题生成(四步法/矩阵/悖论)" },
        { id: "corpus", capabilityId: "corpus:recall", title: "召回高级句式与论证框架" },
        { id: "editor_check", capabilityId: "io:quality-gate", title: "编辑标准校验", params: { criteria: "1) 问题意识明确且不是伪问题; 2) 有理论对话对象; 3) 创新点可一句话说清; 4) 符合马理论学科范式。", text: "{{outputs.topic}}" } },
        { id: "strengthen", capabilityId: "tool:llm_write", title: "论证补全与成文", params: { topic: "把选题打磨成投稿摘要与论证框架(借语料库句式, 不照抄):\n选题: {{outputs.topic}}\n句式素材: {{outputs.corpus}}", length: "长" } },
      ],
      edges: chain(["source", "topic", "corpus", "editor_check", "strengthen"]),
    },
  },

  // ⑨ 从文献到综述(检索密集型)
  {
    id: "tpl_retrieval_heavy",
    name: "多源检索汇编",
    description: "知识库 + 外部学术 + 文献库 三路检索并联 → 去重汇编 → 综述",
    scenario: "手上文献不够, 需要先把材料找齐",
    cost: "medium",
    graph: {
      id: "retrieval-heavy", name: "多源检索汇编",
      description: "三路检索并联(平台四源混合的能力在编排层的直白表达)",
      nodes: [
        { id: "source", capabilityId: "io:clarify", title: "确认检索主题" },
        { id: "kb", capabilityId: "tool:sag_search", title: "知识库检索", params: { query: "{{outputs.source}}", topK: 15 } },
        { id: "external", capabilityId: "tool:view_sciverse_search", title: "外部学术检索", params: { query: "{{outputs.source}}" } },
        { id: "library", capabilityId: "tool:view_literature_search", title: "文献库检索", params: { query: "{{outputs.source}}" } },
        { id: "policy", capabilityId: "tool:policy_search", title: "政策文件检索", params: { query: "{{outputs.source}}" } },
        { id: "merge", capabilityId: "tool:llm_write", title: "去重汇编与综述", params: { topic: "把四路检索结果去重后汇编成综述(标注每条来源):\n知识库: {{outputs.kb}}\n外部: {{outputs.external}}\n文献库: {{outputs.library}}\n政策: {{outputs.policy}}", length: "长" } },
      ],
      edges: [
        { source: "source", target: "kb" },
        { source: "source", target: "external" },
        { source: "source", target: "library" },
        { source: "source", target: "policy" },
        { source: "kb", target: "merge" },
        { source: "external", target: "merge" },
        { source: "library", target: "merge" },
        { source: "policy", target: "merge" },
      ],
    },
  },

  // ⑩ 空画布
  {
    id: "tpl_blank",
    name: "空白画布",
    description: "从零自由编排 —— 从能力面板里挑节点自己连",
    scenario: "已有明确流程, 想自己搭",
    cost: "light",
    graph: {
      id: "blank", name: "空白画布", description: "自己挑能力、自己连线",
      nodes: [{ id: "start", capabilityId: "io:clarify", title: "起点(澄清需求)" }],
      edges: [],
    },
  },
];

export function getTemplate(id: string): OrchestratorTemplate | undefined {
  return ORCHESTRATOR_TEMPLATES.find((t) => t.id === id);
}

/** 模板 → MetaSkillDef(执行时用; capabilityId 由 capability-registry 解释成步骤) */
export function templateToMetaSkill(t: OrchestratorTemplate): MetaSkillDef {
  return {
    id: t.graph.id,
    name: t.name,
    description: t.description,
    steps: [], // 由 orchestrator-service 用 graphToMetaSkill 填(需要能力表)
  };
}
