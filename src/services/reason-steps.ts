// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// reason-steps.ts — 52 步推理链路的**唯一权威定义**(后端前端共用)
//
// 由来(2026-09-13): 前端 ReasonPanel 里有一份 52 步静态数组, 拿它的**下标**去对
//   retrieve_steps 的第 N 条(`retrieveSteps?.[index]`)。但后端落库顺序是
//   outline → stage2_* → stage3_* → …, 且 stage2/stage3 在循环里按检索路径写,
//   二者根本对不上 —— 界面把"1. 问题分类"显示成了 stage2_pgChunks 的数据。
//
//   修法: 步号在这里定义一次, 后端落库带 `step_no`, 前端按步号对齐。
//   任何新增步骤只能改这一个文件, 否则两边又会漂移。
//
// 三类步骤:
//   · 落库步(有 writeAs) —— 后端真写 retrieve_steps 行
//   · 内部步(无 writeAs) —— 真跑但纯内存计算(如三臂 RRF), 不落库; 前端标"内部计算"
//   · 条件步(有 trigger) —— 按条件触发, 未命中时前端显示灰态, 不是故障

export interface ReasonStepDef {
  /** 1..52, 前端展示序号, 也是 retrieve_steps.step_no 的取值 */
  no: number;
  name: string;
  /** 触发条件说明; 有值时表示"本次可能不跑" */
  trigger?: string;
  /** 后端落库用的 search_type; 缺省表示内部计算步(不落库) */
  writeAs?: string;
}

export const REASON_STEPS: ReasonStepDef[] = [
  // ── Stage 0-1: 分类 + 大纲 ──
  { no: 1, name: "问题分类" },
  { no: 2, name: "意图识别" },
  { no: 3, name: "术语变体" },
  { no: 4, name: "拆分子问题", writeAs: "outline" },
  // ── Stage 2: Cognee 粗检索 ──
  { no: 5, name: "实体抽取" },   // 内部: extractEntityNames, 抽出的名字喂给 stage2/stage3
  { no: 6, name: "Cognee HYBRID", writeAs: "stage2_cognee_coarse" },
  { no: 7, name: "RAG补全", writeAs: "stage2_ragCompletion" },
  { no: 8, name: "图遍历", writeAs: "stage2_graphCompletion" },
  { no: 9, name: "关系三元组", writeAs: "stage2_tripletCompletion" },
  { no: 10, name: "摘要检索", writeAs: "stage2_summaries" },
  { no: 11, name: "子问题推理", writeAs: "stage2_hybridCompletion" },
  { no: 12, name: "上下文扩展", writeAs: "stage2_contextExtension" },
  { no: 13, name: "时序分析", trigger: "时序类问题（何时/最近）", writeAs: "stage2_temporal" },
  { no: 14, name: "PG实体补漏", writeAs: "stage2_pgEntities" },
  { no: 15, name: "PG向量", writeAs: "stage2_pgEntityVectors" },
  { no: 16, name: "CHUNKS词法", writeAs: "stage2_chunks" },
  { no: 17, name: "语义检索", writeAs: "stage2_pgChunks" },
  { no: 18, name: "实体直查", writeAs: "stage2_cogneeEntities" },
  // ── Stage 3: Graphiti 精炼 ──
  { no: 19, name: "实体精炼", writeAs: "stage3_graphiti_refine" },
  { no: 20, name: "概念搜索", writeAs: "stage3_hybridEntities" },
  { no: 21, name: "文献蒸馏", writeAs: "stage3_distills" },
  { no: 22, name: "领域知识", writeAs: "stage3_domain" },
  { no: 23, name: "实体邻居", writeAs: "stage3_entities" },   // Graphiti 的实体邻居扩展
  { no: 24, name: "段落回溯", writeAs: "stage3_passages" },
  { no: 25, name: "论文溯源", trigger: "带 paperId 或论文定位命中", writeAs: "stage3_papers" },
  { no: 26, name: "DeepWalk扩展", trigger: "图遍历结果稀疏时" },
  { no: 27, name: "关系查询", trigger: "关系型问题（谁投资/谁创办）" },
  // ── Stage 3.5: HyperEdge 超边知识层 ──
  { no: 28, name: "超边向量检索", trigger: "前端开启超边层", writeAs: "stage35_hyperedge" },
  { no: 29, name: "超边实体导向", trigger: "前端开启超边层" },
  { no: 30, name: "超边BM25", trigger: "前端开启超边层" },
  { no: 31, name: "三路RRF融合", trigger: "前端开启超边层" },
  { no: 32, name: "时间衰减", trigger: "时序类问题" },
  // ── Stage 4: 融合生成 ──
  { no: 33, name: "Compiled Truth" },
  { no: 34, name: "多查询变体" },
  { no: 35, name: "HyDE扩展", trigger: "查询词过短/语义模糊" },
  { no: 36, name: "意图调配额" },
  { no: 37, name: "三臂RRF" },
  { no: 38, name: "Cosine重打分" },
  { no: 39, name: "Boost链" },
  { no: 40, name: "超边配额", trigger: "超边层有命中" },
  { no: 41, name: "LLM重排", writeAs: "stage4_rerank" },
  { no: 42, name: "压缩段落" },
  { no: 43, name: "COT推理", trigger: "多跳推理类问题" },
  { no: 44, name: "Agentic搜索", trigger: "首次检索不足时" },
  { no: 45, name: "生成假设", writeAs: "stage4_hypothesis" },
  { no: 46, name: "自评校验", writeAs: "stage4_evaluate" },
  { no: 47, name: "置信评估", writeAs: "stage4_confidence" },
  { no: 48, name: "溯源标注" },
  { no: 49, name: "回写知识页", trigger: "结论通过评估" },
  { no: 50, name: "失败降级", trigger: "推理失败/置信度过低" },
  { no: 51, name: "快速回退", trigger: "全栈超时（180s）" },
  { no: 52, name: "响应返回" },
];

