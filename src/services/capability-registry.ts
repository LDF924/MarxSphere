// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/capability-registry.ts — V415: 编排能力注册表(单一真源)
//
// 由来: 此前「课题流程编排」画布把节点写死成 5 个 phrase + 4 个模块(QuickModeView 的
//   makeNodes/MODULE_DEFS), 而 MarxSphere 实际有 75 个 agent 工具(48 静态 + 22 view_* + 插件)、
//   270+ service、740 条路由。画布上能看到的 < 能用到的 1%。本注册表把可编排的能力收成一张表:
//     ① agent 工具(buildAgentTools, 动态导出, 含 view_* 与插件工具)
//     ② 工作台能力(实证/统计/审稿/绘图/编辑器/格式评测/引文核验/经典文本/C刊/语料库…)
//        —— 这些当前只有 HTTP 端点, 这里用声明式 step(run 端点 / tool_call / llm_chat) 接入
//     ③ 编排模板(orchestrator-templates.ts) — 画布起点
//   前端 /workbench/quick 从 /api/orchestrator/capabilities 拉节点, 不再写死。
//
// 关于 import: 本模块从 agent-tool-router 动态导入 buildAgentTools(见 listToolCapabilities),
//   因为 tool-router 自己也会动态导入一堆业务 service —— 顶层静态导入会把启动期依赖图拉长。
import type { MetaStepDef, MetaSkillDef } from "./meta-skill-runtime.js";

/** 能力分类(前端按此分组渲染"可选节点"面板) */
export type CapabilityCategory =
  | "检索" | "推理" | "写作" | "实证" | "统计" | "审稿" | "绘图"
  | "编辑" | "格式" | "引文" | "经典" | "教育" | "知识" | "文件" | "通用";
/** 能力实现方式 — 决定运行时怎么执行 */
export type CapabilityKind =
  /** 复用 agent 工具注册表(有 params schema + risk) */
  | "agent_tool"
  /** 调 MarxSphere HTTP 端点(工作台能力) */
  | "endpoint"
  /** 单次 LLM 生成 */
  | "llm_chat"
  /** 质量门 / 分类(闭集) */
  | "llm_gate"
  /** 暂停收集用户输入 */
  | "user_input";

export interface CapabilityDef {
  id: string;
  label: string;
  category: CapabilityCategory;
  kind: CapabilityKind;
  description: string;
  /** 输入端口(画布上节点左侧, 产物按边传入 → 渲染进 with) */
  inputs: string[];
  /** 输出端口(画布上节点右侧, 落 ctx.outputs[id]) */
  outputs: string[];
  /** 危险级别: safe 直接执行 / review 需审批 / deny 默认禁止 */
  risk: "safe" | "review" | "deny";
  /**
   * V415: 成本量级 —— 画布上给用户预判"这一条编排要花多少"。
   *   light  纯检索/规则, 几乎不烧 LLM(知识库/文献库/政策检索、代码搜索…)
   *   medium 单次 LLM 生成或单次工作台任务(写作/摘要/单张图/一次统计)
   *   heavy  长文生成、多轮、沙箱执行(综述/五阶段正文/回归跑码)
   * 这是**量级**不是精确预算: 能力内部还会按输入长度放大, 精确成本看运行结束后的账本。
   */
  cost: "light" | "medium" | "heavy";
  /** 升到 agent_tool 时用的工具名 */
  tool?: string;
  /** endpoint 型: 相对路径 + 请求体模板 */
  endpoint?: { path: string; method?: "GET" | "POST"; body?: Record<string, unknown> };
  /** 产物落到哪里(供前端"产物"面板直接打开对应工作台) */
  artifact?: { where: string; label: string };
  /** 生成的 MetaSkill 步骤(运行时解释; 模板里可作为起点被改写) */
  step: MetaStepDef;
  /** 参数提示(画布节点的可编辑字段, 供面板表单渲染) */
  fields?: Array<{ name: string; label: string; type: "string" | "number" | "boolean"; required?: boolean; placeholder?: string; default?: string }>;
}

// ─── agent 工具 → 编排能力(全部 48 个, 从 buildAgentTools 动态导出) ───

/** 工具名 → 分类(未列出的按通用) */
const TOOL_CATEGORY: Record<string, CapabilityCategory> = {
  sag_search: "检索", sag_retrieve: "检索", sag_get_event: "检索", sag_ingest: "知识",
  sag_reason: "推理", concept_trace: "推理", policy_search: "检索", wiki_query: "知识", wiki_graph: "知识",
  llm_write: "写作", summarize: "写作", gongwen_draft: "写作", video_note: "写作",
  empirical_analysis: "实证", format_eval: "格式", forensics_scan: "审稿", review_output: "审稿",
  chart_template: "绘图", doc_edit: "编辑",
  education_service: "教育", get_learner_context: "教育", record_learning_event: "教育",
  patch_learner_profile: "教育", assess_learning_prerequisites: "教育", review_learner_profile: "教育",
  run_code: "通用", runtime_exec: "通用", run_command: "通用", code_search: "通用",
  web_search: "检索", web_fetch: "检索", browser_control: "通用", computer_use: "通用",
  file_read: "文件", file_write: "文件", attachment_read: "文件", provenance_query: "文件", snapshot_take: "文件",
  image_analyze: "文件", audio_transcribe: "文件", github_repo: "通用", agent_subagent: "通用",
  apply_patch: "文件", todo_update: "通用", retrieve_tool_result: "通用",
  b5_ensemble: "推理", meta_invoke: "通用", meta_list: "通用",
};

