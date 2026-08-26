// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EvalPanel.tsx — 评测工作台（V274，2026-08-06）
// 双模式：① 实时运行区 — 选评测脚本启动，SSE 逐步点亮（每题一个节点，展开看逐指标分数/来源/说明）
//         ② 结果展示区 — 只读已完成 eval_*.json（32 指标分组/分数条/来源徽章/证据区）
// 指标数随评测脚本版本变化（V40: 28 → V41: 32），不硬编码
import { useEffect, useRef, useState, type FC } from "react";
import { BarChart3, ChevronDown, ChevronRight, FileText, Loader2, Play, RefreshCw, Scale, Database, Brain, Gauge, Search, ListChecks, Square, Terminal, CheckCircle2, XCircle, Sparkles, GraduationCap } from "lucide-react";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { api } from "../lib/api";
import type { EvalStreamEvent } from "../types";
import { LearningToolsSection } from "./LearningToolsSection";

interface EvalFileInfo {
  name: string;
  updatedAt: string;
  size: number;
  questionCount: number;
  overallAvg: number;
  /** V399-2 P2: 该结果文件的数据指纹（无指纹的旧产物为 null） */
  fingerprint?: string | null;
  /** V399-2 P2: 结果数据指纹 ≠ 当前数据指纹 → 数据已变更, 结果过期 */
  stale?: boolean;
}

/** V399-2 P2: 当前数据指纹（来自 /api/eval/results, 前端 stale 徽标 + 指纹展示） */
interface EvalFingerprintInfo {
  algorithm?: string;
  value?: string | null;
  sampledAt?: string;
}

interface EvalQuestion {
  question_id: string;
  question_type: string;
  question?: string;
  overall: number;
  dimA: number;
  dimB: number;
  dimC: number;
  dimD: number;
  metrics: Record<string, MetricItem>;
  hypothesis?: string;
  fusedContext?: string;
  entity_names?: string[];
  _debugCoarse?: Record<string, any>;
  _debugRefined?: Record<string, any>;
  error?: string;
}

interface MetricItem {
  score: number;
  rule_score?: number;
  llm_score?: number | null;
  source: string;
  reason?: string;
}

/** 实时运行中的一步（每题一个节点） */
interface LiveStep {
  question: string;
  qtype: string;
  status: "running" | "done" | "failed";
  index?: number;
  total?: number;
  phase?: string;
  error?: string;
  overall?: number;
  dims?: { A: number; B: number; C: number; D: number };
  detail?: string;
  /** 逐步到达的指标（分数/来源/说明/评分逻辑），展开可见 */
  metrics: Array<{ key: string; cat?: string; score: number | null; rule_score?: number | null; llm_score?: number | null; source?: string; reason?: string | null }>;
}

const EVAL_SCRIPTS: Array<{ value: string; label: string; desc: string }> = [
  { value: "eval-32-metrics", label: "eval-32-metrics", desc: "32 评分指标主评测（A12+B9+C3+D7），逐题逐指标推送" },
  { value: "run-eval-dual", label: "run-eval-dual", desc: "双模式 A/B 对比（template vs adaptive），每题两个耗时" },
  { value: "ablation-eval", label: "ablation-eval", desc: "真消融（12 算子×50 题，MRR/NDCG/paper_hit），按算子分阶段" },
];

/** 所选评测脚本的指标规格（标题跟随脚本显示） */
const SCRIPT_SPEC: Record<string, string> = {
  "eval-32-metrics": "32 评分指标（A12+B9+C3+D7）+ 6 观测",
  "run-eval-dual": "双模式 A/B 对比（template vs adaptive）",
  "ablation-eval": "12 算子消融（MRR/NDCG/paper_hit）",
};

/** 脚本默认输出文件名（默认选中结果时优先匹配） */
const SCRIPT_OUTPUT: Record<string, string> = {
  "eval-32-metrics": "eval_32metrics.json",
  "run-eval-dual": "eval_32metrics_dual.json",
  "ablation-eval": "",
};

/** 32 指标中文说明（对齐 METRIC_SPEC，含旧版本 V40 的 28 项） */
const METRIC_DESC: Record<string, { cat: string; desc: string }> = {
  context_recall: { cat: "A1", desc: "实体召回 — gold实体在fusedContext中的命中率(规则max LLM)" },
  context_precision: { cat: "A2", desc: "分块精度 — LLM判定检索chunk与问题相关比例" },
  context_relevancy: { cat: "A3", desc: "上下文相关性 — fusedContext有效信息占比(3轮中位数)" },
  entity_utilization: { cat: "A4", desc: "实体利用率 — 检索实体在fusedContext中的命中率" },
  mrr: { cat: "A5", desc: "MRR — embedding语义首相关排名倒数" },
  ndcg: { cat: "A6", desc: "NDCG — embedding语义排序质量归一化" },
  context_diversity: { cat: "A7", desc: "分块多样性 — 去YAML+取中部200字去重比例" },
  cross_doc_coverage: { cat: "A8", desc: "跨文档覆盖 — 检索覆盖的论文来源数(min(1,count/5))" },
  context_json_contamination: { cat: "A9", desc: "上下文JSON噪音 — fusedContext中非语义噪音行占比" },
  paper_hit: { cat: "A10", desc: "论文命中 — fusedContext是否含目标论文标题片段(规则0/1)" },
  paper_recall_at_k: { cat: "A11", desc: "论文召回率 — 检索原始chunk中目标论文占比" },
  source_grounded: { cat: "A12", desc: "溯源达标 — 答案引用目标论文(0否认/0.5未提/1引用)" },
  answer_correctness: { cat: "B1", desc: "答案正确性 — 与金标语义一致性" },
  answer_completeness: { cat: "B2", desc: "答案完整性 — 覆盖金标核心要点(答多不扣分)" },
  answer_relevancy: { cat: "B3", desc: "答案相关性 — 是否直接针对提问无发散" },
  faithfulness: { cat: "B4", desc: "忠实度 — 事实陈述是否有检索上下文依据" },
  hallucination_rate: { cat: "B5", desc: "反幻觉率 — 是否编造不存在事实(1=无编造)" },
  factual_consistency: { cat: "B6", desc: "事实一致性 — 回答内部事实逻辑不矛盾" },
  citation_f1: { cat: "B7", desc: "引用准确度 — 来源标注可验证性综合得分" },
  conciseness: { cat: "B8", desc: "简洁度 — 答多且有实质不扣,只扣真冗余" },
  answer_readability: { cat: "B9", desc: "可读性 — 文本结构分层表达清晰度" },
  cot_quality: { cat: "C1", desc: "COT推理链质量 — 五级离散3轮中位数" },
  multi_hop_accuracy: { cat: "C2", desc: "多跳推理准确率 — 仅多跳题型评测" },
  reasoning_depth: { cat: "C3", desc: "推理深度 — 逻辑连贯+无隐含假设+拒答合理性" },
  stage2_latency_norm: { cat: "D1", desc: "Stage2归一化耗时 — 1-min(1,ms/30000)" },
  stage3_latency_norm: { cat: "D2", desc: "Stage3归一化耗时 — 1-min(1,ms/60000)" },
  stage4_latency_norm: { cat: "D3", desc: "Stage4归一化耗时 — 1-min(1,ms/40000)" },
  end_to_end_norm: { cat: "D4", desc: "端到端归一化耗时 — 1-min(1,ms/90000)" },
  token_efficiency: { cat: "D5", desc: "Token效率 — √(金标字符数/回答字符数)" },
  neo4j_query_norm: { cat: "D6", desc: "Neo4j查询归一化 — 1-min(1,n/20)" },
  pg_query_norm: { cat: "D7", desc: "PG查询归一化 — 1-min(1,n/15)" },
  // raw 观测项（不计分）
  stage2_latency_ms: { cat: "D-raw", desc: "Stage2实际耗时(毫秒)" },
  stage3_latency_ms: { cat: "D-raw", desc: "Stage3实际耗时(毫秒)" },
  stage4_latency_ms: { cat: "D-raw", desc: "Stage4实际耗时(毫秒)" },
  end_to_end_latency_ms: { cat: "D-raw", desc: "端到端实际耗时(毫秒)" },
  neo4j_query_count: { cat: "D-raw", desc: "Neo4j查询次数" },
  pg_query_count: { cat: "D-raw", desc: "PG查询次数" },
};

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  judge: { label: "LLM", cls: "bg-blue-50 text-blue-700" },
  rule: { label: "规则", cls: "bg-green-50 text-green-700" },
  mixed: { label: "混合", cls: "bg-purple-50 text-purple-700" },
  embedding: { label: "向量", cls: "bg-cyan-50 text-cyan-700" },
  raw: { label: "原始", cls: "bg-gray-100 text-gray-600" },
};

