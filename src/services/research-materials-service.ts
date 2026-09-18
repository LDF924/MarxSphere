// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// research-materials-service.ts — SocialSci P0-2: 素材库 CRUD + 跨模块导入钩子
// 形态对齐(闭源产品交互语义, 原创实现): 素材库四类素材 + 从其他模块导入(实证结果/绘图产物/审稿结果)
// 迁移116 research_materials
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
// AI 素材生成补漏组2: LLM 调用
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm } from "../ai/llm-common.js";

/** PG text[] 数组字面量: ["a","b"] → {a,b} */
function toPgArray(items: string[]): string {
  return "{" + items.map((i) => i.replace(/[{}",\\]/g, "")).join(",") + "}";
}

export interface MaterialInput {
  projectId: string;
  userId: string;
  kind: "note" | "citation" | "data_result" | "figure" | "file" | "theory" | "table";
  title?: string;
  contentMd?: string;
  tags?: string[];
  sourceRef?: string;
  producedByDagNode?: string;
  meta?: Record<string, unknown>;
  // SocialSci R3: 完整 schema 扩展列
  summary?: string;
  caption?: string;
  sourceType?: string;
  sourceUrl?: string;
  imagePath?: string;
  tableData?: unknown;
  analysisMethod?: string;
  sectionId?: string;
  /** V417: 挂章数组(section_ids jsonb)。前端读 sectionIds 判断"已关联", 此前只有单数 sectionId 被写 */
  sectionIds?: string[];
  references?: unknown[];
  notes?: string;
  sortOrder?: number;
  /** V417: 本素材条目实际来自哪些检索源(pg/mdlibrary/graphiti/cognee) —— 迁移 149 建的 retrieval_sources 列 */
  retrievalSources?: string[];
  /**
   * 2026-09-15: 建素材时一并落结构化来源文献(检索命中)。此前 source_docs 只有
   * addMaterialSource(挂在 POST /materials/:id/sources 上)能写, 而那个端点前端零调用 ——
   * 「素材来源」弹层点开永远空白。检索结果本来就在手上, 建素材时顺手写掉。
   */
  sourceDocs?: Array<Record<string, unknown>>;
}

export async function createMaterial(input: MaterialInput) {
  const id = randomUUID();
  await pool.query(
    `insert into research_materials
       (id, project_id, user_id, kind, title, content_md, tags, source_ref, produced_by_dag_node, meta, created_by,
        summary, caption, source_type, source_url, image_path, table_data, analysis_method, section_id, references_json, notes, sort_order,
        section_ids, retrieval_sources, source_docs)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$3,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      id, input.projectId, input.userId, input.kind,
      input.title ?? "", input.contentMd ?? "",
      // tags 是 PG text[]: 用数组字面量 {a,b}(JSON 字符串会 malformed array literal)
      toPgArray(input.tags ?? []), input.sourceRef ?? "",
      input.producedByDagNode ?? "", JSON.stringify(input.meta ?? {}),
      input.summary ?? "", input.caption ?? "", input.sourceType ?? "",
      input.sourceUrl ?? "", input.imagePath ?? "", JSON.stringify(input.tableData ?? {}),
      input.analysisMethod ?? "", input.sectionId ?? "",
      JSON.stringify(input.references ?? []), input.notes ?? "", input.sortOrder ?? 0,
      // section_ids 是 jsonb 数组 —— 前端读的就是 sectionIds(/已关联角标、发布门禁都靠它),
      //   此前只有 section_id(单数, text) 这一列被写, 所以那个角标几乎从不出现。
      JSON.stringify(input.sectionIds ?? []),
      // retrieval_sources 是 text[]: 同样用数组字面量
      toPgArray(input.retrievalSources ?? []),
      // source_docs 是 jsonb
      JSON.stringify(input.sourceDocs ?? []),
    ]
  );
  return { id };
}

/**
 * 素材行 → camelCase(列表与单条**共用**, 保证同一份资源两处字段名一致)。
 *
 * 2026-09-16: 单条 `getMaterial` 此前返回**原始蛇形行**(`references_json`/`content_md`/`section_ids`),
 * 而列表返回 camelCase(`references`/`contentMd`/`sectionIds`) —— 同一资源两套命名。
 * 后果是"列表里读得到的字段, 单条读回来叫另一个名字": 前端把单条结果塞回编辑表单时
 * `references` 是 undefined, 一保存就把结构化文献抹掉。
 * 旧蛇形键**原样保留**(`{...m}` 展开的结果)。
 * 2026-09-18: 保留它的原始理由(「React 侧 MaterialsDrawer 直接读 `content_md`」)**已失效** ——
 *   那批 09-06/07 的 React 组件已删(零引用死代码)。现在保留是因为它成了**对外契约的一部分**:
 *   `test/research-exec-engine.test.ts` 与外部 Agent/MCP 消费方可能仍按列名取值,
 *   且删它属于"顺带改契约", 与本改动无关。要收紧就单独开一条, 别混在删除里。
 */
function mapMaterialRow<T extends Record<string, unknown>>(m: T) {
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  const source = (meta.source ?? {}) as Record<string, unknown>;
  return {
    ...m,
    projectId: m.project_id,
    sourceRef: m.source_ref ?? "",
    producedByDagNode: m.produced_by_dag_node ?? "",
    sectionIds: m.section_ids ?? [],
    usageStatus: m.usage_status ?? "candidate",
    contentMd: m.content_md ?? "",
    sourceType: m.source_type ?? "",
    sourceUrl: m.source_url ?? "",
    imagePath: m.image_path ?? "",
    tableData: m.table_data ?? {},
    analysisMethod: m.analysis_method ?? "",
    sectionId: m.section_id ?? "",
    references: m.references_json ?? [],
    platformType: String(meta.platformType ?? m.source_type ?? ""),
    source: { sourceStatus: (meta.sourceStatus ?? source ?? {}) as Record<string, string> },
    createdAt: m.created_at ?? null,
    updatedAt: m.updated_at ?? null,
  };
}

export async function listMaterials(userId: string, projectId?: string, kind?: string) {
  const clauses = ["user_id=$1"];
  const vals: unknown[] = [userId];
  if (projectId) { vals.push(projectId); clauses.push(`project_id=$${vals.length}`); }
  if (kind) { vals.push(kind); clauses.push(`kind=$${vals.length}`); }
  const r = await pool.query(
    `select id, project_id, kind, title, tags, source_ref, produced_by_dag_node, section_ids, usage_status,
            content_md, caption, summary, source_type, source_url, image_path, table_data, analysis_method,
            section_id, references_json, meta, created_at, updated_at
       from research_materials where ${clauses.join(" and ")}
      order by created_at desc limit 200`,
    vals
  );
  // 富列 camelCase 映射(与单条 getMaterial 共用同一个 mapMaterialRow, 避免两处漂移)
  return r.rows.map(mapMaterialRow);
}

export async function getMaterial(userId: string, materialId: string) {
  const r = await pool.query(
    `select * from research_materials where id=$1 and user_id=$2`,
    [materialId, userId]
  );
  // 与列表同一个形状(见 mapMaterialRow 注释: 两处字段名不一致会让编辑表单丢 references)
  return r.rows[0] ? mapMaterialRow(r.rows[0]) : null;
}

/**
 * 局部更新素材。
 *
 * `references` 是**结构化文献数组**(jsonb 列 references_json), 2026-09-16 补上 ——
 * 此前只有 createMaterial 能写它, PUT 写不了, 于是「编辑」一条文献素材会把它已有的
 * 结构化条目抹掉(PUT 只带 title/contentMd)。前端文献卡、GB/T 7714 引用、参考文献池
 * 都依赖这个字段, 不能是"创建时才有、一编辑就没"。
 */
export async function updateMaterial(userId: string, materialId: string, patch: { title?: string; contentMd?: string; tags?: string[]; kind?: string; references?: unknown[] }) {
  const sets: string[] = ["updated_at=now()"];
  const vals: unknown[] = [materialId, userId];
  /**
   * 入参是 **camelCase**(前端/接口层口径), 列是 snake_case —— 必须显式映射。
   *
   * 2026-09-16 修: 这里原先把键名**直接当列名**拼进 SQL(`contentMd=$3`)。PG 的标识符会被
   * 折叠成小写, 于是变成 `contentmd = $3` → `column "contentmd" does not exist`。
   * 后果: 编辑**任何**素材都会失败(前端 toast「更新失败」), 因为保存链必带 contentMd。
   * 只对 key 做白名单映射, 未列出的键一律忽略 —— 免得又是"把请求体当列名用"。
   */
  const COL: Record<string, string> = {
    title: "title",
    contentMd: "content_md",
    tags: "tags",
    kind: "kind",
    references: "references_json",
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = COL[k];
    if (!col) continue;
    if (k === "references") {
      sets.push(`${col}=$${vals.length + 1}::jsonb`);
      vals.push(JSON.stringify(v ?? []));
      continue;
    }
    sets.push(`${col}=$${vals.length + 1}`);
    // tags 是 PG text[]: 数组字面量; 其余原样
    vals.push(k === "tags" && Array.isArray(v) ? toPgArray(v as string[]) : v);
  }
  const r = await pool.query(
    `update research_materials set ${sets.join(",")} where id=$1 and user_id=$2 returning id`,
    vals
  );
  return r.rows[0] ?? null;
}

export async function deleteMaterial(userId: string, materialId: string) {
  const r = await pool.query(
    `delete from research_materials where id=$1 and user_id=$2 returning id`,
    [materialId, userId]
  );
  return r.rows[0] ?? null;
}

/** 素材排序重排(前端拖拽): 不落库排序位, 按 created_at; 预留接口语义 */
export async function reorderMaterials(userId: string, ids: string[]) {
  // 素材无独立排序字段, 用数组顺序更新时间戳(小写越前越新), 保持幂等
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (let i = 0; i < ids.length; i++) {
      const offset = Math.max(0, 200 - i); // 越靠前 updated_at 越近 now
      await client.query(
        `update research_materials set updated_at=now() - ($2 || ' seconds')::interval
          where id=$1 and user_id=$3`,
        [ids[i], offset, userId]
      );
    }
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** 素材上下文(供写作节点注入): 按 kind 分组截断, 返回可嵌入 prompt 的文本 */
export async function buildMaterialsContext(userId: string, projectId: string, maxKinds = 6): Promise<string> {
  const mats = await listMaterials(userId, projectId);
  if (!mats.length) return "";
  const groups = new Map<string, string[]>();
  for (const m of mats) {
    const full = await getMaterial(userId, m.id);
    if (!full) continue;
    const head = `【${m.kind}·${m.title || "未命名"}】\n${String(full.content_md ?? "").slice(0, 500)}`;
    const arr = groups.get(m.kind) ?? [];
    arr.push(head);
    groups.set(m.kind, arr);
  }
  const parts: string[] = [];
  for (const [kind, arr] of groups) {
    if (parts.length >= maxKinds) break;
    parts.push(arr.slice(0, 3).join("\n"));
  }
  return parts.join("\n\n");
}

// ═══ SocialSci 补漏组2: 素材深层操作 ═══
/** 素材来源文献(引文摘要/出处; source_docs 字段结构化) */
export async function getMaterialSources(userId: string, materialId: string) {
  const m = await getMaterial(userId, materialId);
  if (!m) return null;
  return { materialId: m.id, sources: m.source_docs ?? [], sourceRef: m.source_ref ?? "" };
}

/** 追加素材来源文献 */
export async function addMaterialSource(userId: string, materialId: string, doc: { id?: string; title?: string; authors?: string; year?: number; excerpt?: string }) {
  const m = await getMaterial(userId, materialId);
  if (!m) return null;
  const docs = [...(m.source_docs ?? []), doc];
  await pool.query(`update research_materials set source_docs=$3 where id=$1 and user_id=$2`,
    [materialId, userId, JSON.stringify(docs)]);
  return { ok: true };
}

/** 素材采纳(adopted)→ 挂章节: materialUsages 语义 */
export async function adoptMaterial(userId: string, materialId: string, sectionIds: string[]) {
  const r = await pool.query(
    `update research_materials set usage_status='adopted', section_ids=$3 where id=$1 and user_id=$2 returning id`,
    [materialId, userId, JSON.stringify(sectionIds)]);
  return r.rows[0] ? { ok: true } : { ok: false, error: "素材不存在" };
}

/** 内容哈希(去重/溯源; HAR: wfart.contentHash) */
export function contentHashOf(payload: unknown): string {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** AI 生成素材(按目标章节+主题 → 结构化素材; LLM 输出, 失败降级错误) */
export async function aiGenerateMaterial(userId: string, projectId: string, input: {
  targetSectionId?: string; sectionTitle?: string; count?: number; topic?: string; prompt?: string;
}): Promise<{ ok: boolean; materials?: unknown[]; error?: string }> {
  const count = Math.min(10, Math.max(1, input.count ?? 3));
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是社科研究素材生成器。为论文章节生成学术素材清单, 输出 JSON:
{"materials":[{"title":"素材名","kind":"note|citation|data_result|theory","content":"素材正文(300字内, 学术化, 不编造具体文献—引用处用[待补引文])","tags":["标签"]}]}

【目标章节】${input.sectionTitle || input.targetSectionId || "未指定"}
【研究主题】${input.topic || "未指定"}
${input.prompt && input.prompt !== "无" ? `【附加要求】${input.prompt}` : ""}` }],
    temperature: 0.7, maxTokens: 4096, timeoutMs: 240_000,
  });
  const text = res?.text ?? "";
  let list: unknown[] = [];
  try { list = JSON.parse(text.replace(/```json|```/g, "").trim())?.materials ?? []; } catch { /* 解析失败走空 */ }
  if (!Array.isArray(list) || !list.length) return { ok: false, error: "AI 未能生成素材, 请重试" };
  const out = (list as Array<{ title: string; kind?: string; content: string; tags?: string[] }>).slice(0, count);
  // 落库
  const created: unknown[] = [];
  for (const m of out) {
    const { id } = await createMaterial({
      projectId, userId: userId, kind: ((m.kind ?? "note") as never),
      title: m.title, contentMd: m.content, tags: m.tags ?? [],
      producedByDagNode: input.targetSectionId ?? "",
    });
    created.push({ id, title: m.title, kind: m.kind ?? "note" });
  }
  return { ok: true, materials: created };
}

