// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// fix-skill-descriptions.ts — 技能 description 自动修复（BOOK-GAP-ROADMAP P1-2 续）
// 闭环: 审计发现缺口 → LLM 补全 description → 写回 SKILL.md → 重跑审计验证缺口闭合 → 治愈率报告
// 防复发: 修复时只追加不删改（保留原始信息），治愈率 < 100% 的缺口列入待办
// 用法: npx tsx scripts/fix-skill-descriptions.ts [--limit 5] [--dry-run]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import os from 'node:os';
import path from 'node:path';

const DS_URL = process.env.DS_BASE_URL || "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

/** 递归收集 SKILL.md */
function collectSkillMds(root: string): Array<{ name: string; skillMdPath: string }> {
  const out: Array<{ name: string; skillMdPath: string }> = [];
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "_中文说明" || entry.name === "__pycache__" || entry.name === ".git" || entry.name === "node_modules") continue;
      const childDir = path.join(cur.dir, entry.name);
      const childRel = cur.rel ? `${cur.rel}/${entry.name}` : entry.name;
      if (existsSync(path.join(childDir, "SKILL.md"))) {
        out.push({ name: childRel, skillMdPath: path.join(childDir, "SKILL.md") });
      } else if (cur.depth < 2) {
        stack.push({ dir: childDir, rel: childRel, depth: cur.depth + 1 });
      }
    }
  }
  return out;
}

/** 审计单技能（复用 audit 逻辑, 含 notTriggers 字段检查） */
function auditSkill(mdPath: string): { desc: string; missing: string[] } {
  let content = "";
  try { content = readFileSync(mdPath, 'utf8'); } catch { return { desc: "", missing: ["无法读取"] }; }
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const desc = descMatch ? descMatch[1].trim() : "";
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*/, "");
  const fmAll = fm + body.substring(0, 800);
  const hasTrigger = /(?:use when|当|适用|触发|用于|场景|时机|^triggers:)/im.test(fmAll) || /(?:use when|当|适用|触发|用于|场景|时机)/i.test(desc);
  const hasBoundary = /(?:don'?t use|never|不要|不适用|避免|切勿|not for|^notTriggers:)/im.test(fmAll);
  // V326: 示例/代价也检查 description 本身
  const hasExample = /(?:示例|例如|e\.g\.|比如|如：|例如：|参数值)/i.test(desc + body.substring(0, 1500));
  const hasCost = /(?:耗时|分钟|秒|token|费用|成本|\$\d|分钟级|秒级)/i.test(desc + body.substring(0, 1500));
  const missing: string[] = [];
  if (!hasTrigger) missing.push("缺触发时机");
  if (!hasBoundary) missing.push("缺边界反例");
  if (!hasExample) missing.push("缺具体示例");
  if (!hasCost) missing.push("缺执行代价");
  return { desc, missing };
}

