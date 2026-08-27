// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ImportsPanel.tsx — 文献管理（2026-08-27 v2, Agentero 对照前端）
// 玻璃拟态宇宙风设计: 渐变头部 + 状态徽章 + 分区卡片 + 结果面板 + 操作反馈
// Zotero 导入 / 论文搜索 / RSS·arXiv / S3 同步 / SSH 远程
import { useEffect, useState } from "react";
import { BookOpen, Search, Rss, Database, CloudUpload, Network, RefreshCw, Loader2, CheckCircle2, X, ArrowRight, FileText, Globe, Cpu } from "lucide-react";

interface PaperHit {
  title: string; abstract?: string; authors: string[]; year?: number;
  doi?: string; url?: string; source: string; externalId?: string;
}

export function ImportsPanel() {
  const [sourceId, setSourceId] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [notice, setNotice] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [searchQ, setSearchQ] = useState("");
  const [papers, setPapers] = useState<PaperHit[]>([]);
  const [paperExpanded, setPaperExpanded] = useState<number | null>(null);

  const [rssUrl, setRssUrl] = useState("");
  const [rssEntries, setRssEntries] = useState<Array<{ title: string; link: string; date?: string; summary?: string }>>([]);

  const [zoteroStatus, setZoteroStatus] = useState<any>(null);
  const [s3Status, setS3Status] = useState<any>(null);
  const [sshStatus, setSshStatus] = useState<any>(null);

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((j) => {
      const list = (j.projects || []).map((p: any) => ({ id: p.id, name: p.name }));
      setProjects(list);
      if (list.length > 0 && !sourceId) setSourceId(list[0].id);
    }).catch(() => {});
    void fetch("/api/zotero/status").then((r) => r.json()).then(setZoteroStatus).catch(() => {});
    void fetch("/api/s3/status").then((r) => r.json()).then(setS3Status).catch(() => {});
    void fetch("/api/ssh/tunnels").then((r) => r.json()).then(setSshStatus).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const call = async (url: string, opts?: RequestInit): Promise<any> => {
    const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
    return r.json().catch(() => null);
  };

  const tell = (type: "ok" | "err" | "info", text: string) => setNotice({ type, text });

  const importZotero = async () => {
    setBusy("zotero");
    const r = await call("/api/zotero/import", { method: "POST", body: JSON.stringify({ sourceId }) });
    r?.ok ? tell("ok", `Zotero 导入完成：${r.imported} 篇新文献${r.skipped ? `（跳过 ${r.skipped} 篇重复）` : ""}`)
          : tell("err", r?.error?.message || "导入失败（Zotero 桌面未运行？）");
    setBusy(null);
  };

  const searchPapers = async () => {
    if (!searchQ.trim()) return;
    setBusy("search");
    const r = await call(`/api/papers/search?q=${encodeURIComponent(searchQ)}&max=10`);
    setPapers(r?.papers || []);
    r?.papers?.length ? tell("ok", `找到 ${r.papers.length} 篇相关文献`) : tell("info", "未找到结果（检查网络）");
    setBusy(null);
  };

  const importPaper = async (p: PaperHit) => {
    setBusy(`import-${p.externalId}`);
    const r = await call("/api/papers/import", { method: "POST", body: JSON.stringify({ sourceId, paper: p }) });
    r?.imported ? tell("ok", `已导入「${p.title.slice(0, 40)}」`) : tell("info", r?.reason === "已存在" ? "这篇已在库中" : "导入失败");
    setBusy(null);
  };

  const fetchRss = async () => {
    if (!rssUrl.trim()) return;
    setBusy("rss");
    const r = await call(`/api/rss/fetch?url=${encodeURIComponent(rssUrl)}`);
    setRssEntries(r?.entries || []);
    r?.entries?.length ? tell("ok", `RSS 抓到 ${r.entries.length} 条`) : tell("info", "无条目（网络受限？）");
    setBusy(null);
  };

  const arxivToday = async () => {
    setBusy("rss");
    const topic = searchQ || "capitalism agriculture";
    const r = await call(`/api/rss/arxiv?topic=${encodeURIComponent(topic)}&max=10`);
    setRssEntries(r?.entries || []);
    r?.entries?.length ? tell("ok", `arXiv 今日推荐（${topic}）：${r.entries.length} 篇`) : tell("info", "arXiv 无结果（网络受限？）");
    setBusy(null);
  };

  const syncS3 = async () => {
    setBusy("s3");
    const r = await call("/api/s3/sync", { method: "POST" });
    r?.ok ? tell("ok", `文献快照已同步 S3（${r.exported} 篇）`) : tell("err", r?.error || "S3 未配置");
    setBusy(null);
  };

  const openTunnel = async () => {
    setBusy("ssh");
    const r = await call("/api/ssh/tunnel", { method: "POST", body: JSON.stringify({ localPort: 24173 }) });
    r?.ok ? tell("ok", "SSH 隧道已建立 → http://127.0.0.1:24173") : tell("err", r?.error?.message || "SSH 未配置");
    if (r?.ok) void fetch("/api/ssh/tunnels").then((x) => x.json()).then(setSshStatus);
    setBusy(null);
  };

  const StatusBadge = ({ ok, text }: { ok: boolean; text: string }) => (
    <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${ok ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
      {ok ? "● " : "○ "}{text}
    </span>
  );

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* ─── 头部: 渐变 + 标题 + 状态 ─── */}
      <div className="relative overflow-hidden rounded-xl border bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent p-4">
        <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
            <BookOpen className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">文献管理</h2>
            <p className="text-[10px] text-muted-foreground">Zotero 导入 · 论文搜索 · RSS/arXiv · 云同步 · 远程访问</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StatusBadge ok={!!zoteroStatus?.connected} text={zoteroStatus?.connected ? `Zotero ${zoteroStatus.itemCount}条` : "Zotero 未连接"} />
            <StatusBadge ok={!!s3Status?.configured} text={s3Status?.configured ? "S3 已配置" : "S3 未配置"} />
            <StatusBadge ok={!!sshStatus?.configured} text={sshStatus?.configured ? `SSH ${(sshStatus.tunnels || []).length}隧道` : "SSH 未配置"} />
          </div>
        </div>
      </div>

      {/* 操作反馈条 */}
      {notice && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] animate-[view-fade-in_0.2s_ease-out] ${
          notice.type === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
          : notice.type === "err" ? "border-red-500/30 bg-red-500/10 text-red-600"
          : "border-border bg-muted/30 text-muted-foreground"}`}>
          {notice.type === "ok" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}

      {/* ─── 功能区: 网格布局 ─── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Zotero */}
        <div className="flex flex-col rounded-xl border bg-card/60 p-4 backdrop-blur-sm">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-500/15"><Database className="h-3.5 w-3.5 text-blue-600" /></div>
            <div>
              <div className="text-xs font-semibold">Zotero 书库</div>
              <div className="text-[9px] text-muted-foreground">导入标签/笔记/DOI，导出 BibTeX</div>
            </div>
            {busy === "zotero" && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-blue-600" />}
          </div>
          <div className="mt-auto flex items-center gap-2">
            <button type="button" onClick={() => void importZotero()} disabled={!!busy || !sourceId}
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white shadow-sm transition-all hover:bg-blue-700 disabled:opacity-40">
              <Database className="h-3 w-3" /> 导入书库
            </button>
            <a href="/api/zotero/export" target="_blank" rel="noreferrer"
              className="flex items-center gap-1 rounded-lg border px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent">
              <FileText className="h-3 w-3" /> 导出 BibTeX
            </a>
            <span className="ml-auto text-[9px] text-muted-foreground">{zoteroStatus?.connected ? `${zoteroStatus.itemCount} 条可导入` : "需 Zotero 桌面运行"}</span>
          </div>
        </div>

        {/* S3 + SSH 合并 */}
        <div className="flex flex-col rounded-xl border bg-card/60 p-4 backdrop-blur-sm">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-sky-500/15"><CloudUpload className="h-3.5 w-3.5 text-sky-600" /></div>
            <div>
              <div className="text-xs font-semibold">同步与远程</div>
              <div className="text-[9px] text-muted-foreground">S3 云同步 · SSH 隧道访问远程知识库</div>
            </div>
          </div>
          <div className="mt-auto space-y-2">
            <button type="button" onClick={() => void syncS3()} disabled={!!busy}
              className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[11px] hover:bg-accent disabled:opacity-40">
              <span className="flex items-center gap-1.5"><CloudUpload className="h-3 w-3 text-sky-600" /> 同步文献快照 → S3</span>
              {busy === "s3" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3 text-muted-foreground" />}
            </button>
            <button type="button" onClick={() => void openTunnel()} disabled={!!busy}
              className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[11px] hover:bg-accent disabled:opacity-40">
              <span className="flex items-center gap-1.5"><Network className="h-3 w-3 text-purple-600" /> 建立 SSH 隧道（:24173）</span>
              {busy === "ssh" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3 text-muted-foreground" />}
            </button>
          </div>
        </div>

        {/* 论文搜索 */}
        <div className="flex flex-col rounded-xl border bg-card/60 p-4 backdrop-blur-sm lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15"><Search className="h-3.5 w-3.5 text-emerald-600" /></div>
            <div>
              <div className="text-xs font-semibold">论文搜索导入</div>
              <div className="text-[9px] text-muted-foreground">arXiv + Semantic Scholar 双源 · 一键入库</div>
            </div>
            {busy === "search" && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-emerald-600" />}
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void searchPapers()}
                placeholder="输入论文名或关键词，如：工商资本下乡 / capitalism agriculture"
                className="w-full rounded-lg border bg-background py-2 pl-8 pr-3 text-[12px] outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30" />
            </div>
            <button type="button" onClick={() => void searchPapers()} disabled={!!busy || !searchQ.trim()}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-[11px] font-medium text-white transition-all hover:bg-emerald-700 disabled:opacity-40">
              {busy === "search" ? "搜索中…" : "搜索"}
            </button>
          </div>
          {papers.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {papers.map((p, i) => (
                <div key={i} className="rounded-lg border bg-muted/10 px-3 py-2 transition-colors hover:bg-muted/20">
                  <div className="flex items-start gap-2">
                    <button type="button" onClick={() => setPaperExpanded(paperExpanded === i ? null : i)}
                      className="min-w-0 flex-1 text-left">
                      <div className="truncate text-[12px] font-medium hover:text-emerald-700">{p.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9px] text-muted-foreground">
                        <span className="rounded bg-background/80 px-1 py-0.5">{p.source === "arxiv" ? "arXiv" : "Semantic Scholar"}</span>
                        {(p.authors || []).slice(0, 3).join("、")}{p.authors?.length > 3 ? " 等" : ""}
                        {p.year ? <span>· {p.year}</span> : null}
                        {p.doi ? <span className="font-mono">· {p.doi.slice(0, 20)}</span> : null}
                      </div>
                    </button>
                    <button type="button" onClick={() => void importPaper(p)} disabled={!!busy}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-700 transition-all hover:bg-emerald-500/20 disabled:opacity-40">
                      {busy === `import-${p.externalId}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                      导入
                    </button>
                  </div>
                  {paperExpanded === i && p.abstract && (
                    <p className="mt-1.5 border-t border-border/50 pt-1.5 text-[10px] leading-relaxed text-muted-foreground">{p.abstract.slice(0, 300)}…</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RSS/arXiv */}
        <div className="flex flex-col rounded-xl border bg-card/60 p-4 backdrop-blur-sm lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-orange-500/15"><Rss className="h-3.5 w-3.5 text-orange-500" /></div>
            <div>
              <div className="text-xs font-semibold">RSS / arXiv 文献源</div>
              <div className="text-[9px] text-muted-foreground">订阅期刊 RSS · arXiv 今日推荐（按当前关键词）</div>
            </div>
          </div>
          <div className="flex gap-2">
            <input value={rssUrl} onChange={(e) => setRssUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void fetchRss()}
              placeholder="RSS 地址，如 https://arxiv.org/rss/econ"
              className="flex-1 rounded-lg border bg-background px-3 py-2 text-[12px] outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/30" />
            <button type="button" onClick={() => void fetchRss()} disabled={!!busy || !rssUrl.trim()}
              className="rounded-lg border px-3 py-2 text-[11px] hover:bg-accent disabled:opacity-40">
              {busy === "rss" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rss className="h-3 w-3" />} 抓取
            </button>
            <button type="button" onClick={() => void arxivToday()} disabled={!!busy}
              className="flex items-center gap-1 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] font-medium text-orange-600 hover:bg-orange-500/20 disabled:opacity-40">
              <Globe className="h-3 w-3" /> arXiv 今日
            </button>
          </div>
          {rssEntries.length > 0 && (
            <div className="mt-3 grid max-h-48 grid-cols-1 gap-1 overflow-y-auto md:grid-cols-2">
              {rssEntries.map((e, i) => (
                <a key={i} href={e.link} target="_blank" rel="noreferrer"
                  className="group rounded-lg border border-border/50 px-2.5 py-1.5 transition-colors hover:border-orange-500/30 hover:bg-orange-500/5">
                  <div className="truncate text-[11px] group-hover:text-orange-700">{e.title}</div>
                  {e.date ? <div className="mt-0.5 text-[9px] text-muted-foreground">{e.date.slice(0, 10)}</div> : null}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Cpu className="h-3 w-3" />
        配置说明：Zotero 桌面运行 · S3(S3_ENDPOINT/S3_BUCKET/KEY) · SSH(SSH_HOST/SSH_USER) — docs/LITERATURE-MANAGEMENT.md
      </div>
    </div>
  );
}