// ═══ UI审计T7: 参考文献批量解析(粘贴文献列表 → 结构化条目, 供人工核对) ═══
export function parseReferences(raw: string): Array<{ no: number; authors: string; year: string; title: string; source: string; raw: string; valid: boolean }> {
  const lines = raw.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 5);
  const items: Array<{ no: number; authors: string; year: string; title: string; source: string; raw: string; valid: boolean }> = [];
  for (const line of lines) {
    // 去 [N] 前缀
    const m = line.match(/^\s*\[(\d+)\]\s*(.*)$/);
    const body = (m ? m[2] : line).trim();
    if (!body) continue;
    // GB/T7714: 作者. 标题[J/C/D/M]. 刊名, 年(期): 页.
    const g = body.match(/^(.+?)\.\s*(.+?)\s*\[([A-Z])\]\s*\.\s*(.+?)(?:,|\.)\s*(\d{4})/);
    if (g) {
      items.push({ no: items.length + 1, authors: g[1], title: g[2], source: g[4], year: g[5], raw: body, valid: true });
    } else {
      items.push({ no: items.length + 1, authors: "", year: "", title: "", source: "", raw: body, valid: false });
    }
  }
  return items;
}

// ═══ 体验厚度: AI 素材审视(质量/相关/建议) ═══
export async function reviewMaterial(userId: string, materialId: string, topic?: string) {
  const m = await getMaterial(userId, materialId);
  if (!m) return { ok: false as const, error: "素材不存在" };
  const content = String(m.content_md ?? "").slice(0, 3000);
  if (!content.trim()) return { ok: false as const, error: "素材内容为空" };
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是社科研究素材审阅专家。审视下列素材, 输出 JSON:
{"quality":"high|medium|low","score":0-100,"assessment":"素材质量评估(80字内: 来源可信度/内容完整度/学术规范性)","relevance":"与研究的匹配度(60字内)","suggestions":["改进建议1(具体可执行)","建议2"]}

${topic ? `【研究主题】${topic.slice(0, 200)}` : ""}
【素材类型】${m.kind} · 【标题】${m.title ?? "未命名"}
【内容】
${content}` }],
    temperature: 0.3, maxTokens: 1500, timeoutMs: 120_000,
  });
  const text = res?.text ?? "";
  try {
    const p = JSON.parse(text.replace(/```json|```/g, "").trim());
    return { ok: true as const, review: { quality: p.quality ?? "medium", score: p.score ?? 0, assessment: p.assessment ?? "", relevance: p.relevance ?? "", suggestions: Array.isArray(p.suggestions) ? p.suggestions : [] } };
  } catch {
    return { ok: false as const, error: "AI 审视结果解析失败" };
  }
}

// ═══ T4-4: AI 自动编排素材到章节(对齐闭源 MaterialsView allocateMaterials) ═══
// LLM 读「未挂章素材 + 一级章节清单」→ 每条素材建议目标章节 + 理由; 前端确认后逐条 adopt
export async function allocateMaterialsToSections(userId: string, projectId: string): Promise<{
  ok: boolean; suggestions?: Array<{ materialId: string; materialTitle: string; sectionId: string | null; sectionTitle: string; reason: string }>; error?: string;
}> {
  // 未挂章素材(无 section_ids 或空数组)
  const mats = await pool.query(
    `select id, title, kind, content_md, section_ids
       from research_materials
      where project_id=$1 and user_id=$2
        and (section_ids is null or jsonb_array_length(section_ids::jsonb)=0)
      order by created_at limit 12`, [projectId, userId]);
  const sections = await pool.query(
    `select payload->'sections' as secs from research_nodes where project_id=$1 and node_key='sections'`, [projectId]);
  const list = (sections.rows[0]?.secs ?? []) as Array<{ id: string; title: string; level: number }>;
  const top = list.filter((s) => s.level === 1);
  if (!mats.rows.length) return { ok: true as const, suggestions: [] };
  if (!top.length) return { ok: false as const, error: "请先完成科研架构(生成章节清单)" };
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: `你是社科论文素材编排专家。把素材分配到最合适的一级章节, 输出 JSON:
{"assignments":[{"materialId":"素材id","sectionId":"章节id","reason":"匹配理由(40字内)"}]}

一级章节:
${top.map((s) => `${s.id} | ${s.title}`).join("\n")}

待编排素材:
${mats.rows.map((m) => `id=${m.id} | 类型=${m.kind} | 标题=${(m.title ?? "未命名").slice(0, 50)} | 内容=${String(m.content_md ?? "").slice(0, 120).replace(/\n/g, " ")}`).join("\n")}

规则: 每条素材只配一个最相关章节; 若与任何章节都不匹配输出 null 目标。` }],
    temperature: 0.2, maxTokens: 2500, timeoutMs: 120_000,
  });
  const text = res?.text ?? "";
  try {
    const p = JSON.parse(text.replace(/```json|```/g, "").trim());
    const assigns = Array.isArray(p.assignments) ? p.assignments : [];
    const byId = new Map(mats.rows.map((m) => [String(m.id), m]));
    const bySec = new Map(top.map((s) => [String(s.id), s]));
    const suggestions = assigns.slice(0, 12).map((a: { materialId?: string; sectionId?: string | null; reason?: string }) => {
      const m = byId.get(String(a.materialId ?? ""));
      const s = a.sectionId ? bySec.get(String(a.sectionId)) : null;
      if (!m) return null;
      return {
        materialId: String(m.id),
        materialTitle: String(m.title ?? "未命名"),
        sectionId: s ? String(s.id) : null,
        sectionTitle: s ? String(s.title) : "(不匹配)",
        reason: String(a.reason ?? "").slice(0, 80),
      };
    }).filter((x: unknown): x is { materialId: string; materialTitle: string; sectionId: string | null; sectionTitle: string; reason: string } => !!x);
    return { ok: true as const, suggestions };
  } catch {
    return { ok: false as const, error: "AI 编排建议解析失败, 请重试" };
  }
}
