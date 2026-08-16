import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * sciverse-service — Sciverse 外部学术检索 REST 客户端封装
 *
 * 6 工具：search_papers / semantic_search / list_catalog /
 *         list_paper_relations / read_content / get_resource
 *
 * 认证：SCIVERSE_API_TOKEN env → ~/.sciverse/credentials.json
 * 无 key 时进入 mock 模式（configured:false + 罐头数据），UI 可开发演示。
 * 错误映射：401(未配置/失效) / 429(配额) / 超时重试。
 *
 * 参考：~/.claude/skills/sciverse/references/TOOLS_REFERENCE.md
 */

const BASE_URL = process.env.SCIVERSE_BASE_URL || "https://api.sciverse.space";
const PLACEHOLDER = "sv-PLACEHOLDER";

export interface SciverseResult {
  configured: boolean;
  tool: string;
  mock: boolean;
  data: unknown;
  error?: string;
  meta?: {
    query?: string;
    tookMs?: number;
  };
}

function readTokenFromEnv(): string {
  return process.env.SCIVERSE_API_TOKEN || "";
}

function readTokenFromCredentialsFile(): string {
  try {
    const home = os.homedir();
    const file = path.join(home, ".sciverse", "credentials.json");
    if (!fs.existsSync(file)) return "";
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed?.api_key || parsed?.token || "";
  } catch {
    return "";
  }
}

function resolveToken(): string {
  const fromEnv = readTokenFromEnv();
  if (fromEnv) return fromEnv;
  return readTokenFromCredentialsFile();
}

export function isSciverseConfigured(): boolean {
  const token = resolveToken();
  return Boolean(token) && token !== PLACEHOLDER && !token.includes("请到sciverse.space申请");
}