const DIM_META = [
  { key: "A", label: "检索质量", icon: <Search className="h-3.5 w-3.5" />, inScore: true },
  { key: "B", label: "答案质量", icon: <ListChecks className="h-3.5 w-3.5" />, inScore: true },
  { key: "C", label: "推理质量", icon: <Brain className="h-3.5 w-3.5" />, inScore: true },
  { key: "D", label: "性能观测", icon: <Gauge className="h-3.5 w-3.5" />, inScore: false },
];

/** 评分逻辑说明（对齐 scripts/eval-32-metrics.ts 真实实现） */
const METRIC_LOGIC: Record<string, { formula?: string; rule?: string; code?: string; source: string }> = {
  context_recall: {
    formula: "weighted_hits / total_weight（gold实体权重: 核心实体2 / 普通1，子串+正则+字符重合80% + embedding语义兜底）",
    rule: "规则层：gold_entities 逐实体匹配 fusedContext（直接包含/边界正则/字符重叠≥80% → 权重×0.7/embedding余弦≥0.85 → ×0.7）",
    code: "isCore = g.length >= 4 && !/^\\d/.test(g); weight = isCore ? 2 : 1;\nif (fcNorm.includes(gNorm)) { weightedHits += weight; continue; }\nif (new RegExp('(?:^|[^一-龥])' + esc + '(?:$|[^一-龥])').test(fcNorm)) { weightedHits += weight; continue; }\nif (overlap >= goldChars.size * 0.8) { weightedHits += weight * 0.7; }",
    source: "规则+LLM 混合（max）",
  },
  context_precision: {
    formula: "相关chunk数 / 总chunk数（LLM 逐 chunk 判相关性）",
    rule: "规则层：gold关键词命中比例（问题+金标分词前6+4个，chunk 含关键词计相关）",
    code: "a2Rule = kwHitCnt / chunkCount;  // 关键词命中比例\nfor (i...) { p = '判断以下分块与问题的相关程度...'; res = await llmJudgeSingle(p); if (res.score > 0) relevantCnt += Math.min(1, res.score); }\na2Llm = relevantCnt / chunkCount;",
    source: "规则+LLM 混合（max）",
  },
  context_relevancy: {
    formula: "关键词密度 + LLM整体语义覆盖（3轮中位数）",
    rule: "规则层：gold关键词（2字词前12个）在 fusedContext 中的命中密度 a3Rule = min(1, kwDensity / (len/50))",
    code: "a3Rule = Math.min(1, kwDensity / Math.max(1, fcForRecall.length / 50));\n// V42: 整体语义评估 — 整个fusedContext(截断6000)给LLM评估信息价值占比",
    source: "规则+LLM 混合（max）",
  },
  entity_utilization: {
    formula: "命中实体数 / 检索实体总数（子串命中 + LLM 概念蕴含兜底）",
    rule: "规则层：检索实体（entityNames前20 + 精检索实体）在 fusedContext 中的命中比例",
    code: "hit = uniqueEntities.filter(e => fcText.includes(e) || fcNorm.includes(normalize(e))).length;\n// 未命中实体取前6个交 LLM 判断概念是否蕴含\nllmHits += res.score;  a4Llm = (hit + llmHits) / uniqueEntities.length;",
    source: "规则+LLM 混合（max）",
  },
  mrr: {
    formula: "1 / 首个相关 chunk 的排名（相关度阈值 ≥0.25，软兜底 best/(bestRank+1)）",
    rule: "规则层：gold关键词（2字词前12个）在 chunk 文本/中部200字的命中排名",
    code: "a5Rule = 1 / (i + 1);  // 首个含gold关键词的chunk\nsimilarities[i] >= 0.25 → a5Llm = 1 / (i + 1);\n// 全部<0.25 时: bestSim>0 → bestSim/(bestRank+1)",
    source: "规则+LLM 混合（max）",
  },
  ndcg: {
    formula: "DCG / IDCG（相关度×log2衰减累加）",
    rule: "规则层：DCG = Σ(hit_i / log2(i+2))，IDCG = 1/log2(2)",
    code: "dcg += (hit ? 1 : 0) / Math.log2(i + 2);\na6Rule = Math.min(1, dcgRule / (1 / Math.log2(2)));\na6Llm = Math.min(1, idcg > 0 ? dcg / idcg : 0);",
    source: "规则+LLM 混合（max）",
  },
  context_diversity: {
    formula: "去重后中部文本数 / chunk总数（去YAML+取中部200字）",
    rule: "规则层：unique(midTexts) / total，LLM 补充独立信息占比判定",
    code: "a7Rule = diversitySet.size / chunkMidTexts.length;\n// LLM: '判断片段独立信息占比(0=重复,1=独立)' 取前8个片段",
    source: "规则+LLM 混合（max）",
  },
  cross_doc_coverage: {
    formula: "min(1, 覆盖论文数 / 5)",
    rule: "规则层：从 chunk 提取 paperTitle/title 行计数不同论文数",
    code: "a8Rule = Math.min(1, docSet.size / 5);\n// LLM: 识别片段来源论文篇数 → 篇数/5（封顶1）",
    source: "规则+LLM 混合（max）",
  },
  context_json_contamination: {
    formula: "1 - 污染行数 / 总行数（4类噪音特征行级检测 + LLM 样本判定）",
    rule: "规则层：YAML元数据行/JSON块/符号密度≥8且占比>0.3/markdown元数据行 → 污染行",
    code: "a9Rule = 1 - Math.min(1, contaminatedLines / totalLines);\n// LLM 层: 疑似污染样本(前6行)交 LLM 判定污染程度；无疑似行 → 1.0",
    source: "规则+LLM 混合（max）",
  },
  paper_hit: {
    formula: "二进制 0/1：目标论文标题变体是否出现在 fusedContext",
    rule: "规则层：paperVariants（完整标题/去作者/首段）标准化后子串匹配",
    code: "paperHitInContext = paperVariants.some(v => fcNorm.includes(normPaper(v)));\na10Rule = paperHitInContext ? 1 : 0;",
    source: "规则（0/1）",
  },
  paper_recall_at_k: {
    formula: "目标论文 chunk 数 / 检索 chunk 总数",
    rule: "规则层：chunk 原文含目标论文标题变体即算该论文的 chunk",
    code: "paperChunks = allChunks.filter(c => paperVariants.some(v => normPaper(c.text).includes(normPaper(v))));\na11Rule = allChunks.length > 0 ? Math.min(1, paperChunks.length / allChunks.length) : 0;",
    source: "规则",
  },
  source_grounded: {
    formula: "0 否认 / 0.5 未提 / 1 引用目标论文",
    rule: "规则层：答案是否否认(正则) + 是否含论文标题 + fusedContext是否已含目标论文",
    code: "deniedPaper = /未提供|没有提供|无法访问|您并未/.test(hypothesis.slice(0,300));\na12Rule = deniedPaper ? 0 : (paperHitInHyp || a10Rule ? 1 : 0.5);",
    source: "规则",
  },
  answer_correctness: {
    formula: "LLM 判定 0~1（与金标语义一致性，3轮取中位数）",
    rule: "B 组 9 指标批量打分（3 轮洗牌 + 中位数），失败降级逐项补评",
    code: "bScores = await llmJudgeBatchObject(bPromptText);  // 9项一次LLM调用\n// 失败→逐项 llmJudgeSingle 补评；最终取 3 轮中位数",
    source: "LLM（3轮中位数）",
  },
  answer_completeness: { formula: "LLM 判定 0~1（覆盖金标核心要点，答多不扣分）", rule: "同 B 组批量打分（3 轮中位数）", code: "同 answer_correctness（B 组 9 项共 3 轮批量）", source: "LLM（3轮中位数）" },
  answer_relevancy: { formula: "LLM 判定 0~1（直接针对提问无发散）", rule: "同 B 组批量打分（3 轮中位数）", code: "同 answer_correctness（B 组 9 项共 3 轮批量）", source: "LLM（3轮中位数）" },
  faithfulness: { formula: "LLM 判定 0~1（事实陈述有检索上下文依据），提示词附带检索上下文", rule: "同 B 组批量打分（3 轮中位数）", code: "ctxForB = ['faithfulness','hallucination_rate','citation_f1','factual_consistency'].includes(key) ? ' 检索上下文: ' + fusedContext.substring(0, 3000) : '';", source: "LLM（3轮中位数）" },
  hallucination_rate: { formula: "反幻觉 0~1（1=无编造，0=大量虚假），提示词附带检索上下文", rule: "同 B 组批量打分（3 轮中位数）", code: "同 faithfulness（带检索上下文）", source: "LLM（3轮中位数）" },
  factual_consistency: {
    formula: "LLM 判定 0~1（内部事实不矛盾）+ 交叉验证降权",
    rule: "交叉验证：fc≥0.75 且 faith/hallu/correct 至少两项≤0.3 → 降权 fc×(1-penalty×0.7)，下限0.1",
    code: "penalty = 1 - (faithScore + halluScore + correctScore) / 3;\nadjusted = Math.max(0.1, fcScore * (1 - penalty * 0.7));",
    source: "LLM（3轮中位数）+ 交叉验证",
  },
  citation_f1: { formula: "LLM 判定 0~1（引用来源可验证性），提示词附带检索上下文", rule: "同 B 组批量打分（3 轮中位数）", code: "同 faithfulness（带检索上下文）", source: "LLM（3轮中位数）" },
  conciseness: { formula: "LLM 判定 0~1（只扣真冗余，详细论述不扣）", rule: "同 B 组批量打分（3 轮中位数）", code: "同 answer_correctness（B 组 9 项共 3 轮批量）", source: "LLM（3轮中位数）" },
  answer_readability: { formula: "LLM 判定 0~1（结构分层表达清晰度）", rule: "同 B 组批量打分（3 轮中位数）", code: "同 answer_correctness（B 组 9 项共 3 轮批量）", source: "LLM（3轮中位数）" },
  cot_quality: {
    formula: "五级离散（0/0.25/0.5/0.75/1.0）3 轮中位数（概念定义/事实检索题不适用）",
    rule: "LLM 按 5 级锚点打分：0=完全无推理 → 1.0=三步以上完整推理链且每步有依据",
    code: "promptC1 = '严格按五级离散刻度打分(只输出: 0/0.25/0.5/0.75/1.0)...';\ncotRes = await runThreeRoundMedian(() => _llmJudgeOnce(promptC1), d => d.score);",
    source: "LLM（五级×3轮中位数）",
  },
  multi_hop_accuracy: {
    formula: "五级离散 3 轮中位数（仅多跳推理题，其余题型 null）",
    rule: "LLM 评估多跳链路：0=完全断裂 → 1=完整且每跳有上下文依据",
    code: "if (q.question_type === '多跳推理') { ... runThreeRoundMedian(...) } else { score: null }",
    source: "LLM（五级×3轮中位数）",
  },
  reasoning_depth: {
    formula: "三项分评均值：logical_coherence + no_implicit_assumption + refusal_reasonableness",
    rule: "LLM 批量返回 JSON 三项，失败回退逐项评分",
    code: "c3Scores = await llmJudgeBatchObject(promptC3);  // {logical_coherence, no_implicit_assumption, refusal_reasonableness}\nc3Vals.filter(v => v != null) → mean",
    source: "LLM（三项均值）",
  },
  stage2_latency_norm: { formula: "1 - min(1, stage2_ms / 30000)", rule: "规则：Stage2 粗检索耗时归一化", code: "normalizeReverse(timings.stage2_coarse ?? 0, MAX_LATENCY_S2)", source: "规则" },
  stage3_latency_norm: { formula: "1 - min(1, stage3_ms / 60000)", rule: "规则：Stage3 精检索耗时归一化", code: "normalizeReverse(timings.stage3_refine ?? 0, MAX_LATENCY_S3)", source: "规则" },
  stage4_latency_norm: { formula: "1 - min(1, stage4_ms / 40000)", rule: "规则：Stage4 推理耗时归一化", code: "normalizeReverse(timings.stage4_total ?? 0, MAX_LATENCY_S4)", source: "规则" },
  end_to_end_norm: { formula: "1 - min(1, total_ms / 90000)", rule: "规则：端到端耗时归一化", code: "normalizeReverse(result.totalMs ?? 0, MAX_E2E)", source: "规则" },
  token_efficiency: { formula: "√(max(0.1, gold_chars / hyp_chars))", rule: "规则：金标/回答字符比开方（软化长度惩罚）", code: "rawRatio = goldChars / 1.5 / Math.max(1, hypChars / 1.5);\nscore = Math.min(1, Math.sqrt(Math.max(0.1, rawRatio)));", source: "规则" },
  neo4j_query_norm: { formula: "1 - min(1, neo4j查询次数 / 20)", rule: "规则：查询次数归一化", code: "normalizeReverse((timings as any).neo4j_queries || 0, MAX_NEO4J_QUERY)", source: "规则" },
  pg_query_norm: { formula: "1 - min(1, pg查询次数 / 15)", rule: "规则：查询次数归一化", code: "normalizeReverse((timings as any).pg_queries || 0, MAX_PG_QUERY)", source: "规则" },
};

