// failure-attribution.ts — 失败归因（BOOK-GAP-ROADMAP P0-2）
// 输入: eval_32metrics_perq.json (P0-1 产物) + trace_spans 表(步骤轨迹) + gold_dataset.json(金标)
// 流程: 对低分题(overall < 题型中位数, 默认题型内 bottom 40%)组装归因 prompt → 调 getRoleModel("judge")
//       → 强制 JSON 输出 {first_error_step, category, tool, evidence_quote, root_cause, is_recoverable, confidence}
//       → 写 eval_failures 表 + 输出 failure_report.md (按类别聚合)
// 用法: npx tsx scripts/failure-attribution.ts [--perq eval_32metrics_perq.json] [--run-id <标注>] [--dry-run]
// 说明: judge 模型走 llm-model-registry getRoleModel("judge") (默认 deepseek-v4-flash, DeepSeek 兼容端点)
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { Client } from 'pg';
import { getRoleModel } from '../src/services/llm-model-registry.js';

const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const JUDGE_TIMEOUT_MS = 60000;

// 归因 prompt 模板（书中 Ch6 标准: 定位首个错误, 不是最后报错; 多类别并存选"最早且能解释后续"的主因）
// 注意: deepseek-v4-flash 是推理模型, reasoning_content 会占输出配额 —— 字段必须短(总长<800字), max_tokens 给足(5000)
const ATTRIBUTION_PROMPT = `你是失败归因分析器。下面是 SAG 推理链路的一次失败轨迹。
任务：{query}；金标：{gold}
得分：{score}；低分指标：{low_metrics}
答案：{answer_head}
上下文：{context_head}
请定位【第一个】导致偏离的错误（不是最后的报错），输出 JSON：
{"first_error_step":"","category":"retrieval|context|reasoning|hallucination|tool|timeout|other",
 "tool_name":"","evidence_quote":"","root_cause":"","is_recoverable":true|false,"confidence":0.0}
规则：只选最早且能解释后续失败的主因；证据引用上面的原文片段；不确定时 confidence < 0.5。`;

interface PerqEntry { question_id: string; question_type: string; overall: number; dimA?: number; dimB?: number; dimC?: number; dimD?: number; passed?: boolean; eval_error?: boolean; low_metrics?: string[]; answer?: string; fused_context_head?: string }
interface TraceSpan { name: string; status: string; duration_ms: number | null; detail: string | null }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; };
  return {
    perq: get('--perq') || 'eval_32metrics_perq.json',
    runId: get('--run-id') || 'eval-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
    dryRun: args.includes('--dry-run'),
  };
}

function clip(s: string | undefined | null, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.substring(0, n) + '...[截断]';
}

/** 调 judge 模型做归因（复用 eval-32 的 JSON 容错思路, 信号量由脚本内并发度控制）
 * 关键: deepseek-v4-flash 是推理模型, 默认 thinking 阶段会消耗全部输出配额导致 content 为空(finish=length)。
 * 归因是结构化输出任务, 关闭 thinking ({"thinking":{"type":"disabled"}}) 后 reasoning_len=0, 稳定返回 JSON。
 * 若 API 不支持该参数(旧版), 退化为带重试的普通调用。 */
