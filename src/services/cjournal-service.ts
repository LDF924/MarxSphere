// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// cjournal-service.ts — V395-20: 政经 C 刊科研服务
// 基于八篇马理论 C 刊选题方法论整合:
//   四步法选题(时代问题→政经对象→经典理论→中间机制) / 理论接口映射表
//   选题矩阵(核心概念×关系对象) / 悖论选题 / 编辑三标准校验 / 期刊匹配 / 2026布局种子库
import "dotenv/config";  // V395-22: 确保 .env 加载（getLlmEndpoint 依赖 LLM_API_KEY）
import { getRoleModel, resolveModelAlias } from "./llm-model-registry.js";
import { callLlm } from "../ai/llm-common.js";
/** 健壮 JSON 提取: 剥离 ```json 围栏/前后杂文本, 取首个 { 到末个 } */
function extractJson(text: string): string {
  const t = text.trim().replace(/```json|```/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return start !== -1 && end > start ? t.slice(start, end + 1) : t;
}


// ═══ 理论接口映射表（热点 → 经典理论，整合自七篇文章）═══
export const THEORY_INTERFACE_MAP: Array<{ hot: string; object: string; theory: string; example: string }> = [
  { hot: "人工智能", object: "劳动", theory: "马克思劳动过程理论/机器体系", example: "《人工智能时代劳动形态变迁的马克思主义政治经济学分析》" },
  { hot: "算力/算力网", object: "劳动资料", theory: "劳动资料理论/生产力理论", example: "《算力成为新型劳动资料的政治经济学阐释》" },
  { hot: "数据要素", object: "生产要素", theory: "生产要素理论/价值创造", example: "《数据要素参与新质生产力形成的政治经济学阐释》" },
  { hot: "数字经济", object: "生产方式", theory: "生产方式变革理论", example: "《数字经济时代马克思生产力理论的发展逻辑》" },
  { hot: "平台经济", object: "资本组织", theory: "资本逻辑批判/地租理论", example: "《平台资本主义时间规训的政治经济学批判》" },
  { hot: "数字劳动", object: "劳动控制/时间", theory: "剩余价值理论/自由时间理论", example: "《数字零工弹性劳动的自由时间现象：灵活性还是新剥削？》" },
  { hot: "算法", object: "劳动过程/治理", theory: "劳动过程理论/技术观", example: "《算法管理重构平台劳动时间的政治经济学逻辑》" },
  { hot: "耐心资本", object: "资本循环/期限结构", theory: "资本循环与周转理论", example: "《以耐心资本培育新质生产力的作用机制》" },
  { hot: "投资于人", object: "劳动力再生产", theory: "劳动力再生产/人的全面发展", example: "《投资于物和投资于人紧密结合的逻辑理路》" },
  { hot: "新质生产力", object: "生产力系统", theory: "马克思生产力理论", example: "《新质生产力形成中的劳动资料革命及其理论意义》" },
  { hot: "全国统一大市场", object: "社会再生产", theory: "社会总资本再生产理论", example: "《全国统一大市场畅通社会再生产循环的政治经济学逻辑》" },
  { hot: "未来产业", object: "社会分工", theory: "马克思分工理论", example: "《未来产业形成的马克思分工理论解释》" },
  { hot: "共同富裕", object: "分配关系", theory: "分配理论/人的全面发展", example: "《共同富裕的马克思主义政治经济学逻辑》" },
  { hot: "内卷式竞争", object: "资本竞争", theory: "资本竞争理论", example: "《新质生产力破解「内卷式」竞争的内在机理》" },
  { hot: "智能经济", object: "生产方式/主体性", theory: "生产方式变革/人的主体性", example: "《智能社会消费方式变迁的马克思主义政治经济学分析》" },
  // V395-33: 第三篇补充 — 资本批判与全球治理(趋势⑥)的资本新形态
  { hot: "AI资本", object: "资本新形态", theory: "资本积累理论/虚拟资本理论", example: "《AI资本的生成逻辑、增殖机制及其内在限度》" },
  { hot: "金融资本", object: "资本全球化", theory: "金融资本理论/世界市场理论", example: "《金融资本扩张与全球经济治理的马克思主义批判》" },
  { hot: "数字资本", object: "资本新形态", theory: "资本逻辑批判", example: "《数字资本的三重逻辑及其批判》" },
  // V395-36: 第六篇补充 — "十五五"规划国家战略热点
  { hot: "高水平社会主义市场经济体制", object: "制度体系", theory: "市场经济理论/基本经济制度", example: "《高水平社会主义市场经济体制的马克思主义政治经济学阐释》" },
  { hot: "区域联动", object: "区域发展", theory: "生产力布局理论/协调发展", example: "《区域联动发展的马克思主义生产力布局理论阐释》" },
  { hot: "智能经济新形态", object: "生产方式", theory: "生产方式变革理论", example: "《智能经济新形态的政治经济学分析》" },
];

// ═══ 2026 布局种子库（整合第三/四篇）═══
export const SEED_TOPICS = [
  "新质生产力发展的马克思主义生产力理论创新研究",
  "人工智能时代马克思劳动理论的发展逻辑",
  "数字生产力发展的马克思主义政治经济学阐释",
  "中国式现代化进程中生产力与生产关系协调发展的理论逻辑",
  "数字资本主义发展的马克思主义批判研究",
  "人工智能推动生产方式变革的历史唯物主义分析",
  "数据要素价值形成的马克思主义政治经济学解释",
  "智能社会中人的全面发展问题研究",
  "平台资本主义运行逻辑及其批判路径",
  "共同富裕的马克思主义政治经济学逻辑",
  "从机器大工业到人工智能：马克思生产力理论的时代发展逻辑",
  "数字劳动兴起与马克思劳动理论的时代价值",
  "技术异化批判视域下人工智能发展的风险及其超越",
  "马克思世界历史理论视域下中国式现代化道路创新研究",
  "人工智能资本化趋势及其内在矛盾分析",
  "人工智能驱动生产力系统质态跃迁的政治经济学逻辑",
  "全国一体化算力网重构社会生产力空间配置的作用机制",
  "数据要素参与新质生产力形成的政治经济学阐释",
  "智能经济新形态下生产方式变革的理论逻辑",
  "数智技术推动劳动资料智能化跃迁的马克思主义政治经济学分析",
  "算法资本的形成逻辑、增殖机制及其内在限度",
  "算力资本化及其价值实现机制的政治经济学分析",
  "平台资本控制劳动过程的新机制及其批判",
  "投资于人与人的全面发展的马克思主义政治经济学逻辑",
  "高质量发展的马克思主义发展理论创新研究",
];

// ═══ 期刊匹配（整合第六篇）═══
export const JOURNAL_PROFILES = [
  { name: "党校/社院学报", style: "统一战线、凝聚共识类主题", match: /统一战线|凝聚|共识|政协|统战/ },
  { name: "统一战线学C刊", style: "追热点", match: /统战|民族|共同体/ },
  { name: "东南学术", style: "学理化、理论纵深", match: /理论|范畴|逻辑/ },
  { name: "经济纵横", style: "经济热点、政策经济", match: /经济|生产力|资本|市场/ },
  { name: "《马克思主义研究》", style: "经典理论时代化、理论创新", match: /马克思|经典|理论/ },
  { name: "《思想理论教育导刊》", style: "思政教育、青年研究", match: /思政|教育|青年|意识形态/ },
];

/** V395-24: 学者库记录 */
export interface CjournalScholar {
  id: string;
  scholar: string;
  concept: string;
  method: string;
  detail: string;
  builtin: boolean;
  paradigm?: any;  // V395-25: 写作范式（提取后）
}

/** 内置 default 方法（不入库, 始终可用） */
const DEFAULT_METHOD: CjournalScholar = {
  id: "default",
  scholar: "综合四步法",
  concept: "时代问题×经典理论×中国实践×具体机制",
  method: "时代重大问题 × 经典理论资源 × 中国实践经验 × 新的机制解释",
  detail: "四步法选题公式：时代重大问题 × 经典理论资源 × 中国实践经验 × 新的机制解释。第一步找真正重要的时代问题（不要从我会什么理论开始）；第二步找到它改变的政治经济学对象（人工智能→劳动、数字经济→生产方式、算力→劳动资料、数据→生产要素、平台→资本组织）；第三步找到经典理论资源（资本论、劳动过程理论、社会再生产理论、资本循环理论、分工理论、地租理论等）；第四步提出自己的中间机制（A究竟通过什么机制改变B——最重要的一步，要回答具体机制而非「具有重要作用」）。",
  builtin: true,
};

/** 学者库缓存（60s 失效, 新增/修改后强制刷新） */
let scholarCache: CjournalScholar[] | null = null;
let scholarCacheAt = 0;

/** V395-25: 清空学者缓存（范式回填后调用） */
export function clearScholarCache(): void {
  scholarCache = null;
}

/** 加载全部学者（DB + default） */
export async function listScholars(force = false): Promise<CjournalScholar[]> {
  if (!force && scholarCache && Date.now() - scholarCacheAt < 60_000) return scholarCache;
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query("select * from cjournal_scholars order by builtin desc, created_at asc");
    scholarCache = [DEFAULT_METHOD, ...r.rows.map((row: any) => ({
      id: row.id, scholar: row.scholar, concept: row.concept,
      method: row.method, detail: row.detail, builtin: row.builtin,
      paradigm: row.paradigm || null,  // V395-25: 写作范式
    }))];
  } catch {
    scholarCache = [DEFAULT_METHOD];
  }
  scholarCacheAt = Date.now();
  return scholarCache;
}

/** 按 id 取方法（含 default） */
async function getMethodById(id: string | undefined): Promise<CjournalScholar> {
  const methods = await listScholars();
  return methods.find((m) => m.id === id) || DEFAULT_METHOD;
}

