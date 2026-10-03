// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// TopicWikiPanel.tsx — 主题 wiki(2026-10-04)
//
// ⚠ 界面**移植**自开源项目 观澜/Guanlan(MIT)的 `guanlan/archive_wiki.py` 的
//   `_render_wiki_html` / `_render_wiki_markdown` / `format_wiki_build_summary`
//   (深色卡片 + core/candidate 左边条 + 主题网格)。见 THIRD_PARTY_NOTICES.md 第 9 节。
//
// ═══ 界面上必须显式的两条(照搬原文写在生成物里的边界) ═══
//   ① **它是归档的组织层, 不是全网知识库**。没命中只能说"本地没存过"。
//   ② **core/candidate 是"能不能直接复用", 不是"真假"**。candidate 是"先用之前核一下"。
import { useEffect, useState } from "react";
import { Loader2, Library, RefreshCw, FolderOpen, Copy, Check, Hammer } from "lucide-react";
import { cn } from "../lib/utils";
import { apiWeb } from "../lib/api";
import { PanelNotice, panelInputCls } from "./PanelShell";

type Build = Awaited<ReturnType<typeof apiWeb.listWikiBuilds>>["builds"][number];
type ContextResult = Awaited<ReturnType<typeof apiWeb.wikiContext>>;

const FORMATS: Array<[string, string]> = [
  ["markdown", "Markdown"],
  ["html", "HTML(深色单页)"],
  ["llm-wiki", "llm-wiki(给本地模型/RAG)"],
  ["both", "Markdown + HTML"],
];

