// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/search-provider-registry.ts — V404-24(H5): 检索 provider 目录
// 借鉴 OpenSquilla search/{registry,types,retry_policy}(capability 集 + fallback 链), 自写 TS:
//   - provider spec 单一真源: provider_id/capabilities(web/freshness/content/domain_filter)/requires_key/env_key
//   - 按请求能力过滤 → 活跃 provider 排序(有 key 的 API provider 优先, 本地 Edge 抓取兜底)
//   - fallback 链: 主 provider 失败 → 下一个能力足够的自动切换(网络级/认证级错误分类)
//   - Bocha(博查)一等公民: 国内直连 + 有 key 时优先; 摘要即 content, 免二次抓取
// 现有 Edge 无头抓取(agent-tool-router web_search)保留为 provider: edge_bing(默认兜底)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type SearchCapability = "web" | "freshness" | "content" | "domain_filter" | "no_key" | "semantic";
export type SearchErrorKind = "auth" | "rate_limit" | "timeout" | "network" | "http" | "parse" | "blocked" | "unknown";

export interface SearchProviderSpec {
  providerId: string;
  label: string;
  requiresApiKey?: boolean;
  envKey?: string;
  capabilities: SearchCapability[];
  /** 国内直连优先(无墙) */
  cnFriendly?: boolean;
  /** 有 key 时优先于无 key provider */
  preferredWhenKeyed?: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  provider: string;
  publishedAt?: string | null;
}

export interface ProviderSearchOptions {
  query: string;
  maxResults?: number;
  recency?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
}

export interface ProviderSearchResult {
  ok: boolean;
  hits?: SearchHit[];
  error?: string;
  errorKind?: SearchErrorKind;
}

/** 单 provider 适配器接口 */
export interface SearchProviderAdapter {
  providerId: string;
  search(opts: ProviderSearchOptions): Promise<ProviderSearchResult>;
}

// ═══ 注册表(spec 单一真源) ═══
export const SEARCH_PROVIDER_SPECS: SearchProviderSpec[] = [
  { providerId: "bocha", label: "博查(国内直连)", requiresApiKey: true, envKey: "BOCHA_SEARCH_API_KEY", capabilities: ["web", "freshness", "content"], cnFriendly: true, preferredWhenKeyed: true },
  { providerId: "tavily", label: "Tavily", requiresApiKey: true, envKey: "TAVILY_API_KEY", capabilities: ["web", "freshness", "domain_filter"], preferredWhenKeyed: true },
  { providerId: "exa", label: "Exa", requiresApiKey: true, envKey: "EXA_API_KEY", capabilities: ["web", "freshness", "semantic", "content"], preferredWhenKeyed: true },
  { providerId: "edge_bing", label: "Edge 无头抓取(默认)", capabilities: ["web", "no_key"] },
];

export function providerSpec(id: string): SearchProviderSpec | undefined {
  return SEARCH_PROVIDER_SPECS.find((p) => p.providerId === id);
}

/** provider 是否可用(有 key 或 no_key) */
export function providerAvailable(spec: SearchProviderSpec): boolean {
  if (!spec.requiresApiKey) return true;
  return !!process.env[spec.envKey || ""];
}

/**
 * 选择 provider 顺序: 有 key 的 API provider 优先(preferredWhenKeyed), 本地 Edge 兜底。
 * 排序: cnFriendly 加分 → 需 key 且有 key 加分 → 无 key 保底。
 */
export function rankedProviders(need: SearchCapability[] = ["web"]): SearchProviderSpec[] {
  const usable = SEARCH_PROVIDER_SPECS.filter((p) => providerAvailable(p) && need.every((c) => p.capabilities.includes(c)));
  const score = (p: SearchProviderSpec): number =>
    (p.cnFriendly ? 100 : 0) + (p.preferredWhenKeyed ? 50 : 0) + (p.requiresApiKey ? 0 : 10);
  return [...usable].sort((a, b) => score(b) - score(a));
}

// ═══ provider 适配器 ═══

/** Bocha 博查 API(国内直连; 需要 BOCHA_SEARCH_API_KEY; 响应摘要即 content 免二次抓取) */
export class BochaSearchProvider implements SearchProviderAdapter {
  providerId = "bocha";
  private key: string;
  constructor(key?: string) {
    this.key = key || process.env.BOCHA_SEARCH_API_KEY || "";
  }
  async search(opts: ProviderSearchOptions): Promise<ProviderSearchResult> {
    if (!this.key) return { ok: false, error: "缺 BOCHA_SEARCH_API_KEY", errorKind: "auth" };
    try {
      const body: Record<string, unknown> = {
        query: opts.query,
        count: Math.min(opts.maxResults || 10, 20),
        summarize: true, // 博查摘要 → content(免二次抓取)
      };
      if (opts.recency) body.freshness = opts.recency;
      const resp = await fetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      if (!resp.ok) {
        const kind: SearchErrorKind = resp.status === 401 || resp.status === 403 ? "auth" : resp.status === 429 ? "rate_limit" : "http";
        return { ok: false, error: `Bocha HTTP ${resp.status}`, errorKind: kind };
      }
      const data: any = await resp.json();
      const pages = data?.data?.webPages?.value || data?.data?.webPages || data?.webPages || [];
      const hits: SearchHit[] = pages.map((p: any) => ({
        title: String(p.title || p.name || ""),
        url: String(p.url || ""),
        snippet: String(p.summary || p.snippet || p.description || ""),
        provider: "bocha",
        publishedAt: p.dateLastCrawled || p.publishedDate || null,
      })).filter((h: SearchHit) => h.url && h.title);
      return { ok: true, hits: hits.slice(0, opts.maxResults || 10) };
    } catch (e: any) {
      const kind: SearchErrorKind = /timeout|abort/i.test(String(e?.message || "")) ? "timeout" : "network";
      return { ok: false, error: String(e?.message || e).slice(0, 120), errorKind: kind };
    }
  }
}

