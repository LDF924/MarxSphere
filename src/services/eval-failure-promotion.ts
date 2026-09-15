// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// eval-failure-promotion.ts — V417: bad case → gold 候选提名（可触发入口）
//
// 由来(2026-09-15 盘点):
//   bad case 回流此前**只有命令行脚本**（scripts/promote-to-gold.ts + eval-evolve-pipeline.sh）,
//   没有任何 API / 定时器 —— 产物 data/gold_candidates.json 停在 2026-08-07, 37 天没人动过。
//   而 eval_failures 里躺着 30 条已归因的失败（14 条置信≥0.7）。缺的不是材料, 是"有人点一下"。
//
// 本模块把提名做成**可调用入口**（API 端点 + 可选定时提名），逻辑与脚本同源:
//   取 eval_failures 里 confidence≥阈值 且 is_recoverable=false 的题 → LLM 基于**同一篇论文**
//   起草新题 → 追加到 data/gold_candidates.json（status=draft）。
//
// **红线(不自动化)**: 候选永远是 draft。改 gold_dataset.json 必须人工确认 —— 自动把模型
//   自己产的题塞进评测集, 等于让被测者出考题, 评测就失去意义了。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm } from "../ai/llm-common.js";

const CANDIDATES_FILE = path.resolve(process.env.SAG_GOLD_CANDIDATES || "data/gold_candidates.json");

export interface PromotionOptions {
  /** 置信度门槛(默认 0.7, 与脚本一致) */
  minConfidence?: number;
  /** 本轮最多起草几道(默认 5; 每道一次 LLM 调用, 控成本) */
  maxItems?: number;
  /** 只看某次评测运行(默认全部) */
  evalRunId?: string;
}

export interface PromotionResult {
  ok: boolean;
  /** 达到门槛的失败总数 */
  eligible: number;
  /** 本次真正起草的条数 */
  drafted: number;
  /** 被跳过的(已存在候选) */
  skipped: number;
  draftedIds: string[];
  /**
   * 口径说明 —— 为什么没有更多。
   * 典型情况: 置信≥阈值但 is_recoverable=true 的题**不提名**(它们被判为"应该能恢复",
   * 更适合去修检索而不是固化成题)。
   */
  note: string;
  error?: string;
}

interface GoldCandidate {
  id: string;
  source_question: string;
  source_failure_category: string;
  question: string;
  gold_answer: string;
  question_type?: string;
  paper_title?: string;
  paper_id?: string;
  md_path?: string;
  status: string;
  drafted_at: string;
}

async function draftQuestion(input: {
  questionId: string;
  category: string;
  rootCause: string;
  paperTitle: string;
}): Promise<{ question: string; gold_answer: string; question_type?: string } | null> {
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchLlm({
        url: ep.url, key: ep.key, model: ep.model,
        messages: [{
          role: "user",
          content: `你是评测题设计者。下面是某次评测中失败的案例，请基于**同一篇论文**设计一道新的评测题。
要求:
1. 新题必须能考察出触发该失败的**同类能力**（不要重复原题，但针对同一个薄弱点）
2. gold_answer 必须是**这篇论文里明确写了的**内容，不得编造
3. 输出 JSON: {"question":"题干","gold_answer":"标准答案","question_type":"concept_definition|mechanism|comparison|application"}

【论文】${input.paperTitle || "(未知)"}
【原题号】${input.questionId}
【失败类别】${input.category}
【失败根因】${String(input.rootCause || "").slice(0, 600)}

只输出 JSON，不要其他文字。`,
        }],
        temperature: 0.3, maxTokens: 2000, timeoutMs: 180_000,
      });
      const text = String(res?.text ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const obj = JSON.parse(m[0]) as { question?: string; gold_answer?: string; question_type?: string };
      if (typeof obj.question !== "string" || typeof obj.gold_answer !== "string") continue;
      return { question: obj.question, gold_answer: obj.gold_answer, question_type: obj.question_type };
    } catch { /* 重试一次 */ }
  }
  return null;
}

