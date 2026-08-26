// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// significance.ts — 配对统计显著性检验（BOOK-GAP-ROADMAP P0-1）
// 用法: npx tsx scripts/significance.ts --before <evalA.json> --after <evalB.json> [--out significance_report.md]
// 输入: 两份逐题评测结果，支持两种格式：
//   1) P0-1 新格式 eval_32metrics_perq.json: {generated_at, question_count, questions:[{question_id, overall, dimA..D, passed}]}
//   2) 历史格式 eval_32metrics*.json: 数组 [{question_id, question_type, overall, dimA, dimB, dimC, dimD, metrics}]（自动兼容）
// 检验方法（书中 Ch6 标准）:
//   - 配对 McNemar: 每题达标(overall>=0.55)=1 否则 0 → 2x2 表, chi2=(|b-c|-1)^2/(b+c) 带连续性校正
//   - 配对 bootstrap: 逐题分数差序列 10000 次重采样 → 95% CI（CI 不含 0 才算显著）
// 判定: p<0.05 且 CI 不含 0 → 显著改善/退化; b+c<10 → 样本量不足警告
// 输出: significance_report.md（均值差、p 值、CI、判定、逐题差异表、按题型分组）
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';

interface PerqEntry {
  question_id: string;
  question_type?: string;
  overall: number;
  dimA?: number; dimB?: number; dimC?: number; dimD?: number;
  passed?: boolean;
  eval_error?: boolean;
}

/** 解析任意格式的评测文件 → Map<question_id, PerqEntry> */
function parseResults(file: string): Map<string, PerqEntry> {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  let list: any[];
  if (Array.isArray(raw)) {
    list = raw; // 历史格式: 结果数组
  } else if (raw && Array.isArray(raw.questions)) {
    list = raw.questions; // P0-1 新格式
  } else {
    throw new Error('无法识别的评测文件格式: ' + file);
  }
  const map = new Map<string, PerqEntry>();
  for (const item of list) {
    // V399-2 P1: 跳过指纹元数据条目（question_id='__fingerprint__', 不参与配对统计）
    if (!item || !item.question_id || item.question_id === '__fingerprint__') continue;
    map.set(item.question_id, {
      question_id: item.question_id,
      question_type: item.question_type,
      overall: typeof item.overall === 'number' ? item.overall : 0,
      dimA: item.dimA, dimB: item.dimB, dimC: item.dimC, dimD: item.dimD,
      passed: typeof item.passed === 'boolean' ? item.passed : item.overall >= 0.55,
      eval_error: !!item.eval_error || !!item.error,
    });
  }
  return map;
}

/** 二项尾概率 P(X >= k), X ~ Bin(n, 0.5) — McNemar 精确检验（b+c 小样本时比卡方近似准） */
function binomialTailProb(k: number, n: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  // C(n,i) 迭代计算避免阶乘溢出 (n<=50, C(50,25)≈1.26e14 < 2^53)
  let c = 1; // C(n,0)
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    if (i >= k) sum += c;
    if (i < n) c = c * (n - i) / (i + 1);
  }
  return Math.min(1, sum / Math.pow(2, n));
}

/** 互补误差函数 erfc — Abramowitz-Stegun 7.1.26 近似（误差 < 1.5e-7，足够 1 自由度卡方 p 值） */
function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const e = y * Math.exp(-x * x);
  return x >= 0 ? e : 2 - e;
}
/** 1 自由度卡方分布 p 值: P(X > chi2) = erfc(sqrt(chi2/2)) */
function chi2PValue1df(chi2: number): number {
  if (chi2 <= 0) return 1;
  return erfc(Math.sqrt(chi2 / 2));
}

/** 配对 bootstrap: 逐题分数差序列 10000 次重采样 → {meanDiff, ciLo, ciHi} */
function pairedBootstrap(diffs: number[], nIter = 10000): { meanDiff: number; ciLo: number; ciHi: number } {
  const n = diffs.length;
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const sampleMeans: number[] = [];
  for (let iter = 0; iter < nIter; iter++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(Math.random() * n)];
    sampleMeans.push(sum / n);
  }
  sampleMeans.sort((a, b) => a - b);
  return {
    meanDiff: mean(diffs),
    ciLo: sampleMeans[Math.floor(nIter * 0.025)],
    ciHi: sampleMeans[Math.floor(nIter * 0.975)],
  };
}

function parseArgs(): { before: string; after: string; out: string } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const before = get('--before');
  const after = get('--after');
  if (!before || !after) {
    console.error('用法: npx tsx scripts/significance.ts --before <evalA.json> --after <evalB.json> [--out report.md]');
    process.exit(1);
  }
  return { before, after, out: get('--out') || 'significance_report.md' };
}

