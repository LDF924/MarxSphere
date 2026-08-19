// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// external-sources-service.ts — MarxSphere 外部数据源服务
// 统一暴露：数据源注册表 + OpenAlex 等开放 API 检索
import { sourcesRegistry, type DataSource } from "./sources-registry.js";

export interface ExternalSourceResult {
  source: string;
  items: Array<Record<string, unknown>>;
  error?: string;
}

// ─── OpenAlex 英文文献检索（免费 API 免 key）───
async function searchOpenAlex(input: {
  query: string;
  perPage?: number;
}): Promise<ExternalSourceResult> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(input.query)}&per-page=${input.perPage ?? 5}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "MarxSphereResearch/1.0" }
    });
    clearTimeout(timeout);
    if (!response.ok) return { source: "openalex", items: [], error: `OpenAlex HTTP ${response.status}` };
    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map((item: any) => ({
          title: item.title ?? "",
          doi: item.doi ?? "",
          year: item.publication_year ?? "",
          venue: item.primary_location?.source?.display_name ?? "",
          authors: (item.authorships ?? []).slice(0, 3).map((a: any) => a.author?.display_name ?? ""),
          cited_by: item.cited_by_count ?? 0,
          url: item.doi ? `https://doi.org/${item.doi.replace("https://doi.org/", "")}` : item.primary_location?.landing_page_url ?? ""
        }))
      : [];
    return { source: "openalex", items: results };
  } catch (error) {
    return { source: "openalex", items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── CORE.ac.uk 检索（开放 API）───
async function searchCore(input: {
  query: string;
  limit?: number;
}): Promise<ExternalSourceResult> {
  try {
    const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(input.query)}&limit=${input.limit ?? 5}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "MarxSphereResearch/1.0" }
    });
    clearTimeout(timeout);
    if (!response.ok) return { source: "core", items: [], error: `CORE HTTP ${response.status}` };
    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map((item: any) => ({
          title: item.title ?? "",
          doi: item.doi ?? "",
          year: item.yearPublished ?? "",
          publisher: item.publisher ?? "",
          authors: (item.authors ?? []).map((a: any) => a.name ?? ""),
          url: item.downloadUrl ?? item.landingPageUrl ?? ""
        }))
      : [];
    return { source: "core", items: results };
  } catch (error) {
    return { source: "core", items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── World Bank Open Knowledge Repository（DSpace v7 API）───
async function searchWorldBank(input: {
  query: string;
  limit?: number;
}): Promise<ExternalSourceResult> {
  try {
    const url = `https://openknowledge.worldbank.org/server/api/discover/search/objects?query=${encodeURIComponent(input.query)}&size=${input.limit ?? 5}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "MarxSphereResearch/1.0" }
    });
    clearTimeout(timeout);
    if (!response.ok) return { source: "worldbank", items: [], error: `WorldBank HTTP ${response.status}` };
    const data = await response.json();

    // DSpace v7: _embedded.searchResult._embedded.objects[]
    const objects = data?._embedded?.searchResult?._embedded?.objects ?? [];
    const results = objects
      .map((obj: any) => {
        const md = obj?._embedded?.indexableObject?.metadata ?? {};
        const getVal = (key: string): string => {
          const arr = md[key];
          return arr && arr.length > 0 ? arr[0].value ?? "" : "";
        };
        return {
          title: getVal("dc.title") || getVal("dc.title.alternative") || "",
          date: getVal("dc.date.issued") || getVal("dc.date") || "",
          authors: [getVal("dc.contributor.author")].filter(Boolean),
          abstract: getVal("dc.description.abstract").slice(0, 200),
          url: obj?._embedded?.indexableObject?._links?.self?.href
            ? `https://openknowledge.worldbank.org${obj._embedded.indexableObject._links.self.href}`
            : ""
        };
      })
      .filter((item: any) => item.title);

    return { source: "worldbank", items: results };
  } catch (error) {
    return { source: "worldbank", items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── GitHub 检索（REST API：仓库/代码/用户/议题）───
// 免 token 匿名 60 次/时；配置 GITHUB_TOKEN 后 5000 次/时且 code 搜索可用。
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() ?? "";
const GITHUB_BASE = "https://api.github.com";

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "MarxSphereResearch/1.0", // GitHub 强制要求 User-Agent
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
  };
}

