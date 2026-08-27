// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ImportsPanel.tsx — 文献管理（2026-08-27, Agentero 对照前端）
// Zotero 导入 / RSS·arXiv / 论文搜索导入 / S3 同步 / SSH 远程 — 全部 Agentero 对照能力的前端 UI
import { useEffect, useState } from "react";
import { BookOpen, Search, Rss, Database, CloudUpload, Network, RefreshCw, Loader2, CheckCircle2 } from "lucide-react";

interface PaperHit {
  title: string; abstract?: string; authors: string[]; year?: number;
  doi?: string; url?: string; source: string; externalId?: string;
}

export function ImportsPanel() {
  const [sourceId, setSourceId] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // 搜索
  const [searchQ, setSearchQ] = useState("");
  const [papers, setPapers] = useState<PaperHit[]>([]);

  // RSS
  const [rssUrl, setRssUrl] = useState("");
  const [rssEntries, setRssEntries] = useState<Array<{ title: string; link: string; date?: string }>>([]);

  // 状态
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

  const importZotero = async () => {
    setBusy(true);
    const r = await call("/api/zotero/import", { method: "POST", body: JSON.stringify({ sourceId }) });
    setNotice(r?.ok ? `✅ Zotero 导入: ${r.imported} 篇（跳过 ${r.skipped}）` : `❌ ${r?.error?.message || "导入失败"}`);
    setBusy(false);
  };

  const searchPapers = async () => {
    setBusy(true);
    const r = await call(`/api/papers/search?q=${encodeURIComponent(searchQ)}&max=8`);
    setPapers(r?.papers || []);
    setNotice(r?.papers?.length ? `🔍 找到 ${r.papers.length} 篇` : "（未找到或网络受限）");
    setBusy(false);
  };

  const importPaper = async (p: PaperHit) => {
    const r = await call("/api/papers/import", { method: "POST", body: JSON.stringify({ sourceId, paper: p }) });
    setNotice(r?.imported ? `✅ 已导入: ${p.title.slice(0, 40)}` : `（${r?.reason || "已存在或失败"}）`);
  };

  const fetchRss = async () => {
    setBusy(true);
    const r = await call(`/api/rss/fetch?url=${encodeURIComponent(rssUrl)}`);
    setRssEntries(r?.entries || []);
    setNotice(r?.entries?.length ? `📡 RSS: ${r.entries.length} 条` : "（无条目或网络受限）");
    setBusy(false);
  };

  const syncS3 = async () => {
    setBusy(true);
    const r = await call("/api/s3/sync", { method: "POST" });
    setNotice(r?.ok ? `☁️ S3 已同步 ${r.exported} 篇` : `❌ ${r?.error || "S3 未配置"}`);
    setBusy(false);
  };

  const openTunnel = async () => {
    setBusy(true);
    const r = await call("/api/ssh/tunnel", { method: "POST", body: JSON.stringify({ localPort: 24173 }) });
    setNotice(r?.ok ? `🔗 SSH 隧道已建立 (127.0.0.1:24173)` : `❌ ${r?.error?.message || "SSH 未配置"}`);
    if (r?.ok) void fetch("/api/ssh/tunnels").then((x) => x.json()).then(setSshStatus);
    setBusy(false);
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-emerald-600" />
        <span className="text-sm font-semibold">文献管理（导入/同步/远程）</span>
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}
          className="ml-auto rounded border bg-background px-2 py-1 text-[11px]">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>

      {notice && <div className="rounded border bg-muted/20 px-2 py-1 text-[11px]">{notice}</div>}

      {/* Zotero 导入 */}
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
          <Database className="h-3.5 w-3.5 text-blue-600" /> Zotero 书库导入
          <span className="ml-auto text-[10px] text-muted-foreground">{zoteroStatus?.connected ? `已连接 (${zoteroStatus.itemCount} 条)` : "未连接（需 Zotero 桌面运行）"}</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void importZotero()} disabled={busy || !sourceId}
            className="rounded border px-3 py-1 text-[11px] text-blue-700 hover:bg-blue-50 disabled:opacity-40">
            导入书库（标签/笔记 → 项目）
          </button>
          <a href="/api/zotero/export" target="_blank" rel="noreferrer"
            className="rounded border px-3 py-1 text-[11px] text-muted-foreground hover:bg-accent">导出 BibTeX</a>
        </div>
      </div>

      {/* 论文搜索导入 */}
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
          <Search className="h-3.5 w-3.5 text-emerald-600" /> 论文搜索导入（arXiv + Semantic Scholar）
        </div>
        <div className="flex gap-2">
          <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="输入论文名/关键词，如：capitalism agriculture"
            className="flex-1 rounded border bg-background px-2 py-1 text-[11px]" />
          <button type="button" onClick={() => void searchPapers()} disabled={busy || !searchQ}
            className="rounded border px-3 py-1 text-[11px] hover:bg-accent disabled:opacity-40">
            <Search className="mr-1 inline h-3 w-3" />搜索
          </button>
        </div>
        {papers.length > 0 && (
          <div className="mt-2 space-y-1">
            {papers.map((p, i) => (
              <div key={i} className="flex items-start gap-1 rounded border bg-muted/10 px-2 py-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium">{p.title}</div>
                  <div className="text-[9px] text-muted-foreground">
                    {(p.authors || []).slice(0, 3).join("、")} {p.year ? `(${p.year})` : ""} · {p.source}
                  </div>
                </div>
                <button type="button" onClick={() => void importPaper(p)}
                  className="shrink-0 rounded border px-2 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-50">
                  <CheckCircle2 className="mr-0.5 inline h-3 w-3" />导入
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RSS 抓取 */}
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
          <Rss className="h-3.5 w-3.5 text-orange-500" /> RSS / arXiv 文献源
        </div>
        <div className="flex gap-2">
          <input value={rssUrl} onChange={(e) => setRssUrl(e.target.value)} placeholder="RSS 地址，如 https://arxiv.org/rss/..."
            className="flex-1 rounded border bg-background px-2 py-1 text-[11px]" />
          <button type="button" onClick={() => void fetchRss()} disabled={busy || !rssUrl}
            className="rounded border px-3 py-1 text-[11px] hover:bg-accent disabled:opacity-40">抓取</button>
          <button type="button" onClick={() => { setRssUrl(""); void call("/api/rss/arxiv?topic=" + encodeURIComponent(searchQ || "machine learning")).then((r) => { setRssEntries(r?.entries || []); setNotice(`arXiv: ${r?.entries?.length || 0} 篇`); }); }}
            className="rounded border px-3 py-1 text-[11px] text-orange-600 hover:bg-orange-50">arXiv 今日</button>
        </div>
        {rssEntries.length > 0 && (
          <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {rssEntries.map((e, i) => (
              <div key={i} className="truncate text-[10px]">
                <a href={e.link} target="_blank" rel="noreferrer" className="hover:underline">{e.title}</a>
                {e.date ? <span className="ml-1 text-[9px] text-muted-foreground">{e.date.slice(0, 10)}</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* S3 同步 + SSH 远程 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            <CloudUpload className="h-3.5 w-3.5 text-sky-600" /> S3 云同步
            <span className="ml-auto text-[10px] text-muted-foreground">{s3Status?.configured ? "已配置" : "未配置"}</span>
          </div>
          <button type="button" onClick={() => void syncS3()} disabled={busy}
            className="rounded border px-3 py-1 text-[11px] text-sky-700 hover:bg-sky-50 disabled:opacity-40">
            同步文献快照 → S3
          </button>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            <Network className="h-3.5 w-3.5 text-purple-600" /> SSH 远程
            <span className="ml-auto text-[10px] text-muted-foreground">
              {sshStatus?.configured ? `${(sshStatus.tunnels || []).length} 隧道` : "未配置"}
            </span>
          </div>
          <button type="button" onClick={() => void openTunnel()} disabled={busy}
            className="rounded border px-3 py-1 text-[11px] text-purple-700 hover:bg-purple-50 disabled:opacity-40">
            建立隧道（127.0.0.1:24173）
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <RefreshCw className="h-3 w-3" />
        配置：Zotero 桌面运行 / S3 (S3_ENDPOINT等) / SSH (SSH_HOST等) — 见 docs/LITERATURE-MANAGEMENT.md
      </div>
    </div>
  );
}