/** 新增/更新学者方法（id 重复则更新） */
export async function upsertScholar(input: { id: string; scholar: string; concept: string; method: string; detail?: string }): Promise<CjournalScholar> {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query(
    `insert into cjournal_scholars (id, scholar, concept, method, detail, builtin)
     values ($1, $2, $3, $4, $5, false)
     on conflict (id) do update set
       scholar = excluded.scholar, concept = excluded.concept,
       method = excluded.method, detail = excluded.detail
     returning *`,
    [input.id.trim(), input.scholar.trim(), input.concept.trim(), input.method.trim(), (input.detail || "").trim()]
  );
  scholarCache = null;  // 强制下次刷新
  return {
    id: r.rows[0].id, scholar: r.rows[0].scholar, concept: r.rows[0].concept,
    method: r.rows[0].method, detail: r.rows[0].detail, builtin: r.rows[0].builtin,
  };
}

/** 删除学者（内置不可删） */
export async function deleteScholar(id: string): Promise<{ ok: boolean; error?: string }> {
  if (id === "default") return { ok: false, error: "综合四步法不可删除" };
  const { pool } = await import("../db/pool.js");
  const r = await pool.query("select builtin from cjournal_scholars where id = $1", [id]);
  if (r.rows.length === 0) return { ok: false, error: "学者不存在" };
  if (r.rows[0].builtin) return { ok: false, error: "内置学者不可删除" };
  await pool.query("delete from cjournal_scholars where id = $1", [id]);
  scholarCache = null;
  return { ok: true };
}

/** 四步法选题：时代问题 → 政经对象 → 经典理论 → 中间机制（LLM 生成）
 * V395-21: ①加中国实践经验维度 ②支持三学者方法选择
 * V395-24: 学者方法从库动态加载（可添加新学者） */
export async function generateTopicFourStep(input: {
  hotTopic: string;
  theory?: string;
  method?: string;
  practice?: string;
}): Promise<{ topic: string; steps: Array<{ step: string; content: string }>; candidates: string[]; methodDetail: string; methodScholar: string; methodConcept: string }> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const interfaceHints = THEORY_INTERFACE_MAP
    .filter((t) => input.hotTopic.includes(t.hot) || t.hot.includes(input.hotTopic))
    .map((t) => `${t.hot}→${t.object}→${t.theory}`);
  // V395-24: 动态加载学者方法（DB + default）
  const methodInfo = await getMethodById(input.method);
  const methodHint = `${methodInfo.scholar}式（${methodInfo.concept}）：${methodInfo.method}`;
  const methodDetail = `【方法详解：${methodInfo.scholar} · ${methodInfo.concept}】\n${methodInfo.detail}`;
  const practiceHint = input.practice
    ? `\n中国实践场景（必须绑定）: ${input.practice}`
    : `\n中国实践场景（自动选择最贴合的具体实践，如 全国一体化算力网/全国统一大市场/共同富裕示范区/中国式现代化实践）`;
  const prompt = `你是马理论 C 刊选题专家。基于四步法生成政经论文选题：
选题风格：${methodHint}
${methodDetail}
第一步 时代问题：${input.hotTopic}
第二步 政经对象：它改变了什么？（如 AI→劳动、算力→劳动资料、数据→生产要素）${interfaceHints.length ? `\n已匹配理论接口: ${interfaceHints.join("; ")}` : ""}
第三步 经典理论：${input.theory || "自动选择最匹配的马克思经典理论（劳动过程/生产力/资本循环/社会再生产/地租/分工/自由时间等）"}
第四步 中国实践：${practiceHint}
第五步 中间机制：A 通过什么机制改变 B（最关键，须具体可论证）

输出 JSON:
{"topic":"最终选题标题（具体、有理论纵深、绑定中国实践、避免价值困境路径模板）","steps":[{"step":"第一步 时代问题","content":"30字内要点"},{"step":"第二步 政经对象","content":"30字内要点"},{"step":"第三步 经典理论","content":"30字内要点"},{"step":"第四步 中国实践","content":"30字内要点"},{"step":"第五步 中间机制","content":"60字内机制说明"}],"candidates":["3个备选题目(各20字内)"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 2500 });
  if (!r?.text) console.warn("[cjournal] LLM 返回空响应 (model=" + model + ")", r ? "text缺失" : "callLlm null");
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      topic: String(parsed.topic || ""),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: any) => ({ step: String(s.step || ""), content: String(s.content || "") })) : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
      // V395-23: 返回方法详解（前端详细呈现三学者方法论）
      methodDetail,
      methodScholar: methodInfo.scholar,
      methodConcept: methodInfo.concept,
    };
  } catch (e: any) {
    console.warn("[cjournal] JSON解析失败:", String(e?.message || e).slice(0, 80), "| raw:", (r?.text || "").slice(0, 100));
    return { topic: `${input.hotTopic}的马克思主义政治经济学分析`, steps: [], candidates: [], methodDetail, methodScholar: methodInfo.scholar, methodConcept: methodInfo.concept };
  }
}

/** V395-21: 概念命名 — 现实事件→典型现象→理论概念（"数字官僚主义"式命名能力） */
export async function generateConceptNaming(input: { phenomenon: string }): Promise<{
  concept: string;
  reasoning: string;
  candidates: string[];
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论选题专家。基于"给现象命名"方法（刘衍峰式）：
现实事件/现象: ${input.phenomenon}

做三步转换：现实事件 → 典型现象 → 理论概念
要求：概念有学术辨识度（如"数字官僚主义""被编程的日常""奥德赛时期""技术封建主义"），一看到标题就知道在解释什么新问题；能带出理论解释力（技术控制/行为引导/权力关系等）。

输出 JSON: {"concept":"核心理论概念","reasoning":"三步转换推导","candidates":["3个候选命名"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.4, maxTokens: 500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      concept: String(parsed.concept || ""),
      reasoning: String(parsed.reasoning || ""),
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
    };
  } catch { return { concept: "", reasoning: "", candidates: [] }; }
}

/** V395-21: 跨学科嫁接 — 马理论×经济×社会×公管×传播 选题空间 */
export async function generateCrossDisciplinary(input: { coreConcept: string }): Promise<{
  matrix: Array<{ discipline: string; topic: string }>;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论选题专家。基于"跨学科嫁接"方法（刘衍峰式）：
核心概念: ${input.coreConcept}

把核心概念与多个学科交叉嫁接（马理论×经济学×社会学×公共管理×传播学×数字技术），生成具体选题。
新问题往往产生在学科交叉地带（如 算法×中华民族共同体意识、数字平台×日常生活政治、新大众文艺×国际传播）。

输出 JSON: {"matrix":[{"discipline":"学科","topic":"具体题目（含理论接口）"}]} 共6-8项`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.4, maxTokens: 1500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      matrix: Array.isArray(parsed.matrix) ? parsed.matrix.map((m: any) => ({ discipline: String(m.discipline || ""), topic: String(m.topic || "") })) : [],
    };
  } catch { return { matrix: [] }; }
}

/** V395-21: 模板反例检测器 — 识别"价值意蕴/困境/路径"四段模板（只有新对象没有新问题） */
export function checkTopicTemplate(topic: string): {
  isTemplate: boolean;
  hits: string[];
  advice: string;
} {
  const TEMPLATE_PATTERNS = [
    { re: /价值意蕴|重要意义|时代价值/, label: "价值意蕴段" },
    { re: /现实困境|现实挑战|存在的问题|梗阻/, label: "困境段" },
    { re: /实践路径|对策|优化路径|路径选择|策略/, label: "路径段" },
    { re: /(?:赋能|推动|促进|助力)\S*(?:的)?(?:高质量发展|现代化|发展)/, label: "赋能句式" },
    { re: /^(?:新时代|新形势下)\S{2,10}(?:研究|探析|分析)$/, label: "宏大前缀" },
  ];
  const hits = TEMPLATE_PATTERNS.filter((p) => p.re.test(topic)).map((p) => p.label);
  const isTemplate = hits.length >= 2;
  return {
    isTemplate,
    hits,
    advice: isTemplate
      ? `⚠️ 题目落入模板化风险（命中: ${hits.join("、")}）。"只有新对象没有新问题"是 C 刊退稿主因。建议: ①把概念改为"关系型选题"（X如何改变Y）②加理论接口（马克思XX理论视域下）③加中间机制（通过什么机制）④用悖论句式（为什么A却B）`
      : hits.length === 1
        ? `⚠️ 轻微模板信号（命中: ${hits[0]}）。建议加理论接口或机制追问提升辨识度。`
        : "✅ 未命中模板模式，题目结构健康。",
  };
}

/** V395-21: 对象特殊性检验（小新学姐式）— 换掉研究对象小标题还成立 = 模板化 */
export async function checkObjectSpecificity(input: { topic: string; outline?: string }): Promise<{
  generic: boolean;
  assessment: string;
  specificFeatures: string[];
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是 C 刊审稿专家。对选题做"对象特殊性检验"：
选题: ${input.topic}
${input.outline ? `论文框架: ${input.outline}` : ""}

检验方法（小新学姐式）: 如果把研究对象换成另一个对象，小标题/框架基本还能成立，说明框架模板化不够深。
好的例子: 研究深地经济→应出现极端环境/地下通信/复杂地质/长周期投资；研究智算经济→异构算力/跨域调度/算力交易/绿电协同。

输出 JSON: {"generic":true/false,"assessment":"检验结论与理由","specificFeatures":["该对象应有的特殊性维度(3-5个, 写框架时可嵌入)"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      generic: !!parsed.generic,
      assessment: String(parsed.assessment || ""),
      specificFeatures: Array.isArray(parsed.specificFeatures) ? parsed.specificFeatures.map(String) : [],
    };
  } catch { return { generic: false, assessment: "", specificFeatures: [] }; }
}

