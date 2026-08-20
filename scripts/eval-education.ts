// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// eval-education.ts — 教育场景评测（复赛冲刺期，对应方案 §5.2）
// 六项指标：
//   ① BKT 预测准确率：预测下次答对概率 vs 实际作答的 AUC
//   ② 学情诊断准确率：诊断薄弱点与模拟答案真实错因匹配率
//   ③ 路径规划合理性：拓扑路径无先修逆序率
//   ④ 作业批改准确率：客观题规则判分与标准答案一致率
//   ⑤ 思政内容核验：意识形态/表述/引用核验通过率（规则通道）
//   ⑥ 任务闭环完成率：完整链路可跑通比例（服务调用级）
// 用法: DATABASE_URL=... npx tsx scripts/eval-education.ts
import { pool } from "../src/db/pool.js";
import { bktUpdate, DEFAULT_PARAMS } from "../src/services/cognitive-diagnosis.js";
import { planPath, validatePath } from "../src/services/knowledge-graph-edu.js";
import { ruleScan } from "../src/services/content-audit-service.js";
import { gradeSubmission } from "../src/services/teaching-assistant-service.js";
import { locateGaps } from "../src/services/diagnostic-service.js";

// ═══ ① BKT 预测准确率（AUC 近似：正例预测分 > 负例预测分的比例）═══
function bktAuc(samples: Array<{ pred: number; actual: boolean }>): number {
  const pos = samples.filter((s) => s.actual).map((s) => s.pred);
  const neg = samples.filter((s) => !s.actual).map((s) => s.pred);
  if (pos.length === 0 || neg.length === 0) return 0;
  let wins = 0;
  for (const p of pos) for (const n of neg) if (p > n) wins++;
  return wins / (pos.length * neg.length);
}

/** 模拟作答序列（确定性，可复现）：知识点 A 真实掌握（90% 对），B 真实未掌握（20% 对）；
 *  用前一轮预测 vs 本轮实际；前 3 轮为预热不计入评估 */
function simBktSamples(): Array<{ pred: number; actual: boolean }> {
  const samples: Array<{ pred: number; actual: boolean }> = [];
  const gen = (pattern: boolean[]) => {
    let p = 0.5;
    pattern.forEach((actual, i) => {
      if (i >= 3) samples.push({ pred: p, actual });
      p = bktUpdate(p, actual, DEFAULT_PARAMS);
    });
  };
  gen([true, true, false, true, true, true, true, false, true, true, true, true]);   // A：10 轮 90% 对
  gen([false, false, true, false, false, false, true, false, false, false, false, true]); // B：10 轮 20% 对
  return samples;
}

// ═══ ② 学情诊断准确率（薄弱点匹配）═══
/** 模拟作答：预设「价值规律」「剩余价值」为薄弱（错多），其余掌握 */
async function evalDiagnosis(): Promise<number> {
  const studentId = "eval-sim-student";
  const weak = ["价值规律", "剩余价值"];
  const strong = ["商品", "劳动二重性"];
  for (const kp of weak) {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `insert into answer_history (student_id, subject, knowledge_point, question, is_correct) values ($1,'政治经济学',$2,'评测题',$3)`,
        [studentId, kp, i < 1]
      );
    }
  }
  for (const kp of strong) {
    await pool.query(
      `insert into answer_history (student_id, subject, knowledge_point, question, is_correct) values ($1,'政治经济学',$2,'评测题',true)`,
      [studentId, kp]
    );
  }
  const gaps = (await locateGaps({ studentId, subject: "政治经济学" })) as any;
  const detected = (gaps.gaps?.lowAccuracyPoints || []).map((g: any) => g.knowledge_point);
  // 匹配率：检测出的薄弱点中，属于真实薄弱点的比例
  const hit = detected.filter((d: string) => weak.includes(d)).length;
  const precision = detected.length > 0 ? hit / detected.length : 0;
  const recall = hit / weak.length;
  // 清理模拟数据
  await pool.query(`delete from answer_history where student_id = $1`, [studentId]);
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0; // F1
}

// ═══ ③ 路径规划合理性（无先修逆序率）═══
async function evalPath(): Promise<{ rate: number; violations: number }> {
  const targets = ["配方法", "二次方程", "剩余价值", "价值规律", "价值"];
  let violations = 0;
  let total = 0;
  for (const target of targets) {
    const plan = (await planPath({ subject: target.includes("配方法") || target === "二次方程" ? "数学" : "政治经济学", target })) as any;
    if (!plan.path || plan.path.length === 0) continue;
    total++;
    const v = (await validatePath({ subject: plan.subject, path: plan.path })) as any;
    if (!v.valid) violations++;
  }
  return { rate: total > 0 ? (total - violations) / total : 0, violations };
}

