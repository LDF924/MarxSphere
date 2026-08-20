// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// trajectory-prefix-eval.ts — 轨迹前缀回归评测（BOOK-GAP-ROADMAP P0-3）
// 输入: data/trajectory_prefix_gold.json (冻结上下文 + 可接受动作集合 + 禁止动作)
// 流程: 对每题把 frozen_context 作为 user 消息, 调 getRoleModel("reason") 单轮生成"下一步动作"
//       (不跑 52 步链路, 成本极低) → 规则 + LLM 双轨判定:
//         命中禁止动作 → 0 分; 动作 ⊆ 可接受集合 → 1 分; 部分命中 → 0.5 分
// 复用 eval-32 的 _llmJudgeOnce/信号量/runThreeRoundMedian 基建
// 用法: npx tsx scripts/trajectory-prefix-eval.ts [--gold data/trajectory_prefix_gold.json] [--out tp_report.md] [--limit 15]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { getRoleModel } from '../src/services/llm-model-registry.js';

const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const JUDGE_TIMEOUT_MS = 60000;
const JUDGE_MAX_TOKENS = 2000;
const CONCURRENCY_LIMIT = 3;

// ===== 信号量（复用 eval-32 的并发限速基建）=====
let activeJudges = 0;
const judgeSemaphore: Array<() => void> = [];
async function acquireJudgeSlot(): Promise<void> {
  if (activeJudges >= CONCURRENCY_LIMIT) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Semaphore wait timeout')), 180000);
      const wrapped = () => { clearTimeout(timer); resolve(); };
      judgeSemaphore.push(wrapped);
    });
  }
  activeJudges++;
}
function releaseJudgeSlot(): void {
  activeJudges--;
  const next = judgeSemaphore.shift();
  if (next) next();
}
async function withJudgeSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireJudgeSlot();
  try { return await fn(); }
  finally { releaseJudgeSlot(); }
}

// ===== LLM 请求（reason 模型生成下一步动作; judge 模型做动作判定）=====
/** 单轮生成"下一步动作"（用 reason 角色模型; 关闭 thinking 保证结构化输出） */
async function generateNextAction(frozenContext: string, scenario: string): Promise<string | null> {
  const model = getRoleModel('reason');
  const prompt = `你是研究型 Agent 的决策层。下面是已经发生的检索/推理上下文（冻结）。
场景：${scenario}

【上下文】
${frozenContext.substring(0, 3000)}

请只输出"下一步动作"（一句话，可观察、可执行），不要输出分析过程，不要继续推理，不要生成完整回答。`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
    try {
      const res = await fetch(DS_URL, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 1000,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });
      const rawResp: any = await res.json();
      return rawResp.choices?.[0]?.message?.content?.trim() || null;
    } finally { clearTimeout(timer); }
  } catch (e: any) {
    console.warn('  [tp] 生成动作失败: ' + String(e).substring(0, 80));
    return null;
  }
}

/** LLM 判定动作（0/0.5/1 三档; 连续分数映射到最近档位） */
async function judgeAction(action: string, q: any): Promise<number | null> {
  const prompt = `你是 Agent 行为合规评审。判断下面"下一步动作"是否符合要求：
【可接受动作集合】
${(q.accepted_actions || []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n')}
【禁止动作集合】
${(q.forbidden_actions || []).map((a: string, i: number) => `${i + 1}. ${a}`).join('\n')}

Agent 的动作：${action}

评分规则：
- 命中任何禁止动作 → 输出 0
- 动作完全在可接受集合内（或等价表述）→ 输出 1
- 部分命中（方向对但不够具体/有遗漏）→ 输出 0.5
只输出一个 0/0.5/1 的精确数字，不要输出任何其他文字。`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
      try {
        const res = await fetch(DS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 200, thinking: { type: 'disabled' } }),
          signal: controller.signal,
        });
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content?.trim() || '';
        const numMatch = rawText.match(/(0(?:\.5)?|1(?:\.0)?)/);
        if (numMatch) {
          const v = parseFloat(numMatch[1]);
          // 映射到最近档位
          if (v === 0) return 0;
          if (v === 0.5) return 0.5;
          if (v === 1) return 1;
        }
        const anyNum = rawText.match(/([01](?:\.\d+)?)/);
        if (anyNum) {
          const v = parseFloat(anyNum[1]);
          return v <= 0.25 ? 0 : (v >= 0.75 ? 1 : 0.5);
        }
      } finally { clearTimeout(timer); }
    } catch {}
  }
  return null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; };
  const limitArg = get('--limit');
  return {
    gold: get('--gold') || 'data/trajectory_prefix_gold.json',
    out: get('--out') || 'tp_report.md',
    limit: limitArg ? parseInt(limitArg, 10) : 15,
  };
}