/** V395-21: 外审意见翻译（小新学姐式）— 把审稿意见翻译成本质问题 */
export async function translateReviewComment(input: { comment: string }): Promise<{
  translation: string;
  action: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是资深投稿辅导。把 C 刊外审意见翻译成本质问题（小新学姐式）：
外审意见: ${input.comment}

翻译方法:
- "创新不足" → 你与现有研究到底有什么不同？（不是让你加一句"本文具有创新性"）
- "理论深度不够" → 你只有现象描述没有解释机制？（不是多引几句马克思）
- "问题意识不强" → 为什么现在需要研究这个？（重写引言和核心命题）
- 具体意见 → 说明值得继续救，逐条改

输出 JSON: {"translation":"意见翻译成的本质问题(为什么/凭什么/与别人相比多了什么/机制怎么发生)","action":"具体修改动作"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 400 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return { translation: String(parsed.translation || ""), action: String(parsed.action || "") };
  } catch { return { translation: "", action: "" }; }
}

/** V395-21: 稿件梯队管理（小新学姐式）— 分层管理在写/在改/在投/在审 */
export function manuscriptLadder(items: Array<{ title: string; stage: "writing" | "revising" | "submitting" | "reviewing" | "published"; tier: "impact" | "stable" | "stage" }>): {
  overview: string;
  counts: Record<string, number>;
  tips: string[];
} {
  const stageLabels: Record<string, string> = { writing: "在写", revising: "在改", submitting: "在投", reviewing: "在审", published: "已发" };
  const tierLabels: Record<string, string> = { impact: "冲击型", stable: "稳健型", stage: "阶段成果" };
  const counts: Record<string, number> = { writing: 0, revising: 0, submitting: 0, reviewing: 0, published: 0 };
  for (const it of items) counts[it.stage] = (counts[it.stage] || 0) + 1;
  const tips: string[] = [];
  if (counts.writing === 0) tips.push("建议保持「一篇在写」的节奏，避免稿件断档");
  if (counts.reviewing === 0 && counts.submitting > 0) tips.push("有稿件在投但无在审，可准备下一轮投稿或跟进");
  if (!items.some((i) => i.tier === "impact")) tips.push("缺少冲击型稿件（代表作意识）— 建议安排一两篇冲更高水平 C 刊，问题更重要/理论更扎实/机制更清楚");
  if (items.filter((i) => i.tier === "stage").length > 2) tips.push("阶段成果偏多，注意向稳定型/冲击型升级");
  const overview = `稿件梯队: 在写${counts.writing} · 在改${counts.revising} · 在投${counts.submitting} · 在审${counts.reviewing} · 已发${counts.published}`;
  return { overview, counts, tips };
}

/** 悖论选题："为什么 A 却 B" 式问题生成 */
export async function generateParadoxTopic(input: { phenomenon: string }): Promise<{ paradox: string; topic: string }> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论选题专家。基于"悖论即问题"方法：
现象: ${input.phenomenon}
生成一个"为什么A却B"式悖论问题（如：技术越先进人反而越受控制？平台提供自由劳动却导致新不自由？），并据此给出一个具体论文题目（有张力、有理论接口）。

输出 JSON: {"paradox":"悖论问题","topic":"论文题目"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.4, maxTokens: 400 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return { paradox: String(parsed.paradox || ""), topic: String(parsed.topic || "") };
  } catch { return { paradox: "", topic: "" }; }
}

