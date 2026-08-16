// diagnostic-service.ts — 学情诊断升级（V386）
// 从做题/交互行为挖掘学习问题，输出可落地诊断报告
// 四层能力：
//   ① 知识点漏洞定位：区分 不会知识点/审题失误/计算粗心/概念混淆 四类
//   ② 学习行为分析：学习时长/做题速度/畏难点/高频错误类型
//   ③ 诊断报告输出：学生版（自我改进建议）+ 教师版（班级共性问题）
//   ④ 预测预警：预判后续学习风险，提前干预薄弱环节
// 数据源: answer_history(答题) + wrong_questions(错题) + learning_pace(节奏) + knowledge_mastery(掌握度)
import { pool } from "../db/pool.js";
import { llmJson, recallStudentMemory } from "./education-service.js";

// ═══ ① 知识点漏洞定位：按错误类型分类 ═══
export async function locateGaps(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const params: unknown[] = [studentId];
  let where = "student_id = $1";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }

  // 从错题本按类型聚合（mistake_type 区分漏洞类别）
  const wrongByType = await pool.query(
    `select mistake_type, count(*)::int as n, array_agg(distinct knowledge_point) as points
     from wrong_questions where ${where} and mastered = false group by mistake_type order by n desc`,
    params
  );

  // 从答题历史找正确率低的知识点（不会知识点）
  const weakByHistory = await pool.query(
    `select knowledge_point,
            count(*)::int as attempts,
            sum(case when is_correct then 1 else 0 end)::int as correct,
            round(avg(case when is_correct then 1 else 0 end)::numeric, 3) as accuracy
     from answer_history where ${where}
     group by knowledge_point having count(*) >= 2
     order by accuracy asc limit 10`,
    params
  );

  // 漏洞分类映射（缺 answer_history 未标类型时，按正确率+难度推断）
  const typeLabels: Record<string, string> = {
    "概念不清": "概念混淆",
    "方法不熟": "不会知识点",
    "计算失误": "计算粗心",
    "审题偏差": "审题失误",
    "unknown": "待分类",
  };

  const gaps = {
    byType: wrongByType.rows.map((r) => ({ type: typeLabels[r.mistake_type] || r.mistake_type, count: r.n, points: r.points })),
    lowAccuracyPoints: weakByHistory.rows.filter((r) => Number(r.accuracy) < 0.6),
  };

  return { ok: true, gaps };
}

// ═══ ② 学习行为分析：时长/速度/畏难点/高频错误 ═══
export async function behaviorAnalysis(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const params: unknown[] = [studentId];
  let where = "student_id = $1";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }

  // 学习时长（learning_pace 汇总）
  const pace = await pool.query(
    `select count(*)::int as days, coalesce(sum(session_minutes), 0)::int as total_minutes,
            round(coalesce(avg(session_minutes), 0)::numeric, 1) as avg_minutes
     from learning_pace where ${where}`,
    params
  );

  // 做题速度（answer_history 按天分组近似：次数/天数）+ 正确率
  const speed = await pool.query(
    `select count(*)::int as total_answers,
            sum(case when is_correct then 1 else 0 end)::int as correct,
            round(avg(case when is_correct then 1 else 0 end)::numeric, 3) as accuracy,
            count(distinct knowledge_point)::int as points_covered
     from answer_history where ${where}`,
    params
  );

  // 畏难点（反复做但正确率低 = 卡住的知识点）
  const fearPoints = await pool.query(
    `select knowledge_point, count(*)::int as attempts,
            round(avg(case when is_correct then 1 else 0 end)::numeric, 3) as accuracy
     from answer_history where ${where}
     group by knowledge_point having count(*) >= 3 and avg(case when is_correct then 1 else 0 end) < 0.5
     order by attempts desc limit 5`,
    params
  );

  // 高频错误类型（wrong_questions 的 mistake_type 分布）
  const errorTypes = await pool.query(
    `select mistake_type, count(*)::int as n from wrong_questions
     where ${where} group by mistake_type order by n desc limit 5`,
    params
  );

  return {
    ok: true,
    behavior: {
      pace: pace.rows[0] || { days: 0, total_minutes: 0, avg_minutes: 0 },
      speed: speed.rows[0] || { total_answers: 0, correct: 0, accuracy: 0, points_covered: 0 },
      fearPoints: fearPoints.rows,
      topErrorTypes: errorTypes.rows,
    },
  };
}

