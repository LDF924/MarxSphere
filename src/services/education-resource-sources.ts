// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// education-resource-sources.ts — 教育外部资源源接入（V389）
// 教育复用资产除自建外，可接入外部来源：学校资源库 / 公开平台 / 任意 HTTP JSON 接口。
// 架构：来源注册表（类型 + 适配器）→ 拉取 → 归一化 → 导入资产库（模板/案例/课程切片）
// 适配器模式（对齐 agent-oauth 的 provider 模式）：新来源 = 新增一个 config。
import { pool } from "../db/pool.js";

/** 资源源定义 */
export interface ResourceSource {
  id: string;
  name: string;            // 来源名称（如：学校资源库 / 国家智慧教育平台）
  type: "url" | "api";     // url=直接抓取 JSON 文件；api=接口拉取
  url: string;             // 资源地址
  kind: "templates" | "cases" | "courses";  // 导入到哪类资产
  authHeader?: string;      // 可选认证头（如 Bearer xxx）
  enabled: boolean;
}

/** 预置资源源（可扩展；学校/机构部署时替换为自己的资源库地址） */
const PRESET_SOURCES: ResourceSource[] = [
  {
    id: "school-resource",
    name: "学校资源库",
    type: "url",
    url: "",  // 部署时配置：如 https://edu.example.edu.cn/assets.json
    kind: "courses",
    enabled: false,
  },
  {
    id: "public-platform",
    name: "公开教育平台",
    type: "api",
    url: "",  // 部署时配置
    kind: "cases",
    enabled: false,
  },
];

/** 资源源存储（DB 表 edu_resource_sources；未建表时用内存） */
let memorySources: ResourceSource[] = [...PRESET_SOURCES];

export async function listSources(): Promise<ResourceSource[]> {
  try {
    const r = await pool.query(`select id, name, type, url, kind, auth_header as "authHeader", enabled from edu_resource_sources order by name`);
    const dbSources = r.rows as ResourceSource[];
    if (dbSources.length === 0) return memorySources;
    // 合并：DB 来源 + 预置中不在 DB 的（预置默认展示）
    const dbIds = new Set(dbSources.map((s) => s.id));
    const merged = [...dbSources, ...PRESET_SOURCES.filter((s) => !dbIds.has(s.id))];
    return merged;
  } catch {
    return memorySources;
  }
}

export async function upsertSource(input: ResourceSource): Promise<{ ok: boolean; source?: ResourceSource; error?: string }> {
  // SSRF 防护: 写库前校验 URL 仅允许公网地址（防后续 fetch 打到内网/元数据端点）
  if (input.url) {
    const { assertPublicUrl } = await import("./url-guard.js");
    try {
      await assertPublicUrl(input.url);
    } catch {
      return { ok: false, error: "URL 不允许访问内网/本地地址" };
    }
  }
  // 写库（表不存在则内存）
  try {
    await pool.query(
      `insert into edu_resource_sources (id, name, type, url, kind, auth_header, enabled)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set name = $2, type = $3, url = $4, kind = $5, auth_header = $6, enabled = $7`,
      [input.id, input.name, input.type, input.url, input.kind, input.authHeader || null, input.enabled]
    );
  } catch {
    const i = memorySources.findIndex((s) => s.id === input.id);
    if (i >= 0) memorySources[i] = input; else memorySources.push(input);
  }
  return { ok: true, source: input };
}

/** 拉取外部资源并归一化（url 类型：直接抓 JSON；api 类型：GET 接口取 items） */
export async function fetchFromSource(source: ResourceSource): Promise<{ ok: boolean; items: unknown[]; error?: string }> {
  if (!source.url) return { ok: false, items: [], error: "来源未配置地址（部署时填写资源库 URL）" };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (source.authHeader) headers["Authorization"] = source.authHeader;
    const res = await fetch(source.url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { ok: false, items: [], error: `HTTP ${res.status}` };
    const j = await res.json();
    // 归一化：兼容多种返回结构
    const items = Array.isArray(j) ? j : j.items || j.cases || j.templates || j.courses || (j.data && (Array.isArray(j.data) ? j.data : [])) || [];
    return { ok: true, items };
  } catch (e: any) {
    return { ok: false, items: [], error: String(e?.message || e).slice(0, 120) };
  }
}

/** 把拉取的外部条目导入资产库（按 kind 归入模板/案例/课程） */
export async function importFromSource(input: { sourceId: string }): Promise<Record<string, unknown>> {
  const sources = await listSources();
  const source = sources.find((s) => s.id === input.sourceId);
  if (!source) return { ok: false, error: "来源不存在" };

  const fetched = await fetchFromSource(source);
  if (!fetched.ok) return { ok: false, error: fetched.error || "拉取失败" };

  let imported = 0;
  for (const item of fetched.items as Array<Record<string, unknown>>) {
    const title = String(item.title || item.name || item.heading || "");
    const content = String(item.content || item.description || item.question || "");
    if (!title || !content) continue;

    // courses → source_chunks；templates/cases → 对应 JSON 文件（由 server 层写入）
    if (source.kind === "courses") {
      const exists = await pool.query(`select id from source_chunks where heading = $1 limit 1`, [title]);
      if (exists.rows.length > 0) continue;
      await pool.query(
        `insert into source_chunks (id, source_id, source_type, heading, content, raw_content, rank, metadata)
         values (gen_random_uuid(), $1, 'document', $2, $3, $3, 0, $4)`,
        [process.env.EDU_SOURCE_ID || "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a", title, content,
         JSON.stringify({ subject: item.subject || "外部资源", kind: "示例课程", source: source.name })]
      );
      imported += 1;
    }
  }

  return { ok: true, imported, source: source.name, kind: source.kind, note: imported > 0 ? `从「${source.name}」导入 ${imported} 条` : "无新条目（已存在或格式不匹配）" };
}

export const educationResourceSourcesService = { listSources, upsertSource, fetchFromSource, importFromSource };