/** 选题矩阵：核心概念 × 关系对象 → 系列选题（LLM 扩展 + 内置对象库） */
export async function generateTopicMatrix(input: { coreConcept: string }): Promise<{
  matrix: Array<{ dimension: string; topic: string }>;
  motherTopic: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const baseObjects = ["劳动", "时间", "消费", "文化", "治理", "生产力", "主体性", "资本"];
  const prompt = `你是马理论科研规划专家。围绕核心概念"${input.coreConcept}"生成选题矩阵（刘衍峰式连续开发）：
- 母题：一句话概括研究主线（如 "数字技术—资本逻辑—劳动控制—时间规训"）
- 矩阵：核心概念 × 关系对象 → 系列论文题目（6-8个, 每个都具体有理论接口）

输出 JSON: {"motherTopic":"母题","matrix":[{"dimension":"关系对象","topic":"具体题目"}]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 800 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      motherTopic: String(parsed.motherTopic || ""),
      matrix: Array.isArray(parsed.matrix) ? parsed.matrix.map((m: any) => ({ dimension: String(m.dimension || ""), topic: String(m.topic || "") })) : [],
    };
  } catch {
    // 兜底: 内置对象库
    return { motherTopic: `${input.coreConcept}—资本逻辑—社会关系`, matrix: baseObjects.map((o) => ({ dimension: o, topic: `${input.coreConcept}与${o}的马克思主义政治经济学分析` })) };
  }
}

/** 编辑三标准校验（整合第五篇） */
export async function validateByEditorStandards(input: { topic: string }): Promise<{
  checks: Array<{ standard: string; passed: boolean; feedback: string }>;
  verdict: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是 C 刊编辑。用三条标准评估选题"${input.topic}"：
1. 时代紧迫性：为什么现在需要研究？(通过=有明显时代背景/政策/新现象)
2. 理论解释力：现有理论能否解释新变化？(通过=有明确的马克思主义理论接口)
3. 现实指导价值：能解决什么现实问题？(通过=有明确现实指向)

输出 JSON: {"checks":[{"standard":"时代紧迫性","passed":true/false,"feedback":"..."}],"verdict":"总体评价(通过/需调整/不建议)"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      checks: Array.isArray(parsed.checks) ? parsed.checks.map((c: any) => ({ standard: String(c.standard || ""), passed: !!c.passed, feedback: String(c.feedback || "") })) : [],
      verdict: String(parsed.verdict || ""),
    };
  } catch { return { checks: [], verdict: "" }; }
}

// ══════════════════════════════════════════════════════════════════
// V395-33: 马原理 C 刊选题六大趋势（第三篇方法论完整落地）
// 六趋势 + 三条选题规律 + 2026 布局清单(5重点+5关注)
// ══════════════════════════════════════════════════════════════════

/** 六趋势静态数据（趋势卡展示 + 生成 prompt 构建） */
export const MARX_TREND_SYSTEM = {
  trends: [
    { id: "classic", key: 1, title: "经典理论时代化", desc: "从文本阐释→理论创新：经典理论 × 数字革命/科技革命", example: "马克思生产力理论 × 新质生产力", prompt: "经典理论时代化：把马克思经典理论（生产力/劳动/剩余价值/再生产等）与当代数字革命、科技革命结合，做理论创新而非文本阐释。输出含经典理论接口与时代化创新点。" },
    { id: "new-quality", key: 2, title: "新质生产力增长点", desc: "回答『如何体现生产力理论发展』而非解释概念", example: "新质生产力 × 生产关系适应性变革", prompt: "新质生产力增长点：不解释新质生产力概念本身，而是回答『新质生产力如何体现马克思生产力理论的时代发展』——聚焦生产力与生产关系的适应性变革、劳动资料革命、劳动者素质跃迁等具体机制。" },
    { id: "digital", key: 3, title: "数字革命推动政经创新", desc: "数据/算法/平台/数字劳动四问", example: "数字生产力政经阐释", prompt: "数字革命推动政经创新：围绕数据要素、算法、平台经济、数字劳动四大对象各提出核心问题，做马克思主义政治经济学的新阐释（数据价值/算法资本/平台垄断/数字劳动剥削）。" },
    { id: "ai-future", key: 4, title: "人工智能与未来社会", desc: "技术革命如何影响人的发展/劳动方式/社会结构", example: "AI历史唯物主义阐释、AI时代主体性", prompt: "人工智能与未来社会：从历史唯物主义视角阐释 AI 如何改变劳动方式、人的发展与社会结构——AI 时代的主体性问题、劳动解放与异化、技术封建主义批判。" },
    { id: "chinese-modern", key: 5, title: "中国式现代化稳定方向", desc: "现代化理论创新/共同富裕/高质量发展/国家治理", example: "共同富裕政经逻辑", prompt: "中国式现代化稳定方向：聚焦现代化理论创新、共同富裕、高质量发展、国家治理现代化四个方向的马克思主义政治经济学阐释，绑定中国实践。" },
    { id: "capital-critique", key: 6, title: "资本批判与全球治理", desc: "聚焦资本新形态（数字/平台/金融/AI资本）", example: "数字资本主义批判", prompt: "资本批判与全球治理：聚焦资本新形态（数字资本/平台资本/金融资本/AI资本）的形成逻辑、增殖机制与内在限度，以及全球治理中的资本批判。" },
  ],
  laws: [
    { title: "经典理论 + 时代问题是 C 刊选题基本盘", desc: "理论接口是入场券, 时代问题提供必要性——两者缺一不可（与第二篇刘衍峰'始终连接经典理论'呼应）" },
    { title: "解释关系优于解释概念", desc: "两个变量之间的关系与机制才是论文, 单一概念解释易落入模板（与第二篇'热点之间的关系才是论文'呼应）" },
    { title: "批判视角提供辨识度", desc: "资本批判/技术批判视角让选题有立场与深度, 避免纯粹描述（与'矛盾感/张力即问题'呼应）" },
  ],
  layout2026: {
    focus: [
      "新质生产力与马克思生产力理论创新",
      "人工智能时代马克思劳动理论的发展",
      "数字生产力与马克思主义政治经济学新阐释",
      "中国式现代化与马克思主义现代化理论",
      "数字资本主义批判与资本新形态治理",
    ],
    watch: [
      "数据要素价值创造与分配",
      "智能社会人的全面发展与主体性",
      "平台资本运行逻辑与治理",
      "共同富裕与分配正义",
      "金融资本扩张与全球经济治理",
    ],
  },
};

/** 六趋势选题生成：选趋势 → 输入热点 → 按趋势专属 prompt 生成 */
export async function generateTrendTopic(input: { trendId: string; hotTopic: string }): Promise<{
  trendTitle: string;
  topic: string;
  reasoning: string;
  steps: Array<{ step: string; content: string }>;
  candidates: string[];
}> {
  const trend = MARX_TREND_SYSTEM.trends.find((t) => t.id === input.trendId) || MARX_TREND_SYSTEM.trends[0];
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马原理 C 刊选题专家。基于"${trend.title}"（马原理 C 刊选题六大趋势之${trend.key}）生成选题：
趋势要领: ${trend.prompt}
热点/方向: ${input.hotTopic}
代表选题风格: ${trend.example}

要求:
1. 从"解释概念"升级为"解释关系与机制"（A通过什么机制改变B）
2. 必须挂接明确的理论接口（马克思经典理论）
3. 题目具体有张力, 避免"价值/困境/路径"模板
4. 绑定中国实践或当代现实场景

输出 JSON: {"topic":"论文题目(20-35字)","reasoning":"选题理由(60字内)","steps":[{"step":"趋势定位","content":"该趋势下的选题方向"},{"step":"理论接口","content":"挂接的经典理论"},{"step":"关系机制","content":"A如何通过机制改变B"},{"step":"现实绑定","content":"中国实践/当代场景"}],"candidates":["3个备选题目"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 1200 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      trendTitle: trend.title,
      topic: String(parsed.topic || ""),
      reasoning: String(parsed.reasoning || ""),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: any) => ({ step: String(s.step || ""), content: String(s.content || "") })) : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
    };
  } catch { return { trendTitle: trend.title, topic: "", reasoning: "", steps: [], candidates: [] }; }
}

// ══════════════════════════════════════════════════════════════════
// V395-35: C 刊编辑视角选题六法（第五篇方法论完整落地）
// 六法 + 三标准; 整合策略: ⑥三标准→复用编辑校验tab, ⑤连续性→复用主线/系列延伸,
// ③经典×实践→复用四步法/理论接口表; 新做 ①②④ 生成器 + 六法总览(带复用跳转)
// ══════════════════════════════════════════════════════════════════

/** 编辑视角六法静态数据（六法总览 + 复用工具映射） */
export const EDITOR_SYSTEM = {
  methods: [
    {
      id: "question-first", key: 1, title: "从'时代问题'出发, 非'我想研究'",
      core: "追问而非宽泛——题目必须指向一个时代问题而非一个领域",
      example: "《人工智能发展研究》→《AI时代劳动形态变迁的政治经济学分析》",
      reuse: null,  // 全新: 追问式生成
    },
    {
      id: "national-proposition", key: 2, title: "国家重大命题找理论空间",
      core: "中国式现代化等重大命题背后必有理论问题, 找到它",
      example: "《中国式现代化路径研究》→《人的全面发展视域下中国式现代化的价值逻辑》",
      reuse: null,  // 全新: 重大命题理论空间生成
    },
    {
      id: "classic-practice", key: 3, title: "经典理论×新时代实践结合处",
      core: "用经典回应时代——新质生产力→生产力理论、AI→劳动理论、数字技术→技术观",
      example: "新质生产力 → 生产力理论、AI → 劳动理论",
      reuse: { tab: "fourstep", label: "四步法选题", desc: "输入热点→自动挂接理论接口（第三步经典理论）" },
    },
    {
      id: "policy-to-theory", key: 4, title: "政策热点→理论问题（非政策解读）",
      core: "政策→理论问题→论文三段推演: 政策话语→理论追问→论文命题",
      example: "'AI推动产业升级'→'AI是否改变生产力规律'→论文",
      reuse: null,  // 全新: 政策三段推演
    },
    {
      id: "continuity", key: 5, title: "连续性选题（不换方向）",
      core: "围绕核心方向系列深化——数字赋能城乡→数据要素区域→AI新质生产力→智能社会人的发展",
      example: "数字赋能城乡 → 数据要素区域 → AI新质生产力 → 智能社会人的发展",
      reuse: { tab: "research-line", label: "研究主线", desc: "母题+子问题链条" },
    },
    {
      id: "editor-standards", key: 6, title: "编辑三标准",
      core: "时代紧迫性 × 理论解释力 × 现实指导价值",
      example: "为什么现在研究 / 能否解释新变化 / 解决什么现实问题",
      reuse: { tab: "validate", label: "编辑校验", desc: "三标准自动打分" },
    },
  ],
  standards: [
    { name: "时代紧迫性", question: "为什么现在研究这个？", pass: "有明显时代背景/政策/新现象" },
    { name: "理论解释力", question: "现有理论能否解释新变化？", pass: "有明确的马克思主义理论接口" },
    { name: "现实指导价值", question: "能解决什么现实问题？", pass: "有明确现实指向" },
  ],
};

/** 编辑视角选题生成：选方法(①②④) → 输入 → 按该方法生成
 * ③⑤⑥ 复用现有工具(前端跳转), 此生成器只处理 ①②④ */
export async function generateEditorTopic(input: { methodId: string; topic: string }): Promise<{
  methodTitle: string;
  topic: string;
  reasoning: string;
  steps: Array<{ step: string; content: string }>;
  candidates: string[];
}> {
  const method = EDITOR_SYSTEM.methods.find((m) => m.id === input.methodId);
  const model = resolveModelAlias(getRoleModel("plan"));
  // 三种方法的专属 prompt
  const PROMPTS: Record<string, string> = {
    "question-first": `你是 C 刊编辑视角的选题顾问。基于"从时代问题出发, 非'我想研究'"方法:
输入(宽泛/领域式): ${input.topic}
要领: 追问而非宽泛——把"我想研究X"改写为"X背后/之中的时代问题是什么"。宽泛题目没有审稿人想读的问题。
步骤: ①识别输入中的领域/对象 ②追问: 这个领域当下正在发生的时代问题/新变化是什么 ③把问题转化为"对象×新变化×理论接口"的具体题目（示例: 人工智能发展研究→AI时代劳动形态变迁的政治经济学分析）
输出 JSON: {"topic":"追问后的具体题目(20-35字)","reasoning":"追问过程(60字内)","steps":[{"step":"领域识别","content":"..."},{"step":"时代追问","content":"..."},{"step":"问题转化","content":"..."}],"candidates":["3个备选"]}`,
    "national-proposition": `你是 C 刊编辑视角的选题顾问。基于"国家重大命题找理论空间"方法:
输入(重大命题/政策表述): ${input.topic}
要领: 重大命题(中国式现代化/共同富裕/高质量发展等)背后必有理论空间——找到它并建立理论接口。不是政策解读, 而是用马克思主义理论揭示命题的学理基础。
步骤: ①识别重大命题 ②追问: 它的理论基础问题是什么(人的发展/生产方式/分配正义/国家与市场等) ③建立命题×理论的接口并具体化（示例: 中国式现代化路径研究→人的全面发展视域下中国式现代化的价值逻辑）
输出 JSON: {"topic":"理论空间化的题目(20-35字)","reasoning":"理论空间识别(60字内)","steps":[{"step":"命题识别","content":"..."},{"step":"理论追问","content":"..."},{"step":"接口建构","content":"..."}],"candidates":["3个备选"]}`,
    "policy-to-theory": `你是 C 刊编辑视角的选题顾问。基于"政策热点→理论问题"三段推演方法:
输入(政策热点/政策话语): ${input.topic}
要领: 政策话语→理论问题→论文命题 三段推演。政策提供问题线索, 理论提供分析框架, 论文回答理论问题（示例: "AI推动产业升级"→"AI是否改变生产力规律"→论文）。
步骤: ①提取政策话语中的核心断言 ②把断言转化为理论问题(是否改变规律/机制/关系?) ③将理论问题写成论文题目
输出 JSON: {"topic":"论文题目(20-35字)","reasoning":"三段推演过程(60字内)","steps":[{"step":"政策话语","content":"..."},{"step":"理论问题","content":"..."},{"step":"论文命题","content":"..."}],"candidates":["3个备选"]}`,
  };
  const prompt = PROMPTS[input.methodId] || PROMPTS["question-first"];
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 1200 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      methodTitle: method?.title || "",
      topic: String(parsed.topic || ""),
      reasoning: String(parsed.reasoning || ""),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: any) => ({ step: String(s.step || ""), content: String(s.content || "") })) : [],
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
    };
  } catch { return { methodTitle: method?.title || "", topic: "", reasoning: "", steps: [], candidates: [] }; }
}

// ══════════════════════════════════════════════════════════════════
// V395-36: C 刊投稿五条军规（第六篇方法论完整落地）
// ①守住主线 ②回应国家战略(十五五) ③小切口深研 ④新视角 ⑤匹配期刊
// 整合: ③复用尺度检验tab, ⑤复用参考数据tab(期刊画像); 新做 ①②④ 生成器 + 军规总览
// ══════════════════════════════════════════════════════════════════

/** 五条军规静态数据（总览 + 复用映射） */
export const RULES_SYSTEM = {
  rules: [
    {
      id: "mainline", key: 1, title: "守住主线",
      core: "马克思主义中国化时代化、'两个结合''六个必须坚持'核心范畴, 不偏离主流框架",
      example: "选题落点在主流范畴体系内, 但可用新现象激活它",
      reuse: null,  // 全新: 主线体检
    },
    {
      id: "national-strategy", key: 2, title: "回应国家战略（'十五五'）",
      core: "期刊要生存, 优先录用'理论解释现实、现实反哺理论'——能带来下载量引用量的选题",
      example: "高水平社会主义市场经济体制 / 未来产业 / 区域联动 / 智能经济新形态",
      reuse: null,  // 全新: 国家战略生成
    },
    {
      id: "small-incision", key: 3, title: "小切口深研",
      core: "聚焦一个核心概念/实践场景/政策, '小题大做、以小见大'",
      example: "全国统一大市场的法治建设（切口小而深）",
      reuse: { tab: "scope", label: "尺度检验", desc: "做窄做深, 不做大体系" },
    },
    {
      id: "new-angle", key: 4, title: "要有新视角",
      core: "人文经济学标识性概念 / 中国人经济的人民性 / 数智时代领导力建设",
      example: "用新概念/新视角重构老问题",
      reuse: null,  // 全新: 新视角生成
    },
    {
      id: "journal-match", key: 5, title: "匹配目标期刊",
      core: "党校/社院学报偏统一战线、统一战线学C刊追热点、东南学术偏学理化、经济纵横偏经济热点",
      example: "投稿前先匹配期刊定位与口味",
      reuse: { tab: "reference", label: "接口·期刊·种子", desc: "期刊画像表 + 投稿匹配" },
    },
  ],
  nationalStrategy: [
    { name: "高水平社会主义市场经济体制", theory: "市场经济理论/基本经济制度" },
    { name: "未来产业", theory: "马克思分工理论" },
    { name: "区域联动", theory: "生产力布局理论/协调发展" },
    { name: "智能经济新形态", theory: "生产方式变革理论" },
  ],
  mainlineCore: {
    zhuhu: ["马克思主义中国化时代化", "两个结合", "六个必须坚持"],
    desc: "守住主线 = 选题落点在主流范畴体系内, 但不等于口号化——用新现象、新机制激活核心范畴, 实现'理论解释现实、现实反哺理论'的双向循环。",
  },
};

/** 军规①主线体检: 输入题目 → 检查是否偏离主流框架 → 给出主线定位与激活建议 */
export async function checkMainline(input: { topic: string }): Promise<{
  onMainline: boolean;
  assessment: string;
  coreCategory: string;    // 命中的核心范畴
  activation: string;      // 激活建议(如何用新现象激活)
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论 C 刊投稿顾问。对选题做"主线体检"：
选题: ${input.topic}

守住主线的含义: 马克思主义中国化时代化、"两个结合"（马克思主义基本原理同中国具体实际、同中华优秀传统文化相结合）、"六个必须坚持"（人民至上/自信自立/守正创新/问题导向/系统观念/胸怀天下）等核心范畴。
体检标准:
1. 是否偏离主流框架（纯西方理论无中国化转换/脱离时代化语境/纯技术描述无价值立场）
2. 命中的核心范畴是什么（可多个）
3. 如何用新现象激活核心范畴（主线不偏离 + 选题有新意 = 双向循环）

输出 JSON: {"onMainline":true/false,"assessment":"体检结论(60字内)","coreCategory":"命中的核心范畴(如: 守正创新+问题导向)","activation":"激活建议(50字内)"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      onMainline: !!parsed.onMainline,
      assessment: String(parsed.assessment || ""),
      coreCategory: String(parsed.coreCategory || ""),
      activation: String(parsed.activation || ""),
    };
  } catch { return { onMainline: true, assessment: "", coreCategory: "", activation: "" }; }
}

/** 军规②国家战略生成: "十五五"热点 × 理论接口 → 双向循环选题 */
export async function generateNationalStrategy(input: { strategy: string; phenomenon?: string }): Promise<{
  strategy: string;
  theory: string;
  topic: string;
  bidirectional: string;   // 理论解释现实 + 现实反哺理论 双向
  candidates: string[];
}> {
  const st = RULES_SYSTEM.nationalStrategy.find((s) => s.name === input.strategy) || { name: input.strategy, theory: "（自动匹配经典理论）" };
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论 C 刊投稿顾问。基于"回应国家战略"军规生成"十五五"选题：
战略热点: ${st.name}
理论接口: ${st.theory}
${input.phenomenon ? `结合的具体现象: ${input.phenomenon}` : "（自动选择该战略下的具体实践场景）"}

核心要领（期刊录用逻辑）: "理论解释现实、现实反哺理论"双向循环——论文要能带来下载量与引用量。不是政策解读, 而是用马克思主义理论解释战略的现实机制, 并从现实中提炼理论新意。

输出 JSON: {"topic":"选题题目(20-35字)","bidirectional":"理论解释现实什么+现实反哺理论什么(60字内)","candidates":["3个备选"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 900 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      strategy: st.name,
      theory: st.theory,
      topic: String(parsed.topic || ""),
      bidirectional: String(parsed.bidirectional || ""),
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
    };
  } catch { return { strategy: st.name, theory: st.theory, topic: "", bidirectional: "", candidates: [] }; }
}

/** 军规④新视角生成: 输入老问题 → 用新视角重构 */
export async function generateNewAngle(input: { topic: string }): Promise<{
  angle: string;        // 新视角名称
  source: string;       // 视角来源(人文经济学/人民性/数智时代等)
  topic: string;        // 重构后的题目
  reasoning: string;
  candidates: string[];
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论 C 刊投稿顾问。基于"要有新视角"军规, 为老问题找新视角：
老问题/老选题: ${input.topic}

新视角来源示例: 人文经济学标识性概念（人文经济学/人民经济学/幸福经济学）、中国人经济的人民性、数智时代领导力建设、治理现代化等。新视角 = 用新的概念框架/价值立场/时代语境重构老问题, 让审稿人眼前一亮。
步骤: ①识别老问题的常规视角 ②选择/创造新视角（有理论纵深+现实指向） ③用新视角重构题目

输出 JSON: {"angle":"新视角名称(10字内)","source":"视角来源(15字内)","topic":"重构后的题目(20-35字)","reasoning":"重构理由(50字内)","candidates":["3个备选"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.4, maxTokens: 900 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      angle: String(parsed.angle || ""),
      source: String(parsed.source || ""),
      topic: String(parsed.topic || ""),
      reasoning: String(parsed.reasoning || ""),
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
    };
  } catch { return { angle: "", source: "", topic: "", reasoning: "", candidates: [] }; }
}

// ══════════════════════════════════════════════════════════════════
// V395-34: 《马克思主义研究》经典马研究六大方向（第四篇方法论完整落地）
// 核心转向: 从"马克思说了什么"(文本阐释) → "马克思主义能解释什么"(时代化转化/现实价值)
// 六方向传统写法→深化写法对照 + 18选题 + 转向诊断 + 方向深化生成
// ══════════════════════════════════════════════════════════════════

/** 经典马研究六方向静态数据（传统写法 → 深化写法对照） */
export const CLASSIC_MARX_SYSTEM = {
  coreShift: {
    from: "马克思说了什么（文本阐释）",
    to: "马克思主义能解释什么（时代化转化/现实价值）",
    desc: "《马克思主义研究》26年第7期的核心转向：不满足于复述经典，而是用马克思主义理论资源解释当代新现象——选题的价值在于'解释力'而非'忠实度'。",
  },
  directions: [
    {
      id: "productive-force", key: 1, title: "生产力理论 × 新质生产力", importance: "重点",
      traditional: "马克思生产力理论研究",
      deep: "新质生产力形成逻辑——劳动资料革命/劳动者跃迁/生产关系适应性变革",
      examples: ["从机器大工业到人工智能：马克思生产力理论的时代发展逻辑", "新质生产力形成中的劳动资料革命及其理论意义", "数据要素参与新质生产力形成的政治经济学阐释"],
    },
    {
      id: "labor-ai", key: 2, title: "劳动理论 × AI 劳动变革", importance: "重点",
      traditional: "劳动价值论研究",
      deep: "劳动形态变迁——数字劳动/算法管理/劳动过程重构/剩余价值新形式",
      examples: ["数字劳动兴起与马克思劳动理论的时代价值", "算法管理重构平台劳动时间的政治经济学逻辑", "人工智能时代劳动形态变迁的马克思主义政治经济学分析"],
    },
    {
      id: "capital-digital", key: 3, title: "资本批判 × 数字资本", importance: "潜力最大",
      traditional: "资本批判思想研究",
      deep: "数字资本扩张批判——数据垄断/平台地租/算力殖民/资本新形态",
      examples: ["平台经济中的资本逻辑及其超越路径", "数字资本的三重逻辑及其批判", "AI资本的数据殖民机制与全球算力秩序重构"],
    },
    {
      id: "technology-governance", key: 4, title: "技术思想 × 智能社会治理", importance: "重点",
      traditional: "马克思技术观研究",
      deep: "AI 治理价值逻辑——技术异化/技术乌托邦/智能社会风险治理",
      examples: ["技术异化批判视域下人工智能发展的风险及其超越", "算法治理的马克思主义技术批判", "智能社会治理中的价值排序与制度安排"],
    },
    {
      id: "human-dev", key: 5, title: "人的全面发展 × 智能社会", importance: "重点",
      traditional: "人的发展理论研究",
      deep: "智能社会主体性——劳动解放/自由时间/数字主体性/人的发展新形态",
      examples: ["智能社会背景下人的全面发展的马克思主义理论阐释", "数字零工自由时间与人的发展的张力", "人工智能时代人的主体性重构"],
    },
    {
      id: "world-history", key: 6, title: "世界历史理论 × 中国式现代化", importance: "稳定",
      traditional: "世界历史理论研究",
      deep: "中国式现代化道路创新——人类文明新形态/现代化理论的中国化",
      examples: ["马克思世界历史理论视域下中国式现代化道路创新研究", "人类文明新形态的世界历史意蕴", "中国式现代化对马克思世界历史理论的发展"],
    },
  ],
  laws: [
    { title: "经典理论 + 时代问题", desc: "理论的解释力在时代问题中显现（与前两篇完全一致）" },
    { title: "理论分析 + 中国实践", desc: "分析框架来自马克思, 经验材料来自中国实践" },
    { title: "宏大主题 + 具体机制", desc: "主题可宏大, 落点必须具体机制（避免体系建构式空泛）" },
  ],
};

/** 转向诊断：输入题目 → 判断是否停留在"文本阐释" → 给出时代化深化方向
 * 这是第四篇的核心价值: 从"马克思说了什么"→"马克思主义能解释什么" */
export async function diagnoseClassicTopic(input: { topic: string }): Promise<{
  stillExegesis: boolean;      // 是否仍停留在文本阐释
  signal: string;              // 诊断信号
  deepVersion: string;         // 深化后的题目
  mechanism: string;           // 应回答的具体机制
  matchedDirection: string;    // 命中的六大方向
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  // 规则信号: 文本阐释式题目的典型句式
  const EXEGESIS_PATTERNS = [
    { re: /^(?:马克思|马克思主义|经典作家)\S{2,14}(?:思想|理论|观点)$/, label: "直接研究'马克思XX思想/理论'——纯文本阐释" },
    { re: /(?:思想|理论|观点|概念)(?:研究|探析|解读|阐释|析论|疏证)$/, label: "'XX思想研究'式——停在理论内部" },
    { re: /(?:再解读|再阐释|重读|文本)(?:研究|解读|阐释|考察)?$/, label: "重读/文本式——忠实度导向" },
    { re: /^(?:浅析|浅论|试析|简论)/, label: "浅析/试论式——深度不足" },
  ];
  const signal = EXEGESIS_PATTERNS.filter((p) => p.re.test(input.topic)).map((p) => p.label);
  const prompt = `你是《马克思主义研究》选题顾问。判断选题"${input.topic}"是否还停留在"马克思说了什么"(文本阐释), 并给出"马克思主义能解释什么"(时代化转化)的深化版本。
${signal.length ? `已命中文本阐释信号: ${signal.join("; ")}` : "未命中明显信号, 仍需专业判断。"}

核心转向: 从文本阐释 → 时代化转化/现实价值。深化写法 = 经典理论 × 当代新现象 × 具体机制（如: 马克思生产力理论研究 → 新质生产力形成逻辑; 资本批判思想研究 → 数字资本扩张批判）。

输出 JSON: {"stillExegesis":true/false,"signal":"诊断信号(40字内)","deepVersion":"深化后的题目(20-35字)","mechanism":"应回答的具体机制(50字内)","matchedDirection":"命中的方向(生产力理论/劳动理论/资本批判/技术思想/人的发展/世界历史)"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 600 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      stillExegesis: !!parsed.stillExegesis,
      signal: String(parsed.signal || ""),
      deepVersion: String(parsed.deepVersion || ""),
      mechanism: String(parsed.mechanism || ""),
      matchedDirection: String(parsed.matchedDirection || ""),
    };
  } catch {
    return {
      stillExegesis: signal.length > 0,
      signal: signal.join("; ") || "",
      deepVersion: "",
      mechanism: "",
      matchedDirection: "",
    };
  }
}

