// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// editor-service.ts — SocialSci P0-5: 学术文本编辑器后端(文档 CRUD + 选区改写 + 全文检查 + 图表代码)
// 形态对齐(闭源产品交互语义, 原创实现): 选中文本→改写5模式+humanize / 全文一致性检查 / AI图表代码
// 诚实性边界: 全文检查"不验证文献真实性"(与 citation-verify 定位区分, 服务注释注明)
// 迁移119 documents_v2; 与 doc-session-service(锁/心跳) 配合
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlmDetailed } from "../ai/llm-common.js";

// 学术写作角色: 编辑器 AI 单独路由(用户可在 AI 面板切换, 不影响推理链 reason)
async function callLlm(prompt: string, maxTokens = 4000, temperature = 0.4): Promise<string> {
  const ep = getLlmEndpoint({ model: getRoleModel("editor") });
  // 2026-09-10: 此前用 fetchLlm(null 静默) → 失败被当成"成功但内容为空", 前端显示空白却报 done。
  // 现在如实抛出, 由 job 标 failed 并把原因显示到面板。
  const res = await fetchLlmDetailed({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt }],
    temperature, maxTokens, timeoutMs: 240_000,
  });
  if (!res.ok) {
    const where = /not exist|不匹配|不存在/.test(res.message) ? ` (端点 ${new URL(ep.url).host})` : "";
    throw new Error(`${res.message}${where}${res.detail ? ` — ${res.detail.slice(0, 200)}` : ""}`);
  }
  if (!res.text.trim()) {
    // 空正文不再当成功: 模型存在但没吐内容, 大概率是配额/thinking 配置问题
    throw new Error(`模型 ${ep.model} 返回空内容${res.finishReason ? ` (finish_reason=${res.finishReason})` : ""}`);
  }
  return res.text;
}

function wc(s: string): number { return s.replace(/\s/g, "").length; }

// ═══ 文档 CRUD ═══
// R8a/R8c: 列表带分页+创建者 username(HAR 实证 editor documents 响应形状); 保存自动写 doc2_versions 版本行回填指针
export async function listDocs(userId: string, opts: { page?: number; pageSize?: number } = {}) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const off = (page - 1) * pageSize;
  const total = await pool.query(
    `select count(*)::int n from documents_v2 where user_id=$1`, [userId]);
  const r = await pool.query(
    `select d.id, d.title, d.word_count, d.status, d.tags, d.locked_by, d.locked_at,
            d.current_version_id, d.updated_at, u.username
       from documents_v2 d join users u on u.id=d.user_id
      where d.user_id=$1 order by d.updated_at desc limit $2 offset $3`,
    [userId, pageSize, off]);
  return { items: r.rows, total: total.rows[0]?.n ?? 0, page, pageSize };
}

export async function createDoc(userId: string, title: string, content = "") {
  const id = randomUUID();
  const hash = contentHash(content);
  await pool.query(
    `insert into documents_v2 (id, user_id, title, content, word_count) values ($1,$2,$3,$4,$5)`,
    [id, userId, title || "未命名文档", content, wc(content)]);
  // 初始版本行 + 指针(R8c; content 快照供回档)
  await pool.query(
    `insert into doc2_versions (document_id, version, content_hash, title, content_len, content, by_editor) values ($1,1,$2,$3,$4,$5,$6)`,
    [id, hash, title || "未命名文档", content.length, content, "editor"]);
  await pool.query(
    `update documents_v2 set current_version_id=(select v.id from doc2_versions v where v.document_id=$1 order by v.version desc limit 1) where id=$1`,
    [id]);
  return { id };
}

function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16);
}

export async function getDoc(userId: string, docId: string) {
  const r = await pool.query(
    `select d.*, u.username from documents_v2 d join users u on u.id=d.user_id where d.id=$1 and d.user_id=$2`,
    [docId, userId]);
  return r.rows[0] ?? null;
}