/** Edge 无头抓取 Bing(保留 web_search 既有逻辑; no_key 兜底) */
export class EdgeBingSearchProvider implements SearchProviderAdapter {
  providerId = "edge_bing";
  constructor(private edgePath: string) {}
  async search(opts: ProviderSearchOptions): Promise<ProviderSearchResult> {
    const query = opts.query;
    const maxResults = Math.min(opts.maxResults || 5, 10);
    const suffix = /(论文|研究|文献)/.test(query) ? "" : " 研究";
    const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query + suffix)}`;
    try {
      const execFileAsync = promisify(execFile);
      const tmpDir = path.join(os.tmpdir(), "sag-search");
      mkdirSync(tmpDir, { recursive: true });
      const outFile = path.join(tmpDir, `search-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`);
      let html = "";
      try {
        await execFileAsync(this.edgePath, [
          "--headless", "--disable-gpu", "--dump-dom", "--virtual-time-budget=4000",
          `--user-data-dir=${path.join(tmpDir, "profile")}`, searchUrl,
        ], { timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true })
          .then(({ stdout }) => writeFileSync(outFile, stdout, "utf8"))
          .catch((e) => writeFileSync(outFile, String(e?.stdout || e?.stderr || e), "utf8"));
      } catch { /* Edge 不可用 */ }
      html = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
      if (!html) {
        const resp = await fetch(searchUrl, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, errorKind: resp.status === 429 ? "rate_limit" : "http" };
        const text = (await resp.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return { ok: true, hits: text ? [{ title: query, url: searchUrl, snippet: text.slice(0, 1500), provider: "edge_bing" }] : [] };
      }
      const hits: SearchHit[] = [];
      const algoBlocks = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"/i).slice(1);
      const clean = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      for (const block of algoBlocks.slice(0, maxResults)) {
        const title = clean((block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || "");
        const url = ((block.match(/<a[^>]*href="([^"]+)"/i) || [])[1] || "").trim();
        const snippet = clean((block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "");
        if (title && url) hits.push({ title: title.slice(0, 120), url: url.slice(0, 200), snippet: snippet.slice(0, 200), provider: "edge_bing" });
      }
      return { ok: true, hits };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 150), errorKind: "unknown" };
    }
  }
}

// ═══ 统一入口: 能力过滤 + 排序 + fallback 链 ═══
export interface RegistrySearchResult {
  ok: true;
  provider: string;
  hits: SearchHit[];
  /** 实际尝试过的 provider 链 */
  attempted: string[];
}

/**
 * 统一搜索: 按能力选 provider 列表 → 逐个尝试(错误分类决定是否继续):
 * auth/blocked → 跳过该 provider 试下一个; 其余失败 → 试下一个(网络级 fallback)。
 * 全部失败 → 返回最后错误。
 */
export async function searchWithRegistry(
  query: string,
  opts: { maxResults?: number; providers?: string[]; recency?: "day" | "week" | "month" | "year"; edgePath?: string } = {}
): Promise<{ ok: true; provider: string; hits: SearchHit[]; attempted: string[] } | { ok: false; error: string; attempted: string[] }> {
  const need: SearchCapability[] = ["web"];
  let pool = opts.providers && opts.providers.length > 0
    ? opts.providers.map((id) => providerSpec(id)).filter((x): x is SearchProviderSpec => !!x)
    : rankedProviders(need);
  if (opts.recency) pool = pool.filter((p) => p.capabilities.includes("freshness"));
  const attempted: string[] = [];
  for (const spec of pool) {
    attempted.push(spec.providerId);
    let adapter: SearchProviderAdapter;
    if (spec.providerId === "bocha") adapter = new BochaSearchProvider();
    else if (spec.providerId === "edge_bing") adapter = new EdgeBingSearchProvider(opts.edgePath || "");
    else continue; // 未实现 provider 跳过
    const r = await adapter.search({ query, maxResults: opts.maxResults || 8, recency: opts.recency });
    if (r.ok && r.hits && r.hits.length > 0) {
      return { ok: true, provider: spec.providerId, hits: r.hits, attempted };
    }
    if (!r.ok && (r.errorKind === "auth" || r.errorKind === "blocked")) {
      // 认证缺失直接跳过本 provider(不浪费 fallback 时间)
      continue;
    }
  }
  return { ok: false, error: `全部搜索 provider 失败(尝试: ${attempted.join(" → ")})`, attempted };
}


export const searchProviderRegistry = { providerSpec, rankedProviders, searchWithRegistry, SEARCH_PROVIDER_SPECS, BochaSearchProvider, EdgeBingSearchProvider };
