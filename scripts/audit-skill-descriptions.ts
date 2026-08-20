// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// audit-skill-descriptions.ts — 技能 description 系统化审计（BOOK-GAP-ROADMAP P1-2）
// 遍历 ~/.claude/skills 下 SKILL.md，提取 frontmatter description，检查四要素：
//   ①触发时机(Use when) ②边界反例(Don't use when/NEVER) ③具体示例(参数值而非术语) ④执行代价(耗时/结果量级)
// 输出 skill-audit-report.md：按缺口分组 + 每技能形态建议(Skill 文本 vs 结构化工具)
// 用法: npx tsx scripts/audit-skill-descriptions.ts [--out skill-audit-report.md]
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import os from 'node:os';
import path from 'node:path';

interface SkillAudit {
  name: string;
  desc: string;
  descLen: number;
  hasTrigger: boolean;      // 触发时机（Use when / 当…时 / 适用…）
  hasBoundary: boolean;     // 边界反例（Don't use when / NEVER / 不要用于 / 不适用）
  hasExample: boolean;      // 具体示例（示例/例如/e.g./参数值）
  hasCost: boolean;         // 执行代价（耗时/成本/分钟/秒/token/费用）
  missing: string[];
}

/** 递归收集 SKILL.md（复用 skills-service 的扫描逻辑） */
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

function auditSkill(name: string, mdPath: string): SkillAudit {
  let content = "";
  try { content = readFileSync(mdPath, 'utf8'); } catch { return { name, desc: "", descLen: 0, hasTrigger: false, hasBoundary: false, hasExample: false, hasCost: false, missing: ["无法读取"] }; }
  // frontmatter 提取
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const desc = descMatch ? descMatch[1].trim() : "";
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*/, "");
  // V325: 检查整个 frontmatter（含 triggers/notTriggers 专门字段），不只 description+正文
  const fmAll = fm + body.substring(0, 800);

  // 触发时机: description/triggers 字段/正文
  const hasTrigger = /(?:use when|当|适用|触发|用于|场景|时机|^triggers:)/im.test(fmAll) || /(?:use when|当|适用|触发|用于|场景|时机)/i.test(desc);
  // 边界反例: notTriggers 字段/正文
  const hasBoundary = /(?:don'?t use|never|不要|不适用|避免|切勿|not for|^notTriggers:)/im.test(fmAll);
  // V326: 示例/代价也检查 description 本身（修复脚本把要素加进 description 行）
  // V327: desc 不截断（超长 description 的成本词在 1500 字截断之外会被误判缺失）
  const hasExample = /(?:示例|例如|e\.g\.|比如|如：|例如：|参数值)/i.test(desc + body.substring(0, 1500));
  const hasCost = /(?:耗时|分钟|秒|token|费用|成本|\$\d|分钟级|秒级)/i.test(desc + body.substring(0, 1500));

  const missing: string[] = [];
  if (!hasTrigger) missing.push("缺触发时机");
  if (!hasBoundary) missing.push("缺边界反例");
  if (!hasExample) missing.push("缺具体示例");
  if (!hasCost) missing.push("缺执行代价");
  return { name, desc, descLen: desc.length, hasTrigger, hasBoundary, hasExample, hasCost, missing };
}

function main() {
  const args = process.argv.slice(2);
  const out = (() => { const i = args.indexOf('--out'); return i >= 0 && i + 1 < args.length ? args[i + 1] : 'skill-audit-report.md'; })();
  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  if (!existsSync(skillsDir)) { console.error('技能目录不存在: ' + skillsDir); process.exit(1); }

  const skills = collectSkillMds(skillsDir);
  console.log(`扫描到 ${skills.length} 个技能`);
  const audits = skills.map((s) => auditSkill(s.name, s.skillMdPath)).sort((a, b) => b.missing.length - a.missing.length);

  const byGap: Record<string, number> = {};
  for (const a of audits) for (const m of a.missing) byGap[m] = (byGap[m] || 0) + 1;
  const perfect = audits.filter((a) => a.missing.length === 0);
  const needsWork = audits.filter((a) => a.missing.length > 0);

  // 形态建议（书中 Ch4-1）：参数复杂/变更频繁 → Skill 文本；嵌套对象/联合校验 → 结构化工具
  const suggestForm = (a: SkillAudit): string => {
    if (a.descLen > 200) return "Skill 文本（描述长，适合文本触发）";
    if (a.descLen < 20) return "⚠️ 描述过短（<20字，需重写）";
    return "Skill 文本（标准形态）";
  };

  const lines: string[] = [];
  lines.push('# 技能 description 审计报告（P1-2）');
  lines.push('');
  lines.push(`- **技能总数**: ${skills.length}`);
  lines.push(`- **四要素齐全**: ${perfect.length} 个（${(perfect.length / skills.length * 100).toFixed(1)}%）`);
  lines.push(`- **有缺口**: ${needsWork.length} 个`);
  lines.push(`- **生成时间**: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 缺口分布');
  lines.push('');
  lines.push('| 缺口 | 技能数 |');
  lines.push('|---|---|');
  for (const [gap, n] of Object.entries(byGap).sort((a, b) => b[1] - a[1])) lines.push(`| ${gap} | ${n} |`);
  lines.push('');
  lines.push('## 四要素齐全的技能（可作模板参考）');
  lines.push('');
  lines.push('| 技能 | 描述 |');
  lines.push('|---|---|');
  for (const a of perfect.slice(0, 20)) lines.push(`| ${a.name} | ${a.desc.substring(0, 60)} |`);
  lines.push('');
  lines.push('## 缺口技能清单（按缺口数排序）');
  lines.push('');
  lines.push('| 技能 | 缺口 | 描述长度 | 形态建议 |');
  lines.push('|---|---|---|---|');
  for (const a of audits) {
    lines.push(`| ${a.name} | ${a.missing.join('、') || '无'} | ${a.descLen} | ${suggestForm(a)} |`);
  }
  lines.push('');
  lines.push('> 行动建议: 优先修"缺边界反例"+"缺执行代价"的高频技能（书中 Ch4: 边界反例是防误触发的关键）; 抽样 10 个高频技能改写后跑路由回归。');
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`\n审计报告已写入: ${out}`);
  console.log(`四要素齐全: ${perfect.length}/${skills.length} | 缺口TOP: ${Object.entries(byGap).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([g,n])=>`${g}(${n})`).join(' ')}`);
}

main();