export async function saveDoc(userId: string, docId: string, patch: { title?: string; content?: string; tags?: string[] }) {
  const sets = ["updated_at=now()"]; const vals: unknown[] = [docId, userId];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      if (k === "content") { sets.push(`content=$${vals.length + 1}`, `word_count=$${vals.length + 2}`); vals.push(v, wc(String(v))); }
      else if (k === "tags") { sets.push(`tags=$${vals.length + 1}`); vals.push(JSON.stringify(v)); }
      else { sets.push(`${k}=$${vals.length + 1}`); vals.push(v); }
    }
  }
  const r = await pool.query(
    `update documents_v2 set ${sets.join(",")} where id=$1 and user_id=$2 returning id, word_count`, vals);
  const row = r.rows[0];
  if (!row) return null;
  // 每次保存写版本行并回填指针(R8c: current_version_id 递增语义)
  const title = patch.title !== undefined ? patch.title : null;
  const content = patch.content !== undefined ? patch.content : null;
  const hash = contentHash(String(content ?? ""));
  const cur = await pool.query(
    `select coalesce(max(version),0)+1 v from doc2_versions where document_id=$1`, [docId]);
  const ver = cur.rows[0]?.v ?? 1;
  const vrow = await pool.query(
    `insert into doc2_versions (document_id, version, content_hash, title, content_len, content, by_editor)
     values ($1,$2,$3,$4,$5,$6,'editor') returning id`,
    [docId, ver, hash, title ?? "", content?.length ?? 0, content ?? ""]);
  await pool.query(`update documents_v2 set current_version_id=$2 where id=$1`, [docId, vrow.rows[0].id]);
  return { ...row, currentVersion: ver };
}

/** 版本回档: 取历史版本 content 写回当前文档 + 落一条新版本行 */
export async function restoreDocVersion(userId: string, docId: string, version: number) {
  const owner = await pool.query(`select id from documents_v2 where id=$1 and user_id=$2`, [docId, userId]);
  if (!owner.rows.length) return null;
  const v = await pool.query(
    `select content, title from doc2_versions where document_id=$1 and version=$2`, [docId, version]);
  if (!v.rows[0]) return null;
  const content = v.rows[0].content ?? "";
  const title = v.rows[0].title ?? "";
  const sets = ["content=$3", "word_count=$4", "updated_at=now()"];
  if (title) sets.push("title=$5");
  const vals: unknown[] = [docId, userId, content, wc(content)];
  if (title) vals.push(title);
  await pool.query(`update documents_v2 set ${sets.join(",")} where id=$1 and user_id=$2`, vals);
  // 新版本行(回档也是新历史)
  const hash = contentHash(content);
  const cur = await pool.query(
    `select coalesce(max(version),0)+1 v from doc2_versions where document_id=$1`, [docId]);
  const nv = cur.rows[0]?.v ?? 1;
  const vrow = await pool.query(
    `insert into doc2_versions (document_id, version, content_hash, title, content_len, content, by_editor)
     values ($1,$2,$3,$4,$5,$6,'restore') returning id`,
    [docId, nv, hash, title, content.length, content]);
  await pool.query(`update documents_v2 set current_version_id=$2 where id=$1`, [docId, vrow.rows[0].id]);
  return { restoredFrom: version, currentVersion: nv };
}

export async function deleteDoc(userId: string, docId: string) {
  const r = await pool.query(`delete from documents_v2 where id=$1 and user_id=$2 returning id`, [docId, userId]);
  return r.rows[0] ?? null;
}

/** 锁(与 doc-session-service 同语义: 编辑会话持锁, 他人只读) */
export async function lockDoc(userId: string, docId: string): Promise<{ ok: boolean; lockedBy?: string }> {
  const r = await pool.query(
    `update documents_v2 set locked_by=$3, locked_at=now(), status='locked'
      where id=$1 and (user_id=$2 or locked_by=$3)
        and (locked_by='' or locked_by=$3 or locked_at < now() - interval '5 minutes')
     returning locked_by`, [docId, userId, `user:${userId}`]);
  return r.rows.length ? { ok: true, lockedBy: r.rows[0].locked_by } : { ok: false };
}