/**
 * V415: 工具名 → 成本量级。未列出的按 medium(大多数工具底层都会打一次 LLM 或端点)。
 * 判据是"这一步会不会产生 LLM/沙箱开销", 不是耗时。
 */
const TOOL_COST: Record<string, "light" | "medium" | "heavy"> = {
  // 纯检索/读取: 不打 LLM(或只走 embedding), 便宜
  sag_search: "light", sag_retrieve: "light", sag_get_event: "light", policy_search: "light",
  wiki_query: "light", wiki_graph: "light", code_search: "light", file_read: "light",
  attachment_read: "light", retrieve_tool_result: "light", meta_list: "light",
  view_policy_tree: "light", view_truth_list: "light", view_truth_narrative: "light",
  view_sciverse_search: "light", view_openalex_search: "light", view_oa_lookup: "light",
  view_literature_search: "light", view_corpus_recall: "light", view_vault_tree: "light",
  view_memory_context: "light", view_skill_search: "light", view_graph_query: "light",
  view_documents_stats: "light", view_alerts: "light", view_traces: "light",
  view_ingest_status: "light", view_eval_report: "light", provenance_query: "light",
  // 长文/多轮/沙箱: 重
  llm_write: "heavy", sag_reason: "heavy", run_code: "heavy", runtime_exec: "heavy",
  empirical_analysis: "heavy", forensics_scan: "heavy", agent_subagent: "heavy",
  meta_invoke: "heavy", b5_ensemble: "heavy", doc_edit: "heavy",
};

/** 工具名 → 产物落点(供前端产物面板跳转; 只列有明确去向的) */
const TOOL_ARTIFACT: Record<string, { where: string; label: string }> = {
  sag_search: { where: "documents", label: "文献库" },
  sag_retrieve: { where: "documents", label: "文献库" },
  concept_trace: { where: "truth", label: "知识页" },
  empirical_analysis: { where: "empirical-research", label: "实证研究" },
  chart_template: { where: "plot-agent", label: "成果可视化工坊" },
  format_eval: { where: "format-eval", label: "格式智能评测" },
  forensics_scan: { where: "review-lab", label: "论文质量评审" },
  review_output: { where: "review-lab", label: "论文质量评审" },
  doc_edit: { where: "editor", label: "学术文本工作台" },
  llm_write: { where: "editor", label: "学术文本工作台" },
};

let cachedTools: CapabilityDef[] | null = null;

/**
 * 从 agent 工具注册表导出能力(实测 75 项: 48 静态 + 22 view_* + pdf + 插件)。
 * 工具定义里有 params(JSON Schema 简化版) 与 risk, 直接映射成画布节点与步骤参数。
 * @param refresh 绕过缓存(插件热加载后需要)
 */
export async function listToolCapabilities(refresh = false): Promise<CapabilityDef[]> {
  if (cachedTools && !refresh) return cachedTools;
  const { buildAgentTools } = await import("./agent-tool-router.js");
  const tools = await buildAgentTools({});
  const caps: CapabilityDef[] = tools.map((t) => {
    const argsTemplate: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t.params)) {
      // 必填参数用模板占位: 上游有同名产物则自动代入, 否则用户在上游 user_input 里填
      if (v.required) argsTemplate[k] = `{{inputs}}`;
    }
    return {
      id: `tool:${t.name}`,
      label: t.label,
      category: TOOL_CATEGORY[t.name] ?? "通用",
      kind: "agent_tool",
      description: t.description,
      inputs: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k),
      outputs: ["text"],
      risk: t.risk,
      cost: TOOL_COST[t.name] ?? "medium",
      tool: t.name,
      artifact: TOOL_ARTIFACT[t.name],
      step: { id: t.name, kind: "tool_call", label: t.label, with: { tool: t.name, args: argsTemplate } },
      fields: Object.entries(t.params).map(([k, v]) => ({
        name: k, label: k, type: v.type, required: v.required, placeholder: v.desc,
      })),
    };
  });
  cachedTools = caps;
  return caps;
}

// ─── 工作台能力(HTTP 端点型) ───
// 说明: 这些能力各自已有独立前端面板与 service, 此处登记"被编排时怎么调"。
//   endpoint 型由 meta-skill-runtime 的 callEndpoint 统一执行(带鉴权转发 + 超时 + 错误细节抽取)。
//
// 覆盖范围(2026-09-13 核对): 工作台里**有可执行的 HTTP 端点**的能力都在这张表里 ——
//   检索/写作/质量/经典/学术/理论(agent 工具侧) + 实证/统计/绘图/审稿/格式/引文/政经C刊/语料/
//   编辑器/大纲/PDF2Obsidian + 澄清与质量门。
//   未登记的几处是有意为之, 不是漏:
//     · 教育能力(120 路由)   —— 走 agent 工具 education_service 统一路由, 单独登记端点会变成两套;
//     · 技能库 / Agent 面板   —— 技能是 agent 侧能力, 服务端没有"执行某个技能"的 HTTP 端点;
//     · 知识库/文献库入库     —— 写操作, 由 agent 工具 sag_ingest 承担(manager 权限), 见下。
function cap(c: CapabilityDef): CapabilityDef { return c; }

