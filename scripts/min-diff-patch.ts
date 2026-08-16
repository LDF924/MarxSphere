// min-diff-patch.ts — 最小 diff 系统提示词补丁（BOOK-GAP-ROADMAP P1-5）
// 输入: eval_failures 表中同类别失败的题（按 failure_category 聚合）
// 流程: 同类别失败 → LLM(getRoleModel("plan"), pro级) 生成 old_str→new_str 最小补丁
//       → 四门槛检查(①非空且diff<30% ②可追溯绑定失败题 ③边界集改善 ④保留集不退化)
//       → 写入 prompt_patches 表 status='candidate' → 人工确认 → 'canary'(PROMPT_CANARY启用) → 'released'
// 用法: npx tsx scripts/min-diff-patch.ts [--category context] [--dry-run]
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { Client } from 'pg';
import { getRoleModel } from '../src/services/llm-model-registry.js';

const DS_URL = process.env.DS_BASE_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

const PATCH_PROMPT = `你是系统提示词工程专家。以下是 SAG 推理 Agent 在 {category} 类别的失败归因摘要。
请为推理生成器的系统提示词生成一个【最小 diff 补丁】：找到提示词中导致该类失败的部分（old_str），替换为修复版本（new_str）。

失败题: {failures}
当前相关提示词片段: {current_prompt}

输出 JSON:
{"old_str":"要替换的原文(必须能在提示词中找到)",
 "new_str":"替换后的新文本",
 "rationale":"为什么这样改能修复该类失败"}

规则: new_str 与 old_str 的差异必须 < 30%（最小 diff，不整段重写）；必须能追溯绑定到上述失败题。`;

/** 调 plan 模型生成补丁（thinking 禁用保证结构化输出） */
async function generatePatch(prompt: string): Promise<Record<string, unknown> | null> {
  const model = getRoleModel('plan');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch(DS_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + DEEPSEEK_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 3000,
            thinking: { type: 'disabled' },
          }),
          signal: controller.signal,
        });
        const rawResp: any = await res.json();
        const rawText = rawResp.choices?.[0]?.message?.content?.trim() || '';
        if (!rawText) { if (attempt < 2) continue; return null; }
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const objMatch = cleaned.match(/{[\s\S]*}/);
        if (!objMatch) { if (attempt < 2) continue; return null; }
        const obj = JSON.parse(objMatch[0]);
        if (typeof obj.old_str !== 'string' || typeof obj.new_str !== 'string') { if (attempt < 2) continue; return null; }
        return obj;
      } finally { clearTimeout(timer); }
    } catch { if (attempt < 2) continue; }
  }
  return null;
}

/** 四门槛检查（第一版：前两门槛代码化，边界/保留集需跑评测） */
function checkGate(patch: Record<string, unknown>, failureIds: string[]): { diff_ratio: number; traceable: boolean; boundary_ok: boolean; retention_ok: boolean } {
  const oldStr = String(patch.old_str || '');
  const newStr = String(patch.new_str || '');
  const maxLen = Math.max(1, oldStr.length, newStr.length);
  // 门槛1: 差异占比 < 30%（字符级 Levenshtein 近似）
  let diff = 0;
  for (let i = 0; i < Math.min(oldStr.length, newStr.length); i++) if (oldStr[i] !== newStr[i]) diff++;
  diff += Math.abs(oldStr.length - newStr.length);
  const diffRatio = diff / maxLen;
  // 门槛2: 可追溯（old_str 非空 + 绑定失败题）
  const traceable = oldStr.length > 0 && failureIds.length > 0;
  // 门槛3/4: 需评测验证（占位：边界集=失败题重跑, 保留集=随机10题）——由后续流程跑评测确认
  return { diff_ratio: Math.round(diffRatio * 1000) / 1000, traceable, boundary_ok: false, retention_ok: false };
}

function main() {
  if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  const args = process.argv.slice(2);
  const catArg = (() => { const i = args.indexOf('--category'); return i >= 0 && i + 1 < args.length ? args[i + 1] : 'context'; })();
  const dryRun = args.includes('--dry-run');
  const runId = 'patch-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  (async () => {
    await client.connect();
    // 取该类别的失败题（含根因）
    const failures = await client.query(
      `select question_id, failure_category, root_cause, first_error_step from eval_failures
       where failure_category = $1 and root_cause is not null order by id desc limit 8`,
      [catArg]
    );
    if (failures.rows.length === 0) { console.log(`无 ${catArg} 类别失败题`); await client.end(); return; }
    console.log(`${catArg} 类别失败题 ${failures.rows.length} 个:`);
    for (const f of failures.rows) console.log(' ', f.question_id, '|', String(f.root_cause).substring(0, 60));

    // 当前提示词片段（从 inference-service generateHypothesis 的 systemPrompt 截取关键段）
    const currentPrompt = `你是学术知识检索助手。基于三层检索链(Cognee粗检索→Graphiti精炼→SAG融合)提供的上下文回答问题。
P0规则: 如果上下文中没有相关检索结果, 请直接回复"抱歉，当前知识库中未找到与该问题相关的信息"。
关键规则: Cognee分块/PG实体是直接从论文原文检索的, 置信度高, 优先采信。`;

    const failureDesc = failures.rows.map((f: any) =>
      `${f.question_id}: ${f.failure_category}@${f.first_error_step || '?'} — ${String(f.root_cause).substring(0, 120)}`
    ).join('\n');

    const prompt = PATCH_PROMPT
      .replace('{category}', catArg)
      .replace('{failures}', failureDesc)
      .replace('{current_prompt}', currentPrompt);

    console.log(`\n生成 ${catArg} 补丁...`);
    const patch = await generatePatch(prompt);
    if (!patch) { console.log('补丁生成失败'); await client.end(); return; }
    console.log('生成补丁:');
    console.log(' old_str:', String(patch.old_str).substring(0, 100));
    console.log(' new_str:', String(patch.new_str).substring(0, 100));
    console.log(' rationale:', String(patch.rationale || '').substring(0, 100));

    const checks = checkGate(patch, failures.rows.map((f: any) => f.question_id));
    console.log(`\n四门槛: diff_ratio=${checks.diff_ratio} (需<0.3) | traceable=${checks.traceable} | boundary_ok=${checks.boundary_ok}(需跑评测) | retention_ok=${checks.retention_ok}(需跑评测)`);
    const gatePass = checks.diff_ratio < 0.3 && checks.traceable;
    console.log(`门槛判定: ${gatePass ? '✅ 通过(前两门槛), 边界/保留集待评测' : '❌ 未通过'}`);

    if (gatePass && !dryRun) {
      await client.query(
        `insert into prompt_patches (trigger_failure_ids, component, old_str, new_str, scope, checks, status)
         values ($1, 'hypothesis_generator', $2, $3, 'reason', $4, 'candidate')`,
        [JSON.stringify(failures.rows.map((f: any) => f.question_id)), patch.old_str, patch.new_str, JSON.stringify(checks)]
      );
      console.log(`\n✅ 补丁已写入 prompt_patches (status=candidate, run=${runId})`);
      console.log('下一步: 人工确认 → update prompt_patches set status=canary where id=<id>（PROMPT_CANARY=id 生效）→ 评测边界/保留集 → released');
    } else if (dryRun) {
      console.log(`\n[dry-run] 未写库（运行 min-diff-patch.ts 不带 --dry-run 才写入）`);
    }
    await client.end();
  })().catch((e: any) => { console.error('补丁生成异常:', e); process.exit(1); });
}

main();