export async function unlockDoc(userId: string, docId: string) {
  await pool.query(
    `update documents_v2 set locked_by='', status='draft' where id=$1 and locked_by=$2`,
    [docId, `user:${userId}`]);
  return { ok: true };
}

// ═══ 选区改写 6 模式 + humanize(T5: 补"扩展论证", 闭源 EditorView 对齐) ═══
export type RewriteMode = "condense" | "de-template" | "polish" | "proofread" | "journal-style" | "humanize" | "expand";

const MODE_PROMPT: Record<RewriteMode, string> = {
  condense: "压缩冗余: 保留核心信息, 删除重复与空泛表达, 缩短 30-40%, 学术语气不变",
  "de-template": "去除模板化表达: 减少口号化、套路化和机械表达, 让文字更自然学术",
  polish: "学术润色: 优化用词与句式, 提升表达准确性和专业度",
  proofread: "修正错别字、语病和标点; 只改错不改风格",
  "journal-style": "改成中文期刊风格: 严谨客观、术语规范、符合核心期刊表达习惯",
  humanize: "降低 AI 痕迹: 消除机械感/重复句式/生硬连接词, 让行文更接近人类学者手笔(仅优化表达不改变事实与结构)",
  expand: "扩展论证: 补足推理链条和解释, 用证据/机理/示例把论点展开得更充分(不改变原观点, 扩充约 40-60%)",
};

export async function rewriteText(mode: RewriteMode, text: string, context = ""): Promise<{ text: string }> {
  if (!text.trim()) return { text: "" };
  const instruction = MODE_PROMPT[mode];
  const ctx = context.trim() ? `\n【上下文(仅供判断风格与衔接, 不要改写)】\n${context.slice(0, 3000)}\n` : "";
  const out = await callLlm(`你是中文学术写作编辑。对以下选中文本执行: ${instruction}
${ctx}
【选中文本】
${text.slice(0, 6000)}

直接输出改写后的文本(只输出正文, 不要解释)。`, 4000, 0.4);
  // 2026-09-10: 不再 `out.trim() || text` 静默回原文 —— 那会让"润色"按钮在失败时
  // 原样返回用户自己的文字并显示成功(徒有其表)。callLlm 已在失败/空内容时抛错。
  return { text: out.trim() };
}