export const WORKBENCH_CAPABILITIES: CapabilityDef[] = [
  // ── 实证研究链 ──
  // 说明: 端点路径与请求体都按 server.ts 里的实际 schema 写(zod 严格校验, 字段名错了会 400)。
  //   stat/reliability/regression 需要数据文件: 由上游节点产出 fileId/dataVersionId, 或用画布
  //   节点的 params 手填 —— 这些能力本身不解决"数据从哪来", 那是数据准备环节的事。
  cap({
    id: "emp:questionnaire-recognize", label: "问卷识别", category: "实证", kind: "endpoint", cost: "medium",
    description: "题目文本 → 识别题目结构(单选/多选/量表), 落问卷库",
    inputs: ["text"], outputs: ["questionnaire"], risk: "safe",
    endpoint: { path: "/api/empirical/questionnaires/recognize", method: "POST", body: { text: "{{inputs}}" } },
    artifact: { where: "empirical-research", label: "实证研究·问卷" },
    step: { id: "questionnaire", kind: "tool_call", label: "问卷识别", with: { endpoint: "/api/empirical/questionnaires/recognize", body: { text: "{{inputs}}" } } },
    fields: [{ name: "text", label: "题目文本", type: "string", required: true, placeholder: "粘贴问卷题目" }],
  }),
  cap({
    id: "emp:reliability", label: "信效度检验", category: "实证", kind: "endpoint", cost: "heavy",
    description: "Cronbach α / KMO — 需要 dataVersionId 或内联数据({columnOrder, rows})",
    inputs: ["dataVersionId"], outputs: ["result"], risk: "safe",
    endpoint: { path: "/api/empirical/reliability", method: "POST", body: { dataVersionId: "{{dataVersionId}}" } },
    artifact: { where: "empirical-research", label: "实证研究·信效度" },
    step: { id: "reliability", kind: "tool_call", label: "信效度检验", with: { endpoint: "/api/empirical/reliability", body: { dataVersionId: "{{dataVersionId}}" } } },
    fields: [{ name: "dataVersionId", label: "数据版本 id", type: "string", required: true, placeholder: "实证台里的数据版本 UUID" }],
  }),
  cap({
    id: "emp:regression", label: "回归分析", category: "实证", kind: "endpoint", cost: "heavy",
    description: "跑回归代码(OLS/Logit/面板) — 需 projectId + Python 代码; 结果写证据账本",
    inputs: ["code"], outputs: ["result"], risk: "safe",
    endpoint: { path: "/api/empirical/regression/run", method: "POST", body: { code: "{{code}}" } },
    artifact: { where: "empirical-research", label: "实证研究·回归" },
    step: { id: "regression", kind: "tool_call", label: "回归分析", with: { endpoint: "/api/empirical/regression/run", body: { code: "{{code}}" } } },
    fields: [
      { name: "code", label: "回归代码", type: "string", required: true, placeholder: "Python 代码, 用 pandas/statsmodels 读数据并输出结果" },
      { name: "projectId", label: "课题 id", type: "string", placeholder: "留空则用当前编排的课题" },
    ],
  }),
  cap({
    id: "emp:imputation", label: "缺失值插补", category: "实证", kind: "endpoint", cost: "heavy",
    description: "三分类插补(完全随机/随机/非随机) — 论文复现口径",
    inputs: ["dataVersionId"], outputs: ["result"], risk: "safe",
    endpoint: { path: "/api/empirical/imputation/start", method: "POST", body: { dataVersionId: "{{dataVersionId}}" } },
    artifact: { where: "empirical-research", label: "实证研究·插补" },
    step: { id: "imputation", kind: "tool_call", label: "缺失值插补", with: { endpoint: "/api/empirical/imputation/start", body: { dataVersionId: "{{dataVersionId}}" } } },
    fields: [{ name: "dataVersionId", label: "数据版本 id", type: "string", required: true }],
  }),
  // ── 统计(19 法) ──
  cap({
    id: "stat:run", label: "统计方法", category: "统计", kind: "endpoint", cost: "heavy",
    description: "19 种统计方法(描述/交叉表/相关/方差/卡方/聚类/因子/t 检验…) 单次执行",
    inputs: ["fileId"], outputs: ["result", "chart"], risk: "safe",
    endpoint: { path: "/api/statistics-jobs", method: "POST", body: { fileId: "{{fileId}}", tool: "{{tool}}", params: "{{params}}" } },
    artifact: { where: "empirical-research", label: "实证研究·统计" },
    step: { id: "statistics", kind: "tool_call", label: "统计方法", with: { endpoint: "/api/statistics-jobs", body: { fileId: "{{fileId}}", tool: "{{tool}}" } } },
    fields: [
      { name: "tool", label: "方法", type: "string", required: true, default: "describe", placeholder: "如 crosstab / ologit / describe / ols" },
      { name: "fileId", label: "数据 fileId", type: "string", placeholder: "实证台上传后的 fileId" },
    ],
  }),
  // ── 绘图 ──
  cap({
    id: "viz:render", label: "科研绘图", category: "绘图", kind: "endpoint", cost: "heavy",
    description: "数据 + 需求描述 → 出版级图表(Python 沙箱直出 png/svg)",
    inputs: ["message"], outputs: ["chart"], risk: "safe",
    endpoint: { path: "/api/viz/jobs", method: "POST", body: { sessionId: "{{sessionId}}", message: "{{message}}", fileId: "{{fileId}}" } },
    artifact: { where: "plot-agent", label: "成果可视化工坊" },
    step: { id: "viz", kind: "tool_call", label: "科研绘图", with: { endpoint: "/api/viz/jobs", body: { message: "{{message}}", fileId: "{{fileId}}" } } },
    fields: [
      { name: "message", label: "绘图需求", type: "string", required: true, placeholder: "如 分组柱状图, 标注显著性" },
      { name: "fileId", label: "数据 fileId", type: "string", placeholder: "留空则由上游传入" },
    ],
  }),
  // ── 审稿 ──
  cap({
    id: "review:paper", label: "论文质量评审", category: "审稿", kind: "endpoint", cost: "heavy",
    description: "按期刊规范多维评分 + 原文批注 + 复核层(异步 job, 返回 jobId)",
    inputs: ["text"], outputs: ["jobId"], risk: "safe",
    endpoint: { path: "/api/review/jobs", method: "POST", body: { text: "{{inputs}}", title: "{{title}}" } },
    artifact: { where: "review-lab", label: "论文质量评审" },
    step: { id: "review", kind: "tool_call", label: "论文质量评审", with: { endpoint: "/api/review/jobs", body: { text: "{{inputs}}" } } },
    fields: [{ name: "title", label: "稿件标题", type: "string", placeholder: "便于在审稿库区分" }],
  }),
  // ── 格式 ──
  cap({
    id: "format:eval", label: "格式智能评测", category: "格式", kind: "endpoint", cost: "medium",
    description: "学位论文/期刊/职称格式 — 规则引擎 + LLM 双层审校(文本至少 50 字)",
    inputs: ["text"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/format-eval/check", method: "POST", body: { text: "{{inputs}}", llm: true } },
    artifact: { where: "format-eval", label: "格式智能评测" },
    step: { id: "format_eval", kind: "tool_call", label: "格式智能评测", with: { endpoint: "/api/format-eval/check", body: { text: "{{inputs}}", llm: true } } },
  }),
  // ── 引文 ──
  cap({
    id: "citation:verify", label: "引文核验", category: "引文", kind: "endpoint", cost: "medium",
    description: "三维核验(存在性/一致性/相关性) — 防幻觉引文; 需给出 claim(5-3000 字)",
    inputs: ["claim"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/citations/verify", method: "POST", body: { claim: "{{claim}}" } },
    artifact: { where: "citation-verify", label: "引文核验" },
    step: { id: "citation_verify", kind: "tool_call", label: "引文核验", with: { endpoint: "/api/citations/verify", body: { claim: "{{claim}}" } } },
    fields: [{ name: "claim", label: "待核论断", type: "string", required: true, placeholder: "一条带引用的论断" }],
  }),
  // ── 经典文本(5 场景) ──
  // 各场景的入参不同(不是统一的 text): 概念/篇目/多篇文档。按 server.ts 里的实际校验写,
  // 否则编排一跑就 400(实测: 早先把 argument-structure 当 {text} 传, 直接 "缺少 documentId")。
  cap({
    id: "classical:concept-trace", label: "经典·概念溯源", category: "经典", kind: "endpoint", cost: "medium",
    description: "概念在经典文本中的语义演变与出处",
    inputs: ["concept"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/classical/concept-trace", method: "POST", body: { concept: "{{concept}}" } },
    artifact: { where: "scenarios", label: "经典文本研究" },
    step: { id: "concept_trace", kind: "tool_call", label: "经典·概念溯源", with: { endpoint: "/api/classical/concept-trace", body: { concept: "{{concept}}" } } },
    fields: [{ name: "concept", label: "概念", type: "string", required: true, placeholder: "如 生产关系" }],
  }),
  cap({
    id: "classical:exegesis", label: "经典·晦涩阐释", category: "经典", kind: "endpoint", cost: "medium",
    description: "难句释义 + 语境还原",
    inputs: ["text"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/classical/exegesis", method: "POST", body: { text: "{{inputs}}" } },
    artifact: { where: "scenarios", label: "经典文本研究" },
    step: { id: "classical_exegesis", kind: "tool_call", label: "经典·晦涩阐释", with: { endpoint: "/api/classical/exegesis", body: { text: "{{inputs}}" } } },
  }),
  cap({
    id: "classical:argument-structure", label: "经典·论证拆解", category: "经典", kind: "endpoint", cost: "heavy",
    description: "还原论证结构(前提/推理/结论) — 需已入库文档的 documentId",
    inputs: ["documentId"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/classical/argument-structure", method: "POST", body: { documentId: "{{documentId}}" } },
    artifact: { where: "scenarios", label: "经典文本研究" },
    step: { id: "argument_structure", kind: "tool_call", label: "经典·论证拆解", with: { endpoint: "/api/classical/argument-structure", body: { documentId: "{{documentId}}" } } },
    fields: [{ name: "documentId", label: "文档 id", type: "string", required: true, placeholder: "文献库里已入库的文档" }],
  }),
  cap({
    id: "classical:intertextual", label: "经典·互文对照", category: "经典", kind: "endpoint", cost: "heavy",
    description: "多文本互文关系与影响链路 — 需主题 + 至少 2 个 documentId",
    inputs: ["topic"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/classical/intertextual", method: "POST", body: { topic: "{{topic}}", documentIds: "{{documentIds}}" } },
    artifact: { where: "scenarios", label: "经典文本研究" },
    step: { id: "intertextual", kind: "tool_call", label: "经典·互文对照", with: { endpoint: "/api/classical/intertextual", body: { topic: "{{topic}}" } } },
    fields: [
      { name: "topic", label: "对照主题", type: "string", required: true },
      { name: "documentIds", label: "文档 id 列表(≥2)", type: "string", required: true, placeholder: "逗号分隔" },
    ],
  }),
  cap({
    id: "classical:collation", label: "经典·版本校勘", category: "经典", kind: "endpoint", cost: "heavy",
    description: "异文比对与版本谱系 — 按 documentGroup 分组",
    inputs: ["documentGroup"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/classical/collation", method: "POST", body: { documentGroup: "{{documentGroup}}" } },
    artifact: { where: "scenarios", label: "经典文本研究" },
    step: { id: "collation", kind: "tool_call", label: "经典·版本校勘", with: { endpoint: "/api/classical/collation", body: { documentGroup: "{{documentGroup}}" } } },
    fields: [{ name: "documentGroup", label: "版本组", type: "string", required: true, placeholder: "同一文本的多个版本归组名" }],
  }),
  // ── 学术研究(5 场景) ──
  ...[
    ["academic/school", "学派脉络", "学派谱系与师承共现"],
    ["academic/view-comparison", "观点对比", "多学者观点聚类对比"],
    ["academic/debate", "争鸣还原", "学术争论的时间线与焦点"],
    ["academic/scholar", "学者谱系", "学者关系网络与产出脉络"],
    ["academic/frontier", "学科前沿", "学科热点与前沿方向"],
  ].map(([path, label, desc]) => cap({
    id: `academic:${path.split("/")[1]}`, label: `学术·${label}`, category: "推理" as CapabilityCategory, kind: "endpoint" as CapabilityKind, cost: "medium" as const,
    description: desc, inputs: ["text"], outputs: ["report"], risk: "safe" as const,
    endpoint: { path: `/api/${path}`, method: "POST" as const, body: { text: "{{inputs}}" } },
    artifact: { where: "scenarios", label: "学术研究" },
    step: { id: path.split("/")[1].replace(/-/g, "_"), kind: "tool_call" as const, label: `学术·${label}`, with: { endpoint: `/api/${path}`, body: { text: "{{inputs}}" } } },
  })),
  // ── 政经C刊 ──
  cap({
    id: "cjournal:topic", label: "政经C刊选题", category: "写作", kind: "endpoint", cost: "medium",
    description: "四步法选题(热点×理论×方法×实践)",
    inputs: ["text"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/cjournal/four-step", method: "POST", body: { hotTopic: "{{inputs}}" } },
    artifact: { where: "cjournal", label: "政经C刊科研" },
    step: { id: "cjournal_topic", kind: "tool_call", label: "政经C刊选题", with: { endpoint: "/api/cjournal/four-step", body: { hotTopic: "{{inputs}}" } } },
  }),
  // ── 语料库 ──
  cap({
    id: "corpus:recall", label: "写作语料召回", category: "写作", kind: "endpoint", cost: "light",
    description: "按写作模块召回高级句式/论证框架/核心概念/段落范例",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/writing-corpus/recall", method: "POST", body: { q: "{{inputs}}", limit: 4 } },
    artifact: { where: "corpus", label: "写作语料库" },
    step: { id: "corpus_recall", kind: "tool_call", label: "写作语料召回", with: { endpoint: "/api/writing-corpus/recall", body: { q: "{{inputs}}", limit: 4 } } },
  }),
  // ── 教育 ──
  // 注意: /api/education/capabilities 是 GET 且返回"教育能力清单"而非执行结果, 不适合作为
  //   编排节点 —— 它会让用户以为跑了一步实际只拿到目录。教育能力统一走 agent 工具
  //   education_service(它内部才真正路由到 120 条教育路由), 这里不再重复登记端点型入口。
  // ── 学术文本编辑器(端点要求登录; 身份由编排层按运行带下去, 见 meta-skill-runtime 的 withCaller) ──
  // 这几项是把"编辑器里已经做好的 14 个 AI 动作"接进编排 —— 之前它们在画布上完全不可见,
  // 用户没法把"先改写再查重再定标题"排成一条链。
  cap({
    id: "editor:rewrite", label: "编辑器·段落改写", category: "编辑", kind: "endpoint", cost: "medium",
    description: "对选中文本做定向改写: 压缩/去模板化/润色/校对/期刊语体/去AI味/扩写",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/editor/v1/rewrite", method: "POST", body: { mode: "{{mode}}", text: "{{inputs}}" } },
    artifact: { where: "editor", label: "学术文本工作台" },
    step: { id: "editor_rewrite", kind: "tool_call", label: "编辑器·段落改写", with: { endpoint: "/api/editor/v1/rewrite", body: { mode: "humanize", text: "{{inputs}}" } } },
    // body 里写的是默认值而不是 {{mode}}: renderTemplate 只认 inputs/user.x/outputs.x,
    // 自定义字段名渲染出来是 "[未渲染:{{mode}}]", 传给端点直接参数校验失败。
    // 用户改字段 → 节点参数覆盖 body.mode(见 dagNodeToMetaStep)。
    fields: [{ name: "mode", label: "改写方式", type: "string", required: true, default: "humanize", placeholder: "condense/de-template/polish/proofread/journal-style/humanize/expand" }],
  }),
  cap({
    id: "editor:title-abstract", label: "编辑器·标题摘要", category: "编辑", kind: "endpoint", cost: "medium",
    description: "全文 → 标题 + 摘要 + 关键词",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/editor/v1/title-abstract", method: "POST", body: { text: "{{inputs}}" } },
    artifact: { where: "editor", label: "学术文本工作台" },
    step: { id: "editor_title_abstract", kind: "tool_call", label: "编辑器·标题摘要", with: { endpoint: "/api/editor/v1/title-abstract", body: { text: "{{inputs}}" } } },
  }),
  cap({
    id: "editor:check-fulltext", label: "编辑器·全文体检", category: "编辑", kind: "endpoint", cost: "medium",
    description: "全文一致性与规范检查(术语/引文/结构)",
    inputs: ["text"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/editor/v1/check-fulltext", method: "POST", body: { text: "{{inputs}}" } },
    artifact: { where: "editor", label: "学术文本工作台" },
    step: { id: "editor_check", kind: "tool_call", label: "编辑器·全文体检", with: { endpoint: "/api/editor/v1/check-fulltext", body: { text: "{{inputs}}" } } },
  }),
  cap({
    id: "editor:format-references", label: "编辑器·引文规范化", category: "引文", kind: "endpoint", cost: "light",
    description: "参考文献条目 → GB/T 7714 规范化",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/editor/v1/format-references", method: "POST", body: { text: "{{inputs}}" } },
    artifact: { where: "editor", label: "学术文本工作台" },
    step: { id: "format_refs", kind: "tool_call", label: "编辑器·引文规范化", with: { endpoint: "/api/editor/v1/format-references", body: { text: "{{inputs}}" } } },
  }),
  // ── 研途写作舱(论文大纲) ──
  // 入参按 server.ts 的 outlineChapterSchema / outlineComponentSchema 逐字对齐:
  //   chapter 要 nodeId + level(必填), component 的 sections 必须是**数组**而非字符串 ——
  //   端点走 zod 严格校验, 字段名或类型错了直接 400。
  cap({
    id: "outline:chapter", label: "大纲·章节正文", category: "写作", kind: "endpoint", cost: "heavy",
    description: "按章节标题 + 主题生成该章正文(需上游给出章节节点 id 与层级)",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/paper-outline/chapter", method: "POST", body: { nodeId: "{{nodeId}}", title: "{{title}}", level: "{{level}}", topic: "{{topic}}", thesis: "{{thesis}}" } },
    artifact: { where: "paper-outline", label: "研途写作舱" },
    step: { id: "outline_chapter", kind: "tool_call", label: "大纲·章节正文", with: { endpoint: "/api/paper-outline/chapter", body: { nodeId: "{{nodeId}}", title: "{{title}}", level: "{{level}}", topic: "{{topic}}" } } },
    fields: [
      { name: "topic", label: "论文主题", type: "string", required: true },
      { name: "title", label: "章节标题", type: "string", required: true },
      { name: "nodeId", label: "章节节点 id", type: "string", required: true, placeholder: "大纲树里的节点标识, 如 ch2" },
      { name: "level", label: "层级(0-3)", type: "number", required: true, default: "1" },
      { name: "thesis", label: "核心论点", type: "string", placeholder: "选填, 用于让本章贴合主线" },
    ],
  }),
  cap({
    id: "outline:component", label: "大纲·摘要关键词", category: "写作", kind: "endpoint", cost: "medium",
    description: "由主题/论点和章节目录生成摘要、关键词或结论(章节目录为数组)",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/paper-outline/component", method: "POST", body: { kind: "abstract", topic: "{{topic}}", thesis: "{{thesis}}", sections: ["第一章", "第二章"] } },
    artifact: { where: "paper-outline", label: "研途写作舱" },
    step: { id: "outline_component", kind: "tool_call", label: "大纲·摘要关键词", with: { endpoint: "/api/paper-outline/component", body: { kind: "abstract", topic: "{{topic}}", sections: ["第一章", "第二章"] } } },
    // sections 必须是**数组**: zod 要求 string[]。默认值给两个占位章节, 用户改成自己的目录
    //   (数组参数在 body 里保持数组, 见 meta-skill-runtime 的 renderBodyValue)。
    fields: [
      { name: "kind", label: "产出类型", type: "string", required: true, default: "abstract", placeholder: "abstract / keywords / conclusion" },
      { name: "topic", label: "论文主题", type: "string", required: true },
      { name: "thesis", label: "核心论点", type: "string" },
    ],
  }),
  // ── PDF2Obsidian(PDF → Markdown/笔记) ──
  // 用 pdfPath 分支: 服务端已有文件路径(与 Agent 工具/CLI 同一入口)。url/fileBase64 分支
  //   要么需要编排层能发二进制、要么把整个 PDF 塞进 JSON, 都不是 DAG 节点该干的事。
  cap({
    id: "p2o:convert", label: "PDF→Obsidian 转换", category: "知识", kind: "endpoint", cost: "heavy",
    description: "服务端 PDF 路径 → Markdown/笔记(异步任务, 返回 taskId; 图像分析耗时较长)",
    inputs: ["pdfPath"], outputs: ["taskId"], risk: "safe",
    endpoint: { path: "/api/p2o/tasks", method: "POST", body: { pdfPath: "{{pdfPath}}" } },
    artifact: { where: "p2o", label: "PDF2Obsidian" },
    step: { id: "p2o_convert", kind: "tool_call", label: "PDF→Obsidian 转换", with: { endpoint: "/api/p2o/tasks", body: { pdfPath: "{{pdfPath}}" } } },
    fields: [{ name: "pdfPath", label: "PDF 路径(服务端)", type: "string", required: true, placeholder: "文献库内的 PDF 绝对路径" }],
  }),
  // ── 结构解析(图/表/公式/算法定位) ──
  // 对应工作台「结构解析」面板: 论文正文 → 结构化块清单。纯规则解析, 不烧 LLM。
  cap({
    id: "structure:overview", label: "结构解析", category: "知识", kind: "endpoint", cost: "light",
    description: "论文正文 → 图/表/公式/算法块清单与定位(纯解析, 不调 LLM)",
    inputs: ["text"], outputs: ["report"], risk: "safe",
    endpoint: { path: "/api/papers/structure", method: "POST", body: { content: "{{inputs}}" } },
    artifact: { where: "structure", label: "结构解析" },
    step: { id: "structure_overview", kind: "tool_call", label: "结构解析", with: { endpoint: "/api/papers/structure", body: { content: "{{inputs}}" } } },
  }),
  // ── 编排入口自身(可嵌套) ──
  cap({
    id: "orch:sub-dag", label: "子编排(DAG 套 DAG)", category: "通用", kind: "endpoint", cost: "heavy",
    description: "把另一条编排作为本节点执行 — 复杂课题拆成可复用的子流程",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/orchestrator/run", method: "POST", body: { input: "{{inputs}}", wait: true } },
    step: { id: "sub_dag", kind: "tool_call", label: "子编排", with: { endpoint: "/api/orchestrator/run", body: { input: "{{inputs}}", wait: true } } },
    // templateId 由节点参数给字面值(字段默认 tpl_lit_review, 用户可改成别的模板 id),
    // 模板里不写 {{templateId}} —— 那个占位符渲染不出来, 见编辑器改写的同处说明。
    fields: [{ name: "templateId", label: "子流程", type: "string", required: true, default: "tpl_lit_review", placeholder: "模板 id, 如 tpl_five_stage" }],
  }),
  // ── 澄清节点(人机协同) ──
  cap({
    id: "io:clarify", label: "澄清追问", category: "通用", kind: "user_input", cost: "light",
    description: "暂停流水线收集必要信息(主题/对象/方法/边界) — 缺什么问什么",
    inputs: [], outputs: ["text"], risk: "safe",
    artifact: { where: "dag-workbench", label: "编排画布" },
    step: {
      id: "clarify", kind: "user_input", label: "澄清追问",
      clarify: {
        intro: "执行前确认关键信息:",
        fields: [
          { name: "topic", type: "string", required: true, prompt: "研究主题" },
          { name: "object", type: "string", prompt: "研究对象" },
          { name: "method", type: "string", prompt: "研究方法" },
          { name: "boundary", type: "string", prompt: "研究边界(年份/地区/样本)" },
        ],
      },
    },
    fields: [{ name: "topic", label: "研究主题", type: "string", required: true }],
  }),
  // ── 质量门(通用) ──
  cap({
    id: "io:quality-gate", label: "质量门", category: "通用", kind: "llm_gate", cost: "medium",
    description: "按标准判定上游产出是否合格; 不合格触发 on_failure 备胎步骤",
    inputs: ["text"], outputs: ["pass"], risk: "safe",
    step: {
      id: "gate", kind: "llm_gate", label: "质量门",
      with: { criteria: "1) 有明确来源/依据标注(非空泛陈述); 2) 直接回答任务目标而非泛泛而谈; 3) 结构完整可交付。", text: "{{inputs}}" },
    },
    fields: [{ name: "criteria", label: "判定标准", type: "string", default: "1) 有明确来源/依据标注(非空泛陈述); 2) 直接回答任务目标而非泛泛而谈; 3) 结构完整可交付。" }],
  }),
  // ── LLM 生成(通用) ──
  cap({
    id: "io:llm-write", label: "LLM 生成", category: "通用", kind: "llm_chat", cost: "heavy",
    description: "按提示词单次生成 — 通用兜底节点(自定义 system/task)",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    artifact: { where: "editor", label: "学术文本工作台" },
    step: { id: "llm", kind: "llm_chat", label: "LLM 生成", with: { system: "你是马克思主义理论研究领域的学术写作专家。", task: "{{inputs}}", maxTokens: 3000 } },
    // 默认值给"能直接跑"的提示词: 空提示词等于把节点做空, 用户必须先想清楚写什么才能跑。
    // 有上游依赖时 {{inputs}} 会被换成上游产出(见 MetaRunContext.stepInput)。
    fields: [
      { name: "system", label: "系统提示", type: "string", default: "你是马克思主义理论研究领域的学术写作专家。", placeholder: "角色与要求" },
      { name: "task", label: "任务提示", type: "string", required: true, default: "{{inputs}}", placeholder: "含 {{inputs}} 引用上游产出" },
    ],
  }),
];

/** 全部能力(工具 + 工作台), 按分类排序 */
export async function listCapabilities(opts: { refresh?: boolean } = {}): Promise<CapabilityDef[]> {
  const tools = await listToolCapabilities(!!opts.refresh);
  const all = [...tools, ...WORKBENCH_CAPABILITIES];
  const order: CapabilityCategory[] = ["检索", "推理", "写作", "实证", "统计", "审稿", "绘图", "编辑", "格式", "引文", "经典", "教育", "知识", "文件", "通用"];
  return all.sort((a, b) => {
    const d = order.indexOf(a.category) - order.indexOf(b.category);
    return d !== 0 ? d : a.label.localeCompare(b.label, "zh");
  });
}

/**
 * V415: 一个编排图的总成本量级 —— 由各节点能力的 cost 推出。
 * 判据是"有没有重节点": 有 heavy ≥2 个就算 heavy(长文/沙箱, 量级由它主导);
 * 有 heavy 但只有 1 个、或 ≥3 个 medium 算 medium; 其余 light。
 * 前端在模板卡与画布顶部显示它, 让用户点"开始执行"前知道大概要花多少。
 */
export function estimateGraphCost(
  graph: { nodes: Array<{ capabilityId?: string }> },
  caps: CapabilityDef[],
): "light" | "medium" | "heavy" {
  let heavy = 0;
  let medium = 0;
  for (const n of graph.nodes) {
    const c = n.capabilityId ? findCapability(n.capabilityId, caps) : undefined;
    const cost = c?.cost ?? "medium"; // 未登记的自定义节点按 medium(它会退化成一次 LLM 生成)
    if (cost === "heavy") heavy++;
    else if (cost === "medium") medium++;
  }
  if (heavy >= 2) return "heavy";
  if (heavy === 1 || medium >= 3) return "medium";
  return "light";
}

export function findCapability(id: string, caps: CapabilityDef[]): CapabilityDef | undefined {
  return caps.find((c) => c.id === id || c.tool === id || c.step.id === id);
}

/**
 * 画布节点(dagNode) → MetaSkill 步骤。
 * 供 orchestrator-service 与 agent-tool-router 的 meta_invoke 共用 —— 这是"画布上的图"
 * 与"后端能跑的 DAG"之间唯一的转换点。
 *
 * 节点形态(前端 BizNode 的超集):
 *   { id, capabilityId?, title?, params?, state?, onFailure?, route? }
 */
export function dagNodeToMetaStep(node: {
  id: string;
  capabilityId?: string;
  title?: string;
  params?: Record<string, unknown>;
  onFailure?: string;
  route?: Array<{ when: string; to: string }>;
}, caps: CapabilityDef[], deps: string[]): MetaStepDef {
  const capability = node.capabilityId ? findCapability(node.capabilityId, caps) : undefined;
  const base = capability?.step;
  const step: MetaStepDef = base
    ? { ...base, id: node.id, label: node.title || base.label }
    : {
        // 未登记的能力(用户手写的自定义节点) → 退化为 LLM 生成, 提示词即用途说明
        id: node.id,
        kind: "llm_chat",
        label: node.title || node.id,
        with: { system: "你是马克思主义理论研究领域的学术写作专家。", task: "{{inputs}}", maxTokens: 3000 },
      };
  step.depends_on = deps;
  /**
   * V415(2026-09-13 实测修复): 节点参数要合进**运行时真正读的那个子对象**。
   *
   * 运行时只读 with.args(tool 型)/ with.body(端点型)/ with 顶层(llm_* 直接读),
   * 而这里原来一律往 with 顶层合并 —— 后果是节点参数**全部是死键**:
   *   · 模板里写好的 topic 文本(如"为题目《X》设计 5 章架构")被丢弃,
   *     实际发出去的是 args.template 的 {{inputs}}(即上游整段产出);
   *   · 端点型的字段永远不生效 —— 实测"编辑器改写"节点传 mode=humanize,
   *     请求体里的 {{mode}} 渲染成空, 端点报 400"mode 需为 …", 而前端字段面板看着一切正常。
   * 两者都不报错, 只是"怎么改都没反应"/"莫名 400", 属于最难查的一类。
   */
  const params = node.params || {};
  const nested = step.kind === "tool_call" && (step.with?.tool || step.with?.endpoint)
    ? (step.with.tool ? "args" : "body")
    : null;
  if (nested) {
    const sub = { ...((step.with?.[nested] as Record<string, unknown>) || {}), ...params };
    // 允许节点参数直接给 args/body(与子对象键重名时它更明确)
    const override = params[nested];
    step.with = {
      ...step.with,
      ...(override && typeof override === "object" ? override : {}),
      [nested]: sub,
    };
    // 节点带上游依赖时, 那条链的主输入就是上游产出 —— 参数里没显式给 text/topic 就补上,
    // 否则字段面板一填别的参数, 上游产出就进不来了。
    if (nested === "args" && deps.length && sub.input == null && params.input == null) sub.input = "{{inputs}}";
  } else if (Object.keys(params).length) {
    step.with = { ...(step.with || {}), ...params };
  }
  if (node.onFailure) step.on_failure = node.onFailure;
  if (node.route?.length) step.route = node.route;
  return step;
}

/**
 * 画布(节点 + 边) → MetaSkillDef。
 * 边的语义: source → target 表示"source 的产出作为 target 的依赖"(即 target.depends_on 含 source)。
 * 与旧实现的关键差别: 旧代码用**数组顺序**推进、以写死的 id→jobKind 字典决定阶段类型, 边只用于画线;
 * 这里边就是依赖本体 —— 用户连线即真正改执行计划。
 */
export function graphToMetaSkill(
  graph: { id?: string; name?: string; description?: string; nodes: Array<{ id: string; capabilityId?: string; title?: string; params?: Record<string, unknown>; onFailure?: string }>; edges: Array<{ source: string; target: string }> },
  caps: CapabilityDef[],
): MetaSkillDef {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const deps = new Map<string, string[]>();
  for (const n of graph.nodes) deps.set(n.id, []);
  for (const e of graph.edges) {
    // 两端节点都要存在 —— 否则是脏数据(节点被删但边没清), 跳过而不是抛错
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    const list = deps.get(e.target)!;
    if (!list.includes(e.source)) list.push(e.source);
  }
  const steps = graph.nodes.map((n) => dagNodeToMetaStep(n, caps, deps.get(n.id) ?? []));
  return {
    id: graph.id || `graph-${Date.now().toString(36)}`,
    name: graph.name || "自定义编排",
    description: graph.description || "画布编排的工作流",
    steps,
  };
}