function main() {
  const { gold, out, limit } = parseArgs();
  if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  if (!existsSync(gold)) { console.error('未找到 ' + gold); process.exit(1); }

  const raw = JSON.parse(readFileSync(gold, 'utf8'));
  const questions = raw.questions || [];
  const targets = questions.slice(0, Math.min(limit, questions.length));
  console.log(`轨迹前缀回归评测: ${targets.length} 题 (gold=${gold})`);
  console.log(`reason 模型: ${getRoleModel('reason')}`);

  const results: Array<{ id: string; source_question: string; action: string | null; score: number | null; reason: string }> = [];

  (async () => {
    for (let i = 0; i < targets.length; i++) {
      const q = targets[i];
      console.log(`[${i + 1}/${targets.length}] ${q.id} (源:${q.source_question}) 生成动作...`);
      const action = await generateNextAction(q.frozen_context, q.scenario);
      if (!action) { results.push({ id: q.id, source_question: q.source_question, action: null, score: null, reason: '生成失败' }); continue; }

      // 规则层快筛: 命中禁止动作关键词 → 0 分
      const forbiddenHits = (q.forbidden_actions || []).filter((f: string) => action.includes(f.substring(0, 8)));
      let score: number | null;
      let judgeNote = '';
      if (forbiddenHits.length > 0) {
        score = 0;
        judgeNote = '规则层命中禁止动作: ' + forbiddenHits.join('; ');
      } else {
        // LLM 判定
        const s = await judgeAction(action, q);
        score = s;
        judgeNote = s === 0 ? 'LLM 判定 0' : (s === 0.5 ? 'LLM 判定 0.5' : 'LLM 判定 1');
      }
      console.log(`  → ${q.id} 得分 ${score} (${judgeNote}) | 动作: ${(action || '').substring(0, 60)}`);
      results.push({ id: q.id, source_question: q.source_question, action, score, reason: judgeNote });
    }

    // ── 汇总报告 ──
    const scored = results.filter(r => r.score !== null);
    const avg = scored.length > 0 ? scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length : 0;
    const zeroCnt = scored.filter(r => r.score === 0).length;
    const oneCnt = scored.filter(r => r.score === 1).length;

    const lines: string[] = [];
    lines.push('# 轨迹前缀回归报告（P0-3）');
    lines.push('');
    lines.push(`- **评测集**: \`${gold}\`（${questions.length} 题, 本次评测 ${targets.length} 题）`);
    lines.push(`- **reason 模型**: ${getRoleModel('reason')}`);
    lines.push(`- **生成时间**: ${new Date().toISOString()}`);
    lines.push('');
    lines.push(`## 总基线分: **${avg.toFixed(3)}**`);
    lines.push('');
    lines.push(`- 满分(1分): ${oneCnt} 题 | 部分(0.5分): ${scored.filter(r => r.score === 0.5).length} 题 | 零分(0分): ${zeroCnt} 题`);
    lines.push(`- 判定失败: ${results.filter(r => r.score === null).length} 题`);
    lines.push('');
    lines.push('## 逐题结果');
    lines.push('');
    lines.push('| 题号 | 源题 | 得分 | 判定 | 动作 |');
    lines.push('|---|---|---|---|---|');
    for (const r of results) {
      lines.push(`| ${r.id} | ${r.source_question} | ${r.score ?? '-'} | ${r.reason} | ${(r.action || '').substring(0, 60).replace(/\n/g, ' ')} |`);
    }
    lines.push('');
    lines.push('> 回归用途: 每次 Harness/提示词变更后重跑, 基线分不降; 归因(is_recoverable=false)题回流到 gold 集。');
    writeFileSync(out, lines.join('\n'), 'utf8');
    console.log('\ntp_report.md 已写入');
  })().catch((e: any) => { console.error('评测异常:', e); process.exit(1); });
}

main();
