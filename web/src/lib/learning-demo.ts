// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// learning-demo.ts — 评测学习引擎演示数据（2026-08-08 V290）
// 5 个工具的静态演示数据（内嵌真实跑过的结果），供 LearningToolsSection demo 播放用
// 数据来源: eval_failures 表(15行) / significance_report.md / kappa_report.md / tp_report.md / model-swap 矩阵

export type DemoRow = {
  /** 单元格内容（第一列通常是题号/类别） */
  cells: string[];
  /** 该行得分（用于着色） */
  score?: number;
  /** 是否零分/失败行（红色高亮） */
  bad?: boolean;
};

export interface ToolDemo {
  id: string;
  label: string;
  desc: string;
  /** 步骤式演示: 每步一个提示文本 */
  steps: string[];
  /** 最终表格数据（逐行点亮） */
  rows: DemoRow[];
  /** 最终统计数字（大字号展示） */
  stats?: Array<{ label: string; value: string; good?: boolean }>;
}

export const LEARNING_TOOLS: ToolDemo[] = [
  // ───── P0-2 失败归因 ─────
  {
    id: "attribution",
    label: "失败归因",
    desc: "对低分题定位【第一个】导致偏离的错误（类别/步骤/证据/置信度），写入 eval_failures 表",
    steps: [
      "读取评测逐题分数，筛选低分题（整体最低 15 题）…",
      "组装归因 prompt（任务/金标/低分指标/答案/上下文）…",
      "调用 judge 模型（thinking 禁用）做结构化归因…",
      "15 题归因完成，写入 eval_failures 表",
    ],
    rows: [
      { cells: ["Q08", "retrieval", "检索阶段", "0.600"] },
      { cells: ["Q05", "retrieval", "citation_f1=0.00", "0.600"] },
      { cells: ["Q41", "context", "上下文检索与引用", "0.900"] },
      { cells: ["Q26", "context", "context_precision", "0.600"] },
      { cells: ["Q09", "retrieval", "检索上下文生成", "0.950"] },
      { cells: ["Q28", "retrieval", "检索阶段", "0.850"] },
      { cells: ["Q18", "retrieval", "PG检索", "0.600"] },
      { cells: ["Q23", "context", "context_precision", "0.600"] },
      { cells: ["Q36", "retrieval", "PG检索", "0.800"] },
      { cells: ["Q04", "timeout", "stage3_latency_norm=0.00", "0.600"] },
      { cells: ["Q20", "timeout", "stage3_latency_norm=0.00", "0.400"] },
      { cells: ["Q25", "context", "context_relevancy", "0.800"] },
      { cells: ["Q45", "context", "context_precision", "0.700"] },
      { cells: ["Q42", "retrieval", "Step 1", "0.700"] },
      { cells: ["Q43", "context", "context_precision 低分（0.25）", "0.600"] },
    ],
    stats: [
      { label: "定位到具体步骤率", value: "100%", good: true },
      { label: "置信度 ≥ 0.5 占比", value: "100%" },
    ],
  },
  // ───── P0-1 统计显著性 ─────
  {
    id: "significance",
    label: "统计显著性",
    desc: "配对 McNemar + 配对 bootstrap：判断两次评测的分差是真实改善还是抽样噪声",
    steps: [
      "读取两份评测的逐题分数（eval_32metrics_perq.json）…",
      "按题号配对对齐（38 题双方有效）…",
      "构造 2×2 配对表（双达标/仅前/仅后/双不达标）…",
      "McNemar χ² = 0.00（连续性校正），p = 1.0000…",
      "配对 bootstrap 10000 次重采样：95% CI = [0.0000, 0.0000]…",
      "判定：不显著（分差未超噪声）",
    ],
    rows: [
      { cells: ["双达标 (a)", "38", "before 达标 且 after 达标"] },
      { cells: ["仅 before 达标 (b)", "0", "after 掉出达标线"] },
      { cells: ["仅 after 达标 (c)", "0", "after 新进入达标线"] },
      { cells: ["双不达标 (d)", "0", "两次都未达标"] },
    ],
    stats: [
      { label: "McNemar p 值", value: "1.0000" },
      { label: "Bootstrap 95% CI", value: "[0.0000, 0.0000]" },
      { label: "判定", value: "不显著", good: false },
    ],
  },
  // ───── P0-4 评判者校准 ─────
  {
    id: "calibration",
    label: "评判者校准",
    desc: "Cohen's kappa：测量 LLM Judge 与人工金标的一致性，kappa ≥ 0.7 才放量",
    steps: [
      "读取金标集（data/judge_gold.json，20 条：14 达标 + 6 不达标）…",
      "用同一 judge 模板 3 轮中位数重跑打分…",
      "一致率 p_o = 1.0000（两档判定完全一致）…",
      "随机一致率 p_e = 0.5800（边际概率乘积）…",
      "kappa = (1.0000 - 0.5800) / (1 - 0.5800) = 1.0000…",
      "判定：kappa ≥ 0.7，Judge 可放量使用 ✓",
    ],
    rows: [
      { cells: ["Q46", "多跳推理", "0.897", "0.900"], score: 1 },
      { cells: ["Q15", "多跳推理", "0.898", "0.950"], score: 1 },
      { cells: ["Q08", "政策评估", "0.850", "0.850"], score: 1 },
      { cells: ["Q20", "政策评估", "0.883", "0.800"], score: 1 },
      { cells: ["Q25", "概念定义", "0.886", "0.800"], score: 1 },
      { cells: ["Q21", "概念定义", "0.951", "0.900"], score: 1 },
      { cells: ["Q41_L1", "事实检索", "0.150", "0.000"], bad: true },
      { cells: ["Q18_L2", "事实检索", "0.350", "0.200"], bad: true },
      { cells: ["Q06_L3", "事实检索", "0.200", "0.000"], bad: true },
      { cells: ["Q34_L4", "事实检索", "0.450", "0.000"], bad: true },
      { cells: ["Q48_L5", "事实检索", "0.300", "0.000"], bad: true },
      { cells: ["Q23_L6", "多跳推理", "0.100", "0.000"], bad: true },
    ],
    stats: [
      { label: "Cohen's kappa", value: "1.0000", good: true },
      { label: "一致率 p_o", value: "1.0000" },
      { label: "分歧题", value: "0 题", good: true },
    ],
  },
  // ───── P0-3 轨迹前缀回归 ─────
  {
    id: "trajectory",
    label: "轨迹前缀回归",
    desc: "冻结已发生上下文，只要求模型输出'下一步可观察动作'——测试边界决策能力（低成本）",
    steps: [
      "读取轨迹前缀评测集（15 题：9 个低分题真实上下文 + 6 个边界场景）…",
      "reason 模型单轮生成'下一步动作'…",
      "规则 + LLM 双轨判定（命中禁止动作 → 0 / 可接受 → 1 / 部分 → 0.5）…",
      "15 题评测完成，输出基线分",
    ],
    rows: [
      { cells: ["TP01", "Q22", "引用资料事实并标注来源", "1.0"], score: 1 },
      { cells: ["TP02", "Q39", "检索青海省金融量化进展 chunk", "1.0"], score: 1 },
      { cells: ["TP03", "Q01", "检索 PPP 本质属性定义", "1.0"], score: 1 },
      { cells: ["TP04", "Q50", "检索社会资本参与案例或数据", "1.0"], score: 1 },
      { cells: ["TP05", "Q07", "检索人力资本负向影响机制解释", "1.0"], score: 1 },
      { cells: ["TP06", "Q24", "提取验收指引具体条款核对", "0.0"], bad: true },
      { cells: ["TP07", "Q47", "检索年报公司治理结构原文", "0.0"], bad: true },
      { cells: ["TP08", "Q35", "检索规范维度与政治信任实证数据", "1.0"], score: 1 },
      { cells: ["TP09", "Q08", "检索治理机制实证分析", "1.0"], score: 1 },
      { cells: ["TP10", "Q44", "检索论文A原文提取甲政策规定", "1.0"], score: 1 },
      { cells: ["TP11", "Q44", "检索实施细则或官方数据", "1.0"], score: 1 },
      { cells: ["TP12", "Q22", "交叉验证数据口径与年份", "1.0"], score: 1 },
      { cells: ["TP13", "Q39", "检索第三项具体量化指标", "0.0"], bad: true },
      { cells: ["TP14", "Q01", "直接引用官方定义原文", "1.0"], score: 1 },
      { cells: ["TP15", "Q50", "对比资料A/B出处与发布时间", "1.0"], score: 1 },
    ],
    stats: [
      { label: "总基线分", value: "0.800", good: true },
      { label: "满分(1分)", value: "12 题" },
      { label: "零分(0分)", value: "3 题", good: false },
    ],
  },
  // ───── P0-5 模型替换 ─────
  {
    id: "model-swap",
    label: "模型替换",
    desc: "固定 Harness 只换 reason 模型，判断'模型不行' vs 'Harness 不行'",
    steps: [
      "MODEL_SWAP_ROLE 环境变量切换 reason 角色模型…",
      "配置 1：baseline（deepseek-v4-flash）— 当前基准…",
      "配置 2：强模型（deepseek-v4-pro）— 涨→模型有提升空间；不涨→Harness 瓶颈…",
      "配置 3：异源（qwen3.7-max）— 涨→偏见/能力互补；不涨→链路本身…",
      "三配置对照跑同一 50 题，用 significance.ts 做配对检验",
    ],
    rows: [
      { cells: ["基线", "deepseek-v4-flash", "当前基准分 0.870", "—"] },
      { cells: ["强模型", "deepseek-v4-pro", "涨 → 模型有提升空间", "待数据"] },
      { cells: ["异源", "qwen3.7-max", "涨 → 偏见/能力互补", "待数据"] },
    ],
    stats: [
      { label: "实现", value: "MODEL_SWAP_ROLE 已就绪", good: true },
      { label: "实测", value: "待 PG 恢复后执行" },
    ],
  },
];