/** 方向深化生成：选方向 → 输入当代现象 → 按该方向的深化写法生成选题 */
export async function generateClassicDirection(input: { directionId: string; phenomenon: string }): Promise<{
  directionTitle: string;
  deepApproach: string;
  topic: string;
  reasoning: string;
  candidates: string[];
}> {
  const dir = CLASSIC_MARX_SYSTEM.directions.find((d) => d.id === input.directionId) || CLASSIC_MARX_SYSTEM.directions[0];
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是《马克思主义研究》选题专家。基于"${dir.title}"方向（${dir.importance}）生成深化选题：
传统写法(不要): ${dir.traditional}
深化写法(要): ${dir.deep}
当代现象: ${input.phenomenon}

核心转向: 从"马克思说了什么"→"马克思主义能解释什么"。要求: 经典理论做分析框架, 当代现象做解释对象, 给出具体机制而非套概念。

输出 JSON: {"topic":"深化题目(20-35字)","reasoning":"为什么这样深化(50字内)","candidates":["3个备选题目"]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 900 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      directionTitle: dir.title,
      deepApproach: dir.deep,
      topic: String(parsed.topic || ""),
      reasoning: String(parsed.reasoning || ""),
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates.map(String) : [],
    };
  } catch { return { directionTitle: dir.title, deepApproach: dir.deep, topic: "", reasoning: "", candidates: [] }; }
}

