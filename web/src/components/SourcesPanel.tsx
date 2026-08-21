// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// SourcesPanel.tsx — MarxSphere 统一数据源面板（29 个外部源）
// 按状态展示：已接入 / 可接入 / 需注册。含 OpenAlex/CORE 英文文献检索。
import { useState, useEffect, type FC } from "react";
import { Database, Loader2, Search, Globe, Lock, CheckCircle2, ExternalLink, RefreshCw, Download } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import type { DataSourceRecord } from "../types";

const STATUS_LABELS: Record<string, string> = {
  active: "已接入",
  ready: "可接入",
  requires_auth: "需注册/权限"
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  ready: "bg-blue-100 text-blue-700",
  requires_auth: "bg-yellow-100 text-yellow-700"
};

const TYPE_LABELS: Record<string, string> = {
  api: "开放 API",
  web: "网页转 PDF",
  mcp: "MCP",
  auth: "注册制"
};

export function SourcesPanel() {
  const [sources, setSources] = useState<DataSourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "active" | "ready" | "requires_auth">("all");
  // 外部源检索
  const [oaQuery, setOaQuery] = useState("");
  const [oaResults, setOaResults] = useState<Array<Record<string, unknown>>>([]);
  const [oaLoading, setOaLoading] = useState(false);
  const [extSource, setExtSource] = useState<string>("openalex");
  // V412: URL 一键导入
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlResult, setUrlResult] = useState<{ ok: boolean; title?: string; chunks?: number; error?: string } | null>(null);

  const importUrl = async () => {
    const url = urlInput.trim();
    if (!url || urlLoading) return;
    setUrlLoading(true);
    setUrlResult(null);
    try {
      const r = await fetch("/api/sources/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const d = await r.json();
      setUrlResult(d);
      if (d.ok) { setUrlInput(""); void loadSources(); }
    } catch {
      setUrlResult({ ok: false, error: "请求失败，请重试" });
    }
    setUrlLoading(false);
  };
  const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "openalex", label: "OpenAlex（学术）" },
    { value: "core", label: "CORE（OA全文）" },
    { value: "worldbank", label: "World Bank（世行）" },
    { value: "github", label: "GitHub（代码/仓库）" },
    { value: "qstheory", label: "求是网" },
    { value: "people_theory", label: "人民日报理论版" },
    { value: "xuexi", label: "学习强国" },
    { value: "gmw_theory", label: "光明日报理论版" },
    { value: "studytimes", label: "学习时报" },
    { value: "ce_theory", label: "经济日报理论版" },
    { value: "cssn", label: "中国社会科学网" },
    { value: "aisixiang", label: "爱思想网" }
  ];

  const loadSources = async () => {
    setLoading(true);
    try {
      const data = await api.getSources();
      setSources(data.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSources();
  }, []);

  const runOpenAlex = async () => {
    const isWebSource = ["qstheory", "people_theory", "xuexi", "gmw_theory", "studytimes", "ce_theory", "cssn", "aisixiang"].includes(extSource);
    if (!oaQuery.trim() && !isWebSource) return;
    setOaLoading(true);
    setError(null);
    try {
      const data = await api.searchExternalSource({ source: extSource as "openalex" | "core" | "worldbank" | "github", query: oaQuery.trim(), limit: 8 });
      if (data.error) setError(data.error);
      else setOaResults(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOaLoading(false);
    }
  };

  const filtered = filter === "all" ? sources : sources.filter((s) => s.status === filter);
  const counts = {
    active: sources.filter((s) => s.status === "active").length,
    ready: sources.filter((s) => s.status === "ready").length,
    requires_auth: sources.filter((s) => s.status === "requires_auth").length
  };

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">外部数据源（{sources.length} 个）</h2>
          <div className="ml-auto flex items-center gap-2">
            {["all", "active", "ready", "requires_auth"].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f as typeof filter)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
                )}
              >
                {f === "all" ? `全部 ${sources.length}` : `${STATUS_LABELS[f]} ${counts[f as keyof typeof counts] ?? 0}`}
              </button>
            ))}
            <ButtonSmall onClick={() => void loadSources()}><RefreshCw className="h-3.5 w-3.5" /></ButtonSmall>
          </div>
        </div>

        {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载数据源…</div>}

        {/* V412: URL 一键导入（粘贴网址 → 抓取 → 入库） */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Globe className="h-4 w-4 text-emerald-600" /> URL 一键导入
          </div>
          <div className="flex gap-2">
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void importUrl(); }}
              placeholder="粘贴网页链接，如 https://www.qstheory.cn/...（自动抓取 → 切片 → 向量化入库）"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
            <Button onClick={() => void importUrl()} disabled={urlLoading}>
              {urlLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />} 一键导入
            </Button>
          </div>
          {urlResult && (
            <div className={`mt-2 rounded-md px-3 py-2 text-xs ${urlResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
              {urlResult.ok ? `✓ 已入库：「${urlResult.title}」（${urlResult.chunks ?? "?"} 个切片）` : `✗ ${urlResult.error}`}
            </div>
          )}
        </Card>

        {/* 外部文献检索（API + 网页源） */}
        <Card className="p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Globe className="h-4 w-4 text-primary" /> 外部检索（学术 API + 理论网页）
          </div>
          <div className="flex gap-2">
            <select
              value={extSource}
              onChange={(event) => setExtSource(event.target.value)}
              className="rounded-md border border-border bg-background px-2 py-2 text-sm"
            >
              {SOURCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <input
              value={oaQuery}
              onChange={(event) => setOaQuery(event.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runOpenAlex(); }}
              placeholder="输入关键词（网页源可留空抓取最新文章）"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Button onClick={() => void runOpenAlex()} disabled={oaLoading}>
              {oaLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />} 检索
            </Button>
          </div>
          {oaResults.length > 0 && (
            <div className="mt-3 space-y-2">
              {oaResults.map((item, index) => {
                const rec = item as Record<string, unknown>;
                const title = String(rec.title ?? rec.name ?? "");
                const year = rec.year ? String(rec.year) : "";
                const venue = String(rec.venue ?? "");
                const citedBy = rec.cited_by ? Number(rec.cited_by) : 0;
                const stars = rec.stars ? Number(rec.stars) : 0;
                const language = String(rec.language ?? "");
                const url = rec.url ? String(rec.url) : "";
                const isRepo = typeof rec.stars === "number";
                return (
                  <div key={index} className="rounded border border-border p-2">
                    <div className="text-sm font-medium">{title.slice(0, 100)}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {isRepo ? (
                        <span>⭐ {stars.toLocaleString()} {language ? `· ${language}` : ""} {rec.description ? `· ${String(rec.description).slice(0, 80)}` : ""}</span>
                      ) : (
                        <span>{year ? `${year} · ` : ""}{venue} · 被引 {citedBy}</span>
                      )}
                    </div>
                    {url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">查看 →</a>}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* 数据源列表 */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((source) => (
            <Card key={source.id} className="flex flex-col p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{source.name}</div>
                  <div className="text-xs text-muted-foreground">{source.category} · {TYPE_LABELS[source.type]}</div>
                </div>
                <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", STATUS_COLORS[source.status])}>
                  {source.status === "active" ? <CheckCircle2 className="mr-0.5 inline h-3 w-3" /> : source.status === "requires_auth" ? <Lock className="mr-0.5 inline h-3 w-3" /> : null}
                  {STATUS_LABELS[source.status]}
                </span>
              </div>
              <p className="mt-2 flex-1 text-xs text-muted-foreground">{source.description}</p>
              <a href={source.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="h-3 w-3" /> {source.url.replace(/^https?:\/\//, "").slice(0, 30)}
              </a>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function ButtonSmall(props: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={props.onClick} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
      {props.children}
    </button>
  );
}