/**
 * 提名 entry：读失败 → 起草候选 → 写候选文件（draft）。
 * 幂等: 已存在同名 source_question 的候选(非 rejected)不重复起草。
 */
export async function proposeGoldCandidates(opts: PromotionOptions = {}): Promise<PromotionResult> {
  const minConf = opts.minConfidence ?? 0.7;
  const maxItems = Math.max(1, Math.min(opts.maxItems ?? 5, 20));

  const rows = await pool.query(
    `select question_id, failure_category, root_cause, confidence
       from eval_failures
      where confidence >= $1 and is_recoverable = false
        and ($2::text is null or eval_run_id = $2)
      order by confidence desc`,
    [minConf, opts.evalRunId ?? null],
  );
  const eligible = rows.rows.length;
  if (!eligible) {
    return {
      ok: true, eligible: 0, drafted: 0, skipped: 0, draftedIds: [],
      note: `没有达到门槛的失败(confidence≥${minConf} 且 is_recoverable=false)。注意: 被判"可恢复"的题不在此列 —— 它们更适合去修检索, 而不是固化成考题。`,
    };
  }

  const existing: { candidates: GoldCandidate[] } = existsSync(CANDIDATES_FILE)
    ? JSON.parse(readFileSync(CANDIDATES_FILE, "utf8"))
    : { candidates: [] };
  const seen = new Set(
    (existing.candidates ?? []).filter((c) => c.status !== "rejected").map((c) => c.source_question),
  );

  // 来源论文: 从 gold 集里取(硬性约束 —— 新题必须基于同一篇论文)
  const goldRaw = JSON.parse(readFileSync(path.resolve("gold_dataset.json"), "utf8")) as
    | Array<{ id: string; paper_title?: string; paper_id?: string; md_path?: string }>
    | { questions?: Array<{ id: string; paper_title?: string; paper_id?: string; md_path?: string }> };
  const goldList = Array.isArray(goldRaw) ? goldRaw : (goldRaw.questions ?? []);
  const goldMap = new Map(goldList.map((g) => [String(g.id), g]));

  let drafted = 0;
  let skipped = 0;
  const draftedIds: string[] = [];
  for (const f of rows.rows) {
    if (drafted >= maxItems) break;
    if (seen.has(f.question_id)) { skipped++; continue; }
    const src = (goldMap.get(String(f.question_id)) ?? {}) as {
      paper_title?: string; paper_id?: string; md_path?: string;
    };
    const paperTitle = String(src.paper_title ?? "");
    const obj = await draftQuestion({
      questionId: String(f.question_id),
      category: String(f.failure_category ?? "other"),
      rootCause: String(f.root_cause ?? ""),
      paperTitle,
    });
    if (!obj) continue;
    const id = `Q_${f.question_id}_${Date.now().toString(36)}`.slice(0, 40);
    existing.candidates.push({
      id,
      source_question: String(f.question_id),
      source_failure_category: String(f.failure_category ?? "other"),
      question: obj.question,
      gold_answer: obj.gold_answer,
      question_type: obj.question_type,
      paper_title: paperTitle,
      paper_id: String(src.paper_id ?? ""),
      md_path: String(src.md_path ?? ""),
      status: "draft",
      drafted_at: new Date().toISOString(),
    });
    seen.add(String(f.question_id));
    drafted++;
    draftedIds.push(id);
  }

  try {
    mkdirSync(path.dirname(CANDIDATES_FILE), { recursive: true });
    writeFileSync(CANDIDATES_FILE, JSON.stringify({ generated_at: new Date().toISOString(), candidates: existing.candidates }, null, 2), "utf8");
  } catch (e) {
    return { ok: false, eligible, drafted: 0, skipped, draftedIds: [], note: "", error: `候选文件写入失败: ${String(e).slice(0, 120)}` };
  }

  return {
    ok: true, eligible, drafted, skipped, draftedIds,
    note: `新起草 ${drafted} 道(共 ${existing.candidates.length} 条候选, 全部为 draft)。**改 gold 集需人工在评测面板确认** —— 自动把模型出的题塞进评测集等于被测者出题。`,
  };
}
