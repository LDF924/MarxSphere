// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// workbenchContext.ts — V416: 全站工作台上下文表（科研助手 + 导航共读）
//
// 由来（2026-09-14 用户反馈"科研助手并不能很好反映每一个功能页"）：实测 45 个视图里，
// 助手把 **33 个页面名兜底成"工作台"**，38 个没有步骤引导 —— 名字表 VIEW_LABELS 只写了
// 12 条，流程表 VIEW_FLOW 只挂了 7 个视图。助手因此说不出"你在哪、这页能干什么"。
//
// 这张表是全站唯一真源：
//   label — 面板**实际渲染**的名字（注意: 导航菜单里 {"chat"} 那条标着"MCP工具检索"，但
//           渲染的是 ChatPanel（AI 对话），MCP 面板挂在 mcp 视图。以渲染为准，不抄导航）
//   hint  — 取自各面板**自己的文件头注释**（不是编的），写进界面文案前请先核对源码
//   steps — 流程链; to 缺省表示"就在本页完成"
//
// 不放进 App.tsx 的 categories：那是**可见导航**，本表含设置/首页等非导航项，
// 且流程语义与导航分组是两回事，混在一起会互相绑死。
//
// ── 可执行动作埋点约定（V416，写在这里以免散落各处） ──
// 交互控件加 `data-control="<view>:<key>"`：
//   view = 本表的键（workspaceView / hash 路由值），key = 小写 kebab 动词短语
//   例：`dream:scan` / `eval:run` / `quick:ms-run`
// data-control 的值会原样出现在科研助手的"当前页可执行"里，**按钮文案也直接取自 DOM**，
// 所以这里不列 key 清单 —— 想改文案改按钮，不用来改本文件。
// 例外：一个组件被多个视图共用时省略 view 前缀（如 EngineIngestPanel 的 `ingest:run`
// 同时服务 graphiti-ingest / cognee-ingest），此时该控件出现在这些视图下都算合理。
// iframe 里的控件由 soc 侧自动上报（见 socialsci-vue/src/shared/actions-bridge.ts），
// 同样只需加属性，不用写桥接代码。

export interface WorkbenchStep {
  key: string;
  label: string;
  purpose: string;
  /** 该步落在哪个视图；缺省=当前位置即可完成 */
  to?: string;
}

export interface WorkbenchContext {
  label: string;
  hint: string;
  steps?: WorkbenchStep[];
}