// ═══ ③ 诊断报告：学生版 + 教师版 ═══
export async function diagnosticReport(input: { studentId?: string; subject?: string; audience?: "student" | "teacher" }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const audience = input.audience || "student";

  // 汇总行为数据（喂给 LLM 生成报告）
  const [gaps, behavior] = await Promise.all([locateGaps({ studentId, subject: input.subject }), behaviorAnalysis({ studentId, subject: input.subject })]);
  const memory = await recallStudentMemory(`${input.subject || ""} 学情诊断 ${studentId}`);

  const audienceRule = audience === "student"
    ? "学生版报告：面向学生本人，给出自我改进建议（具体可执行，非空泛鼓励）"
    : "教师版报告：面向教师，提炼班级/学生共性问题与教学干预建议";

  const prompt = `你是学情诊断专家。基于以下数据生成${audienceRule}。
数据: ${JSON.stringify({ gaps: gaps.gaps, behavior: behavior.behavior }).substring(0, 2500)}
${memory}

输出 JSON: {
  "overall": "总体学情评价(3-5句)",
  "gapSummary": [{"type":"漏洞类型","points":"涉及知识点","suggestion":"改进建议"}],
  "behaviorInsights": [{"aspect":"行为维度","finding":"发现","implication":"影响"}],
  "actionPlan": [{"priority":"高/中/低","action":"具体行动","expectedOutcome":"预期效果"}],
  "attention": "最需要关注的一点"
}`;

  return { ok: true, report: await llmJson(prompt), audience };
}

// ═══ ④ 预测预警：风险预判 + 提前干预 ═══
export async function predictRisk(input: { studentId?: string; subject?: string }): Promise<Record<string, unknown>> {
  const studentId = input.studentId || "default";
  const params: unknown[] = [studentId];
  let where = "student_id = $1";
  if (input.subject) { params.push(input.subject); where += " and subject = $" + params.length; }

  // 规则引擎：从数据推导风险信号
  const signals: Array<{ level: string; signal: string; evidence: string; intervention: string }> = [];

  // 信号1：整体正确率 < 50%
  const acc = await pool.query(
    `select count(*)::int as n, sum(case when is_correct then 1 else 0 end)::int as c from answer_history where ${where}`,
    params
  );
  const n = acc.rows[0]?.n || 0;
  const c = acc.rows[0]?.c || 0;
  if (n >= 3 && c / n < 0.5) {
    signals.push({ level: "high", signal: "整体正确率偏低", evidence: `答 ${n} 题对 ${c} 题（${((c / n) * 100).toFixed(0)}%）`, intervention: "建议降低难度，回到基础知识点系统复习" });
  }

  // 信号2：存在畏难点（≥3次尝试仍 <50%）
  const fears = await pool.query(
    `select knowledge_point, count(*)::int as attempts from answer_history
     where ${where} group by knowledge_point having count(*) >= 3 and avg(case when is_correct then 1 else 0 end) < 0.5`,
    params
  );
  for (const f of fears.rows) {
    signals.push({ level: "high", signal: `畏难点「${f.knowledge_point}」`, evidence: `${f.attempts} 次尝试仍未掌握`, intervention: `针对「${f.knowledge_point}」安排微课+变式题专项巩固` });
  }

  // 信号3：错题本堆积（≥5 未掌握）
  const wrong = await pool.query(`select count(*)::int as n from wrong_questions where ${where} and mastered = false`, params);
  if ((wrong.rows[0]?.n || 0) >= 5) {
    signals.push({ level: "medium", signal: "错题本堆积", evidence: `${wrong.rows[0].n} 道错题未巩固`, intervention: "启动错题清空计划：每天 3 道变式题，一周内清零" });
  }

  // 信号4：学习时长不足（<30 分钟/天）
  const pace = await pool.query(`select round(coalesce(avg(session_minutes), 0)::numeric, 1) as avg from learning_pace where ${where}`, params);
  if (Number(pace.rows[0]?.avg || 0) > 0 && Number(pace.rows[0]?.avg) < 30) {
    signals.push({ level: "medium", signal: "学习时长不足", evidence: `日均 ${pace.rows[0].avg} 分钟`, intervention: "建议延长至 45 分钟/天，分两段学习" });
  }

  // 信号5：整体数据量过少 → 数据不足预警
  if (n < 3) {
    signals.push({ level: "info", signal: "学习数据不足", evidence: `仅 ${n} 次作答`, intervention: "先完成 3-5 次练习，系统才能给出准确诊断" });
  }

  // 综合风险等级
  const highCount = signals.filter((s) => s.level === "high").length;
  const riskLevel = highCount >= 2 ? "high" : signals.some((s) => s.level === "high") ? "medium" : signals.length > 0 ? "low" : "ok";

  return { ok: true, riskLevel, signals, summary: riskLevel === "high" ? "存在明显学习风险，建议立即干预" : riskLevel === "medium" ? "有中等风险，建议本周内干预" : riskLevel === "low" ? "整体健康，继续保持" : "数据不足，暂无法预警" };
}

export const diagnosticService = { locateGaps, behaviorAnalysis, diagnosticReport, predictRisk };