const scoreColor = (v: number) => v >= 0.8 ? "bg-green-500" : v >= 0.6 ? "bg-amber-500" : "bg-red-500";

/** 演示回退数据：无真实结果文件时的示例评分（演示值 0.91，满分 1 分制），明确标注非真实评测 */
const DEMO_FALLBACK: EvalStreamEvent[] = [
  { type: "phase", phase: "start", total: 50, output: "eval_32metrics.json" },
  { type: "question_start", question: "Q01", qtype: "概念定义", index: 1, total: 50 },
  { type: "metric_done", question: "Q01", key: "context_recall", cat: "A1", score: 0.91, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "context_precision", cat: "A2", score: 0.87, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "context_relevancy", cat: "A3", score: 0.85, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "entity_utilization", cat: "A4", score: 0.92, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "mrr", cat: "A5", score: 0.8, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "ndcg", cat: "A6", score: 0.78, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "context_diversity", cat: "A7", score: 0.9, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "cross_doc_coverage", cat: "A8", score: 0.8, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "context_json_contamination", cat: "A9", score: 0.95, source: "mixed", reason: null },
  { type: "metric_done", question: "Q01", key: "paper_hit", cat: "A10", score: 1.0, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "paper_recall_at_k", cat: "A11", score: 0.9, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "source_grounded", cat: "A12", score: 0.85, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "answer_correctness", cat: "B1", score: 0.9, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "answer_completeness", cat: "B2", score: 0.88, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "answer_relevancy", cat: "B3", score: 0.95, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "faithfulness", cat: "B4", score: 0.93, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "hallucination_rate", cat: "B5", score: 0.97, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "factual_consistency", cat: "B6", score: 0.9, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "citation_f1", cat: "B7", score: 0.86, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "conciseness", cat: "B8", score: 0.89, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "answer_readability", cat: "B9", score: 0.94, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "cot_quality", cat: "C1", score: 0.85, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "multi_hop_accuracy", cat: "C2", score: null, source: "rule", reason: "题型不适用" },
  { type: "metric_done", question: "Q01", key: "reasoning_depth", cat: "C3", score: 0.9, source: "judge", reason: null },
  { type: "metric_done", question: "Q01", key: "stage2_latency_norm", cat: "D1", score: 0.9, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "stage3_latency_norm", cat: "D2", score: 0.95, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "stage4_latency_norm", cat: "D3", score: 0.85, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "end_to_end_norm", cat: "D4", score: 0.8, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "neo4j_query_norm", cat: "D6", score: 0.9, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "pg_query_norm", cat: "D7", score: 0.85, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "token_efficiency", cat: "D5", score: 0.87, source: "rule", reason: null },
  { type: "metric_done", question: "Q01", key: "stage2_latency_ms", cat: "D-raw", score: 2245, source: "raw", reason: null },
  { type: "metric_done", question: "Q01", key: "stage3_latency_ms", cat: "D-raw", score: 4, source: "raw", reason: null },
  { type: "metric_done", question: "Q01", key: "stage4_latency_ms", cat: "D-raw", score: 31764, source: "raw", reason: null },
  { type: "metric_done", question: "Q01", key: "end_to_end_latency_ms", cat: "D-raw", score: 101206, source: "raw", reason: null },
  { type: "metric_done", question: "Q01", key: "neo4j_query_count", cat: "D-raw", score: 0, source: "raw", reason: null },
  { type: "metric_done", question: "Q01", key: "pg_query_count", cat: "D-raw", score: 3, source: "raw", reason: null },
  { type: "question_done", question: "Q01", ok: true, overall: 0.91, dimA: 0.91, dimB: 0.91, dimC: 0.88, dimD: 0.87 },
  { type: "phase", phase: "done", output: "eval_32metrics.json" },
];

/**
 * 构建演示事件：优先从真实结果文件 eval_32metrics.json 同步真实分数（真实评测完成后自动反映），
 * 无有效数据时回退演示值（0.91 示例评分，满分 1 分制，明确标注非真实）。
 */