// ══════════════════════════════════════════════════════════════════
// V395-31: 刘衍峰式选题方法系统（第二篇方法论完整落地）
// 7 大特征 + 5 种思路 + 选题生产系统 + 关键告诫
// ══════════════════════════════════════════════════════════════════

/** 特征① 关系型选题 — 追政策但不止于政策解释: 热点 A × 热点 B → 关系即论文
 * 从"解释概念"升级为"解释两变量关系"（新质生产力×内卷式竞争） */
export async function generateRelationalTopic(input: { hotA: string; hotB?: string }): Promise<{
  relation: string;        // 两变量关系命题
  topic: string;           // 论文题目（含理论接口）
  mechanism: string;       // 中间机制
  steps: Array<{ step: string; content: string }>;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const hotB = input.hotB || "（自动从热点库中选一个与之有张力的热点 B, 如: 新质生产力×内卷式竞争、数字乡村×要素流动、耐心资本×风险偏好）";
  const prompt = `你是马理论 C 刊选题专家。基于"追政策但不止于政策解释"方法（刘衍峰式）:
热点 A: ${input.hotA}
热点 B: ${hotB}

核心要领: 只解释一个热点 = "价值、困境与路径"模板（必死）。热点的关系才是论文——从"解释概念"升级为"解释两变量关系"。
步骤:
1. 找到热点 A 与热点 B 之间的真实关系（冲突/互构/张力/因果机制, 如"新质生产力如何破解内卷式竞争"）
2. 把关系命题化为可论证的研究问题（A 通过什么机制改变 B）
3. 挂接经典理论接口（资本竞争/生产力/劳动过程/社会再生产等马克思理论）
4. 给出具体中间机制（不是"具有重要作用", 要可操作可检验）

输出 JSON: {"relation":"两变量关系命题(20字内)","mechanism":"中间机制(60字内)","topic":"论文题目(含理论接口与机制)","steps":[{"step":"热点关系","content":"..."},{"step":"理论接口","content":"..."},{"step":"中间机制","content":"..."}]}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 1200 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      relation: String(parsed.relation || ""),
      topic: String(parsed.topic || ""),
      mechanism: String(parsed.mechanism || ""),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: any) => ({ step: String(s.step || ""), content: String(s.content || "") })) : [],
    };
  } catch { return { relation: "", topic: "", mechanism: "", steps: [] }; }
}

/** 特征③ 研究主线设计 — 稳定研究主线: 一个母题 + 子问题链条
 * 数字技术→资本逻辑→劳动控制→时间规训→主体自由 */
export async function designResearchLine(input: { corePhenomenon: string }): Promise<{
  motherTopic: string;       // 母题（研究主线一句话）
  chain: Array<{ node: string; question: string }>;  // 链条: 每个环节+子问题
  matrix: Array<{ dimension: string; topic: string }>;  // 沿主线的系列论文
  advice: string;            // 主线开发建议
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论科研规划专家。基于"稳定研究主线"方法（刘衍峰式）:
现象起点: ${input.corePhenomenon}

核心要领: 不换题、沿系列延伸。一个母题 + 若干子问题, 每篇推进链条一环。示例链条: 数字技术→资本逻辑→劳动控制→时间规训→主体自由（每篇一个环节, 前一篇结论是后一篇前提）。
步骤:
1. 设计 4-6 环节的递进链条（现象→机制→效应→批判→建构, 每环节一个子问题）
2. 每个环节给具体研究问题（可写成一篇论文）
3. 沿链条生成系列论文题目（每篇有理论接口、彼此衔接）
4. 给出主线开发建议（先写哪篇、哪些留给以后、怎么积累）

输出 JSON: {"motherTopic":"母题(30字内, 含研究主线)","chain":[{"node":"环节名","question":"子问题"}],"matrix":[{"dimension":"环节/对象","topic":"论文题目"}],"advice":"开发建议(80字内)"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 1500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      motherTopic: String(parsed.motherTopic || ""),
      chain: Array.isArray(parsed.chain) ? parsed.chain.map((c: any) => ({ node: String(c.node || ""), question: String(c.question || "") })) : [],
      matrix: Array.isArray(parsed.matrix) ? parsed.matrix.map((m: any) => ({ dimension: String(m.dimension || ""), topic: String(m.topic || "") })) : [],
      advice: String(parsed.advice || ""),
    };
  } catch { return { motherTopic: "", chain: [], matrix: [], advice: "" }; }
}

/** 告诫③ 研究标签生成 — 博士建立 3-5 个长期核心关键词反复组合（形成研究标签）
 * 提供: 从已有研究/兴趣生成关键词组合矩阵 */
export async function generateResearchLabels(input: { researchFocus: string }): Promise<{
  labels: Array<{ keyword: string; why: string }>;   // 3-5 个核心关键词
  combinations: Array<{ combo: string; topic: string }>;  // 关键词两两组合 → 选题
  advice: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是马理论科研规划专家。基于"研究标签"方法（刘衍峰式）:
研究领域/兴趣: ${input.researchFocus}

核心要领: 博士建立 3-5 个长期核心关键词, 反复组合形成"研究标签"——你在学术共同体中的辨识度。不追每篇新热点, 而是热点来了就与自己的关键词组合。
步骤:
1. 提取 3-5 个核心关键词（2 个理论关键词 + 1-2 个现象关键词 + 1 个方法关键词, 如: 资本逻辑/劳动过程/数字劳动/算法/政治经济学批判）
2. 每个关键词说明为何选它（能反复出题、有理论纵深、别人不易复制）
3. 关键词两两组合生成 5-8 个选题（热点×自有关键词 = 每篇都不换题但都在出新题）
4. 给出研究标签的定位建议

输出 JSON: {"labels":[{"keyword":"关键词","why":"理由"}],"combinations":[{"combo":"A×B","topic":"题目"}],"advice":"标签定位建议"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 1500 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      labels: Array.isArray(parsed.labels) ? parsed.labels.map((l: any) => ({ keyword: String(l.keyword || ""), why: String(l.why || "") })) : [],
      combinations: Array.isArray(parsed.combinations) ? parsed.combinations.map((c: any) => ({ combo: String(c.combo || ""), topic: String(c.topic || "") })) : [],
      advice: String(parsed.advice || ""),
    };
  } catch { return { labels: [], combinations: [], advice: "" }; }
}

/** 告诫④ 题目尺度检验 — 做窄做深, 不做《新时代马政经体系建构研究》
 * 规则: 标题越宏大 → 越需要具体化; 反向检验: 能否用 30 字说明白研究对象与机制 */
export function checkTopicScope(topic: string): {
  tooBroad: boolean;
  reasons: string[];
  narrowed: string[];   // 收窄建议
  advice: string;
} {
  const BROAD_PATTERNS = [
    { re: /^(?:新时代|新形势下|中国式现代化视域下)\S{4,16}研究$/, label: "宏大前缀+大主题", reason: "主题泛化无研究对象" },
    { re: /(?:建构|构建|重构)\S{0,6}(?:体系|系统|框架|范式|理论)$/, label: "体系建构式", reason: "体系建构是专著任务不是单篇论文" },
    { re: /^马(?:克思主义)?(?:主义)?(?:政治经济学)?(?:理论|体系)\S{2,8}研究$/, label: "学科总论式", reason: "学科总论无具体对象无问题" },
    { re: /(?:逻辑理路|内在逻辑|生成逻辑|逻辑进路)$/, label: "XX逻辑式", reason: "只说逻辑没有现象与机制" },
    { re: /^[一-龥]{2,6}的(?:马克思主义|社会主义|中国式)\S{4,20}研究$/, label: "大概念+大限定", reason: "对象过大难以深做" },
  ];
  const reasons = BROAD_PATTERNS.filter((p) => p.re.test(topic)).map((p) => `${p.label}（${p.reason}）`);
  const tooBroad = reasons.length > 0;
  // 收窄建议: 规则化重构
  const narrowed = tooBroad
    ? [
        `加具体对象: ${topic.replace(/研究$/, "的")}——以${"（具体领域）"}为对象`,
        `加机制追问: 把"逻辑/体系"改为"X通过什么机制改变Y"`,
        `加时间/空间限定: 数字经济时代 / 平台经济场景 / 县域实践`,
      ]
    : [];
  return {
    tooBroad,
    reasons,
    narrowed,
    advice: tooBroad
      ? `⚠️ 题目尺度过大（命中: ${reasons.join("、")}）。C 刊单篇论文只做一个窄而深的机制问题——做窄做深, 不做《新时代马政经体系建构研究》。建议: ${narrowed.join("; ")}`
      : `✅ 题目尺度适中, 可以深做。记住尺度口诀: 一个机制问题 + 一个理论接口 + 一个具体场景。`,
  };
}

/** 告诫⑤ 系列延伸 — 一篇成功不换题: 沿已有论文延伸下一篇
 * 输入: 已发表/在写论文题 → 生成沿系列延伸的下一步选题 */
export async function extendResearchSeries(input: { paperTitle: string; published?: string }): Promise<{
  extension: string;        // 延伸方向
  nextTopic: string;        // 下一篇题目
  seriesPlan: Array<{ order: number; topic: string }>;  // 系列规划
  advice: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const publishedHint = input.published ? `已发论文: ${input.published}` : "";
  const prompt = `你是马理论科研规划专家。基于"一篇成功不换题"方法（刘衍峰式）:
现有论文: ${input.paperTitle}
${publishedHint}

核心要领: 一篇论文成功发表后, 不换题, 沿系列延伸——同一研究主线推进一环, 读者的认知累积、审稿人印象、理论纵深都在积累。示例: 从"数字劳动时间规训"→"零工自由时间的悖论"→"算法管理的劳动控制边界"。
步骤:
1. 识别这篇论文的研究主线与未展开的空间（哪一环是下一篇）
2. 给出延伸方向（加深/加对象/加层次/换场景）
3. 生成下一篇论文题目（与上一篇衔接、不重复）
4. 给 3-5 篇系列规划（先写哪篇、顺序与衔接）

输出 JSON: {"extension":"延伸方向(40字内)","nextTopic":"下一篇题目","seriesPlan":[{"order":1,"topic":"题目"}],"advice":"系列开发建议"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, maxTokens: 1200 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      extension: String(parsed.extension || ""),
      nextTopic: String(parsed.nextTopic || ""),
      seriesPlan: Array.isArray(parsed.seriesPlan) ? parsed.seriesPlan.map((s: any) => ({ order: Number(s.order) || 0, topic: String(s.topic || "") })) : [],
      advice: String(parsed.advice || ""),
    };
  } catch { return { extension: "", nextTopic: "", seriesPlan: [], advice: "" }; }
}

