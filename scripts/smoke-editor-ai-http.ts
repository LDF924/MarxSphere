// 冒烟(HTTP 层): 走真实 /api/editor/v1/ai/jobs → SSE, 覆盖 14 按钮 + 模型切换
// 验证: ①每个按钮后端真跑 ②SSE model 事件回报真实模型(非 "default") ③切模型后 job.model 跟随
// 用法: SAG_TOKEN=<jwt> npx tsx scripts/smoke-editor-ai-http.ts   (默认 http://127.0.0.1:4173)
const BASE = process.env.SAG_BASE ?? "http://127.0.0.1:4173";
const TOKEN = process.env.SAG_TOKEN ?? "";
const AUTH: Record<string, string> = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

const DOC = `数字经济赋能共同富裕的机制与路径研究

摘要: 本文基于 2011-2022 年中国省级面板数据, 采用固定效应模型考察数字经济对共同富裕的影响及其作用机制。研究发现, 数字经济显著提升了共同富裕水平。

一、引言
共同富裕是社会主义的本质要求。本文试图回答: 数字经济通过何种机制影响共同富裕?

二、研究设计
被解释变量为共同富裕指数(熵值法)。核心解释变量为数字经济发展水平。模型: 共同 = α + β*数字经济 + γ*控制 + 固定效应 + ε。

三、实证结果
数字经济系数 0.237, 1% 水平显著。中西部效应更强(0.312), 东部较弱(0.145)。

四、结论
第一, 大力发展数字经济。第二, 重视区域差异。

参考文献
[1] 张三. 数字经济与收入分配[J]. 经济研究, 2021(3).
[2] 李四. 共同富裕的理论内涵[J]. 中国社会科学, 2022.`;

const BUTTONS: Array<{ id: string; tab: string; action: string; mode: string }> = [
  { id: "logic_check", tab: "check", action: "check", mode: "logic" },
  { id: "section_coherence_check", tab: "check", action: "check", mode: "cohesion" },
  { id: "variable_method_conclusion_check", tab: "check", action: "check", mode: "consistency" },
  { id: "submission_check", tab: "check", action: "check", mode: "submission" },
  { id: "academic_polish", tab: "local", action: "rewrite", mode: "polish" },
  { id: "reduce_ai_tone", tab: "local", action: "rewrite", mode: "de-template" },
  { id: "compress_redundancy", tab: "local", action: "rewrite", mode: "condense" },
  { id: "expand_argument", tab: "local", action: "rewrite", mode: "expand" },
  { id: "proofread", tab: "local", action: "rewrite", mode: "proofread" },
  { id: "title_optimize", tab: "title", action: "title", mode: "title" },
  { id: "abstract_optimize", tab: "title", action: "title", mode: "abstract" },
  { id: "keywords_generate", tab: "title", action: "title", mode: "keywords" },
  { id: "citation_consistency_check", tab: "citation", action: "format_refs", mode: "consistency" },
  { id: "format_check", tab: "citation", action: "format_refs", mode: "format" },
];

async function runOne(b: (typeof BUTTONS)[number]) {
  // 选区类动作送一段选区文本 + 上下文(模拟真实前端)
  const isLocal = b.tab === "local";
  const text = isLocal ? "共同富裕是社会主义的本质要求。本文试图回答数字经济通过何种机制影响共同富裕。" : DOC;
  const context = isLocal ? "Context before selection:\n数字经济赋能共同富裕\n\n[SELECTION]\n" + text + "\n[/SELECTION]\n\nContext after selection:\n一、引言" : "";

  const t0 = Date.now();
  const cr = await fetch(`${BASE}/api/editor/v1/ai/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ action: b.action, text, context, mode: b.mode, language: "中文" }),
  });
  if (!cr.ok) return { id: b.id, ok: false, ms: Date.now() - t0, err: `create ${cr.status}` };
  const { job_id, model } = await cr.json();

  // 读 SSE, 收集 model 事件与 done
  const sres = await fetch(`${BASE}/api/editor/v1/ai/jobs/${job_id}/stream`, { headers: AUTH });
  const raw = await sres.text();
  let sseModel = "";
  let content = "";
  let errMsg = "";
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    const ev = /event:\s*(.+)/.exec(block)?.[1]?.trim();
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    const payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
    if (ev === "model") sseModel = payload?.model ?? "";
    else if (ev === "done") content = payload?.content ?? "";
    else if (ev === "error") errMsg = payload?.message ?? "";
  }
  return { id: b.id, ok: !!content && !errMsg, ms: Date.now() - t0, model, sseModel, chars: content.length, sample: content.replace(/\s+/g, " ").slice(0, 130), err: errMsg || undefined };
}

const results: any[] = [];
for (const b of BUTTONS) {
  process.stderr.write(`▶ ${b.id} ... `);
  try {
    const r = await runOne(b);
    results.push(r);
    process.stderr.write(`${r.ok ? "PASS" : "FAIL"} ${r.ms}ms model=${r.sseModel}\n`);
  } catch (e) {
    results.push({ id: b.id, ok: false, err: String(e) });
    process.stderr.write(`ERROR\n`);
  }
}

// 模型切换验证: 切到 deepseek-v4-pro → 新 job 的 model 应为 pro; 再切回 flash
const before = await (await fetch(`${BASE}/api/editor/v1/ai/model`, { headers: AUTH })).json();
await fetch(`${BASE}/api/editor/v1/ai/model`, { method: "PUT", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ modelId: "deepseek-v4-pro" }) });
const after = await (await fetch(`${BASE}/api/editor/v1/ai/model`, { headers: AUTH })).json();
const sw = await runOne({ id: "switch_probe", tab: "title", action: "title", mode: "keywords" });
await fetch(`${BASE}/api/editor/v1/ai/model`, { method: "PUT", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify({ modelId: "deepseek-v4-flash" }) });
const restored = await (await fetch(`${BASE}/api/editor/v1/ai/model`, { headers: AUTH })).json();

const out = {
  buttons: results,
  modelSwitch: {
    before: before.current,
    afterSwitch: after.current,
    jobModelAfterSwitch: sw.model,
    sseModelAfterSwitch: sw.sseModel,
    jobStillRan: sw.ok,
    restored: restored.current,
    ok: after.current === "deepseek-v4-pro" && sw.sseModel === "deepseek-v4-pro" && sw.ok && restored.current === "deepseek-v4-flash",
  },
};
console.log(JSON.stringify(out, null, 2));
const pass = results.filter((r) => r.ok).length;
console.error(`\n═══ 按钮 ${pass}/${results.length} PASS · 模型切换 ${out.modelSwitch.ok ? "PASS" : "FAIL"} ═══`);