export function TopicWikiPanel() {
  const [topic, setTopic] = useState("");
  const [format, setFormat] = useState("markdown");
  const [minQuality, setMinQuality] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [builds, setBuilds] = useState<Build[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // 证据包(给本地模型/RAG 的那一份) —— 与"构建"是两件事, 分开展示
  const [ctxQuery, setCtxQuery] = useState("");
  const [ctxBusy, setCtxBusy] = useState(false);
  const [ctx, setCtx] = useState<ContextResult | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    try { setBuilds((await apiWeb.listWikiBuilds(20)).builds || []); }
    catch { /* 列表拉不到不影响构建 */ }
  };
  useEffect(() => { void refresh(); }, []);

  const build = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await apiWeb.buildWiki({ topic: topic.trim() || undefined, format: format as never, minQuality });
      // ⚠ 报"生成了几个文件"而不是一律说成功 —— 0 篇文档的 wiki 也是"成功生成"的,
      //   那对用户是误导: 他以为有东西了, 打开只有空目录
      if (!r.documents) {
        setErr("归档里没有匹配的材料 —— 先去「网页归档」存几页, 再回来生成(空的 wiki 也能生成, 但没用)");
      } else {
        setMsg(`已生成: ${r.documents} 篇文档(${r.coreDocuments} core / ${r.candidateDocuments} candidate)· ${r.topics} 个主题 · ${r.files.length} 个文件`);
        setOpenId(r.buildId);
      }
      await refresh();
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 240)); }
    finally { setBusy(false); }
  };

  const runCtx = async () => {
    if (!ctxQuery.trim()) { setErr("先填一个问题 —— 证据包是按问题取的"); return; }
    setCtxBusy(true); setErr("");
    try { setCtx(await apiWeb.wikiContext({ query: ctxQuery.trim(), limit: 20 })); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 240)); }
    finally { setCtxBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Library className="h-4 w-4 text-sky-400" />
        <span className="text-sm font-medium">主题 wiki</span>
        <span className="text-xs text-muted-foreground">
          把<span className="text-foreground/80">已归档</span>的资料聚成主题目录 —— 归档多了之后, 这一层才有用
        </span>
      </div>

      {/* ⚠ 这两句边界必须在操作之前看到, 不是放在结果里 */ }
      <div className="rounded border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px] leading-relaxed text-sky-200/90">
        · 它只代表<span className="font-medium">本地已归档</span>的资料, <span className="font-medium">不是全网知识库</span> —— 没命中只能说明本地没存过。
        <br />· <span className="font-medium">core</span> = 可直接复用; <span className="font-medium">candidate</span> = 正文为空或阅读质量低, 用之前核一下。
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input value={topic} onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void build(); }}
          placeholder="主题(留空=全部归档), 如: 土地流转"
          className={cn(panelInputCls, "min-w-[200px] flex-1")} data-control="wiki:topic" />
        <select value={format} onChange={(e) => setFormat(e.target.value)} className={panelInputCls} data-control="wiki:format">
          {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="低于这个阅读质量分的材料降为 candidate">
          质量下限
          <input type="number" min={0} max={100} value={minQuality}
            onChange={(e) => setMinQuality(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
            className={cn(panelInputCls, "w-16")} data-control="wiki:minq" />
        </label>
        <button type="button" onClick={() => void build()} disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
          data-control="wiki:build">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Hammer className="h-3 w-3" />}
          {busy ? "生成中…" : "生成"}
        </button>
      </div>

      {err ? <PanelNotice type="err">{err}</PanelNotice> : null}
      {msg ? <PanelNotice type="ok">{msg}</PanelNotice> : null}

      {/* ── 生成记录 ── */}
      {builds.length ? (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">生成记录(最近 {builds.length} 次)</div>
          {builds.map((b) => (
            <div key={b.id} className="rounded-lg border border-border bg-card p-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button type="button" onClick={() => setOpenId(openId === b.id ? null : b.id)}
                  data-control={`wiki:open-${b.id.slice(0, 8)}`}
                  className="flex items-center gap-1 hover:underline">
                  <FolderOpen className="h-3.5 w-3.5" />
                  {b.topic || "全部归档"}
                </button>
                <span className="text-muted-foreground">{b.format}</span>
                <span className="text-muted-foreground">
                  {b.documents} 篇 · {b.coreDocuments} core / {b.candidateDocuments} candidate · {b.topics} 主题
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">{b.createdAt.slice(0, 16).replace("T", " ")}</span>
              </div>
              {openId === b.id ? (
                <div className="mt-2 border-t border-border pt-2 text-[11px]">
                  {b.graphSummary?.topEntities?.length ? (
                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                      <span className="text-muted-foreground">高频实体:</span>
                      {b.graphSummary.topEntities.slice(0, 10).map((e, i) => (
                        <span key={i} className="rounded border border-border px-1.5 py-0.5">{e.name} ×{e.count}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mb-1 text-muted-foreground">
                    共现图: {b.graphSummary?.nodes ?? 0} 节点 / {b.graphSummary?.edges ?? 0} 边 ——
                    这是<span className="text-foreground/70">轻量共现图, 不是语义向量图</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded border border-border/60 p-1.5 font-mono text-[10px] leading-relaxed">
                    {b.files.slice(0, 60).map((f, i) => <div key={i}>{f}</div>)}
                    {b.files.length > 60 ? <div className="text-muted-foreground">… 还有 {b.files.length - 60} 个</div> : null}
                  </div>
                  <div className="mt-1 break-all text-[10px] text-muted-foreground">输出目录: {b.outputDir}</div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          还没有生成过。先去「网页归档」存几页材料, 再回来生成 —— 空的归档生成出来的也是空目录。
        </div>
      )}

      {/* ── 证据包: 与"构建"分开, 因为它是给模型吃的、按问题取的 ── */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="mb-1.5 text-xs font-medium">归档证据包</div>
        <div className="mb-2 text-[10px] text-muted-foreground">
          按问题从本地归档取证据, 打成<span className="text-foreground/70">带状态与边界</span>的 Markdown —— 给本地模型/RAG 或 Agent 用。
          它和普通 RAG 的差别是: 每条都标 core/candidate 与正文层级, 末尾还有回答规则(证据薄弱时先声明)。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input value={ctxQuery} onChange={(e) => setCtxQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runCtx(); }}
            placeholder="问题, 如: 资本下乡对土地流转的影响"
            className={cn(panelInputCls, "min-w-[240px] flex-1")} data-control="wiki:ctx-query" />
          <button type="button" onClick={() => void runCtx()} disabled={ctxBusy}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            data-control="wiki:ctx-run">
            {ctxBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}取证据
          </button>
          {ctx ? (
            <button type="button" data-control="wiki:ctx-copy"
              onClick={async () => { try { await navigator.clipboard.writeText(ctx.context); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setErr("复制失败 —— 浏览器拒绝了剪贴板权限"); } }}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 text-[10px] hover:bg-accent">
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}复制
            </button>
          ) : null}
        </div>
        {ctx ? (
          <div className="mt-2">
            <div className="mb-1 text-[10px] text-muted-foreground">
              命中 {ctx.records.length} 条 · {ctx.boundary}
            </div>
            {ctx.records.length ? (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {ctx.records.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
                      r.wikiStatus === "core" ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" : "border-amber-500/30 bg-amber-500/15 text-amber-300")}>
                      {r.wikiStatus}
                    </span>
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="truncate hover:underline">{r.title}</a> : <span className="truncate">{r.title}</span>}
                    <span className="text-[10px] text-muted-foreground">
                      {r.domain} · {r.contentMode}{r.qualityScore === null ? "" : ` · q=${r.qualityScore}`}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-amber-300/90">
                本地归档未命中 —— 只能说明<span className="text-foreground/80">本地没存过</span>, 不代表全网没有证据。先去归档几页再试。
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default TopicWikiPanel;