/** 全站视图上下文（键 = WorkspaceView 值 / hash 路由值） */
export const WORKBENCH_CONTEXT: Record<string, WorkbenchContext> = {
  // ── 对话推理 ──
  home: { label: "首页", hint: "MarxSphere 品牌首页：功能入口、研究数据与检索栈导览" },
  assistant: { label: "AI 对话", hint: "通用对话助手；也可从这里开新项目、发文献检索请求" },
  chat: { label: "AI 对话", hint: "豆包式对话：会话管理 + 富渲染/引用/工具调用 + 模型/联网/附件" },
  reason: { label: "推理工作台", hint: "输入问题 → 查看 52 步推理链与每步 token 消耗" },
  ask: {
    label: "Ask 检索",
    hint: "18 步检索流水线：多臂召回 → 加权 RRF → boost 链 → 重排",
    steps: [
      { key: "query_input", label: "检索输入", purpose: "填主题/变量/文献词" },
      { key: "search", label: "执行检索", purpose: "四库检索跑任务" },
      { key: "evidence_review", label: "证据核对", purpose: "核对结果相关性" },
      { key: "material_import", label: "素材导入", purpose: "证据入素材库" },
    ],
  },

  // ── 科研中心（文献） ──
  literature: { label: "文献库", hint: "本地文献检索：meta-catalog + meta-search 模式" },
  imports: { label: "文献管理", hint: "Zotero / RSS / 论文搜索 / S3 / SSH / 双链笔记 统一入口" },
  sciverse: { label: "外部检索", hint: "全人文社科外部学术检索：工具选择 + 结果卡片 + read_content/relations" },
  scenarios: { label: "场景", hint: "科研场景全景：按研究阶段分组（选题构思 → 评审发表）" },
  education: { label: "教育", hint: "AI+教育六大能力：学习规划 / 课程辅导 / 学情诊断 / 预习复习 / 教师备课 / 学习陪伴" },
  structure: { label: "结构解析", hint: "自动定位论文里的图/表/公式/算法，四类分览 + 每块一键 AI 理解" },
  "citation-verify": { label: "引文核验", hint: "引文三维核验：元数据真伪 / 语境相关性 / 断言支持度" },
  "format-eval": { label: "格式智能评测", hint: "论文格式评测：规则引擎违规清单 + LLM 审校分区" },
  p2o: { label: "PDF2Obsidian", hint: "PDF 三栏工作台：上传区 + PDF 预览 + 译文/阅读材料/结构化输出" },
  cjournal: { label: "政经C刊科研", hint: "马理论选题九工具：四步法 / 选题矩阵 / 悖论选题 / 编辑校验 / 外审翻译" },
  corpus: {
    label: "写作语料库",
    hint: "四大子库：文本范例 / 核心概念 / 论证逻辑 / 词汇句式",
    steps: [
      { key: "collect", label: "语料采集", purpose: "从文献/大纲沉淀语料" },
      { key: "organize", label: "归类整理", purpose: "四库分类 + 去重" },
      { key: "recall", label: "写作取用", purpose: "写作时按需召回" },
      { key: "feedback", label: "产出回流", purpose: "成稿回沉淀为范例" },
    ],
  },
  "paper-outline": {
    label: "研途写作舱",
    hint: "阶段化论文研究：选题界定 → 框架设计 → 文献与资料 → 章节写作 → 统稿定稿",
    steps: [
      { key: "input", label: "选题界定", purpose: "填写主题/方法/字数/目录" },
      { key: "sections", label: "框架设计", purpose: "确认结构/变量/章节指导" },
      { key: "materials", label: "文献与资料", purpose: "生成/审视/编排素材" },
      { key: "workspace", label: "章节写作", purpose: "逐章生成并核对正文" },
      { key: "finalize", label: "统稿定稿", purpose: "合并/审阅/导出终稿" },
    ],
  },
  "dag-workbench": {
    label: "课题流程编排",
    hint: "对话式 DAG 工作流：主题确认后 Agent 自动执行五阶段",
    steps: [
      { key: "input", label: "研究信息", purpose: "填写主题/方法/字数/目录" },
      { key: "sections", label: "科研架构", purpose: "确认结构/变量/章节指导" },
      { key: "materials", label: "素材准备", purpose: "生成/审视/编排素材" },
      { key: "workspace", label: "正文创作", purpose: "逐章生成并核对正文" },
      // 合稿在写作舱里做 —— 原来这步跳到自己(dag-workbench)是个空转，实测发现的
      { key: "finalize", label: "合稿审阅", purpose: "合并/审阅/导出终稿", to: "paper-outline" },
    ],
  },
  "review-lab": {
    label: "论文质量评审",
    hint: "期刊标准审稿：多维评分 + 原文批注 + 审稿历史库",
    steps: [
      { key: "document_input", label: "文稿输入", purpose: "打开或上传文稿" },
      { key: "review_setup", label: "审阅设置", purpose: "选期刊/标准/严格度" },
      { key: "review_run", label: "审阅运行", purpose: "SSE 流式审稿" },
      { key: "suggestion_review", label: "建议核对", purpose: "查看并确认建议" },
    ],
  },
  "plot-agent": {
    label: "成果可视化工坊",
    hint: "对话式科研绘图：数据上传/描述需求 → 出版级图表",
    steps: [
      { key: "chart_input", label: "绘图输入", purpose: "描述图表与数据" },
      { key: "chart_generation", label: "图表生成", purpose: "Agent 计算出图" },
      { key: "chart_review", label: "图表核对", purpose: "核对标注与规范" },
      { key: "export", label: "图表导出", purpose: "导出或入素材库" },
    ],
  },
  editor: {
    label: "学术文本工作台",
    hint: "在线学术编辑器：富文本写作 + AI 选区改写 + 图表/版本",
    steps: [
      { key: "document_create", label: "文档创建", purpose: "新建或打开文档" },
      { key: "editing", label: "内容编辑", purpose: "AI 改写/检查/润色" },
      { key: "formatting", label: "格式整理", purpose: "引用/标题/排版" },
      { key: "versioning", label: "版本管理", purpose: "保存/回档版本" },
    ],
  },
  "empirical-research": {
    label: "实证研究",
    hint: "问卷/数据 → 统计方法 → 结果核对；内置统计·Notebook 双栏联动",
    steps: [
      { key: "data_input", label: "数据输入", purpose: "选择或上传数据" },
      { key: "method_selection", label: "方法选择", purpose: "选统计方法与变量" },
      { key: "analysis_run", label: "分析运行", purpose: "提交后台任务" },
      { key: "result_review", label: "结果核对", purpose: "核对表格图形结论" },
    ],
  },

  // ── 知识中心 ──
  truth: { label: "知识页", hint: "Compiled Truth + Timeline 机制" },
  memory: { label: "记忆", hint: "记忆管理：向量化 + 睡眠学习" },
  documents: { label: "PG入库", hint: "把文献写入 PostgreSQL（向量 + 词法）" },
  "graphiti-ingest": { label: "Graphiti入库", hint: "六阶段抽取：实体 + 蒸馏 + 向量化 + 消歧 + 超边" },
  "cognee-ingest": { label: "Cognee入库", hint: "分块 + cognify 抽取实体关系，批量任务" },
  graph: { label: "图谱", hint: "力导向图谱视图：d3-force 仿真驱动节点" },
  sources: { label: "数据源", hint: "29 个外部数据源的统一接入与状态" },

  // ── 政策资料 ──
  policy: { label: "政策库", hint: "本地政策目录浏览 + gov.cn 检索并一键存入" },
  vault: { label: "资料库", hint: "左树右文浏览 Obsidian 课题库（md/PDF/图片/Office）" },

  // ── 技能工具 ──
  skills: { label: "技能", hint: "技能注册表：触发词 + 健康检查 + Skillify 固化 + 自动更新检测" },
  mcp: { label: "MCP", hint: "MCP 工具服务与外部 Agent 接入" },

  // ── 系统管理 ──
  jobs: { label: "Jobs", hint: "任务队列" },
  tasks: { label: "任务", hint: "自主任务面板" },
  "agent-console": { label: "Agent控制台", hint: "Agent 编排、工具调用与执行日志" },
  dream: { label: "记忆巩固", hint: "Dream 巩固审计：空闲凝练与记忆整合记录" },
  trace: { label: "Trace", hint: "OTEL 风格追踪瀑布：一次请求的完整 span" },
  eval: { label: "评测", hint: "评测工作台：指标、用例与回归趋势" },
  alerts: { label: "告警", hint: "任务巡检 / 降级 / 熔断 / 失败事件汇总" },
  im: { label: "IM接入", hint: "飞书 / 钉钉 / Telegram 机器人远程对话接入" },
  inbox: { label: "Inbox", hint: "待办事项" },
  billing: { label: "账户计费", hint: "套餐、用量与账单" },
  admin: { label: "运营管理", hint: "多租户与运营后台（仅 admin 可见）" },
  docs: { label: "文档中心", hint: "左侧章节导航 + Markdown 渲染" },
  "site-content": { label: "站点内容", hint: "公告 / 帮助 / 条款 / 学术资源导航" },
  "research-history": { label: "历史记录", hint: "六模块历史分区；点击可恢复对应工作台条目" },

  // ── 兜底 ──
  settings: { label: "设置", hint: "外观、模型与系统偏好" },
  jupyter: { label: "Jupyter", hint: "轻量 notebook 工作台：可复用内核变量 + 图表产出" },
};

/** 取某视图的上下文（未登记时给一个诚实的兜底，而不是编造说明） */
export function contextOf(view: string): WorkbenchContext & { known: boolean } {
  const hit = WORKBENCH_CONTEXT[view];
  if (hit) return { ...hit, known: true };
  return { label: "工作台", hint: "该页面尚未登记上下文说明", known: false };
}

/** 全站已登记上下文的视图数（供文档/门禁核对覆盖率） */
export const CONTEXT_COVERED = Object.keys(WORKBENCH_CONTEXT).length;
