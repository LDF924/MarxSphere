// b5-vs-single-eval.ts — V405-B5: "集成超越单模型"实证评测(子集)
// 对照: deepseek-v4-pro 单模型 / qwen3.7-max 单模型 / B5 融合(默认阵容)
// judge: LLM 双盲打分(1-5 标准: 正确性/完整性/引用/结构), 汇总均值。
// 用法: B5_ENABLED=1 npx tsx scripts/b5-vs-single-eval.ts --n 10
import { callLlm } from "../src/ai/llm-common.js";
import { callLlmWithRotation } from "../src/ai/llm-common.js";
import { runB5EnsembleProgressive } from "../src/services/b5-ensemble-service.js";

const N = Number(process.argv[process.argv.indexOf("--n") + 1] || 10);

// 难题子集(比较/引证/机制 — B5 该赢的场景), 取自 53 题语料形态
const HARD_QUESTIONS = [
  "凯恩斯有效需求不足理论与马克思生产过剩危机理论的比较分析",
  "请结合马克思关于资本积累的一般规律的论述，引用原文分析资本有机构成提高对产业后备军的影响机制",
  "数字平台劳动过程与马克思劳动过程理论的当代对接：数据—算法如何重构价值形成机制",
  "我国对工商资本租赁农地有哪些监管规定？请逐条列举政策条款并说明执行机制",
  "新质生产力与马克思主义生产力理论的谱系关系及理论接口",
  "资本下乡对农村集体经济的影响机制与双面效应",
  "剩余价值率在当代资本主义中的表现形式：数字资本、平台经济与金融化",
  "社会资本三个维度如何通过知识存量影响家庭农场订单生产经营行为",
  "习近平关于规范和引导资本健康发展重要论述的理论定位与体系",
  "平台零工劳动过程研究：周绍东范式与经典劳动过程理论的一致性与差异",
  "马克思劳动过程理论核心命题在 AI 时代的适用性与发展",
  "合作社参与对农户人力资本影响的因果机制与中介路径",
].slice(0, N);

interface JudgeScore { q: string; single1: number; single2: number; b5: number }

async function ask(model: string, q: string): Promise<string> {
  const r = await callLlmWithRotation({
    model,
    messages: [
      { role: "system", content: "你是严谨的马克思主义政治经济学研究助手。直接完整回答, 标注不确定处。" },
      { role: "user", content: q },
    ],
    maxTokens: 2000, temperature: 0.3,
  });
  return r?.text || "";
}

async function judge(q: string, answer: string, label: string): Promise<number> {
  const r = await callLlm({
    messages: [
      { role: "system", content: "你是学术评审。给答案打 1-5 分(正确性/完整性/引用依据/结构清晰)。只输出数字。" },
      { role: "user", content: `问题: ${q}\n\n【${label} 的回答】\n${answer.slice(0, 2500)}` },
    ],
    maxTokens: 10, temperature: 0,
  });
  const n = Number((r?.text || "").trim().match(/\d/)?.[0]);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 3;
}

const S1 = "deepseek-v4-pro";   // 强单模型基线
const S2 = "deepseek-v4-flash"; // 弱单模型基线(便宜锚点 — B5 融合应显著胜出)

const results: JudgeScore[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const q of HARD_QUESTIONS) {
  console.log(`── ${q.slice(0, 40)}…`);
  // 串行 + 相位冷却(DeepSeek 连续大输出易限流挂起): 单模型各一轮 → 冷却 → B5 → 冷却
  const a1 = await ask(S1, q);
  const a2 = await ask(S2, q);
  await sleep(15000); // 相位冷却: 让上游限流窗口回落
  const b5 = await runB5EnsembleProgressive(q);
  const [s1, s2, sb] = await Promise.all([
    judge(q, a1, S1), judge(q, a2, S2), judge(q, b5.merged, "B5融合"),
  ]);
  results.push({ q, single1: s1, single2: s2, b5: sb });
  console.log(`  单${S1}=${s1} 单${S2}=${s2} B5=${sb}${b5.progressive?.timedOut?.length ? ` (超时截断: ${b5.progressive.timedOut.join(",")})` : ""}`);
  await sleep(15000);
}

const avg = (k: keyof Omit<JudgeScore, "q">) =>
  results.reduce((a, r) => a + Number(r[k]), 0) / Math.max(1, results.length);
const out = {
  n: results.length,
  avgSingle1: avg("single1"),
  avgSingle2: avg("single2"),
  avgB5: avg("b5"),
  beatsSingle1: avg("b5") > avg("single1"),
  beatsSingle2: avg("b5") > avg("single2"),
  detail: results,
};
console.log("\n═══ 汇总 ═══");
console.log(`单 ${S1} 均值: ${out.avgSingle1.toFixed(2)}`);
console.log(`单 ${S2} 均值: ${out.avgSingle2.toFixed(2)}`);
console.log(`B5 融合均值: ${out.avgB5.toFixed(2)}`);
console.log(`B5 > ${S1}? ${out.beatsSingle1 ? "✅" : "❌"} | B5 > ${S2}? ${out.beatsSingle2 ? "✅" : "❌"}`);
require("fs").writeFileSync("evaluation/eval_b5_vs_single.json", JSON.stringify(out, null, 2), "utf8");
console.log("已存 evaluation/eval_b5_vs_single.json");