// ═══ 全文检查(不验证文献真实性 — 诚实性边界, 与 citation-verify 定位区分) ═══
// P-C 对齐闭源 EditorView 全文检查 4 模式: 全文逻辑检查/章节衔接检查/变量-方法-结论一致性/投稿前检查
// 行为: 只给修改建议, 不直接改正文(闭源明示)
const CHECK_MODES: Record<string, { mode: string; name: string; prompt: string }> = {
  logic: {
    mode: "logic",
    name: "全文逻辑检查",
    prompt: "检查结构、重复、跳跃和论证断裂, 重点: 论证链断裂/因果混乱/前后矛盾/重复论述",
  },
  cohesion: {
    mode: "cohesion",
    name: "章节衔接检查",
    prompt: "检查标题层级、前后承接和小标题支撑关系, 重点: 标题与内容匹配/章节间过渡断裂/小标题未支撑论点",
  },
  consistency: {
    mode: "consistency",
    name: "变量-方法-结论一致性",
    prompt: "检查研究问题、变量、方法和结论是否前后一致, 重点: 提出的变量/方法在结果与结论中是否对应",
  },
  submission: {
    mode: "submission",
    name: "投稿前检查",
    prompt: "列出需要优先处理的修订事项, 从期刊投稿视角: 结构体例/摘要关键词/格式/需优先修订项",
  },
};
// 前端按钮 id → 后端 mode 别名(闭源 UI 动作名与内部 mode 名不同, 两者都接受)
const CHECK_ALIAS: Record<string, string> = {
  logic_check: "logic",
  section_coherence_check: "cohesion",
  variable_method_conclusion_check: "consistency",
  submission_check: "submission",
};
export async function checkFulltext(text: string, mode?: string): Promise<{ mode: string; modeName: string; checks: Array<{ name: string; ok: boolean; findings: string[] }> }> {
  const key = CHECK_ALIAS[mode ?? ""] ?? mode ?? "";
  const m = CHECK_MODES[key] ?? CHECK_MODES.logic;
  const fail = (reason: string) => ({ mode: m.mode ?? mode ?? "logic", modeName: m.name, checks: [{ name: m.name, ok: false, findings: [reason] }] });
  let out = "";
  try {
    out = await callLlm(`你是学术论文质检专家。执行「${m.name}」检查, 只给修改建议, 不直接改正文(不判断文献真实存在与否, 只做文本质量检查)。
检查要点: ${m.prompt}

【全文】
${text.slice(0, 12000)}

输出 JSON: {"checks":[{"name":"${m.name}","ok":true/false,"findings":["问题1(带原文引用片段)"]}]}
没有问题时 findings 为空数组, ok=true。`, 5000, 0.2);
  } catch (e) {
    // 调用失败: 如实说明原因(此前只报"解析失败", 掩盖了真实故障)
    return fail(`质检调用失败: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed?.checks)) return { mode: m.mode ?? mode ?? "logic", modeName: m.name, checks: parsed.checks };
  } catch { /* 解析失败走默认结构 */ }
  return fail("质检结果解析失败, 请重试");
}

// ═══ UI审计T5 深化: 标题/摘要/关键词各自独立 prompt(一按钮一动作, 不再共用一次全出) ═══
interface TitleExtras { keywords?: string[]; originalKeywords?: string[]; originalAbstract?: string }
type TitleKind = "title" | "abstract" | "keywords";

const TITLE_PROMPT: Record<TitleKind, { name: string; prompt: string }> = {
  title: {
    name: "优化标题",
    prompt: `你是中文核心期刊编辑。基于论文全文, 给出 5 个更具体、可研究、少口号化的标题候选。
要求: ①每个候选准确概括研究对象、方法与核心结论 ②单标题 ≤25 字, 必要时可用主副标题 ③避免"初探""浅析""试论"等空泛词与口号化表达 ④5 个候选要有区分度: 分别侧重机制追问 / 效应检验 / 区域差异 / 政策含义 / 理论对话 ⑤符合马克思主义理论·社会科学类核心期刊的表达习惯。
输出 JSON: {"title":"5 个候选中最推荐的一个","alternatives":["候选1","候选2","候选3","候选4","候选5"],"reason":"优化理由(30 字内, 说明原标题的问题)"}`,
  },
  abstract: {
    name: "优化摘要",
    prompt: `你是中文核心期刊编辑。检查论文摘要的目的、方法、结果、结论四要素是否完整, 并给出改写稿。
要求: ①200-300 字 ②完整覆盖"研究目的与问题→数据与方法→主要发现→结论与政策含义" ③客观陈述, 不用"本文认为"式主观表达 ④不出现图表编号和文献引用 ⑤如已提供原摘要, 保留其准确信息, 只补缺失要素并修正结构表达。
输出 JSON: {"abstract":"改写后的摘要正文","issues":["原摘要缺失或存在的问题 1","问题 2"]}`,
  },
  keywords: {
    name: "提取关键词",
    prompt: `你是中文核心期刊编辑。给出关键词候选并说明筛选依据。
要求: ①给出 5-8 个候选词, 每个 2-6 字的名词或名词短语 ②按重要性降序 ③覆盖研究对象、核心概念/变量、方法或视角 ④避免与标题完全重复的词 ⑤每个候选附一句入选依据。
输出 JSON: {"keywords":["关键词1","关键词2","关键词3","关键词4","关键词5"],"reason":"筛选依据(50 字内)"}`,
  },
};

/** 标题/摘要/关键词: mode 决定走哪一套 prompt(空 mode 走 title) */
export async function generateTitleAbstract(text: string, mode?: string): Promise<{ title: string; abstract: string; keywords: string[]; alternatives?: string[]; issues?: string[]; reason?: string }> {
  const kind: TitleKind = (["title", "abstract", "keywords"] as const).includes(mode as TitleKind) ? (mode as TitleKind) : "title";
  const spec = TITLE_PROMPT[kind];
  const out = await callLlm(`你是学术论文编辑。任务: ${spec.name}
${spec.prompt}

【全文】
${text.slice(0, 12000)}

只输出 JSON。`, 4000, 0.3);
  try {
    const p = JSON.parse(out.replace(/```json|```/g, "").trim());
    return {
      title: String(p.title ?? ""),
      abstract: String(p.abstract ?? ""),
      keywords: Array.isArray(p.keywords) ? p.keywords.map(String) : [],
      ...(Array.isArray(p.alternatives) ? { alternatives: p.alternatives.map(String) } : {}),
      ...(Array.isArray(p.issues) ? { issues: p.issues.map(String) } : {}),
      ...(p.reason ? { reason: String(p.reason) } : {}),
    };
  } catch {
    return { title: "", abstract: "", keywords: [] };
  }
}

// ═══ UI审计T9 深化: 引用一致 vs 格式语言 两套独立 prompt(一按钮一动作) ═══
export type CitationCheckKind = "consistency" | "format";

const CITATION_KIND: Record<CitationCheckKind, { name: string; prompt: string }> = {
  consistency: {
    name: "引用一致性检查",
    prompt: `你是学术编辑, 只做引文一致性核查(不判断文献真实存在与否, 不查知网, 只做文本内部一致性)。
核查要点: ①正文标注 [N] 与文末文献列表编号是否一一对应 ②是否有正文引用但列表缺失(或反之) ③同一文献多次出现编号是否一致 ④作者姓名/年份在正文与列表是否一致 ⑤编号是否跳号(如 [1][2][4] 缺 [3])。
本检查只报告问题, 给出的修正建议必须用文字描述(例如"为列表第 3 条在正文补 [3] 标注"), 不要输出规范化后的文献列表。
输出 JSON: {"fixes":["问题1(带原文片段, 说明缺少/多了哪条)"],"stats":{"citedInText":正文[N]标注出现次数,"listed":文末文献列表条数}}`,
  },
  format: {
    name: "格式与语言检查",
    prompt: `你是学术编辑, 检查标题编号、图表编号、语言风格和基本格式风险(不判断文献真实存在与否)。
核查要点: ①标题层级编号是否连贯一致(一/二/三 与 1.1/2.1 是否混用) ②图表编号是否连续、是否有"见表x"但表缺失 ③语言风格是否统一(口语化/口号化表述) ④参考文献著录项是否齐全(缺卷期/页码/DOI) ⑤术语与数字用法是否规范。
输出 JSON: {"text":"规范化后的参考文献列表(保留原编号, 缺项用 [?] 占位)","fixes":["修正点1(简述, 如: 章节编号 2.1 与 一、二、 体系混用)"]}`,
  },
};

/** 引文检查: 返回 {text, fixes, stats?}; kind 决定走一致性还是格式语言 */
export async function formatReferences(text: string, kind: CitationCheckKind = "format"): Promise<{ text: string; fixes: string[]; stats?: { citedInText: number; listed: number } }> {
  const spec = CITATION_KIND[kind] ?? CITATION_KIND.format;
  const out = await callLlm(`你是参考文献编辑。任务: ${spec.name}
${spec.prompt}

【原文】
${text.slice(0, 8000)}

只输出 JSON。`, 4000, 0.3);
  try {
    const p = JSON.parse(out.replace(/```json|```/g, "").trim());
    return {
      // 一致性检查只出问题清单; 格式检查才附带规范化后的文献列表
      text: kind === "consistency" ? "" : String(p.text ?? ""),
      fixes: Array.isArray(p.fixes) ? p.fixes.map(String) : [],
      ...(p.stats ? { stats: p.stats } : {}),
    };
  } catch {
    return { text: "", fixes: ["解析失败, 请重试"] };
  }
}