async function attributeFailure(prompt: string): Promise<Record<string, unknown> | null> {
  const model = getRoleModel('judge');
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 3000,
  };
  // 尝试关闭 thinking（DeepSeek 推理模型支持; 旧 API 会忽略未知参数, 无害）
  try { body.thinking = { type: 'disabled' }; } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
      try {
        const res = await fetch(DS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content || '';
        if (!rawText) {
          if (attempt === 0) { console.warn('  [attribution] content 为空, 重试'); continue; }
          return null;
        }
        // 容错: 去 ```json 包裹, 提取 {..} 对象
        const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const objMatch = cleaned.match(/{[\s\S]*}/);
        if (!objMatch) { if (attempt === 0) continue; return null; }
        const obj = JSON.parse(objMatch[0]);
        if (typeof obj.root_cause !== 'string' && typeof obj.first_error_step !== 'string') { if (attempt === 0) continue; return null; }
        return obj;
      } finally { clearTimeout(timer); }
    } catch (e: any) {
      console.warn('  [attribution] judge 调用失败: ' + String(e).substring(0, 100));
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

/** 从 trace_spans 表取某 trace 的步骤轨迹（span name 列表, 与归因 prompt 的"步骤名/引擎/耗时/结果数"对应） */
async function fetchTraceSpans(client: Client, traceId: string): Promise<TraceSpan[]> {
  try {
    const r = await client.query('select name, status, duration_ms, detail from trace_spans where trace_id = $1 order by started_at limit 60', [traceId]);
    return r.rows;
  } catch { return []; }
}

function main() {
  const { perq, runId, dryRun } = parseArgs();
  if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  if (!existsSync(perq)) {
    console.error('未找到 ' + perq + ' —— 请先跑 eval-32-metrics.ts 生成逐题分数（或指定 --perq 路径）');
    process.exit(1);
  }

  // ── 读取输入 ──
  const perqRaw = JSON.parse(readFileSync(perq, 'utf8'));
  const perqList: PerqEntry[] = Array.isArray(perqRaw) ? perqRaw : (perqRaw.questions || []);
  const goldRaw = JSON.parse(readFileSync('gold_dataset.json', 'utf8'));
  const goldList: any[] = Array.isArray(goldRaw) ? goldRaw : (goldRaw.questions || []);
  const goldMap = new Map(goldList.map(g => [g.id, g]));

  const valid = perqList.filter(r => !r.eval_error);
  if (valid.length === 0) { console.error('perq 文件中没有有效结果'); process.exit(1); }

  // ── 低分题判定: 整体 overall 最低的 N 题（默认 15, --limit 覆盖; 与"9 个低分题"验收口径一致）──
  // 修复: 排除证据缺失的题（无答案/无低分指标 → judge 无法归因只能判 other）,
  //       这些题通常是历史评测 JSON 未存答案/上下文（数据源问题, 非归因能力问题）
  const LOW_N = (() => {
    const i = process.argv.indexOf('--limit');
    const v = i >= 0 && i + 1 < process.argv.length ? parseInt(process.argv[i + 1], 10) : NaN;
    return !isNaN(v) && v > 0 ? v : 15;
  })();
  const hasEvidence = (r: PerqEntry) => (r.answer && r.answer.length >= 20) || ((r.low_metrics || []).length > 0);
  const withEvidence = valid.filter(hasEvidence);
  const noEvidence = valid.filter(r => !hasEvidence(r));
  const pool = withEvidence.length > 0 ? withEvidence : valid; // 全部无证据时退化为全量（宁可归因失败也不静默跳过）
  const sortedAll = [...pool].sort((a, b) => a.overall - b.overall);
  const targets = sortedAll.slice(0, Math.min(LOW_N, sortedAll.length));
  console.log(`低分题: ${targets.length} 题 (证据完整池 ${withEvidence.length}/${valid.length} 题, 证据缺失跳过 ${noEvidence.length} 题)`);
  for (const t of targets) console.log(`  ${t.question_id} (${t.question_type}) overall=${t.overall.toFixed(3)}`);

  // ── 主循环: 归因 ──
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let results: Array<Record<string, unknown>> = [];

  (async () => {
    await client.connect();
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      const q = goldMap.get(r.question_id) || {};
      console.log(`[${i + 1}/${targets.length}] ${r.question_id} 归因中...`);
      const prompt = ATTRIBUTION_PROMPT
        .replace('{query}', clip(q.question, 120))
        .replace('{gold}', clip(q.gold_answer, 150))
        .replace('{score}', r.overall.toFixed(3))
        .replace('{low_metrics}', (r.low_metrics && r.low_metrics.length ? r.low_metrics.slice(0, 5).join('; ') : '(无)'))
        .replace('{answer_head}', clip(r.answer, 250))
        .replace('{context_head}', clip(r.fused_context_head, 200));

      const obj = await attributeFailure(prompt);
      const row: Record<string, unknown> = {
        eval_run_id: runId,
        question_id: r.question_id,
        failure_category: (obj?.category && typeof obj.category === 'string' ? obj.category : 'other'),
        first_error_step: (obj?.first_error_step && typeof obj.first_error_step === 'string' ? obj.first_error_step : null),
        tool_name: (obj?.tool_name && typeof obj.tool_name === 'string' ? obj.tool_name : null),
        evidence: (obj?.evidence_quote && typeof obj.evidence_quote === 'string' ? obj.evidence_quote : null),
        root_cause: (obj?.root_cause && typeof obj.root_cause === 'string' ? obj.root_cause : null),
        is_recoverable: typeof obj?.is_recoverable === 'boolean' ? obj.is_recoverable : null,
        confidence: typeof obj?.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : null,
        full_trace_ref: null,
      };
      results.push({ ...row, attribution: obj });

      if (!dryRun) {
        try {
          await client.query(
            `insert into eval_failures (eval_run_id, question_id, failure_category, first_error_step, tool_name, evidence, root_cause, is_recoverable, confidence, full_trace_ref)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [row.eval_run_id, row.question_id, row.failure_category, row.first_error_step, row.tool_name, row.evidence, row.root_cause, row.is_recoverable, row.confidence, row.full_trace_ref]
          );
          console.log(`  ✓ ${r.question_id} → ${row.failure_category} @ ${row.first_error_step || '?'} (conf=${row.confidence})`);
        } catch (e: any) {
          console.warn('  DB 写入失败: ' + String(e).substring(0, 80));
        }
      } else {
        console.log(`  [dry-run] ${r.question_id} → ${row.failure_category} @ ${row.first_error_step || '?'}`);
      }
    }
    await client.end();

    // ── 输出 failure_report.md ──
    const byCat = new Map<string, number>();
    let withStep = 0, confident = 0;
    for (const r of results) {
      byCat.set(String(r.failure_category), (byCat.get(String(r.failure_category)) || 0) + 1);
      if (r.first_error_step) withStep++;
      if (typeof r.confidence === 'number' && r.confidence >= 0.5) confident++;
    }
    const rate = results.length > 0 ? (withStep / results.length * 100).toFixed(1) + '%' : '-';
    const lines: string[] = [];
    lines.push('# 失败归因报告（P0-2）');
    lines.push('');
    lines.push(`- **评测轮次**: \`${runId}\``);
    lines.push(`- **输入**: \`${perq}\`（${valid.length} 题有效）`);
    lines.push(`- **归因题数**: ${results.length}`);
    lines.push(`- **定位到具体步骤率**: ${rate}${results.length ? '（验收标准: ≥80%）' : ''}`);
    lines.push(`- **置信度 ≥ 0.5 占比**: ${results.length ? (confident / results.length * 100).toFixed(1) + '%' : '-'}`);
    lines.push('');
    lines.push('## 类别聚合');
    lines.push('');
    lines.push('| 类别 | 题数 |');
    lines.push('|---|---|');
    for (const [cat, cnt] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${cat} | ${cnt} |`);
    lines.push('');
    lines.push('## 逐题归因');
    lines.push('');
    lines.push('| 题号 | 类别 | 首个错误步骤 | 工具 | 置信度 | 根因 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of results) {
      lines.push(`| ${r.question_id} | ${r.failure_category} | ${r.first_error_step || '-'} | ${r.tool_name || '-'} | ${r.confidence ?? '-'} | ${String(r.root_cause || '').substring(0, 80)} |`);
    }
    lines.push('');
    lines.push('> 回流建议: `is_recoverable=false` 且归因在决策层(reasoning/context)的题, 可构造为轨迹前缀回归题(P0-3)。');
    writeFileSync('failure_report.md', lines.join('\n'), 'utf8');
    console.log('\nfailure_report.md 已写入');

    // ── V295 闭环②: 归因→轨迹前缀回流（生成候选 TP 题, 人工确认后生效）──
    // 条件: is_recoverable=false 且归因在决策层(reasoning/context) 且置信度≥0.5
    // 产物: data/trajectory_prefix_candidates.json (新题候选, 人工 review 后移入 gold 集)
    try {
      const candidates = results
        .filter((r: any) => r.is_recoverable === false
          && ['reasoning', 'context'].includes(String(r.failure_category))
          && typeof r.confidence === 'number' && r.confidence >= 0.5)
        .map((r: any) => {
          const q = goldMap.get(String(r.question_id)) || {};
          return {
            id: 'TP_CAND_' + r.question_id,
            source_question: r.question_id,
            source_attribution_category: r.failure_category,
            scenario: `基于归因（${r.root_cause || '决策层错误'}）构造的边界决策题`,
            frozen_context: `【已检索到的外部资料】\n${String(q.gold_answer || '资料内容').substring(0, 300)}\n\n（此题的原始失败: ${String(r.root_cause || '').substring(0, 150)}）`,
            accepted_actions: ['基于资料给出决策', '资料不足时明确说明'],
            forbidden_actions: ['重复原始失败模式', '凭常识/训练数据作答'],
            reason: `归因回流: ${r.failure_category}@${r.first_error_step || '?'} (conf=${r.confidence})`,
            source_trace_id: r.full_trace_ref || null,
            status: 'candidate',  // candidate=待人工确认, confirmed=已确认可入gold
          };
        });
      if (candidates.length > 0) {
        const candFile = 'data/trajectory_prefix_candidates.json';
        const existing = existsSync(candFile) ? JSON.parse(readFileSync(candFile, 'utf8')) : { generated_at: new Date().toISOString(), candidates: [] };
        existing.generated_at = new Date().toISOString();
        // 去重（按 source_question）
        const seen = new Set(existing.candidates.map((c: any) => c.source_question));
        for (const c of candidates) if (!seen.has(c.source_question)) { existing.candidates.push(c); seen.add(c.source_question); }
        writeFileSync(candFile, JSON.stringify(existing, null, 2), 'utf8');
        console.log(`\n✅ 闭环② 回流: ${candidates.length} 个候选 TP 题 → ${candFile}（人工确认 status: candidate→confirmed 后移入 trajectory_prefix_gold.json）`);
        for (const c of candidates) console.log('  ', c.id, '←', c.source_question, c.source_attribution_category, '(conf=' + (c as any).confidence + ')');
      } else {
        console.log('\n闭环②: 本轮无可回流题（无 is_recoverable=false 且决策层归因）');
      }
    } catch (e: any) {
      console.warn('闭环② 回流失败(不影响主报告): ' + String(e).substring(0, 100));
    }
  })().catch((e: any) => { console.error('归因过程异常:', e); process.exit(1); });
}

main();