async function request(pathWithQuery: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const url = `${BASE_URL}${pathWithQuery}`;
  const token = resolveToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    if (response.status === 401) {
      throw new SciverseError("SCIVERSE_UNAUTHORIZED", "未配置或无效的 SCIVERSE_API_TOKEN，请到 sciverse.space 控制台申请");
    }
    if (response.status === 429) {
      throw new SciverseError("SCIVERSE_RATE_LIMIT", "Sciverse 配额耗尽（429），请查看控制台配额或升级 Tier");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SciverseError(`SCIVERSE_HTTP_${response.status}`, text.slice(0, 300) || `Sciverse 请求失败 (${response.status})`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof SciverseError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SciverseError("SCIVERSE_TIMEOUT", "Sciverse 请求超时，请检查网络（可能需要代理）");
    }
    throw new SciverseError("SCIVERSE_NETWORK", `Sciverse 网络错误：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

class SciverseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ─── Mock 数据（无 key 时降级演示用）───
function mockCatalog() {
  return {
    mock: true,
    fields: [
      { name: "title", type: "string", filterable: true, sortable: false },
      { name: "authors", type: "string[]", filterable: true, sortable: false },
      { name: "year_from", type: "integer", filterable: true, sortable: true },
      { name: "journals", type: "string[]", filterable: true, sortable: false },
      { name: "subjects", type: "string[]", filterable: true, sortable: false },
      { name: "language", type: "enum", filterable: true, sortable: false, sample_values: ["en", "zh"] },
      { name: "access_is_oa", type: "boolean", filterable: true, sortable: false },
      { name: "doi", type: "string", filterable: true, sortable: false }
    ]
  };
}

function mockSemanticSearch(query: string) {
  return {
    mock: true,
    results: [
      {
        chunk_id: "mock-chunk-1",
        doc_id: "mock-doc-1",
        title: "工商资本下乡与农村集体经济发展研究综述",
        chunk: "资本下乡是近年来农业农村现代化进程中的显著现象，其对农村集体经济发展的影响机制、利益分配与风险防控是学界关注的焦点问题。",
        score: 0.87,
        offset: 0,
        abstract: "综述了资本下乡的双重效应与政策引导路径。",
        is_mock: true
      },
      {
        chunk_id: "mock-chunk-2",
        doc_id: "mock-doc-2",
        title: "Rural Revitalization and Land Transfer in China",
        chunk: "Land transfer plays a crucial role in rural revitalization, affecting collective economy and farmers' welfare.",
        score: 0.72,
        offset: 512,
        abstract: "Examines land transfer's impact on rural collective economy.",
        is_mock: true
      }
    ]
  };
}

function mockSearchPapers(params: Record<string, unknown>) {
  return {
    mock: true,
    total: 2,
    results: [
      {
        unique_id: "mock-paper-1",
        doc_id: "mock-doc-1",
        title: "工商资本下乡与农村集体经济发展研究综述",
        author: "示例作者",
        abstract: "资本下乡的双重效应、机制与政策引导。",
        publication_published_year: 2024,
        publication_venue_name_unified: "中国农村经济",
        language: "zh",
        is_content_accessible: false,
        is_mock: true
      },
      {
        unique_id: "mock-paper-2",
        doc_id: "mock-doc-2",
        title: "Rural Revitalization and Land Transfer in China",
        author: "Example Author",
        abstract: "Land transfer and collective economy.",
        publication_published_year: 2023,
        publication_venue_name_unified: "China Agricultural Economic Review",
        language: "en",
        is_content_accessible: true,
        is_mock: true
      }
    ]
  };
}

function mockReadContent(docId: string, offset: number) {
  return {
    mock: true,
    doc_id: docId,
    offset,
    text: "（Mock 模式）此处为文献原文片段。配置 SCIVERSE_API_TOKEN 后可获取真实全文。",
    bytes_returned: 40,
    more: false,
    is_mock: true
  };
}

function mockRelations(uniqueId: string) {
  return {
    mock: true,
    unique_id: uniqueId,
    relation: "REFERENCES",
    total_count: 3,
    results: [
      { unique_id: "mock-ref-1", title: "农村集体产权制度改革研究", year: 2019 },
      { unique_id: "mock-ref-2", title: "Land Reform and Rural Economy", year: 2020 },
      { unique_id: "mock-ref-3", title: "工商资本参与乡村振兴的路径研究", year: 2022 }
    ],
    is_mock: true
  };
}

async function dispatch(tool: string, params: Record<string, unknown>): Promise<SciverseResult> {
  const configured = isSciverseConfigured();
  const startedAt = Date.now();

  // 双模式：mode="mock" 强制沙箱；mode="online" 强制在线；缺省按 configured 自动
  const mode = String(params.mode ?? "auto");
  const forceMock = mode === "mock";
  const forceOnline = mode === "online";

  if ((!configured && !forceOnline) || forceMock) {
    let data: unknown;
    switch (tool) {
      case "catalog":
        data = mockCatalog();
        break;
      case "semantic_search":
        data = mockSemanticSearch(String(params.query ?? ""));
        break;
      case "search_papers":
        data = mockSearchPapers(params);
        break;
      case "read_content":
        data = mockReadContent(String(params.doc_id ?? ""), Number(params.offset ?? 0));
        break;
      case "relations":
        data = mockRelations(String(params.unique_id ?? ""));
        break;
      default:
        data = { mock: true, message: `未实现 mock: ${tool}` };
    }
    return {
      configured,
      tool,
      mock: true,
      data,
      meta: { query: String(params.query ?? ""), tookMs: Date.now() - startedAt }
    };
  }

  try {
    let data: unknown;
    switch (tool) {
      case "catalog":
        data = await request(`/meta-catalog?collection=${encodeURIComponent(String(params.collection ?? "papers"))}`);
        break;
      case "semantic_search":
        data = await request("/agentic-search", {
          method: "POST",
          body: {
            query: params.query,
            top_k: Number(params.top_k ?? 10),
            source_types: params.source_types,
            mode: params.mode
          }
        });
        break;
      case "search_papers": {
        const body: Record<string, unknown> = {
          collection: params.collection ?? "papers",
          page: Number(params.page ?? 1),
          page_size: Number(params.page_size ?? 20)
        };
        if (params.query) body.query = params.query;
        if (params.title_contains) body.title_contains = params.title_contains;
        if (params.authors) body.authors = params.authors;
        if (params.year_from) body.year_from = Number(params.year_from);
        if (params.year_to) body.year_to = Number(params.year_to);
        if (params.language) body.filters_advanced = [{ field: "language", operator: "FILTER_OP_EQ", value: params.language }];
        if (params.filters_advanced) body.filters_advanced = params.filters_advanced;
        data = await request("/meta-search", { method: "POST", body });
        break;
      }
      case "read_content":
        data = await request(`/content?doc_id=${encodeURIComponent(String(params.doc_id))}&offset=${Number(params.offset ?? 0)}&limit=${Number(params.limit ?? 8192)}`);
        break;
      case "relations":
        data = await request("/meta-paper-relations", {
          method: "POST",
          body: {
            unique_id: params.unique_id,
            relation: params.relation ?? "REFERENCES",
            page: Number(params.page ?? 1),
            page_size: Number(params.page_size ?? 20)
          }
        });
        break;
      case "get_resource":
        data = await request(`/resource?file_name=${encodeURIComponent(String(params.file_name))}`);
        break;
      default:
        throw new SciverseError("SCIVERSE_UNKNOWN_TOOL", `未知工具: ${tool}`);
    }
    return {
      configured,
      tool,
      mock: false,
      data,
      meta: { query: String(params.query ?? ""), tookMs: Date.now() - startedAt }
    };
  } catch (error) {
    if (error instanceof SciverseError) {
      return { configured, tool, mock: false, data: null, error: `${error.code}: ${error.message}` };
    }
    return { configured, tool, mock: false, data: null, error: String(error) };
  }
}

export const sciverseService = {
  isConfigured: isSciverseConfigured,
  dispatch,
  getBaseUrl: () => BASE_URL
};