/** search_type → step_no。后端落库时用它把 search_type 翻成逻辑步号。 */
export const STEP_NO_BY_SEARCH_TYPE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const s of REASON_STEPS) if (s.writeAs && !(s.writeAs in m)) m[s.writeAs] = s.no;
  return m;
})();

/** 步号 → 定义(前端按 step_no 取名字与 trigger) */
export const STEP_BY_NO: Record<number, ReasonStepDef> = (() => {
  const m: Record<number, ReasonStepDef> = {};
  for (const s of REASON_STEPS) m[s.no] = s;
  return m;
})();

/** 动态拼出来的 search_type(如 stage2_<label>) → 步号。前端对齐用, 后端落库时也算。 */
/** 派生/变体 search_type → 它属于哪一步。这些是同一步的分解写法, 前端按主步归并显示。 */
const DERIVED: Record<string, number> = {
  stage2_graphCompletionDecomp: 8,      // 图遍历的分解版
  stage2_graphSummaryCompletion: 10,    // 摘要检索的图增强版
  stage3_paperInfo: 25,                 // 论文溯源的详情版
  // adaptive 模式(LLM 动态选算子)走的是另一套 step 名, 与 52 步模板链路不是同一序列;
  //   前端对它们不做 52 步对齐(保持灰态), 避免把两种模式的步骤混在一张表里。
};

/**
 * adaptive 模式算子 → 52 步步号。
 *
 * adaptive 是另一套执行序列(LLM 按问题复杂度动态选算子, 简单题 5 个、复杂题 20+ 个),
 * 但算子本身与 52 步的**执行单元**是同一批 —— `adaptive-operators.ts:57` 的注释就写着
 * "24 算子注册表(52 步按执行单元合并)"。所以这里按语义把每个算子对回它所属的那一步,
 * 前端就能用同一张 52 步表渲染两种模式: 跑了的显示数据, 没选的显示灰态。
 *
 * 对应关系逐个核过算子 run() 里的实际调用, 不是按名字猜的:
 *   · cognee_derived 一次并发跑 8 条 Cognee 子路(RAG/摘要/图补全/三元组/时序…), 所以它一个
 *     算子覆盖 7~13 多步 —— 映射到该组主步(7 RAG补全), 前端那几步会因为"同一 no"而共享这一条数据;
 *     这是有意的: 让用户看到"这段能力跑了", 而不是假装它拆成了 8 个独立步骤。
 *   · g_heavy 内部并发跑 hybrid_search/distill/domain 三路, 取其中最重的"领域知识"(22)。
 *   · g_entity_info 跑 get_entity_info(邻居) + search_by_concept(概念) → 取"实体邻居"(23)。
 */
const ADAPTIVE_OP_TO_STEP: Record<string, number> = {
  // prep
  adaptive_outline: 4,            // 拆分子问题
  // cognee 组
  adaptive_pg_arm: 17,            // 语义检索(PG 臂)
  adaptive_cognee_hybrid: 6,      // Cognee HYBRID
  adaptive_cognee_derived: 7,     // RAG补全(该算子并发覆盖 7~13 多路, 见上注)
  adaptive_cognee_lexical: 16,    // CHUNKS词法
  adaptive_cognee_cot: 11,        // 子问题推理(COT)
  adaptive_cognee_entities: 18,   // 实体直查
  // graphiti 组
  adaptive_extract_entities: 5,   // 实体抽取
  adaptive_g_chunk: 24,           // 段落回溯
  adaptive_g_literature: 21,      // 文献蒸馏
  adaptive_g_entity_info: 23,     // 实体邻居(+概念搜索)
  adaptive_g_heavy: 22,           // 领域知识(hybrid+distill+domain 三合一)
  adaptive_g_deepwalk: 26,        // DeepWalk扩展
  adaptive_hyperedge: 28,         // 超边向量检索
  // fusion 组
  adaptive_fuse: 37,              // 三臂RRF(融合)
  adaptive_truth: 33,             // Compiled Truth
  adaptive_rerank: 41,            // LLM重排
  adaptive_compress: 42,          // 压缩段落
  // gen 组
  adaptive_hypothesis: 45,        // 生成假设
  adaptive_cite_check: 48,        // 溯源标注(引用核查)
  adaptive_evaluate: 46,          // 自评校验
};

/** 动态 label 落在 stage2/stage3 段内: 按已登记的范围给一个就近步号, 保证不串到别的阶段 */
export function stepNoForSearchType(searchType: string): number | null {
  if (searchType in DERIVED) return DERIVED[searchType];
  const adaptive = ADAPTIVE_OP_TO_STEP[searchType];
  if (adaptive) return adaptive;
  if (searchType === "budget_pruned") return null;   // 预算裁剪埋点, 不是链路上的"一步"
  const direct = STEP_NO_BY_SEARCH_TYPE[searchType];
  if (direct) return direct;
  const dyn = /^stage([23])_(.+)$/.exec(searchType);
  if (!dyn) return null;
  const prefix = dyn[1] === "2" ? "stage2_" : "stage3_";
  const nums = Object.entries(STEP_NO_BY_SEARCH_TYPE)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
  if (!nums.length) return null;
  return Math.min(...nums);
}