async function buildDemoEvents(): Promise<{ events: EvalStreamEvent[]; label: string; fromReal: boolean }> {
  try {
    const res = await fetch("/api/eval/results?file=eval_32metrics.json");
    const data = await res.json();
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    const valid = list.filter(
      (r: any) => r && typeof r.overall === "number" && r.metrics && Object.keys(r.metrics).length > 0
    );
    if (valid.length > 0) {
      const shown = valid.slice(0, 2);
      const events: EvalStreamEvent[] = [
        { type: "phase", phase: "start", total: valid.length, output: "eval_32metrics.json" },
      ];
      for (const q of shown) {
        const idx = valid.indexOf(q) + 1;
        events.push({ type: "question_start", question: q.question_id, qtype: q.question_type, index: idx, total: valid.length });
        for (const [key, m] of Object.entries<any>(q.metrics)) {
          events.push({
            type: "metric_done", question: q.question_id, key,
            cat: METRIC_DESC[key]?.cat || "D",
            score: typeof m.score === "number" ? m.score : null,
            rule_score: typeof m.rule_score === "number" ? m.rule_score : null,
            llm_score: typeof m.llm_score === "number" ? m.llm_score : null,
            source: m.source || "rule",
            reason: m.reason || null,
          });
        }
        events.push({
          type: "question_done", question: q.question_id, ok: true,
          overall: q.overall, dimA: q.dimA, dimB: q.dimB, dimC: q.dimC, dimD: q.dimD,
        });
      }
      events.push({ type: "phase", phase: "done", output: "eval_32metrics.json" });
      return { events, label: `同步自 eval_32metrics.json 真实结果（${shown.length} 题演示 · 满分 1 分制）`, fromReal: true };
    }
  } catch { /* 网络失败回退演示值 */ }
  return { events: DEMO_FALLBACK, label: "演示评分 0.91/1.0（示例数据 · 满分 1 分制 · 非真实评测）", fromReal: false };
}

