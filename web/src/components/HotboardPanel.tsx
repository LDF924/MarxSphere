// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// HotboardPanel.tsx — 中文平台热榜 + 网页归档(2026-10-03)
//
// 由来(对照开源项目 观澜/Guanlan, MIT): 本仓此前只有一个热榜(微博), 且**完全没有**
//   网页归档能力。这两件事在界面上是一体的 —— 看到榜上一条线索, 下一步就是
//   "把它当时的页面存下来", 之后才谈得上"它后来改了什么"。
//
// ═══ 两条口径在界面上必须显式 ═══
//   ① **热榜是注意力样本, 不是事实**: 微博热度 136 万 ≠ 136 万人在议这件事。
//      每个榜带 `evidenceRole`, 界面原样显示, 不让用户把"热"当成"真"。
//   ② **归档是快照不是链接**: 存的是**当时的内容**, 所以"没变"也是一条有价值的结果
//      (`unchanged`)。界面上不能说成"抓取失败"。
import { useEffect, useState } from "react";
import {
  Flame, Loader2, RefreshCw, Archive, Plus, ChevronRight, Clock, AlertTriangle,
  GitCompare, Search, Trash2, BookOpen, ExternalLink,
} from "lucide-react";
import { cn } from "../lib/utils";
import { api, apiWeb } from "../lib/api";
import { PanelNotice, panelInputCls } from "./PanelShell";

interface Board { id: string; name: string; category: string; evidenceRole: string }
interface HotItem { rank: number; title: string; url: string; heat: number; summary?: string }
interface BoardResult extends Board { ok: boolean; via: string; stale: boolean; items: HotItem[]; error?: string }
interface ArchiveRow {
  id: string; url: string; title: string; snapshotCount: number;
  firstSeenAt: string; lastSeenAt: string; qualityScore: number | null; qualityLabel: string; tags: string[];
}

/** 榜单类目的显示顺序 —— 与"研究者先看哪类"一致: 综合 → 社区 → 科技 → 财经 → 视频 */
const CAT_ORDER = ["综合", "社区", "科技", "财经", "视频"];

