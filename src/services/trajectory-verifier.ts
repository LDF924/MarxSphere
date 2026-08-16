// trajectory-verifier.ts — 三层轨迹验证（BOOK-GAP-ROADMAP P1-6）
// 书中 Ch6: 结果正确 ≠ 过程正确（删掉失败用例也能让测试通过）
// ①结果验证器 verifyResult（代码化，零 LLM）：目标论文命中/金标实体覆盖（复用 A10/A11 逻辑）
// ②过程验证器 verifyProcess（规则化）：降级未标注/引用不在上下文/绕过检索直接答
// ③质量验证器 = 现有 Judge（评测脚本内）
// 输出合并进 eval_failures.layer 列（migration 024）

export interface TraceLike {
  hypothesis?: { content?: string };
  fusedContext?: string;
  retrievalStrategy?: string;
  _debugCoarse?: { chunks?: any[]; pgChunks?: any[] };
  _debugRefined?: { entities?: any[] };
  timings?: Record<string, number>;
}

export interface ResultVerdict {
  layer: "result";
  paperHit: boolean;        // fusedContext 含目标论文标题
  goldEntityCoverage: number; // 金标实体在 fusedContext 的覆盖率
  passed: boolean;
  detail: string;
}

export interface ProcessVerdict {
  layer: "process";
  degradedUnmarked: boolean;  // 有降级但答案未标注
  citationNotInContext: boolean; // 引用来源不在 fusedContext
  skippedRetrieval: boolean;  // 绕过检索直接答（步骤过少）
  passed: boolean;
  detail: string;
}

/** 标题变体规范化（复用 eval-32 的 normPaper 思路；连字符/下划线/空格统一移除避免歧义） */
function norm(s: string): string {
  return s.replace(/——|──|—|_|-/g, "").replace(/\s+/g, "").toLowerCase();
}

/** ① 结果验证器：目标论文命中 + 金标实体覆盖（零 LLM，代码化） */
export function verifyResult(q: { paper_title?: string; gold_entities?: string[] }, trace: TraceLike): ResultVerdict {
  const fc = trace.fusedContext || "";
  const paperTitle = (q.paper_title || "").trim();

  // 论文命中（复用 A10 逻辑：标题变体在 fusedContext 中）
  const variants = paperTitle
    ? [paperTitle, paperTitle.split(/[_—]/)[0].trim()].filter((v) => v.length >= 6)
    : [];
  const fcNorm = norm(fc);
  const paperHit = variants.some((v) => fcNorm.includes(norm(v)));

  // 金标实体覆盖（复用 A1 逻辑：子串匹配）
  const entities = q.gold_entities || [];
  let hit = 0;
  for (const e of entities) {
    if (e && fc.includes(e)) hit++;
  }
  const coverage = entities.length > 0 ? hit / entities.length : 0;

  return {
    layer: "result",
    paperHit,
    goldEntityCoverage: coverage,
    passed: paperHit && coverage >= 0.5,
    detail: `论文命中=${paperHit ? "是" : "否"}, 金标实体覆盖=${(coverage * 100).toFixed(0)}% (${hit}/${entities.length})`,
  };
}

/** ② 过程验证器：降级未标注 / 引用不在上下文 / 绕过检索（规则化） */
export function verifyProcess(trace: TraceLike): ProcessVerdict {
  const hyp = trace.hypothesis?.content || "";
  const fc = trace.fusedContext || "";
  const strategy = trace.retrievalStrategy || "standard";

  // ① 有降级但答案未标注（降级策略 ≠ standard 且答案无降级说明）
  const degradedUnmarked = strategy !== "standard"
    && !/(?:降级|回退|策略|仅检索|简化)/.test(hyp.substring(0, 200));

  // ② 引用来源不在 fusedContext（答案提到"根据论文/资料"但上下文无对应内容）
  const citesSource = /(?:根据|引自|来源于|参见|详见|论文.*(?:提出|指出|认为))/.test(hyp);
  const citationNotInContext = citesSource && fc.length === 0;

  // ③ 绕过检索直接答（检索结果为空但答案非拒答）
  const coarseChunks = (trace._debugCoarse?.chunks || []).filter((c: any) => c?.hasText);
  const pgChunks = (trace._debugCoarse?.pgChunks || []).filter((c: any) => c?.hasText);
  const skippedRetrieval = coarseChunks.length === 0 && pgChunks.length === 0 && hyp.length > 50 && !/抱歉/.test(hyp);

  return {
    layer: "process",
    degradedUnmarked,
    citationNotInContext,
    skippedRetrieval,
    passed: !degradedUnmarked && !citationNotInContext && !skippedRetrieval,
    detail: [
      degradedUnmarked ? "降级未标注" : "",
      citationNotInContext ? "引用无上下文依据" : "",
      skippedRetrieval ? "绕过检索直接答" : "",
    ].filter(Boolean).join("; ") || "过程合规",
  };
}

/** 三层汇总（质量层=Judge 已在评测脚本内） */
export function verifyTrace(q: { paper_title?: string; gold_entities?: string[] }, trace: TraceLike): { result: ResultVerdict; process: ProcessVerdict } {
  return {
    result: verifyResult(q, trace),
    process: verifyProcess(trace),
  };
}