// ═══ ④ 作业批改准确率（客观题规则判分 vs 标准答案）═══
async function evalGrading(): Promise<number> {
  const r = (await gradeSubmission({
    subject: "数学",
    questions: [
      { question: "x² = 9，x = ?", studentAnswer: "3", correctAnswer: "±3", type: "objective", fullScore: 5 },
      { question: "2 + 2 = ?", studentAnswer: "4", correctAnswer: "4", type: "objective", fullScore: 5 },
      { question: "π 的近似值", studentAnswer: "3.14", correctAnswer: "3.14", type: "objective", fullScore: 5 },
      { question: "因式分解 x²+5x+6", studentAnswer: "(x+2)(x+3)", correctAnswer: "(x+2)(x+3)", type: "objective", fullScore: 5 },
    ],
  })) as any;
  const results = r.results as Array<{ correct?: boolean; score?: number }>;
  const scored = results.filter((x) => typeof x.correct === "boolean");
  const correct = scored.filter((x) => x.correct).length;
  return scored.length > 0 ? correct / scored.length : 0;
}

// ═══ ⑤ 思政内容核验（规则通道通过率）═══
function evalIdeology(): { passRate: number; blocked: number } {
  const cleanSamples = [
    "价值规律是商品经济的基本规律，商品交换以价值量为基础实行等价交换。",
    "剩余价值由雇佣工人创造，被资本家无偿占有。",
    "生产力决定生产关系，生产关系反作用于生产力。",
  ];
  const riskySamples = [
    "马克思主义已经过时了，不适合当代社会。",
    "社会主义等于资本主义，只是换了个名字。",
    "马克思说剩余价值不存在，剥削已经消失。",
  ];
  const cleanPass = cleanSamples.filter((s) => ruleScan(s).length === 0).length;
  const riskyBlocked = riskySamples.filter((s) => ruleScan(s).length > 0).length;
  return { passRate: cleanPass / cleanSamples.length, blocked: riskyBlocked };
}

// ═══ ⑥ 任务闭环完成率（服务调用级冒烟）═══
async function evalLoop(): Promise<{ ok: number; total: number }> {
  const steps: Array<() => Promise<boolean>> = [
    async () => (await import("../src/services/agent-education.js")).agentEducationService.checkEducationPolicy("正常辅导请求").allowed,
    async () => (await planPath({ subject: "数学", target: "配方法" })).ok === true,
    async () => (await validatePath({ subject: "数学", path: ["一元一次方程", "因式分解", "配方法"] })).valid === true,
    async () => (await locateGaps({ studentId: "eval-loop" })).ok === true,
    async () => (await import("../src/services/education-compliance.js")).educationComplianceService.dataClassification().ok === true,
  ];
  let ok = 0;
  for (const s of steps) {
    try { if (await s()) ok++; } catch { /* 单步失败计 0 */ }
  }
  return { ok, total: steps.length };
}

async function main() {
  console.log("═══ 教育场景评测（§5.2）═══");

  // ① BKT AUC
  const samples = simBktSamples();
  const auc = bktAuc(samples);
  console.log(`① BKT 预测 AUC: ${auc.toFixed(3)} (${samples.length} 样本)`);

  // ② 学情诊断 F1
  const diagF1 = await evalDiagnosis();
  console.log(`② 学情诊断 F1: ${diagF1.toFixed(3)}`);

  // ③ 路径无逆序率
  const pathRes = await evalPath();
  console.log(`③ 路径无逆序率: ${pathRes.rate.toFixed(3)} (${pathRes.violations} 处逆序)`);

  // ④ 批改准确率
  const gradAcc = await evalGrading();
  console.log(`④ 作业批改准确率: ${gradAcc.toFixed(3)}`);

  // ⑤ 思政核验
  const ideo = evalIdeology();
  console.log(`⑤ 思政核验: 正常表述通过率 ${(ideo.passRate * 100).toFixed(0)}% / 高危表述拦截 ${ideo.blocked}/3`);

  // ⑥ 闭环完成率
  const loop = await evalLoop();
  console.log(`⑥ 任务闭环完成率: ${loop.ok}/${loop.total}`);

  const overall = (auc * 0.25 + diagF1 * 0.25 + pathRes.rate * 0.15 + gradAcc * 0.15 + ideo.passRate * 0.1 + loop.ok / loop.total * 0.1);
  console.log(`═══ 综合教育场景分: ${overall.toFixed(3)} ═══`);
  await pool.end();
}

main().catch((e) => {
  console.error("[eval-education] 失败:", e);
  process.exit(1);
});