/** 刘衍峰式选题方法系统总览（静态数据: 7 特征 + 5 思路 + 生产系统 + 告诫, 前端展示用） */
export const LIUYANFENG_SYSTEM = {
  features: [
    { title: "追政策但不止于政策解释", desc: "热点之间的关系才是论文。从'解释概念'升级为'解释两变量关系'", example: "新质生产力 × 内卷式竞争" },
    { title: "给现象'命名'", desc: "现实事件→典型现象→理论概念, 让概念有辨识度", example: "'数字政务程序负担'→数字官僚主义" },
    { title: "稳定研究主线", desc: "一个母题 + 若干子问题, 每篇推进链条一环", example: "数字技术→资本逻辑→劳动控制→时间规训→主体自由" },
    { title: "始终连接经典理论", desc: "现实问题 × 马恩经典, 理论接口是C刊入场券", example: "算法管理×劳动过程理论、数字零工×自由时间理论" },
    { title: "核心概念矩阵式选题", desc: "围绕熟悉概念持续开发, 不追每篇新热点", example: "新质生产力 × 数字乡村/内卷/耐心资本…" },
    { title: "跨学科嫁接", desc: "马理论×经济×社会×公管×传播, 新问题在交叉地带", example: "算法×中华民族共同体意识" },
    { title: "标题要有'矛盾感'", desc: "悖论即问题, 张力即选题", example: "'灵活性还是新剥削？''技术乌托邦与敌托邦'" },
  ],
  ideas: [
    { title: "政策解读型", desc: "中央文件/政策概念出现即跟进, 但要挂理论接口" },
    { title: "现象命名型", desc: "从现实事件提炼新概念, 占据概念解释权" },
    { title: "理论应用型", desc: "用马克思经典理论解释新现象, 检验理论的时代解释力" },
    { title: "关系机制型", desc: "两个变量之间的关系与机制, 最具论文价值" },
    { title: "悖论批判型", desc: "从现实悖论出发批判性提问" },
  ],
  productionChain: [
    { step: "热点观察", detail: "持续追踪政策/新现象, 建热点清单" },
    { step: "理论接口", detail: "热点找经典理论: 耐心资本→资本循环、投资于人→劳动力再生产、AI→机器体系" },
    { step: "关系命题", detail: "热点×热点或热点×理论, 形成关系型问题" },
    { step: "命名提炼", detail: "给现象命名, 形成概念亮点" },
    { step: "机制设计", detail: "提出具体中间机制(A通过什么改变B)" },
    { step: "系列延伸", detail: "一篇成功不换题, 沿主线推进下一篇" },
  ],
  warnings: [
    { text: "不要只有热点没有问题——'价值、困境与路径'模板必死", type: "danger" },
    { text: "博士建立 3-5 个长期核心关键词反复组合（形成研究标签）", type: "key" },
    { text: "热点找理论接口: 耐心资本→资本循环、投资于人→劳动力再生产、AI→机器体系", type: "key" },
    { text: "题目控制尺度——做窄做深, 不做《新时代马政经体系建构研究》", type: "danger" },
    { text: "一篇成功不换题, 沿系列延伸", type: "key" },
  ],
};

/** 方法体系记录（V395-32: 可动态添加/替换, 替代静态 LIUYANFENG_SYSTEM） */
export interface MethodSystem {
  id: string;
  name: string;
  features: Array<{ title: string; desc: string; example: string }>;
  ideas: Array<{ title: string; desc: string }>;
  productionChain: Array<{ step: string; detail: string }>;
  warnings: Array<{ text: string; type: string }>;
  builtin: boolean;
}

/** 方法体系缓存（60s 失效, 变更后强制刷新） */
let methodSystemCache: MethodSystem[] | null = null;
let methodSystemCacheAt = 0;

/** 加载全部方法体系（DB, 按内置在前） */
export async function listMethodSystems(force = false): Promise<MethodSystem[]> {
  if (!force && methodSystemCache && Date.now() - methodSystemCacheAt < 60_000) return methodSystemCache;
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query("select * from cjournal_method_systems order by builtin desc, created_at asc");
    methodSystemCache = r.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      features: Array.isArray(row.features) ? row.features : [],
      ideas: Array.isArray(row.ideas) ? row.ideas : [],
      productionChain: Array.isArray(row.production_chain) ? row.production_chain : [],
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      builtin: row.builtin,
    }));
  } catch { methodSystemCache = []; }
  methodSystemCacheAt = Date.now();
  return methodSystemCache;
}

/** 新增/更新方法体系（id 重复则更新; builtin 不可被普通更新覆盖 builtin 标记） */
export async function upsertMethodSystem(input: {
  id: string; name: string;
  features: MethodSystem["features"];
  ideas: MethodSystem["ideas"];
  productionChain: MethodSystem["productionChain"];
  warnings: MethodSystem["warnings"];
}): Promise<MethodSystem> {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query(
    `insert into cjournal_method_systems (id, name, features, ideas, production_chain, warnings, builtin)
     values ($1, $2, $3, $4, $5, $6, false)
     on conflict (id) do update set
       name = excluded.name, features = excluded.features, ideas = excluded.ideas,
       production_chain = excluded.production_chain, warnings = excluded.warnings
     returning *`,
    [input.id.trim(), input.name.trim(), JSON.stringify(input.features), JSON.stringify(input.ideas), JSON.stringify(input.productionChain), JSON.stringify(input.warnings)]
  );
  methodSystemCache = null;
  return {
    id: r.rows[0].id, name: r.rows[0].name,
    features: r.rows[0].features, ideas: r.rows[0].ideas,
    productionChain: r.rows[0].production_chain, warnings: r.rows[0].warnings,
    builtin: r.rows[0].builtin,
  };
}