/** GitHub 搜索（repositories/code/users/issues 四个 scope） */
async function searchGitHub(input: {
  query: string;
  scope?: "repositories" | "code" | "users" | "issues";
  perPage?: number;
}): Promise<ExternalSourceResult> {
  const scope = input.scope ?? "repositories";
  const perPage = Math.min(input.perPage ?? 8, 20);
  const q = encodeURIComponent(input.query.trim());
  if (!q) return { source: "github", items: [], error: "搜索关键词为空" };

  const endpoints: Record<string, string> = {
    repositories: `${GITHUB_BASE}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`,
    code: `${GITHUB_BASE}/search/code?q=${q}+in:file&per_page=${perPage}`,
    users: `${GITHUB_BASE}/search/users?q=${q}+in:login,fullname&per_page=${perPage}`,
    issues: `${GITHUB_BASE}/search/issues?q=${q}+is:issue&sort=updated&order=desc&per_page=${perPage}`
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(endpoints[scope], {
      signal: controller.signal,
      headers: githubHeaders()
    });
    clearTimeout(timeout);

    // 限流 / 认证错误：读响应头给用户明确提示
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (response.status === 401) {
      return { source: "github", items: [], error: "代码搜索需 GITHUB_TOKEN（在 .env 配置后重启）" };
    }
    if (response.status === 403 || response.status === 429 || remaining === "0") {
      return {
        source: "github",
        items: [],
        error: GITHUB_TOKEN
          ? "GitHub 限流（5000 次/时配额已耗尽），请稍后再试"
          : "GitHub 限流：匿名 60 次/时已用完。配置 GITHUB_TOKEN 可提升至 5000 次/时"
      };
    }
    if (!response.ok) return { source: "github", items: [], error: `GitHub HTTP ${response.status}` };

    const data = await response.json();
    const raw = Array.isArray(data?.items) ? data.items : [];
    let items: Array<Record<string, unknown>> = [];

    if (scope === "repositories") {
      items = raw.map((item: any) => ({
        name: item.full_name ?? "",
        description: item.description ?? "",
        stars: item.stargazers_count ?? 0,
        language: item.language ?? "",
        updated_at: item.updated_at ?? "",
        topics: item.topics ?? [],
        url: item.html_url ?? ""
      }));
    } else if (scope === "code") {
      items = raw.map((item: any) => ({
        name: item.name ?? "",
        repo: item.repository?.full_name ?? "",
        path: item.path ?? "",
        url: item.html_url ?? ""
      }));
    } else if (scope === "users") {
      items = raw.map((item: any) => ({
        name: item.login ?? "",
        repos: item.public_repos ?? 0,
        url: item.html_url ?? ""
      }));
    } else if (scope === "issues") {
      items = raw.map((item: any) => ({
        title: item.title ?? "",
        repo: item.repository_url?.replace(`${GITHUB_BASE}/repos/`, "") ?? "",
        state: item.state ?? "",
        created_at: item.created_at ?? "",
        url: item.html_url ?? ""
      }));
    }

    return { source: "github", items };
  } catch (error) {
    return { source: "github", items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── 通用网页源抓取（CDP 驱动 Edge，复用知网经验）───
// 各网页源：CDP 打开首页 → 提取标题/链接列表
const WEB_SOURCE_URLS: Record<string, string> = {
  qstheory: "http://www.qstheory.cn/",
  people_theory: "http://theory.people.com.cn/",
  xuexi: "https://www.xuexi.cn/",
  gmw_theory: "https://theory.gmw.cn/",
  studytimes: "https://www.studytimes.cn/",
  ce_theory: "http://theory.people.com.cn/",
  cssn: "https://www.cssn.cn/",
  aisixiang: "https://www.aisixiang.com/"
};

const CDP_PROXY = "http://localhost:3456";

async function searchWebSource(input: {
  source: string;
  query?: string;
  limit?: number;
}): Promise<ExternalSourceResult> {
  const url = WEB_SOURCE_URLS[input.source];
  if (!url) return { source: input.source, items: [], error: `未知网页源: ${input.source}` };

  try {
    // 1. CDP 打开目标页（后台 tab）
    const { execFileSync } = await import("node:child_process");
    const newOut = execFileSync(
      "curl",
      ["-s", "-m", "25", "-X", "POST", `${CDP_PROXY}/new`, "--data-raw", url],
      { encoding: "utf-8", timeout: 30000 }
    );
    const targetId = JSON.parse(newOut)?.targetId;
    if (!targetId) return { source: input.source, items: [], error: "无法打开网页" };

    // 2. 等加载后提取标题链接（过滤导航/页脚噪音）
    await new Promise((r) => setTimeout(r, 8000));
    const evalExpr = `(() => {
      const NOISE = ["举报", "ICP", "备案", "登录", "注册", "帮助", "关于", "版权", "联系我们", "服务热线", "客户端", "下载", "京公网安备", "网信"];
      const links = Array.from(document.querySelectorAll("a"))
        .filter(a => {
          const t = (a.innerText || "").trim();
          const h = (a.href || "");
          if (t.length < 8 || t.length > 55) return false;
          if (!h.startsWith("http")) return false;
          if (NOISE.some(n => t.includes(n) || h.includes(n))) return false;
          // 优先正文区链接（排除 nav/footer 内）
          const inNav = a.closest("nav, footer, header, [class*=menu], [class*=nav], [class*=footer]");
          if (inNav && !h.includes("qstheory.cn/qiushi") && !h.includes("theory.people")) return false;
          return true;
        })
        .slice(0, ${input.limit ?? 8})
        .map(a => ({ title: (a.innerText || "").trim(), url: a.href }));
      return JSON.stringify(links);
    })()`;
    const tmpFile = `${process.env.TEMP || "/tmp"}/web-src-eval-${Date.now()}.js`;
    const fs = await import("node:fs");
    fs.writeFileSync(tmpFile, evalExpr, "utf-8");
    const evalOut = execFileSync(
      "curl",
      ["-s", "-m", "20", "-X", "POST", `${CDP_PROXY}/eval?target=${targetId}`, "--data-binary", `@${tmpFile}`],
      { encoding: "utf-8", timeout: 25000 }
    );
    fs.unlinkSync(tmpFile);
    const items = JSON.parse(JSON.parse(evalOut)?.value ?? "[]") as Array<{ title: string; url: string }>;

    // 3. 关闭 tab
    try { execFileSync("curl", ["-s", "-m", "5", `${CDP_PROXY}/close?target=${targetId}`], { encoding: "utf-8", timeout: 10000 }); } catch { /* 忽略 */ }

    return { source: input.source, items: items.slice(0, input.limit ?? 8) };
  } catch (error) {
    return { source: input.source, items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export const externalSourcesService = {
  registry: sourcesRegistry,
  searchOpenAlex,
  searchCore,
  searchWorldBank,
  searchWebSource,
  searchGitHub,
  getSourceList: (): DataSource[] => sourcesRegistry.list()
};
