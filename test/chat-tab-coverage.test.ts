/**
 * chat-tab-coverage.test.ts — 五个工作台的能力必须真的接进 AI 对话。
 *
 * 由来(2026-09-29 用户: "研途写作舱、课题流程编排、论文质量评审、成果可视化工坊、
 * 学术文本工作台这些新增的 tab, AI 对话能调用这些 tab 里的所有能力了吗")。
 *
 * 实测答案是"不能, 而且差得远": 写作舱 ≈21% / 编排 ≈35% / 评审 ≈15% / 工坊 ≈5% /
 * 编辑器 ≈20%。缺口**全部是"没接线"**(后端 service 都已就绪), 于是补齐。
 *
 * 这个文件锁四件事, 每条都对应一个**不报错**的失效方式:
 *   ① **可达**: 五个 tab 的核心能力必须各有 agent 工具 —— 少一个, 对话里就够不着;
 *   ② **登记完整**: 条条都要在 TOOL_MIN_ROLE 里。缺省是 **manager**, 不登记 = 对话里的
 *      analyst 角色**根本用不了**(那不是"少做", 是"白接");
 *   ③ **写工具不许漏登 WRITE_TOOLS**: 只读(评审)会话会拿到它们;
 *   ④ **只读工具不许误登**: 登了会让只读会话白白丢掉它。
 */
import { describe, it, expect } from "vitest";
import { buildAgentTools, WRITE_TOOLS, TOOL_MIN_ROLE_KEYS } from "../src/services/agent-tool-router.js";

/**
 * 每个 tab 的**核心能力** → 它的 agent 工具名。
 * 判据是"用户在对话里说那句话时, AI 够不够得着", 不是"文件里有没有这个函数"。
 */
const TABS: Array<{ tab: string; why: string; tools: string[] }> = [
  {
    tab: "研途写作舱",
    why: "主战场: 项目/素材/证据/假设/大纲/投稿台账 + 申报稿与要件生成",
    tools: [
      "view_research_projects", "view_research_materials", "view_research_evidence",
      "view_research_hypotheses", "view_research_outline", "view_research_submission",
      "research_proposal_generate", "research_component_generate",
    ],
  },
  {
    tab: "课题流程编排",
    why: "跑/单步/控制/看图/能力表 —— 用户说「把这条链跑起来」要能接",
    tools: [
      "view_orch_capabilities", "view_orch_runs", "view_orch_run_detail", "view_orch_events",
      "view_orch_graphs", "view_orch_graph_get", "orch_run_step", "orch_run_graph",
      "orch_graph_save", "orch_graph_delete", "orch_control", "orch_resume",
      "orch_nl_to_dag", "orch_settings_set",
    ],
  },
  {
    tab: "论文质量评审",
    why: "建审稿 job 是核心能力; 期刊库/标准库是它的输入",
    tools: [
      "review_job_create", "view_review_jobs", "view_review_job", "review_job_cancel",
      "review_job_retry", "view_review_stats", "view_review_journals",
      "review_guide_parse", "view_review_standards", "review_standard_parse",
      "review_export_report",
    ],
  },
  {
    tab: "成果可视化工坊",
    why: "出图是核心; 取产物与转素材是它的两条出口",
    tools: [
      "viz_job_create", "view_viz_jobs", "view_viz_job", "view_viz_job_dataset",
      "viz_job_cancel", "viz_job_retry", "view_viz_data_files",
      "viz_artifact_to_materials", "viz_artifact_export", "view_viz_models",
    ],
  },
  {
    tab: "学术文本工作台",
    why: "文档读写 + 14 个 AI 动作 + 图表 + 导出",
    tools: [
      "view_editor_docs", "view_editor_doc", "editor_doc_create", "editor_doc_write",
      "view_editor_versions", "editor_doc_restore", "editor_fulltext_check",
      "editor_rewrite", "editor_title_abstract", "editor_citation_check",
      "editor_ai_job", "editor_chart_code", "editor_export_docx",
    ],
  },
];

describe("五个工作台在对话侧可达", () => {
  it("每个 tab 的核心能力都有 agent 工具注册进 buildAgentTools", async () => {
    const names = new Set((await buildAgentTools({})).map((t) => t.name));
    const missing = TABS.flatMap((t) => t.tools.filter((n) => !names.has(n)).map((n) => `${t.tab} → ${n}`));
    expect(
      missing,
      "这些能力没有注册成 agent 工具 —— 用户在对话里够不着它们。\n" +
        "加到对应的 agent-<模块>-tools.ts 并同步 TOOL_MIN_ROLE / WRITE_TOOLS。",
    ).toEqual([]);
  });

  it("**每一条都要登记角色**(缺省是 manager, 不登记 = analyst 用不了)", () => {
    const known = new Set(TOOL_MIN_ROLE_KEYS);
    const missing = TABS.flatMap((t) => t.tools.filter((n) => !known.has(n)).map((n) => `${t.tab} → ${n}`));
    expect(
      missing,
      "`checkToolRole` 的缺省是 **manager**(不是 reader)—— 不登记 = 对话里的 analyst 根本用不了, " +
        "而这条路径**不报错**, 只是那个工具永远不可用。",
    ).toEqual([]);
  });
});