/** 删除方法体系（内置不可删） */
export async function deleteMethodSystem(id: string): Promise<{ ok: boolean; error?: string }> {
  const { pool } = await import("../db/pool.js");
  const r = await pool.query("select builtin from cjournal_method_systems where id = $1", [id]);
  if (r.rows.length === 0) return { ok: false, error: "方法体系不存在" };
  if (r.rows[0].builtin) return { ok: false, error: "内置方法体系不可删除" };
  await pool.query("delete from cjournal_method_systems where id = $1", [id]);
  methodSystemCache = null;
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════
// V395-37: 小新学姐 12 条科研生产系统经验（第七篇方法论完整落地）
// 五件事: 对象特殊性检验/稿件梯队/代表作意识/外审翻译/写前选刊
// 整合: 对象检验/manuscriptLadder/外审翻译/理论接口清单 已存在 → 复用映射+前端tab;
// 新做: 写前选刊 + 代表作意识诊断 + 12条总览
// ══════════════════════════════════════════════════════════════════

/** 12 条经验总览（含复用映射: 现有函数 → 前端跳转） */
export const XIAOXIN_SYSTEM = {
  summary: "自写自投 8 篇 C 刊 · 12 条经验（七篇中最系统的一篇）",
  items: [
    { id: "theory-list", key: 1, title: "理论接口清单", desc: "AI→机器/劳动过程理论、平台劳动→劳动控制/自由时间、耐心资本→资本循环/周转、统一大市场→社会总资本再生产、投资于人→劳动力再生产", reuse: { tab: "reference", label: "接口·期刊·种子", desc: "理论接口映射表 15+ 条" } },
    { id: "object-check", key: 2, title: "对象特殊性检验", desc: "换掉研究对象小标题还成立 = 模板化（深地经济→极端环境/地下通信；智算→异构算力/算力交易）", reuse: { tab: "experience", label: "对象特殊性检验", desc: "本页检验器（V395-21已有, 补前端入口）" } },
    { id: "manuscript-ladder", key: 3, title: "稿件梯队", desc: "一篇在写/一篇在改/一篇在投/一篇在审 + 分层（冲击型/稳健型/阶段成果）", reuse: { tab: "experience", label: "稿件梯队管理", desc: "本页管理器（V395-21已有, 补前端入口）" } },
    { id: "representative", key: 4, title: "代表作意识", desc: "稳定产出 + 一两篇冲代表作——代表作让你在审稿人/同行心中有辨识度", reuse: null },
    { id: "review-translate", key: 5, title: "外审意见翻译", desc: "'创新不足'→你与现有研究有何不同；'理论深度不够'→只有现象无机制", reuse: { tab: "review", label: "外审翻译", desc: "审稿意见→本质问题+修改动作" } },
    { id: "pre-select-journal", key: 6, title: "写前选刊", desc: "边写边想投哪：期刊重点/题目结构/理论vs实证/是否发过类似主题", reuse: null },
    { id: "template-check", key: 7, title: "模板反例检测", desc: "价值意蕴/困境/路径四段模板=只有新对象没有新问题", reuse: { tab: "template", label: "模板检测", desc: "5 类模板模式识别" } },
    { id: "question-first", key: 8, title: "问题意识优先", desc: "从时代问题出发而非'我想研究'——追问而非宽泛", reuse: { tab: "editor", label: "编辑视角", desc: "六法①时代问题追问" } },
    { id: "small-incision", key: 9, title: "小切口深研", desc: "聚焦一个概念/场景/政策, 小题大做", reuse: { tab: "scope", label: "尺度检验", desc: "做窄做深" } },
    { id: "continuity", key: 10, title: "连续性选题", desc: "围绕核心方向系列深化, 不换方向", reuse: { tab: "research-line", label: "研究主线", desc: "母题+子问题链条" } },
    { id: "mainline", key: 11, title: "守住主线", desc: "马克思主义中国化时代化/两个结合/六个必须坚持", reuse: { tab: "rules", label: "投稿军规", desc: "军规①主线体检" } },
    { id: "journal-match", key: 12, title: "匹配期刊口味", desc: "党校/社院学报偏统一战线, 统一战线学C刊追热点, 东南学术偏学理化, 经济纵横偏经济热点", reuse: { tab: "reference", label: "接口·期刊·种子", desc: "期刊画像表" } },
  ],
  journalSelection: {
    // 写前选刊对照表: 期刊 × 关注点
    focusPoints: ["期刊重点方向", "题目结构偏好", "理论vs实证", "是否发过类似主题"],
    journals: [
      { name: "党校/社院学报", style: "统一战线、凝聚共识", match: "统一战线/凝聚/共识/政协/统战" },
      { name: "统一战线学C刊", style: "追热点", match: "统战/民族/共同体" },
      { name: "东南学术", style: "学理化、理论纵深", match: "理论/范畴/逻辑" },
      { name: "经济纵横", style: "经济热点、政策经济", match: "经济/生产力/资本/市场" },
      { name: "《马克思主义研究》", style: "经典理论时代化", match: "马克思/经典/理论" },
      { name: "《思想理论教育导刊》", style: "思政教育、青年研究", match: "思政/教育/青年/意识形态" },
    ],
  },
};

/** 写前选刊: 输入论文题目 → 匹配目标期刊 + 选刊建议 */
export async function generateJournalSelection(input: { topic: string }): Promise<{
  topic: string;
  matchedJournal: string;
  matchReason: string;
  focusPoints: Array<{ point: string; assessment: string }>;
  advice: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const journalHints = XIAOXIN_SYSTEM.journalSelection.journals.map((j) => `${j.name}（${j.style}, 关键词: ${j.match}）`).join("；");
  const prompt = `你是 C 刊投稿选刊顾问。为论文题目做"写前选刊"（小新学姐式）：
论文题目: ${input.topic}

期刊画像:
${journalHints}

选刊四问（边写边想投哪）:
1. 期刊重点方向: 该刊近期重点发什么
2. 题目结构偏好: 该刊喜欢什么题目形态（宏大理论型/具体机制型/政策回应型）
3. 理论vs实证: 该刊偏理论阐释还是实证研究
4. 是否发过类似主题: 同类主题是否已发（发了=竞争力强但门槛高, 没发=机会但需论证相关性）

输出 JSON: {"matchedJournal":"最匹配期刊(带理由30字内)","matchReason":"匹配原因(40字内)","focusPoints":[{"point":"期刊重点方向","assessment":"该刊重点+本题目契合度(30字内)"},{"point":"题目结构偏好","assessment":"..."},{"point":"理论vs实证","assessment":"..."},{"point":"是否发过类似主题","assessment":"..."}],"advice":"选刊建议(50字内)"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 900 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      topic: String(parsed.topic || input.topic),
      matchedJournal: String(parsed.matchedJournal || ""),
      matchReason: String(parsed.matchReason || ""),
      focusPoints: Array.isArray(parsed.focusPoints) ? parsed.focusPoints.map((f: any) => ({ point: String(f.point || ""), assessment: String(f.assessment || "") })) : [],
      advice: String(parsed.advice || ""),
    };
  } catch { return { topic: input.topic, matchedJournal: "", matchReason: "", focusPoints: [], advice: "" }; }
}

/** 代表作意识诊断: 输入已发论文清单 → 评估代表作结构 + 建议 */
export async function diagnoseRepresentative(input: { papers: string[] }): Promise<{
  hasRepresentative: boolean;
  assessment: string;
  gap: string;
  advice: string;
}> {
  const model = resolveModelAlias(getRoleModel("plan"));
  const prompt = `你是 C 刊投稿顾问。做"代表作意识"诊断（小新学姐式）：
已发表/在写论文清单: ${input.papers.join("；") || "（空）"}

代表作意识含义: 稳定产出（持续发稿维持活跃）+ 一两篇代表作（冲更高水平, 让审稿人/同行记住你）。
诊断维度: ①数量是否稳定（每年有产出） ②是否有冲击型稿件（问题更重要/理论更扎实/机制更清楚） ③清单里哪篇最有代表作潜质

输出 JSON: {"hasRepresentative":true/false,"assessment":"诊断结论(60字内)","gap":"差距分析(50字内)","advice":"建议(50字内)"}`;
  const r = await callLlm({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, maxTokens: 600 });
  try {
    const parsed = JSON.parse(extractJson((r?.text || "")));
    return {
      hasRepresentative: !!parsed.hasRepresentative,
      assessment: String(parsed.assessment || ""),
      gap: String(parsed.gap || ""),
      advice: String(parsed.advice || ""),
    };
  } catch { return { hasRepresentative: false, assessment: "", gap: "", advice: "" }; }
}

export const cjournalService = {
  THEORY_INTERFACE_MAP,
  SEED_TOPICS,
  JOURNAL_PROFILES,
  generateTopicFourStep,
  generateParadoxTopic,
  generateTopicMatrix,
  validateByEditorStandards,
  generateConceptNaming,
  generateCrossDisciplinary,
  checkTopicTemplate,
  checkObjectSpecificity,
  translateReviewComment,
  manuscriptLadder,
  listScholars,
  upsertScholar,
  deleteScholar,
  clearScholarCache,
  // V395-31: 刘衍峰式选题方法系统
  generateRelationalTopic,
  designResearchLine,
  generateResearchLabels,
  checkTopicScope,
  extendResearchSeries,
  LIUYANFENG_SYSTEM,
  // V395-32: 方法体系动态管理（可添加/替换/删除）
  listMethodSystems,
  upsertMethodSystem,
  deleteMethodSystem,
  // V395-33: 马原理 C 刊选题六大趋势
  MARX_TREND_SYSTEM,
  generateTrendTopic,
  // V395-34: 经典马研究六大方向（转向诊断 + 方向深化）
  CLASSIC_MARX_SYSTEM,
  diagnoseClassicTopic,
  generateClassicDirection,
  // V395-35: 编辑视角六法（①②④生成器 + 六法总览带复用映射）
  EDITOR_SYSTEM,
  generateEditorTopic,
  // V395-36: 投稿五条军规（①主线体检②国家战略④新视角 + 总览带复用映射）
  RULES_SYSTEM,
  checkMainline,
  generateNationalStrategy,
  generateNewAngle,
  // V395-37: 小新学姐 12 条经验（写前选刊 + 代表作诊断 + 总览带复用映射）
  XIAOXIN_SYSTEM,
  generateJournalSelection,
  diagnoseRepresentative,
};