/** LLM 生成补全后的 description（超长描述只生成缺失要素追加片段, 脚本拼接避免LLM丢原文） */
async function fixDescription(name: string, currentDesc: string, missing: string[]): Promise<string | null> {
  const isLong = currentDesc.length > 800;
  const prompt = isLong
    ? `技能 ${name} 的描述很长, 缺少：${missing.join('、')}。
请只生成【追加片段】（60-120字, 包含缺失要素）：
- 缺触发时机 → "Use when 何时使用"
- 缺边界反例 → "Don't use when 何时不要用"
- 缺具体示例 → "e.g. 示例"
- 缺执行代价 → "耗时约X分钟/成本约Y"
只返回追加片段文本（不要重复原文）, 不要其他文字。`
    : `你是技能描述优化专家。技能 ${name} 的当前描述缺少以下要素：${missing.join('、')}。
当前描述: ${currentDesc}
请生成【补全后】的完整 description（一句话, 保留原文信息, 追加缺失要素）：
- 缺触发时机 → 加"Use when 何时使用"
- 缺边界反例 → 加"Don't use when 何时不要用"
- 缺具体示例 → 加"e.g. 示例"
- 缺执行代价 → 加"耗时约X分钟/成本约Y"

只返回新 description 文本, 不要其他文字。`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(DS_URL, {
        method: "POST",
        headers: { "Authorization": "Bearer " + DEEPSEEK_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-flash", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: isLong ? 500 : 800,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
      const raw: any = await res.json();
      const text = raw.choices?.[0]?.message?.content?.trim() || "";
      if (!text || text.length < 20) return null;
      // 超长描述: 原文 + 追加片段（片段去掉可能的前缀引导词）
      if (isLong) {
        const append = text.replace(/^(?:追加片段|补全|新增|建议|:|\s)+/i, "");
        return currentDesc + " " + append;
      }
      return text.replace(/^["']|["']$/g, "");  // 去引号
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

/** 写回 SKILL.md 的 description 行（行级替换, 支持内部含引号的超长描述） */
function writeDescription(mdPath: string, newDesc: string): boolean {
  try {
    const content = readFileSync(mdPath, 'utf8');
    const escaped = newDesc.replace(/"/g, '\\"');
    // 行级替换: description: 开头的整行（不管内部引号）, 统一改为带引号格式
    const updated = content.replace(
      /^description:.*$/m,
      `description: "${escaped}"`
    );
    if (updated === content) return false;
    writeFileSync(mdPath, updated, 'utf8');
    return true;
  } catch { return false; }
}

function main() {
  if (!DEEPSEEK_KEY) { console.error('DEEPSEEK_API_KEY 未设置'); process.exit(1); }
  const args = process.argv.slice(2);
  const limit = (() => { const i = args.indexOf('--limit'); const v = i >= 0 && i + 1 < args.length ? parseInt(args[i + 1], 10) : NaN; return !isNaN(v) && v > 0 ? v : 5; })();
  const dryRun = args.includes('--dry-run');

  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const skills = collectSkillMds(skillsDir);
  // 按缺口数排序（缺口多的先治）
  const audited = skills.map((s) => ({ ...s, audit: auditSkill(s.skillMdPath) }))
    .filter((s) => s.audit.missing.length > 0)
    .sort((a, b) => b.audit.missing.length - a.audit.missing.length);

  const targets = audited.slice(0, limit);
  console.log(`待修复技能 ${audited.length} 个, 本次治疗 ${targets.length} 个${dryRun ? '（dry-run）' : ''}`);

  let cured = 0, failed = 0;
  (async () => {
    for (const t of targets) {
      console.log(`\n治疗 ${t.name}（缺: ${t.audit.missing.join('、')}）`);
      const newDesc = await fixDescription(t.name, t.audit.desc, t.audit.missing);
      if (!newDesc) { console.log('  ❌ 生成失败'); failed++; continue; }
      if (dryRun) {
        console.log('  [dry-run] 新描述:', newDesc.substring(0, 100) + '...');
        continue;
      }
      const ok = writeDescription(t.skillMdPath, newDesc);
      if (!ok) { console.log('  ❌ 写回失败'); failed++; continue; }
      // 复查：重跑审计验证缺口闭合
      const reAudit = auditSkill(t.skillMdPath);
      if (reAudit.missing.length === 0) { console.log('  ✅ 治愈（缺口全闭合）'); cured++; }
      else { console.log(`  ⚠️ 部分治愈（仍缺: ${reAudit.missing.join('、')}）`); failed++; }
    }

    console.log('\n═══════ 治愈报告 ═══════');
    console.log(`本次治疗 ${targets.length} 个 | 治愈 ${cured} | 未愈 ${failed}`);
    console.log(`剩余缺口技能 ${audited.length - (dryRun ? 0 : targets.length)} 个（可再次运行继续治疗）`);
    if (dryRun) console.log('[dry-run] 未实际写入（去掉 --dry-run 才生效）');
  })().catch((e: any) => { console.error('修复异常:', e); process.exit(1); });
}

main();