export function HotboardPanel() {
  const [tab, setTab] = useState<"hot" | "archive">("hot");

  // ── 热榜 ──
  const [boards, setBoards] = useState<Board[]>([]);
  const [data, setData] = useState<BoardResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [active, setActive] = useState<string>("");

  // ── 归档 ──
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [arcBusy, setArcBusy] = useState(false);
  const [arcMsg, setArcMsg] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [toVault, setToVault] = useState(true);
  /**
   * 手动粘贴导入。
   *
   * 为什么必须有这条路: 有些平台(知乎/微博/公众号…)**会拦服务器抓取**(实测知乎 403),
   * 而网页在浏览器里是打得开的。所以"抓不到"不该是死路 —— 用户把正文复制过来,
   * 归档照样成立(快照、段落定位、版本比对全都能用), 只是 `via` 记成 manual。
   */
  const [manualMode, setManualMode] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; fetchedAt: string; chars: number; passages: number; via: string; quality: { label?: string; score?: number } }>>([]);
  const [diff, setDiff] = useState<{ added: string[]; removed: string[]; unchanged: number } | null>(null);
  /** 论断台账 —— 抽出的可核对值 + 跨源分歧(移植自观澜 claim_ledger) */
  const [ledger, setLedger] = useState<Awaited<ReturnType<typeof apiWeb.archiveClaims>> | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [locateQ, setLocateQ] = useState("");
  const [hits, setHits] = useState<Array<{ url: string; ord: number; startOffset: number; text: string; fetchedAt: string }>>([]);

  useEffect(() => {
    void apiWeb.getHotBoards().then((d) => setBoards(d.boards || [])).catch(() => { /* 目录失败不阻断 */ });
  }, []);

  useEffect(() => {
    if (tab !== "archive") return;
    void refreshArchives();
  }, [tab]);

  const fetchHot = async () => {
    setBusy(true); setErr("");
    try {
      const d = await apiWeb.fetchHotBoards({ limit: 20 });
      setData(d.boards || []);
      if (!active && d.boards?.length) setActive(d.boards[0].id);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  /**
   * 归档单条(榜上的一个条目)。
   *
   * ⚠ 必须**按返回的 status 分三态报**, 不能 `.then()` 里一律说成功。
   *   第一版就是那么写的, 实测: 知乎的页面服务端返回 **403**, 归档真失败了,
   *   而界面弹出的是「已归档：…」—— 用户会以为存下了, 去归档页却一条都没有。
   *   **把失败说成成功, 比直接报错坏得多** —— 前者会让人放弃核对。
   */
  const archiveOne = async (it: HotItem) => {
    setErr(""); setArcMsg("");
    try {
      const r = await apiWeb.addArchive({ url: it.url, toVault });
      if (!r.ok || r.status === "failed") {
        setErr(`归档失败（${it.title.slice(0, 24)}）：${r.error ?? "该站点拒绝了抓取"} —— 有些平台（知乎/微博等）会拦服务器抓取，可以在原页面手动复制正文后用下面的输入框导入`);
        return;
      }
      setArcMsg(r.status === "created"
        ? `已归档：${it.title.slice(0, 30)}${r.vault ? "（并写入资料库）" : ""}`
        : `内容与上一版相同：${it.title.slice(0, 30)}`);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const refreshArchives = async () => {
    setArcBusy(true); setErr("");
    try { setRows((await apiWeb.listArchives()).items || []); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setArcBusy(false); }
  };

  const doArchive = async () => {
    const u = addUrl.trim();
    if (!u) return;
    if (manualMode && !manualText.trim()) { setErr("粘贴模式下要贴正文"); return; }
    setArcBusy(true); setErr(""); setArcMsg("");
    try {
      const r = await apiWeb.addArchive(manualMode
        ? { url: u, text: manualText, title: manualTitle || u, toVault }
        : { url: u, toVault });
      // ⚠ unchanged 是**成功**的一种 —— 说成"失败"会让用户以为归档坏了
      setArcMsg(r.status === "created" ? `已存下一版快照${r.vault ? `，并写入资料库（${r.vault.name}）` : ""}`
        : r.status === "unchanged" ? "内容与上一版相同，已记录本次访问（快照未重复存储）"
        : `归档失败：${r.error ?? "未知原因"}`);
      if (r.ok && r.status !== "failed") { setAddUrl(""); setManualText(""); setManualTitle(""); }
      await refreshArchives();
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setArcBusy(false); }
  };

  const openArchive = async (id: string) => {
    setOpenId(id); setHistory([]); setDiff(null); setHits([]);
    try { setHistory((await apiWeb.archiveHistory(id)).snapshots || []); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const doDiff = async (l: string, r: string) => {
    try { setDiff(await apiWeb.archiveDiff(l, r)); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const loadLedger = async () => {
    setLedgerBusy(true); setErr("");
    try { setLedger(await apiWeb.archiveClaims()); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setLedgerBusy(false); }
  };

  const doLocate = async () => {
    if (locateQ.trim().length < 4) { setErr("至少 4 个字"); return; }
    try { setHits((await apiWeb.locateArchive(locateQ.trim())).hits || []); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const del = async (id: string) => {
    if (!window.confirm("删除这个归档？它的全部快照与段落都会一起删除。")) return;
    try { await apiWeb.deleteArchive(id); setOpenId(null); await refreshArchives(); }
    catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
  };

  const shown = active ? data.find((b) => b.id === active) : data[0];
  const grouped = CAT_ORDER.map((c) => ({ cat: c, list: boards.filter((b) => b.category === c) })).filter((g) => g.list.length);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Flame className="h-4 w-4 text-amber-400" />中文互联网热榜
        </div>
        <span className="text-xs text-muted-foreground">此刻各平台在议什么</span>
        <div className="ml-auto flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
          {([["hot", "热榜"], ["archive", "网页归档"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)} data-control={`hot:tab-${k}`}
              className={cn("rounded px-3 py-1", tab === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {err ? <PanelNotice type="err">{err}</PanelNotice> : null}
      {arcMsg ? <PanelNotice type="ok">{arcMsg}</PanelNotice> : null}

      {/* ═══════════ 热榜 ═══════════ */}
      {tab === "hot" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void fetchHot()} disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
              data-control="hot:fetch">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {busy ? "抓取中…" : `抓取全部 ${boards.length} 个榜`}
            </button>
            {data.length ? (
              <span className="text-xs text-muted-foreground">
                {data.filter((b) => b.ok).length}/{data.length} 个榜有数据
                {data.some((b) => b.stale) ? "（部分为第三方缓存）" : ""}
              </span>
            ) : null}
          </div>

          {!data.length ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
              点上面按钮抓一次。覆盖 {boards.length} 个平台：知乎 / 微博 / 百度 / 抖音 / B站 / 贴吧 / 澎湃 / 掘金 / V2EX / 少数派 / IT之家 / 虎扑 / 财联社 / 华尔街见闻 / 雪球。
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)]">
              <aside className="space-y-2">
                {grouped.map((g) => (
                  <div key={g.cat} className="rounded-lg border border-border p-2">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{g.cat}</div>
                    {g.list.map((b) => {
                      const r = data.find((x) => x.id === b.id);
                      return (
                        <button key={b.id} type="button" onClick={() => setActive(b.id)} data-control={`hot:board-${b.id}`}
                          className={cn("mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs",
                            active === b.id ? "bg-amber-500/10 text-amber-300" : "hover:bg-accent")}>
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", r?.ok ? "bg-emerald-400" : r ? "bg-red-400" : "bg-muted-foreground/40")} />
                          <span className="min-w-0 flex-1 truncate">{b.name}</span>
                          {r?.items?.length ? <span className="shrink-0 opacity-60">{r.items.length}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </aside>

              <main className="min-w-0">
                {!shown ? null : !shown.ok ? (
                  <div className="rounded-lg border border-red-500/25 bg-red-500/5 p-4 text-xs text-red-300">
                    <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" />{shown.name} 抓取失败</div>
                    <div className="text-red-300/80">{shown.error}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">其余榜单不受影响。</div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border">
                    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                      <span className="text-sm font-medium">{shown.name}</span>
                      {/* evidenceRole 原样显示 —— 这是"别把热度当事实"的唯一入口 */}
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title="这条榜在证据体系里的角色">{shown.evidenceRole}</span>
                      {shown.via === "direct" ? <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300">直连</span> : null}
                      {shown.stale ? <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-300">第三方缓存</span> : null}
                    </div>
                    <div className="divide-y divide-border">
                      {shown.items.map((it) => (
                        <div key={`${it.rank}-${it.title}`} className="flex items-start gap-2 px-3 py-2 hover:bg-accent/30" data-control="hot:item">
                          <span className={cn("mt-0.5 w-5 shrink-0 text-center font-mono text-xs",
                            it.rank <= 3 ? "font-bold text-amber-400" : "text-muted-foreground")}>{it.rank}</span>
                          <div className="min-w-0 flex-1">
                            {it.url ? (
                              <a href={it.url} target="_blank" rel="noreferrer" className="text-sm leading-snug hover:text-primary hover:underline">{it.title}</a>
                            ) : <span className="text-sm leading-snug">{it.title}</span>}
                            {it.summary ? <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{it.summary}</div> : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {it.heat ? <span className="text-[10px] text-muted-foreground">{it.heat.toLocaleString()}</span> : null}
                            {/* 榜上一条线索 → 存下它当时的页面 */}
                            {it.url ? (
                              <button type="button" title="归档这个页面(存下它此刻的内容)" data-control="hot:archive-item"
                                onClick={() => void archiveOne(it)} className="rounded border border-border p-1 hover:bg-accent"><Archive className="h-3 w-3" /></button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground/70">
                  热榜是**公众注意力**的样本，不是事实判断：热度高只说明讨论多，不代表这件事为真或重要。跨平台热度口径不同，不可直接比较。
                </div>
              </main>
            </div>
          )}
        </>
      ) : (
        /* ═══════════ 网页归档 ═══════════ */
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input value={addUrl} onChange={(e) => setAddUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doArchive(); }}
              placeholder="粘贴要归档的网页地址（政策原文 / 新闻 / 榜单页…）"
              className={cn(panelInputCls, "min-w-[18rem] flex-1 py-1.5")} data-control="archive:url" />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="有些平台会拦服务器抓取（知乎/微博等返回 403），改用粘贴正文">
              <input type="checkbox" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} data-control="archive:manual-mode" />
              粘贴正文
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="同时写入 Obsidian 资料库的「网页归档」目录">
              <input type="checkbox" checked={toVault} onChange={(e) => setToVault(e.target.checked)} data-control="archive:to-vault" />
              写入资料库
            </label>
            <button type="button" onClick={() => void doArchive()} disabled={arcBusy || !addUrl.trim()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" data-control="archive:add">
              {arcBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}归档
            </button>
            {manualMode ? (
              <div className="w-full space-y-1.5 rounded-md border border-border bg-muted/20 p-2">
                <p className="text-[11px] text-muted-foreground">
                  在浏览器里打开原页面，全选复制正文贴到这里 —— 归档照样有快照、段落定位与版本比对，
                  只是标注为「手动导入」。
                </p>
                <input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="标题（可留空，取 URL）"
                  className={cn(panelInputCls, "w-full py-1 text-xs")} data-control="archive:manual-title" />
                <textarea value={manualText} onChange={(e) => setManualText(e.target.value)} rows={4}
                  placeholder="粘贴正文…" className={cn(panelInputCls, "w-full resize-y py-1 text-xs")} data-control="archive:manual-text" />
              </div>
            ) : null}
            <button type="button" onClick={() => void refreshArchives()} className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent" data-control="archive:refresh">
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>

          {/* 论断台账 —— 抽出的可核对值 + 跨源分歧 */}
          <div className="rounded-md border border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <GitCompare className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium">论断台账</span>
              <span className="text-[11px] text-muted-foreground">
                从已归档页面里抽出可核对的具体值，标出**跨源分歧**
              </span>
              <button type="button" onClick={() => void loadLedger()} disabled={ledgerBusy}
                className="ml-auto rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
                data-control="archive:claims">
                {ledgerBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "生成台账"}
              </button>
            </div>
            {ledger ? (
              <div className="space-y-2 p-3">
                {ledger.conflictSets.length ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-amber-300">
                      需要人工核对的分歧（{ledger.conflictSets.length}）—— 冲突不等于有人错，只是要把依据翻出来
                    </div>
                    {ledger.conflictSets.map((cs) => (
                      <div key={cs.conflictSet} className="rounded border border-amber-500/25 bg-amber-500/5 p-2" data-control="archive:conflict">
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-amber-200">{cs.conflictSet}</span>
                          <span className="text-muted-foreground">{ledger.categoryLabels[cs.category] ?? cs.category}</span>
                          <span className="font-medium">{cs.values.join("  vs  ")}</span>
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {cs.sources.map((s) => (
                            <div key={s.claimId} className="text-[11px] text-muted-foreground">
                              <span className="font-medium text-foreground/85">{s.value}</span>
                              {" — "}
                              <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-primary hover:underline">{s.sourceTitle || s.url}</a>
                              {s.evidenceRole ? <span className="ml-1 opacity-70">（{s.evidenceRole}）</span> : null}
                              <span className="ml-1 opacity-60">置信 {s.confidence}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
                    {ledger.claims.length
                      ? "已抽出的值之间没有跨源分歧（同一数值、不同来源 —— 那才算分歧）"
                      : "还没抽出可核对的值。先归档几页有具体数字的材料。"}
                  </div>
                )}
                {ledger.claims.length ? (
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">全部论断（{ledger.claims.length}）</div>
                    <div className="max-h-40 space-y-0.5 overflow-y-auto">
                      {ledger.claims.slice(0, 60).map((c) => (
                        <div key={c.claimId} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{ledger.categoryLabels[c.category] ?? c.category}</span>
                          <span className="font-medium">{c.value}</span>
                          <span className="truncate text-muted-foreground">{c.sourceTitle || c.domain}</span>
                          {c.conflictSet ? <span className="rounded bg-amber-400/15 px-1 text-[10px] text-amber-300">⚠ {c.conflictSet}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* 按句子定位 —— 段落偏移的用处 */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input value={locateQ} onChange={(e) => setLocateQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doLocate(); }}
              placeholder="按一句话找它出自哪一版哪一段，例如「资金保障措施」"
              className="min-w-[16rem] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60" data-control="archive:locate-input" />
            <button type="button" onClick={() => void doLocate()} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent" data-control="archive:locate">定位</button>
          </div>
          {hits.length ? (
            <div className="space-y-1 rounded-md border border-sky-500/25 bg-sky-500/5 p-2">
              {hits.map((h, i) => (
                <div key={i} className="text-[11px]">
                  <span className="text-sky-300">{h.ord} 段 @{h.startOffset}</span>
                  <span className="mx-1 text-muted-foreground">·</span>
                  <a href={h.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary hover:underline">{h.url}</a>
                  <span className="ml-1 text-muted-foreground/70">（{h.fetchedAt.slice(0, 10)}）</span>
                  <div className="line-clamp-1 text-foreground/80">{h.text}</div>
                </div>
              ))}
            </div>
          ) : null}

          {arcBusy && !rows.length ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
              还没有归档。归档会**存下这一页此刻的内容**，之后可以对比它改了什么 —— 政策文件会改、新闻会撤稿，链接本身不作数。
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {rows.map((r) => (
                <div key={r.id} className="px-3 py-2" data-control="archive:row">
                  <div className="flex items-start gap-2">
                    <button type="button" onClick={() => void openArchive(r.id)} className="min-w-0 flex-1 text-left" data-control={`archive:open-${r.id.slice(0, 8)}`}>
                      <div className="truncate text-sm font-medium">{r.title || r.url}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{r.url}</div>
                    </button>
                    <div className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                      <span title="已存的版本数" className="inline-flex items-center gap-0.5"><BookOpen className="h-3 w-3" />{r.snapshotCount}</span>
                      {r.qualityLabel ? (
                        <span className={cn("rounded px-1.5 py-0.5",
                          r.qualityLabel === "clean" ? "bg-emerald-500/10 text-emerald-300"
                            : r.qualityLabel === "noisy" ? "bg-amber-500/10 text-amber-300"
                            : "bg-red-500/10 text-red-300")} title="抓取时的抽取质量（不是内容可信度）">
                          {r.qualityLabel} {r.qualityScore ?? ""}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-0.5"><Clock className="h-3 w-3" />{r.lastSeenAt.slice(0, 10)}</span>
                      <a href={r.url} target="_blank" rel="noreferrer" className="rounded border border-border p-1 hover:bg-accent" title="打开原页面"><ExternalLink className="h-3 w-3" /></a>
                      <button type="button" onClick={() => void del(r.id)} className="rounded border border-red-500/30 p-1 text-red-300 hover:bg-red-500/10" title="删除归档"><Trash2 className="h-3 w-3" /></button>
                    </div>
                  </div>

                  {openId === r.id ? (
                    <div className="mt-2 rounded border border-border bg-muted/20 p-2">
                      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">版本历史（{history.length}）</div>
                      <div className="space-y-1">
                        {history.map((h, i) => (
                          <div key={h.id} className="flex items-center gap-2 text-[11px]">
                            <span className="text-muted-foreground">v{i + 1}</span>
                            <span>{h.fetchedAt.slice(0, 16).replace("T", " ")}</span>
                            <span className="text-muted-foreground">{h.chars} 字 · {h.passages} 段</span>
                            <span className="rounded bg-muted px-1 text-[10px]">{h.via}</span>
                            {h.quality?.label ? <span className="text-muted-foreground">{h.quality.label}</span> : null}
                            {i > 0 ? (
                              <button type="button" onClick={() => void doDiff(history[i - 1].id, h.id)}
                                className="ml-auto inline-flex items-center gap-0.5 text-primary hover:underline" data-control={`archive:diff-${i}`}>
                                <GitCompare className="h-3 w-3" />与上一版比
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      {diff ? (
                        <div className="mt-2 space-y-1 border-t border-border pt-2">
                          <div className="text-[11px] text-muted-foreground">未变 {diff.unchanged} 段</div>
                          {diff.added.length ? (
                            <div>
                              <div className="text-[11px] text-emerald-300">新增 {diff.added.length} 段</div>
                              {diff.added.slice(0, 5).map((t, i) => <div key={i} className="line-clamp-2 text-[11px] text-emerald-200/80">+ {t}</div>)}
                            </div>
                          ) : null}
                          {diff.removed.length ? (
                            <div>
                              <div className="text-[11px] text-red-300">删除 {diff.removed.length} 段</div>
                              {diff.removed.slice(0, 5).map((t, i) => <div key={i} className="line-clamp-2 text-[11px] text-red-200/70">− {t}</div>)}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <div className="text-[10px] leading-relaxed text-muted-foreground/70">
            归档存的是**当时的内容快照**（含段落级偏移），不是书签。同一页面内容未变时不会重复存版本；
            质量徽标说的是"这次抽取干不干净"，不是"内容可不可信"。
          </div>
        </>
      )}
    </div>
  );
}

export default HotboardPanel;