function main() {
  const { before, after, out } = parseArgs();
  console.log(`配对显著性检验: ${before}  vs  ${after}`);

  const beforeMap = parseResults(before);
  const afterMap = parseResults(after);

  // 配对对齐（按 question_id）
  const beforeIds = new Set(beforeMap.keys());
  const afterIds = new Set(afterMap.keys());
  const pairedIds = [...beforeIds].filter(id => afterIds.has(id) && !beforeMap.get(id)!.eval_error && !afterMap.get(id)!.eval_error).sort();
  const onlyBefore = [...beforeIds].filter(id => !afterIds.has(id));
  const onlyAfter = [...afterIds].filter(id => !beforeIds.has(id));

  if (pairedIds.length === 0) {
    console.error('错误: 两份文件没有可配对的题目（按 question_id 对齐）');
    process.exit(1);
  }

  const pairOf = (id: string) => ({ b: beforeMap.get(id)!, a: afterMap.get(id)! });

  // ── 1) 配对 McNemar（达标: overall >= 0.55）──
  let a = 0, b = 0, c = 0, d = 0; // a: 双达标, b: 仅before达标, c: 仅after达标, d: 双不达标
  for (const id of pairedIds) {
    const { b: be, a: af } = pairOf(id);
    const bp = be.overall >= 0.55, ap = af.overall >= 0.55;
    if (bp && ap) a++;
    else if (bp && !ap) b++;
    else if (!bp && ap) c++;
    else d++;
  }
  const discordant = b + c;
  const chi2 = discordant > 0 ? Math.pow(Math.abs(b - c) - 1, 2) / discordant : 0;
  const pMcNemarChi2 = chi2PValue1df(chi2);
  const pMcNemarExact = discordant > 0 ? 2 * binomialTailProb(Math.max(b, c), discordant) : 1;
  const insufficient = discordant < 10;

  // ── 2) 配对 bootstrap（逐题分数差）──
  const diffs = pairedIds.map(id => {
    const { b: be, a: af } = pairOf(id);
    return af.overall - be.overall;
  });
  const boot = pairedBootstrap(diffs);
  const meanBefore = pairedIds.reduce((s, id) => s + beforeMap.get(id)!.overall, 0) / pairedIds.length;
  const meanAfter = pairedIds.reduce((s, id) => s + afterMap.get(id)!.overall, 0) / pairedIds.length;

  const sigByChi2 = pMcNemarChi2 < 0.05;
  const sigByExact = pMcNemarExact < 0.05;
  const sigByBoot = boot.ciLo > 0 || boot.ciHi < 0;
  const direction = boot.meanDiff > 0 ? '改善' : (boot.meanDiff < 0 ? '退化' : '持平');

  // 判定: McNemar(b+c>=10 时用卡方/二项, 小样本用二项精确) + bootstrap 双指标
  const verdict = sigByExact && sigByBoot
    ? `显著${direction}（p=${pMcNemarExact.toFixed(4)} < 0.05 且 bootstrap CI 不含 0）`
    : (sigByExact || sigByBoot
      ? `边缘${direction}（仅一项检验显著: McNemar p=${pMcNemarExact.toFixed(4)}, CI=[${boot.ciLo.toFixed(4)}, ${boot.ciHi.toFixed(4)}]）`
      : `不显著（McNemar p=${pMcNemarExact.toFixed(4)} ≥ 0.05 或 bootstrap CI 含 0）`);

  // ── 3) 按题型分组 ──
  const byType = new Map<string, { before: number[]; after: number[] }>();
  for (const id of pairedIds) {
    const { b: be, a: af } = pairOf(id);
    const t = (af.question_type || be.question_type || 'unknown');
    if (!byType.has(t)) byType.set(t, { before: [], after: [] });
    byType.get(t)!.before.push(be.overall);
    byType.get(t)!.after.push(af.overall);
  }

  // ── 输出报告 ──
  const fmt = (x: number, d = 3) => x.toFixed(d);
  const lines: string[] = [];
  lines.push('# 配对显著性检验报告（P0-1）');
  lines.push('');
  lines.push(`- **before**: \`${before}\`（${beforeMap.size} 题）`);
  lines.push(`- **after**: \`${after}\`（${afterMap.size} 题）`);
  lines.push(`- **配对样本**: ${pairedIds.length} 题（仅计算双方都有有效结果的题目）`);
  lines.push(`- **未配对**: 仅 before ${onlyBefore.length} 题${onlyBefore.length ? '（' + onlyBefore.join(',') + '）' : ''} / 仅 after ${onlyAfter.length} 题${onlyAfter.length ? '（' + onlyAfter.join(',') + '）' : ''}`);
  lines.push(`- **生成时间**: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 总体结论');
  lines.push('');
  lines.push(`| 指标 | before | after | 差值 |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| 均值 | ${fmt(meanBefore)} | ${fmt(meanAfter)} | **${fmt(boot.meanDiff, 4)}** |`);
  lines.push(`| 达标率(≥0.55) | ${fmt(pairedIds.filter(id => beforeMap.get(id)!.overall >= 0.55).length / pairedIds.length * 100, 1)}% | ${fmt(pairedIds.filter(id => afterMap.get(id)!.overall >= 0.55).length / pairedIds.length * 100, 1)}% | ${fmt((pairedIds.filter(id => afterMap.get(id)!.overall >= 0.55).length - pairedIds.filter(id => beforeMap.get(id)!.overall >= 0.55).length) / pairedIds.length * 100, 1)}pp |`);
  lines.push('');
  lines.push(`**判定: ${verdict}**`);
  lines.push('');
  lines.push('## 配对 McNemar（达标 vs 不达标）');
  lines.push('');
  lines.push(`| | after 达标 | after 不达标 |`);
  lines.push(`|---|---|---|`);
  lines.push(`| before 达标 | ${a} | ${b} |`);
  lines.push(`| before 不达标 | ${c} | ${d} |`);
  lines.push('');
  lines.push(`- 不一致对数 b+c = ${discordant}${insufficient ? '（⚠️ < 10，卡方近似不可靠，已用二项精确检验）' : ''}`);
  lines.push(`- 连续性校正卡方 χ² = ${fmt(chi2, 2)}，p = ${fmt(pMcNemarChi2, 4)}${pMcNemarChi2 < 0.05 ? ' ✅' : ' ❌'}`);
  lines.push(`- 二项精确检验 p = ${fmt(pMcNemarExact, 4)}${pMcNemarExact < 0.05 ? ' ✅' : ' ❌'}`);
  lines.push('');
  lines.push('## 配对 Bootstrap（逐题分数差，10000 次重采样）');
  lines.push('');
  lines.push(`- 平均分差 = **${fmt(boot.meanDiff, 4)}**`);
  lines.push(`- 95% CI = **[${fmt(boot.ciLo, 4)}, ${fmt(boot.ciHi, 4)}]** ${sigByBoot ? '（不含 0 ✅）' : '（含 0 ❌）'}`);
  lines.push('');
  lines.push('## 按题型分组');
  lines.push('');
  lines.push(`| 题型 | 题数 | before 均值 | after 均值 | 差值 |`);
  lines.push(`|---|---|---|---|---|`);
  for (const [t, v] of byType) {
    const mb = v.before.reduce((s, x) => s + x, 0) / v.before.length;
    const ma = v.after.reduce((s, x) => s + x, 0) / v.after.length;
    lines.push(`| ${t} | ${v.before.length} | ${fmt(mb)} | ${fmt(ma)} | ${fmt(ma - mb, 4)} |`);
  }
  lines.push('');
  lines.push('## 逐题差异表（|差| ≥ 0.05 的题）');
  lines.push('');
  lines.push(`| 题号 | before | after | 差值 |`);
  lines.push(`|---|---|---|---|`);
  const bigDiffs = pairedIds
    .map(id => ({ id, b: beforeMap.get(id)!.overall, a: afterMap.get(id)!.overall }))
    .filter(x => Math.abs(x.a - x.b) >= 0.05)
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
  for (const x of bigDiffs) lines.push(`| ${x.id} | ${fmt(x.b)} | ${fmt(x.a)} | **${fmt(x.a - x.b, 4)}** |`);
  lines.push('');
  lines.push('## 判定规则（书中 Ch6 标准）');
  lines.push('');
  lines.push('1. 分差必须超噪声：bootstrap 95% CI 不含 0');
  lines.push('2. 配对检验成立：McNemar p < 0.05（小样本用二项精确）');
  lines.push('3. 可复现：同一配置跑 3 次（EVAL_SEED 换洗牌顺序），报告均值 ± 波动范围');
  lines.push('');
  lines.push('三条同时满足才可宣称"改善"；否则视为抽样噪声。');
  lines.push('');

  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('\n' + lines.slice(0, 22).join('\n'));
  console.log('\n报告已写入: ' + out);
}

main();