export const EvalPanel: FC = () => {
  // V290: 面板内 tab（评测 / 学习引擎）
  const [panelTab, setPanelTab] = useState<"eval" | "learning">("eval");
  const [files, setFiles] = useState<EvalFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [questions, setQuestions] = useState<EvalQuestion[]>([]);
  // W8: Agent 评测摘要（主评测与 agent 评测桥接展示）
  const [agentSummary, setAgentSummary] = useState<Record<string, number | string> | null>(null);
  // V399-2 P2: 当前数据指纹（stale 徽标/指纹展示用）
  const [currentFingerprint, setCurrentFingerprint] = useState<EvalFingerprintInfo | null>(null);
  const [selectedQ, setSelectedQ] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsedDims, setCollapsedDims] = useState<Set<string>>(new Set());
  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);
  // demo/实时步骤区内指标行的展开态（key = `${question}:${metricKey}`）
  const [expandedLiveMetric, setExpandedLiveMetric] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState<"answer" | "context" | "debug" | null>(null);

  // ─── 实时运行区状态 ───
  const [script, setScript] = useState("eval-32-metrics");
  const [questionsArg, setQuestionsArg] = useState("");
  const [outputArg, setOutputArg] = useState("");
  const [dimsArg, setDimsArg] = useState("");
  const [limitArg, setLimitArg] = useState(50);
  // V397: 教育评测（12 项指标：技术 6 + 教学效果 6）
  const [eduEval, setEduEval] = useState<{ techScore?: number; metrics?: Array<{ id: number; name: string; value: number; sample: string; group: string }>; suggestions?: Array<{ metric: string; action: string; priority: string }> } | null>(null);
  const [eduEvalBusy, setEduEvalBusy] = useState(false);
  const [eduOpen, setEduOpen] = useState<number | null>(null);
  // V381: 评测配置（模型/模式/机制）— 智能默认 + 用户可选
  const [judgeModel, setJudgeModel] = useState("deepseek-v4-flash");
  const [evalPreset, setEvalPreset] = useState<"smart" | "fast" | "rigorous" | "cross">("smart");
  const [crossJudge, setCrossJudge] = useState(false);
  const [mergePolicy, setMergePolicy] = useState("max");
  const [running, setRunning] = useState(false);
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [lastLit, setLastLit] = useState<string | null>(null);
  const [runPhase, setRunPhase] = useState<{ phase: string; total?: number; output?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stepMapRef = useRef<Map<string, LiveStep>>(new Map());
  // demo 播放中（沙箱回放，不真打 API）
  const [demoPlaying, setDemoPlaying] = useState(false);
  const demoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const autoPlayedRef = useRef(false);

  // 加载文件列表
  const loadFiles = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/eval/results");
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setFiles(data.files || []);
      // V399-2 P2: 当前数据指纹（stale 徽标/指纹展示数据源）
      setCurrentFingerprint(data.currentFingerprint || null);
      if (data.files?.length > 0 && !selectedFile) {
        // 默认选中：优先当前脚本的标准输出文件，其次有效的标准结构文件（跳过 dual/旧版对比格式）
        const prefer = SCRIPT_OUTPUT[script] || "";
        const preferred = data.files.find((f: EvalFileInfo) => f.name === prefer && f.questionCount > 0);
        if (preferred) { setSelectedFile(preferred.name); return; }
        const valid = data.files.filter((f: EvalFileInfo) => f.questionCount > 0 && !f.name.includes("dual"));
        const best = valid.find((f: EvalFileInfo) => f.overallAvg > 0) || valid[0] || data.files[0];
        setSelectedFile(best.name);
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  // 加载选中文件
  useEffect(() => {
    if (!selectedFile) return;
    setLoading(true);
    setError("");
    fetch(`/api/eval/results?file=${encodeURIComponent(selectedFile)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); setQuestions([]); return; }
        // 兼容性过滤: 只保留标准单题结构（overall 为 number），
        // dual/对比格式（{question_id,template,adaptive}）无 overall 会导致渲染崩溃
        const list: EvalQuestion[] = (data.data || []).filter(
          (r: any) => r && typeof r.overall === "number"
        );
        const skipped = (data.data || []).length - list.length;
        if (skipped > 0) setError(`${skipped} 条记录为对比格式（无 overall），已跳过展示（不影响评测）`);
        setQuestions(list);
        setSelectedQ(0);
        // W8: agent 评测摘要（主评测结果附带）
        setAgentSummary(data.agentSummary || null);
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedFile]);

  useEffect(() => { loadFiles(); }, []);

  // 进入页面自动播放一次 demo 动画（对齐 AskPanel：静默回放，用户可随时"退出演示"或启动真实评测）
  useEffect(() => {
    if (!autoPlayedRef.current) {
      autoPlayedRef.current = true;
      const timer = setTimeout(playDemo, 800);
      demoTimersRef.current.push(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 事件处理（真实 SSE 与 demo 回放共用）───
  const flushSteps = () => setLiveSteps(Array.from(stepMapRef.current.values()));

  const handleEvalEvent = (evt: EvalStreamEvent) => {
    const e = evt;
    switch (e.type) {
      case "phase":
        if (e.phase === "start") setRunPhase({ phase: "start", total: e.total, output: e.output });
        else if (e.phase === "done") {
          setRunPhase((p) => ({ phase: "done", total: p?.total, output: e.output || p?.output }));
          // V293: 评测完成 → 通知学习引擎立即刷新真实数据
          window.dispatchEvent(new CustomEvent("eval-run-done", { detail: { output: e.output } }));
        }
        else if (e.phase === "exit") setRunPhase((p) => p ? { ...p, phase: p.phase === "done" ? "done" : "exit" } : { phase: "exit" });
        break;
      case "question_start": {
        const step: LiveStep = {
          question: e.question, qtype: e.qtype || "", status: "running",
          index: e.index, total: e.total, phase: e.phase || undefined,
          metrics: [],
        };
        stepMapRef.current.set(e.question, step);
        flushSteps();
        break;
      }
      case "question_done": {
        const prev = stepMapRef.current.get(e.question);
        stepMapRef.current.set(e.question, {
          question: e.question,
          qtype: prev?.qtype || "",
          status: e.ok ? "done" : "failed",
          error: e.error,
          // 保留 question_start 带过来的序号/总数（question_done 事件本身不带 index）
          index: prev?.index,
          total: prev?.total,
          overall: e.overall,
          dims: e.ok && (e.dimA !== undefined || e.mrr !== undefined)
            ? { A: e.dimA ?? 0, B: e.dimB ?? 0, C: e.dimC ?? 0, D: e.dimD ?? 0 }
            : undefined,
          detail: e.ok
            ? (e.tMs !== undefined ? `T=${(e.tMs / 1000).toFixed(1)}s A=${((e.aMs ?? 0) / 1000).toFixed(1)}s plan=${e.planOps ?? "?"}ops` : "")
            : undefined,
          metrics: prev?.metrics || [],
        });
        setLastLit(e.question);
        setTimeout(() => setLastLit(null), 600);
        flushSteps();
        break;
      }
      case "metric_done": {
        const prev = stepMapRef.current.get(e.question);
        if (prev) {
          prev.metrics = [...prev.metrics, { key: e.key, cat: e.cat, score: e.score ?? null, rule_score: e.rule_score ?? null, llm_score: e.llm_score ?? null, source: e.source, reason: e.reason }];
          flushSteps();
        }
        break;
      }
      case "log":
        setLiveLogs((prev) => [...prev.slice(-80), e.line]);
        break;
      case "error":
        setError(e.message);
        setRunPhase((p) => p ? { ...p, phase: "error" } : { phase: "error" });
        break;
      case "done":
        // 评测结束：刷新文件列表 & 自动选中新输出文件
        void loadFiles();
        if (e.output) {
          setSelectedFile(e.output);
        }
        setRunPhase((p) => p ? { ...p, phase: "done", output: e.output || p.output } : { phase: "done", output: e.output });
        break;
    }
  };

  // ─── 沙箱 demo 回放（优先同步真实结果文件分数，无则回退演示值 0.91；不消耗 API）───
  const [demoLabel, setDemoLabel] = useState<string>("");
  const playDemo = async () => {
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];
    setDemoPlaying(true);
    setError("");
    setLiveLogs([]);
    stepMapRef.current.clear();
    setLiveSteps([]);
    setExpandedStep(null);
    setRunPhase(null);
    const { events, label, fromReal } = await buildDemoEvents();
    setDemoLabel(label + (fromReal ? " · 实时同步" : " · 演示数据"));
    const delay = fromReal ? 420 : 420;
    events.forEach((evt, i) => {
      demoTimersRef.current.push(setTimeout(() => handleEvalEvent(evt), i * delay));
    });
  };

  // ─── 退出 demo ───
  const exitDemo = () => {
    demoTimersRef.current.forEach(clearTimeout);
    demoTimersRef.current = [];
    setDemoPlaying(false);
    setLiveSteps([]);
    setRunPhase(null);
    stepMapRef.current.clear();
  };

  // ─── V397: 教育评测（12 项）───
  const runEduEval = async () => {
    setEduEvalBusy(true);
    setEduEval(null);
    try {
      const r = await fetch("/api/education/eval");
      const d = await r.json();
      if (d.ok) setEduEval(d);
    } catch { /* 忽略 */ }
    setEduEvalBusy(false);
  };

  useEffect(() => { void runEduEval(); }, []);

  // ─── 启动评测 ───
  const runEval = async () => {
    if (running) return;
    exitDemo();
    setRunning(true);
    setError("");
    setRunPhase(null);
    setLiveLogs([]);
    stepMapRef.current.clear();
    setLiveSteps([]);
    setExpandedStep(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // V381: 评测配置 → EVAL_* env（模型/机制）
      const evalEnv: Record<string, string> = {};
      if (judgeModel) evalEnv.EVAL_JUDGE_MODEL = judgeModel;
      if (judgeModel === "qwen3.7-max") {
        // qwen 走 DashScope 端点（多源评测）
        evalEnv.EVAL_JUDGE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
        evalEnv.EVAL_JUDGE_API_KEY = (window as any).__DASHSCOPE_KEY__ || "";
      }
      if (mergePolicy !== "max") evalEnv.EVAL_MERGE_POLICY = mergePolicy;
      if (evalPreset === "fast") evalEnv.EVAL_LIMIT = "10";
      if (evalPreset === "cross") {
        // 交叉复评模式：小样本 + 双模型
        evalEnv.EVAL_LIMIT = "10";
        evalEnv.EVAL_JUDGE_MODEL = "deepseek-v4-flash";
      }
      await api.streamEvalRun({
        script: script as "eval-32-metrics" | "run-eval-dual" | "ablation-eval",
        ...(questionsArg.trim() ? { questions: questionsArg.trim() } : {}),
        ...(outputArg.trim() ? { output: outputArg.trim() } : {}),
        ...(dimsArg.trim() ? { dims: dimsArg.trim() } : {}),
        ...(script === "ablation-eval" ? { limit: limitArg } : {}),
        env: evalEnv,
      }, (evt) => {
        handleEvalEvent(evt as EvalStreamEvent);
      }, controller.signal);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setRunPhase({ phase: "stopped" });
      } else {
        setError(err?.message || String(err));
        setRunPhase((p) => p ? { ...p, phase: "error" } : { phase: "error" });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  // ─── 停止评测（断开 SSE → 后端杀掉评测子进程）───
  const stopEval = () => {
    abortRef.current?.abort();
    setRunPhase((p) => p ? { ...p, phase: "stopping" } : { phase: "stopping" });
  };

  const q = questions[selectedQ];
  const toggleDim = (key: string) => {
    setCollapsedDims((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 按维度分组指标
  const groupMetrics = () => {
    const groups: Record<string, Array<[string, MetricItem]>> = { A: [], B: [], C: [], D: [] };
    if (!q?.metrics) return groups;
    for (const [key, item] of Object.entries(q.metrics)) {
      // raw 观测项（耗时/次数，不打分）单独统计，不进评分维度
      if (item.source === "raw") continue;
      const meta = METRIC_DESC[key];
      const cat = meta ? meta.cat[0] : "D";
      if (cat === "A" || cat === "B" || cat === "C") groups[cat].push([key, item]);
      else groups.D.push([key, item]);
    }
    return groups;
  };
  const groups = groupMetrics();
  // 评分指标数（不含 raw 观测——与评测脚本 METRIC_SPEC 口径一致）
  const scoringMetrics = q?.metrics ? Object.entries(q.metrics).filter(([, m]) => m.source !== "raw").length : 0;
  // raw 观测数（耗时/查询次数，独立显示）
  const rawMetrics = q?.metrics ? Object.entries(q.metrics).filter(([, m]) => m.source === "raw").length : 0;
  const dimCounts: Record<string, number> = {};
  for (const dim of DIM_META) dimCounts[dim.key] = groups[dim.key]?.length || 0;

  // 运行汇总统计
  const doneCount = liveSteps.filter((s) => s.status === "done").length;
  const failCount = liveSteps.filter((s) => s.status === "failed").length;
  const runningCount = liveSteps.filter((s) => s.status === "running").length;
  const avgOverall = liveSteps.filter((s) => s.overall !== undefined).reduce((sum, s) => sum + (s.overall ?? 0), 0) / Math.max(1, doneCount);

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">评测工作台</h2>
            <span className="text-xs text-muted-foreground">
              评测脚本：{SCRIPT_SPEC[script] || "—"}
            </span>
          </div>
          {/* V290: 面板内 tab（评测 / 学习引擎） */}
          <div className="flex gap-1">
            {([
              { key: "eval", label: "评测", icon: <BarChart3 className="h-3.5 w-3.5" /> },
              { key: "learning", label: "学习引擎", icon: <GraduationCap className="h-3.5 w-3.5" /> },
            ] as const).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setPanelTab(tab.key)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  panelTab === tab.key
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70"
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ───── V290: 学习引擎 tab（5 工具展示 + demo）───── */}
        {panelTab === "learning" ? (
          <Card className="p-4">
            <LearningToolsSection />
          </Card>
        ) : (
        <>
        {/* ───── V397: 教育评测（12 项：技术 6 + 教学效果 6）───── */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-emerald-600" />
            <span className="text-sm font-medium">教育场景评测（12 项指标）</span>
            <button
              type="button"
              onClick={() => void runEduEval()}
              disabled={eduEvalBusy}
              className="ml-auto flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${eduEvalBusy ? "animate-spin" : ""}`} />
              重新评测
            </button>
          </div>
          {eduEval ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-800">
                  综合技术分：{eduEval.techScore?.toFixed(3)}
                </span>
                <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                  BKT / 诊断 / 路径 / 批改 / 思政 / 闭环 · 掌握度 / 辅导 / 备课 / 批改效率 / 规划 / 满意度
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                {(eduEval.metrics ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setEduOpen((c) => (c === m.id ? null : m.id))}
                    className="rounded-lg border p-2.5 text-left transition-colors hover:bg-muted/40"
                    style={{ borderColor: m.group === "技术" ? "hsl(142 76% 85%)" : "hsl(38 92% 85%)" }}
                    title="点击展开详情"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium">{m.name}</span>
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{m.group}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="text-lg font-bold" style={{ color: m.value >= 0.8 ? "hsl(142 70% 35%)" : m.value >= 0.5 ? "hsl(38 90% 40%)" : "hsl(0 80% 50%)" }}>
                        {(m.value * 100).toFixed(0)}%
                      </span>
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                        <div className="h-full rounded" style={{ width: `${Math.min(100, m.value * 100)}%`, background: m.value >= 0.8 ? "hsl(142 70% 45%)" : m.value >= 0.5 ? "hsl(38 90% 50%)" : "hsl(0 80% 55%)" }} />
                      </div>
                    </div>
                    <div className="mt-1 truncate text-[9px] text-muted-foreground">{m.sample}</div>
                    {eduOpen === m.id && (
                      <div className="mt-2 border-t border-dashed pt-2 text-[10px] leading-4 text-muted-foreground">
                        <div>指标编号：#0{m.id}（{m.group}）</div>
                        <div>评测方法：{m.sample}</div>
                        <div className={m.value >= 0.8 ? "text-emerald-700" : m.value >= 0.5 ? "text-amber-700" : "text-red-700"}>
                          {m.value >= 0.8 ? "✅ 达标（≥80%）" : m.value >= 0.5 ? "⚠️ 需关注（50-80%）" : "❌ 不达标（<50%）"}
                        </div>
                      </div>
                    )}
                  </button>
                ))}
              </div>
              {eduEval.suggestions && eduEval.suggestions.length > 0 && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-amber-800">
                    <Sparkles className="h-3.5 w-3.5" /> 反馈闭环 · 自动改进建议（低分指标 + 负评热点驱动）
                  </div>
                  <div className="space-y-1">
                    {eduEval.suggestions.map((s, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[10px] leading-4 text-amber-900">
                        <span className={`mt-0.5 shrink-0 rounded px-1 py-px text-[8px] font-bold ${s.priority === "high" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                          {s.priority === "high" ? "高优先" : "中优先"}
                        </span>
                        <span><b>{s.metric}</b>：{s.action}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className={`h-4 w-4 animate-spin ${eduEvalBusy ? "" : "hidden"}`} />
              {eduEvalBusy ? "运行教育评测中（12 项指标）..." : "点击「重新评测」加载教育评测结果"}
            </div>
          )}
        </Card>

        {/* ───── 运行评测区（实时流程可视化）───── */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">运行评测（实时流程）</span>
            {runPhase?.phase === "done" && (
              <span className="flex items-center gap-1 rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">
                <CheckCircle2 className="h-3 w-3" /> 已完成
              </span>
            )}
            {runPhase?.phase === "exit" && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">已退出（可能被中断）</span>
            )}
            {runPhase?.phase === "stopped" && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">已停止</span>
            )}
            {runPhase?.phase === "error" && (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700">出错</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={script}
              onChange={(e) => setScript(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            >
              {EVAL_SCRIPTS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            {/* V381: 评测配置中心 — 预设/模型/机制 */}
            <select
              value={evalPreset}
              onChange={(e) => setEvalPreset(e.target.value as typeof evalPreset)}
              title="智能预设：智能=推荐配置 / 快速=10题样本 / 严谨=全量50题 / 交叉=双模型复评"
              className="rounded-md border border-violet-300 bg-violet-50/50 px-2 py-1.5 text-xs text-violet-800"
            >
              <option value="smart">✨ 智能模式（推荐）</option>
              <option value="fast">⚡ 快速模式（10题样本）</option>
              <option value="rigorous">🎯 严谨模式（全量50题）</option>
              <option value="cross">🔀 交叉复评（双模型）</option>
            </select>
            <select
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              title="评测 Judge 模型"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            >
              <option value="deepseek-v4-flash">Judge: DeepSeek V4 Flash（默认）</option>
              <option value="deepseek-v4-pro">Judge: DeepSeek V4 Pro（严谨）</option>
              <option value="qwen3.7-max">Judge: 通义千问 3.7 Max（异源）</option>
            </select>
            <select
              value={mergePolicy}
              onChange={(e) => setMergePolicy(e.target.value)}
              title="规则分与 LLM 分合并策略"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
            >
              <option value="max">合并: Max（规则/LLM 取高）</option>
              <option value="min">合并: Min（严格取低）</option>
              <option value="avg">合并: Avg（平均）</option>
              <option value="rule_only">合并: 仅规则分</option>
              <option value="llm_only">合并: 仅 LLM 分</option>
            </select>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={crossJudge} onChange={(e) => setCrossJudge(e.target.checked)} className="accent-violet-500" />
              交叉复评（qwen 异源）
            </label>
            <input
              value={questionsArg}
              onChange={(e) => setQuestionsArg(e.target.value)}
              placeholder="题号 Q01,Q02（留空=全部）"
              className="w-44 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50"
            />
            <input
              value={outputArg}
              onChange={(e) => setOutputArg(e.target.value)}
              placeholder="输出名 eval_xxx.json（可选）"
              className="w-48 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50"
            />
            <input
              value={dimsArg}
              onChange={(e) => setDimsArg(e.target.value)}
              placeholder="维度 A,B,C,D（可选）"
              className="w-40 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50"
            />
            {script === "ablation-eval" && (
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                题数
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={limitArg}
                  onChange={(e) => setLimitArg(Number(e.target.value))}
                  className="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                />
              </label>
            )}
            {!running ? (
              <>
                <button
                  type="button"
                  onClick={() => void runEval()}
                  className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  <Play className="h-3.5 w-3.5" /> 启动评测
                </button>
                <button
                  type="button"
                  onClick={playDemo}
                  disabled={demoPlaying}
                  className="flex items-center gap-1 rounded-md border border-dashed border-primary/40 px-3 py-1.5 text-xs text-primary hover:bg-primary/5 disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" /> 播放演示
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={stopEval}
                className="flex items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                <Square className="h-3 w-3" /> 停止
              </button>
            )}
            {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
          </div>
          {script !== "" && (
            <div className="mt-1.5 text-[10px] text-muted-foreground">
              {EVAL_SCRIPTS.find((s) => s.value === script)?.desc}
            </div>
          )}

          {/* demo 播放提示条（沙箱回放：优先同步真实结果分数，无则演示值 0.91 · 不消耗 API） */}
          {demoPlaying && (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-3 py-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-muted-foreground">{demoLabel}</span>
              <button
                type="button"
                onClick={exitDemo}
                className="ml-auto rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                退出演示
              </button>
            </div>
          )}

          {/* 步骤点亮：每题一个节点 */}
          <div className="mt-3 space-y-1.5">
            {liveSteps.length === 0 && !running && (
              <div className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                选择脚本并启动评测，执行链路将在这里逐步点亮（每题一个节点，可展开查看逐指标分数）
              </div>
            )}
            {liveSteps.map((step) => {
              const expanded = expandedStep === step.question;
              const liveMetrics = step.metrics;
              const grouped = liveMetrics.reduce<Record<string, typeof liveMetrics>>((acc, m) => {
                const cat = (m.cat || "D")[0];
                (acc[cat] ||= []).push(m);
                return acc;
              }, {});
              return (
                <div key={step.question} className={cn(
                  "rounded border p-2 transition-colors",
                  step.status === "running" && "border-primary/40 bg-primary/5",
                  step.status === "failed" && "border-red-200 bg-red-50/60",
                  step.status === "done" && "border-border hover:border-primary/25",
                  expanded && "border-primary/50",
                  step.status === "done" && lastLit === step.question && "step-light-up"
                )}>
                  <button
                    type="button"
                    onClick={() => setExpandedStep(expanded ? null : step.question)}
                    className="w-full text-left"
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="w-6 shrink-0 rounded bg-muted px-1 text-center text-[10px] text-muted-foreground">{step.index ?? "?"}</span>
                      {step.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                      {step.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                      {step.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-600" />}
                      <span className="font-medium">{step.question}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{step.qtype}</span>
                      {step.phase && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[9px] text-blue-700">{step.phase}</span>
                      )}
                      {step.status === "done" && step.overall !== undefined && (
                        <span className={cn("ml-auto font-mono text-xs", scoreColor(step.overall).replace("bg-", "text-"))}>
                          {typeof step.overall === "number" ? step.overall.toFixed(3) : "–"}
                        </span>
                      )}
                      {step.detail && <span className="ml-auto font-mono text-[9px] text-muted-foreground">{step.detail}</span>}
                      {liveMetrics.length > 0 && (
                        <span className="shrink-0 text-[9px] text-muted-foreground">{liveMetrics.length} 指标</span>
                      )}
                      <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-180")} />
                    </div>
                    {step.error && <div className="mt-1 truncate text-[10px] text-red-600">{step.error}</div>}
                  </button>
                  {/* 展开：逐指标明细（分数/来源/说明） */}
                  {expanded && (
                    <div className="mt-2 space-y-1 rounded bg-muted/20 p-2">
                      {Object.entries(grouped).map(([cat, items]) => (
                        <div key={cat}>
                          <div className="text-[10px] font-medium text-primary">维度 {cat}</div>
                          <div className="mt-0.5 space-y-0.5">
                            {items.map((m) => {
                              const meta = METRIC_DESC[m.key];
                              const badge = SOURCE_BADGE[m.source || "raw"] || SOURCE_BADGE.raw;
                              const isRaw = m.source === "raw";
                              const liveExpanded = expandedLiveMetric === `${step.question}:${m.key}`;
                              return (
                                <div key={m.key} className="rounded border border-border/50">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedLiveMetric(liveExpanded ? null : `${step.question}:${m.key}`)}
                                    className="flex w-full items-center gap-2 rounded bg-background/70 px-1.5 py-1 text-left text-[11px] hover:bg-accent/40"
                                  >
                                    <span className="w-10 shrink-0 font-mono text-[9px] text-primary">{m.cat || meta?.cat || m.key.slice(0, 4)}</span>
                                    <span className="w-32 shrink-0 truncate text-foreground">{m.key}</span>
                                    <span className={cn("shrink-0 rounded px-1 py-0.5 text-[9px]", badge.cls)}>{badge.label}</span>
                                    <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                                      <div
                                        className={cn("h-full rounded", isRaw || m.score === null ? "bg-gray-400" : scoreColor(m.score))}
                                        style={{ width: `${Math.min(100, (m.score ?? 0) * 100)}%` }}
                                      />
                                    </div>
                                    <span className="w-10 shrink-0 text-right font-mono text-foreground">
                                      {isRaw ? m.score : m.score === null ? "–" : `${typeof m.score === "number" ? m.score.toFixed(3) : "–"}`}
                                    </span>
                                    <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform", liveExpanded && "rotate-180")} />
                                  </button>
                                  {liveExpanded && (
                                    <div className="rounded-b border-t border-border/40 bg-background/70 px-1.5 py-1 text-[10px] text-muted-foreground">
                                      <div>{meta?.desc || m.key}</div>
                                      {/* 评分明细（动态数据：规则分/LLM分/来源） */}
                                      {(m.rule_score !== null && m.rule_score !== undefined || m.llm_score !== null && m.llm_score !== undefined) && (
                                        <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px]">
                                          {m.rule_score !== null && m.rule_score !== undefined && (
                                            <span>规则分: <b className="text-foreground">{typeof m.rule_score === "number" ? m.rule_score.toFixed(3) : "–"}</b></span>
                                          )}
                                          {m.llm_score !== null && m.llm_score !== undefined && (
                                            <span>LLM分: <b className="text-foreground">{typeof m.llm_score === "number" ? m.llm_score.toFixed(3) : "–"}</b></span>
                                          )}
                                          <span>最终: <b className="text-foreground">{typeof m.score === "number" ? m.score.toFixed(3) : "–"}</b></span>
                                        </div>
                                      )}
                                      {/* 评分逻辑（静态说明：公式/规则/代码，提炼自评测脚本真实实现） */}
                                      {(() => {
                                        const logic = METRIC_LOGIC[m.key];
                                        if (!logic) return null;
                                        return (
                                          <div className="mt-1.5 space-y-1 rounded bg-muted/30 p-1.5">
                                            <div className="text-[9px] font-medium text-primary">
                                              评分逻辑 · {logic.source}
                                            </div>
                                            {logic.formula && (
                                              <div className="rounded bg-background/80 p-1 font-mono text-[9px] leading-4">
                                                <span className="text-primary">公式 </span>{logic.formula}
                                              </div>
                                            )}
                                            {logic.rule && (
                                              <div className="text-[9px] leading-4">
                                                <span className="text-primary">规则 </span>{logic.rule}
                                              </div>
                                            )}
                                            {logic.code && (
                                              <pre className="overflow-auto rounded bg-background/80 p-1 font-mono text-[9px] leading-4">
                                                <span className="text-primary">代码 </span>{logic.code}
                                              </pre>
                                            )}
                                          </div>
                                        );
                                      })()}
                                      {m.reason && <div className="mt-1 text-[10px] text-amber-600">{m.reason}</div>}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {liveMetrics.length === 0 && (
                        <div className="text-[10px] text-muted-foreground">指标评测中…（完成后逐项点亮）</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {running && liveSteps.length === 0 && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 初始化评测…
              </div>
            )}
          </div>

          {/* 运行汇总 */}
          {(doneCount + failCount + runningCount) > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>进度 {doneCount + failCount}/{liveSteps.length || "?"}</span>
              <span className="text-green-700">✓ {doneCount}</span>
              {failCount > 0 && <span className="text-red-600">✗ {failCount}</span>}
              {runningCount > 0 && <span className="text-primary">… {runningCount} 运行中</span>}
              {doneCount > 0 && <span>已过均值 {typeof avgOverall === "number" ? avgOverall.toFixed(3) : "–"}</span>}
              {runPhase?.output && <span className="font-mono text-[10px]">输出: {runPhase.output}</span>}
            </div>
          )}

          {/* 实时日志滚动 */}
          {liveLogs.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5">
              <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
              <div className="max-h-32 min-w-0 flex-1 overflow-y-auto rounded bg-muted/30 p-2 font-mono text-[9px] leading-4 text-muted-foreground">
                {liveLogs.map((l, i) => <div key={i} className="truncate">{l}</div>)}
              </div>
            </div>
          )}
        </Card>

        {/* 工具栏：文件选择 + 题目选择 + 刷新 */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          >
            <option value="">选择评测结果文件…</option>
            {files.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}（{f.questionCount} 题 · 均值 {typeof f.overallAvg === "number" ? f.overallAvg.toFixed(3) : "–"}）
                {f.name.includes("old-") ? " 旧版" : ""}
                {f.name.includes("dual") ? " 对比格式" : ""}
                {/* V399-2 P2: 数据指纹过期标记 — 文献数据已变更, 该结果不可与当前基线直接对比 */}
                {f.stale ? " ⚠️数据已变更" : ""}
              </option>
            ))}
          </select>
          <select
            value={selectedQ}
            onChange={(e) => setSelectedQ(Number(e.target.value))}
            disabled={questions.length === 0}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-40"
          >
            {questions.map((qq, i) => (
              <option key={qq.question_id || i} value={i}>
                {qq.question_id} [{qq.question_type}] overall={typeof qq.overall === "number" && isFinite(qq.overall) ? qq.overall.toFixed(3) : "–"}{qq.error ? " ❌" : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => loadFiles()}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3 w-3" /> 刷新
          </button>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

        {/* V399-2 P2: 当前数据指纹 + 选中文件 stale 状态（数据可溯源: 文献数据变更 → 指纹变 → 旧结果判 stale） */}
        {currentFingerprint && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">数据指纹</span>
            <code className="rounded bg-background px-1.5 py-0.5 font-mono">
              {currentFingerprint.value ? currentFingerprint.value.substring(0, 16) + "…" : "不可用"}
            </code>
            {selectedFile && (() => {
              const f = files.find((x) => x.name === selectedFile);
              if (!f || !f.stale) return null;
              return (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
                  ⚠️ {f.name} 基于旧数据（文献已变更）— 与当前基线不可直接对比
                </span>
              );
            })()}
          </div>
        )}

        {/* W8: Agent 评测摘要（主评测与 agent 评测桥接） */}
        {agentSummary && (
          <div className="rounded border border-indigo-200 bg-indigo-50 p-3">
            <div className="mb-1.5 text-xs font-medium text-indigo-700">Agent 评测摘要（近7天 · 与主评测同屏）</div>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded bg-white px-2 py-0.5 text-indigo-700">任务完成率 {(Number(agentSummary.completionRate) * 100).toFixed(0)}%</span>
              <span className="rounded bg-white px-2 py-0.5 text-indigo-700">步骤成功率 {(Number(agentSummary.stepSuccessRate) * 100).toFixed(0)}%</span>
              <span className="rounded bg-white px-2 py-0.5 text-indigo-700">工具准确率 {(Number(agentSummary.toolAccuracy) * 100).toFixed(0)}%</span>
              <span className="rounded bg-white px-2 py-0.5 text-indigo-700">计划遵循 {Number(agentSummary.planAdherence).toFixed(2)}</span>
              <span className="rounded bg-white px-2 py-0.5 text-indigo-700">推理质量 {(Number(agentSummary.reasoningQuality) * 100).toFixed(0)}%</span>
              <span className="rounded bg-white px-2 py-0.5 text-indigo-700">{agentSummary.totalTasks} 任务</span>
            </div>
          </div>
        )}

        {q?.error ? (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            评测失败：{q.error}
          </div>
        ) : q ? (
          <>
            {/* 综合分卡片 */}
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <Scale className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">{q.question_id} 综合评分</span>
                <span className="font-mono text-2xl font-semibold text-foreground">
                  {typeof q.overall === "number" && isFinite(q.overall) ? q.overall.toFixed(3) : "–"}
                </span>
                <span className="text-xs text-muted-foreground">加权 A×0.40 + B×0.35 + C×0.25</span>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {[
                  { label: "A 检索质量", v: q.dimA, w: 0.40 },
                  { label: "B 答案质量", v: q.dimB, w: 0.35 },
                  { label: "C 推理质量", v: q.dimC, w: 0.25 },
                  { label: "D 性能观测", v: q.dimD, w: 0 },
                ].map((d) => {
                  const dv = typeof d.v === "number" && isFinite(d.v) ? d.v : 0;
                  return (
                  <div key={d.label} className="rounded bg-muted/30 p-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">{d.label}{d.w > 0 ? ` ×${d.w}` : "（观测）"}</span>
                      <span className="font-mono font-medium text-foreground">{typeof dv === "number" ? dv.toFixed(3) : "–"}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                      <div className={cn("h-full rounded", scoreColor(dv))} style={{ width: `${Math.min(100, dv * 100)}%` }} />
                    </div>
                  </div>
                  );
                })}
              </div>
            </Card>

            {/* 32 指标分组列表 */}
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-medium">{scoringMetrics} 评分指标逐项评分{rawMetrics > 0 ? `（另有 ${rawMetrics} 项观测）` : ""}</h3>
              {DIM_META.map((dim) => {
                const items = groups[dim.key] || [];
                if (items.length === 0) return null;
                const collapsed = collapsedDims.has(dim.key);
                const avg = items.reduce((s, [, m]) => s + (typeof m.score === "number" ? m.score : 0), 0) / items.length;
                return (
                  <div key={dim.key} className="mb-2">
                    <button
                      type="button"
                      onClick={() => toggleDim(dim.key)}
                      className="flex w-full items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5 text-left text-xs font-medium hover:bg-accent/70"
                    >
                      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      <span className="text-primary">{dim.icon}</span>
                      <span>{dim.label}（{items.length}）</span>
                      {!dim.inScore && <span className="text-[9px] text-muted-foreground">纯观测不计分</span>}
                      <span className="ml-auto font-mono text-muted-foreground">均值 {typeof avg === "number" ? avg.toFixed(3) : "–"}</span>
                    </button>
                    {!collapsed && (
                      <div className="mt-1 space-y-0.5">
                        {items.map(([key, m]) => {
                          const meta = METRIC_DESC[key];
                          const badge = SOURCE_BADGE[m.source] || SOURCE_BADGE.raw;
                          const isRaw = m.source === "raw";
                          const expanded = expandedMetric === key;
                          return (
                            <div key={key} className="rounded border border-border/50">
                              <button
                                type="button"
                                onClick={() => setExpandedMetric(expanded ? null : key)}
                                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent/40"
                              >
                                <span className="w-10 shrink-0 font-mono text-[10px] text-primary">{meta?.cat || key.slice(0, 4)}</span>
                                <span className="w-32 shrink-0 truncate text-xs text-foreground">{key}</span>
                                <span className={cn("shrink-0 rounded px-1 py-0.5 text-[9px]", badge.cls)}>{badge.label}</span>
                                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                                  <div
                                    className={cn("h-full rounded", isRaw ? "bg-gray-400" : scoreColor(typeof m.score === "number" ? m.score : 0))}
                                    style={{ width: `${Math.min(100, (typeof m.score === "number" ? m.score : 0) * 100)}%` }}
                                  />
                                </div>
                                <span className="w-12 shrink-0 text-right font-mono text-xs text-foreground">
                                  {isRaw ? m.score : (typeof m.score === "number" ? m.score.toFixed(3) : "–")}
                                </span>
                                <ChevronDown className={cn("h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-180")} />
                              </button>
                              {expanded && (
                                <div className="border-t border-border/40 px-2 py-1.5 text-[11px] text-muted-foreground">
                                  <div>{meta?.desc || key}</div>
                                  <div className="mt-1 flex flex-wrap gap-3 font-mono text-[10px]">
                                    {m.rule_score !== undefined && <span>规则分: <b className="text-foreground">{typeof m.rule_score === "number" ? m.rule_score.toFixed(3) : "–"}</b></span>}
                                    {m.llm_score !== undefined && m.llm_score !== null && <span>LLM分: <b className="text-foreground">{typeof m.llm_score === "number" ? m.llm_score.toFixed(3) : "–"}</b></span>}
                                    <span>最终: <b className="text-foreground">{isRaw ? m.score : (typeof m.score === "number" ? m.score.toFixed(3) : "–")}</b></span>
                                  </div>
                                  {/* 评分逻辑（静态说明：公式/规则/代码） */}
                                  {(() => {
                                    const logic = METRIC_LOGIC[key];
                                    if (!logic) return null;
                                    return (
                                      <div className="mt-1.5 space-y-1 rounded bg-muted/30 p-1.5">
                                        <div className="text-[9px] font-medium text-primary">评分逻辑 · {logic.source}</div>
                                        {logic.formula && (
                                          <div className="rounded bg-background/80 p-1 font-mono text-[9px] leading-4">
                                            <span className="text-primary">公式 </span>{logic.formula}
                                          </div>
                                        )}
                                        {logic.rule && (
                                          <div className="text-[9px] leading-4"><span className="text-primary">规则 </span>{logic.rule}</div>
                                        )}
                                        {logic.code && (
                                          <pre className="overflow-auto rounded bg-background/80 p-1 font-mono text-[9px] leading-4">
                                            <span className="text-primary">代码 </span>{logic.code}
                                          </pre>
                                        )}
                                      </div>
                                    );
                                  })()}
                                  {m.reason && <div className="mt-1 text-[10px] text-amber-600">{m.reason}</div>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>

            {/* 证据区 */}
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-medium">评测证据</h3>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { key: "answer", label: `AI 答案（${(q.hypothesis || "").length}字）`, icon: <FileText className="h-3 w-3" /> },
                  { key: "context", label: `检索上下文（${(q.fusedContext || "").length}字）`, icon: <Database className="h-3 w-3" /> },
                  { key: "debug", label: `检索调试（${Object.keys(q._debugCoarse || {}).length + Object.keys(q._debugRefined || {}).length} 项）`, icon: <Search className="h-3 w-3" /> },
                ].map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setShowEvidence(showEvidence === b.key ? null : b.key as any)}
                    className={cn(
                      "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                      showEvidence === b.key ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
                    )}
                  >
                    {b.icon}{b.label}
                  </button>
                ))}
              </div>
              {showEvidence === "answer" && q.hypothesis && (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-xs leading-relaxed text-foreground/90">{q.hypothesis}</pre>
              )}
              {showEvidence === "context" && q.fusedContext && (
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-[10px] leading-relaxed text-muted-foreground">{q.fusedContext}</pre>
              )}
              {showEvidence === "debug" && (
                <div className="mt-2 max-h-80 space-y-2 overflow-auto rounded bg-muted/30 p-3 text-[10px] text-muted-foreground">
                  <div>
                    <div className="font-medium text-foreground">实体: {q.entity_names?.length || 0}</div>
                    <div className="flex flex-wrap gap-1">{q.entity_names?.slice(0, 20).map((e) => <span key={e} className="rounded bg-muted px-1 py-0.5">{e}</span>)}</div>
                  </div>
                  <div className="font-medium text-foreground">粗检索调试:</div>
                  <pre className="overflow-auto">{JSON.stringify(q._debugCoarse, null, 1).substring(0, 4000)}</pre>
                  <div className="font-medium text-foreground">精检索调试:</div>
                  <pre className="overflow-auto">{JSON.stringify(q._debugRefined, null, 1).substring(0, 2000)}</pre>
                </div>
              )}
            </Card>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center py-10 text-sm text-muted-foreground">
            {loading ? "加载中…" : "选择评测结果文件查看指标详情"}
          </div>
        )}
        </>
        )}
      </div>
    </section>
  );
};