describe("写工具的登记(只读会话不该拿到)", () => {
  /** 会改用户已有数据 / 落库 / 烧钱起后台任务的 —— 与各模块交付报告逐条对齐 */
  const MUST_BE_WRITE: Record<string, string> = {
    viz_job_create: "建任务 = 烧 LLM + 跑 Python + 落产物",
    viz_job_cancel: "改既有任务的状态(前端要等它停下来)",
    viz_job_retry: "再跑一次(又一次账单)",
    viz_artifact_to_materials: "往用户素材库插一条(会被引进正文)",
    editor_doc_create: "新建文档（落 documents_v2）",
    editor_doc_delete: "删文档 —— 版本行 CASCADE 一起走, 不可恢复",
    editor_doc_write: "覆盖用户已写的正文",
    editor_doc_restore: "把正文回档成旧版本",
    editor_ai_job: "起 AI 任务(烧钱 + 可能写回)",
    editor_set_model: "改全局模型配置(影响之后所有 AI 动作)",
    review_job_create: "建审稿任务(分钟级、几毛到几块)",
    review_job_retry: "再跑一次审稿(又一次账单)",
    review_job_delete: "删审稿记录(报告与意见一起没)",
    review_journal_create: "往期刊库增一条(影响之后所有审稿的规则集)",
    review_journal_batch_parse: "批量解析投稿须知入库(逐刊烧 LLM, 且覆盖既有规则)",
    review_standard_set_default: "改默认评审标准(影响之后所有审稿的评分口径)",
    orch_run_step: "起一次编排运行(会调任意工具)",
    orch_run_graph: "起一次编排运行(整条 DAG)",
    orch_graph_save: "覆盖既有画布图",
    orch_graph_delete: "删画布图(不可恢复)",
    orch_control: "暂停/取消/提交等待中的运行",
    orch_resume: "恢复一条已暂停的运行",
    orch_settings_set: "改 Agent 能否触发编排的开关",
    orch_dag_decide: "接受/否决候选 DAG(接受会落库成图)",
  };

  it("写工具**全部**在 WRITE_TOOLS 里", () => {
    const missing = Object.keys(MUST_BE_WRITE).filter((n) => !WRITE_TOOLS.has(n));
    expect(
      missing,
      "不在 WRITE_TOOLS 里, 只读(评审)会话就能触发它们 —— 本仓记过这个坑(orch_run 漏登记那次)。",
    ).toEqual([]);
  });

  it("每一条都写了「为什么算写」(日后没人能凭空判断该不该删)", () => {
    for (const [n, why] of Object.entries(MUST_BE_WRITE)) {
      expect(why.length, `${n} 的理由太短`).toBeGreaterThan(6);
    }
  });
});

describe("只读工具不该被误登为写", () => {
  /**
   * 误登的代价与漏登相反但同样是静默的: 只读会话会**白白丢掉**一个本来能用的工具。
   * ⚠ 我第一版用正则从各文件里抠「算写工具」注释来生成写名单 —— 把文件头那段说明
   * (它也含这四个字)算进了前几条工具, 6 条只读被误判。**判据看到了别的东西**。
   */
  const READ_ONLY = [
    "view_viz_jobs", "view_viz_job", "view_viz_job_dataset", "view_viz_data_files",
    "viz_artifact_export", "view_viz_models",
    "view_editor_doc", "view_editor_versions", "editor_fulltext_check",
    "editor_rewrite", "editor_title_abstract", "editor_citation_check",
    "view_review_job", "view_review_stats", "view_review_journals", "view_review_standards",
    "review_guide_parse", "review_export_report",
    "view_orch_capabilities", "view_orch_runs", "view_orch_run_detail", "view_orch_events",
    "view_orch_graph_get", "orch_nl_to_dag",
  ];
  it("这些只读工具**不在** WRITE_TOOLS 里", () => {
    const wrong = READ_ONLY.filter((n) => WRITE_TOOLS.has(n));
    expect(wrong, `列进 WRITE_TOOLS 会让只读会话白白丢掉它们: ${wrong.join(", ")}`).toEqual([]);
  });
});
