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
//   各能力的路径/请求体按 server.ts 里的实际 zod schema 写 —— 字段名错了会直接 400。

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
    fields: [{ name: "projectId", label: "课题 id", type: "string", placeholder: "留空则用当前编排的课题" }],
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
  // ── 编排入口自身(可嵌套) ──
  cap({
    id: "orch:sub-dag", label: "子编排(DAG 套 DAG)", category: "通用", kind: "endpoint", cost: "heavy",
    description: "把另一条编排作为本节点执行 — 复杂课题拆成可复用的子流程",
    inputs: ["text"], outputs: ["text"], risk: "safe",
    endpoint: { path: "/api/orchestrator/run", method: "POST", body: { templateId: "{{templateId}}", input: "{{inputs}}", wait: true } },
    step: { id: "sub_dag", kind: "tool_call", label: "子编排", with: { endpoint: "/api/orchestrator/run", body: { templateId: "{{templateId}}", input: "{{inputs}}", wait: true } } },
    fields: [{ name: "templateId", label: "子流程", type: "string", required: true, placeholder: "模板 id" }],
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
  if (step.with) {
    step.with = { ...step.with, ...(node.params || {}) };
  } else if (node.params) {
    step.with = { ...node.params };
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
