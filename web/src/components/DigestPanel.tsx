// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// DigestPanel.tsx — 研究速递(2026-10-02 初版; 2026-10-03 按用户要求重做)
//
// 由来: 对照旧项目 Respal 的「研究速递」测绘后补的。它每天 19:19 抓一次,
//   按用户订阅的主题分组推送, 界面是「日期 + 主题 chip + 卡片流 + 偏好设置」。
//
// ═══ 2026-10-03 重做(用户列了 8 条要求, 这里是其中 5 条) ═══
//   · 文章题目 / 作者 / 期刊名 / 摘要原文 / 可点击跳转正文 —— 卡片信息密度提高
//   · **日期选择器**(可任意选时间) —— 改前只能滚 chip, 想"看上周三抓了什么"做不到
//   · 偏好设置改为**勾选式**(主题 + 期刊, 按学科分组), 不再是两个让人手打的 textarea
//   · 按学科分好中英文 —— 期刊库的 field 就是学科, 语言由条目的 lang 决定
//
// ═══ 三个**有意不照抄** Respal 的地方(都是它实测踩到的坑, 见 migrations/174 头注释) ═══
//   ① 它按源 id 去重 → arXiv 同一篇因分类不同入库三次。本仓的去重在**服务端**
//      (item_doi_key / item_title_key 两条部分唯一索引), 前端不参与, 也无从绕过。
//   ② 它的中文刊不带 fetched_at → `ORDER BY fetched_at DESC` 撞上 NULLS LAST,
//      19 篇中文刊整批沉底。本仓 fetched_at 是 NOT NULL, 结构上不可能发生。
//   ③ 它的 published 混了四种格式, 前端只能写正则去擦。本仓入库前已归一成 ISO。
//
// ═══ 本面板**多做**的三件事 ═══
//   · 期刊桶与主题桶分开显示 —— 订了《党政研究》就收到它的目录, 但那不是"政治经济学
//     的研究成果", 混在一个列表里会误导。
//   · 明确显示**哪些订阅的刊取不到动态**(库外的刊), 否则空列表会被读成"没更新"。
//   · 显示抓取批次台账 —— "今天为什么只有 3 条"必须能查到是源挂了还是真没内容。
import { useEffect, useMemo, useState, useCallback } from "react";
import { Newspaper, RefreshCw, Settings, ExternalLink, CheckCheck, AlertTriangle, Loader2, CalendarDays, ChevronDown, ChevronRight, BookOpen, Languages } from "lucide-react";
import { PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, PanelNotice } from "./PanelShell";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

interface Paper {
  id: string; source: string; title: string; doi: string; url: string; journal: string;
  authors: string[]; abstract: string; cnSummary: string;
  publishedAt: string | null; fetchedAt: string; lang: string; topics: string[]; read: boolean;
}
interface Run {
  startedAt: string; ok: boolean; inserted: number;
  perSource: Array<{ source: string; ok: boolean; fetched: number; inserted: number; dup: number; error?: string }>;
  error?: string;
}
interface Digest {
  date: string; total: number;
  topics: Record<string, Paper[]>;
  journals: Record<string, Paper[]>;
  uncoveredJournals: string[];
  runs: Run[];
}
interface Sub { topics: string[]; preferredJournals: string[]; days: number; uncoveredJournals: string[] }
/** 可选项目录(/api/digest/catalog): 期刊库按学科分组 + topic_tags 并集 */
interface Catalog {
  fields: Array<{ field: string; journals: Array<{ name: string; level: string }> }>;
  topics: Array<{ name: string; journalCount: number; field: string }>;
}

/** 源的中文名 —— 显示给用户看的, 不是内部 id */
const SOURCE_LABEL: Record<string, string> = {
  "journal-updates": "期刊动态",
  openalex: "OpenAlex",
  crossref: "Crossref",
  rss: "订阅源",
};

/** 期刊库的 field → 中文分类名(库里的值已经是中文, 这里只做归一与排序) */
const FIELD_ORDER = ["马克思主义", "哲学", "经济学", "政治学", "党史党建", "社会学", "法学", "历史学", "综合"];

function fmtDate(iso: string | null): string {
  if (!iso) return "日期未详";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "日期未详";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDateLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}
/** 日期选择器的候选: 从抓取台账的批次时刻与条目抓取日里取并集, 倒序 */
function dateChoices(digest: Digest | null, papers: Paper[]): string[] {
  const set = new Set<string>();
  for (const p of papers) if (p.fetchedAt) set.add(p.fetchedAt.slice(0, 10));
  for (const r of digest?.runs ?? []) if (r.startedAt) set.add(r.startedAt.slice(0, 10));
  return [...set].sort().reverse();
}

export function DigestPanel() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [sub, setSub] = useState<Sub | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tab, setTab] = useState<string>("__all__");
  const [q, setQ] = useState("");
  /**
   * 日期筛选(2026-10-03 改真日历)。
   *
   * ⚠ 改前是一个下拉, 选项是**已有的抓取批次日**("不限 / 2026-10-02 / 2026-10-01")。
   *   那是"从已经抓到的日子里面挑", 用户要的是**能任意选年月日的日历** ——
   *   两者是两回事: 前者只能选到"有批次的那几天", 后者能问"9 月 15 到 10 月 1 之间有什么"。
   *   现在两个都留: `from`/`to` 是真日历(任选年月日), `batchDate` 是"按抓取批次"的快捷选择。
   */
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [batchDate, setBatchDate] = useState("");
  /** 期刊在线搜索结果(用户输入刊名 → OpenAlex/Crossref 实时搜) */
  const [journalQuery, setJournalQuery] = useState("");
  const [journalHits, setJournalHits] = useState<Array<{ name: string; source: string; works: number; level: string }>>([]);
  const [journalSearching, setJournalSearching] = useState(false);
  /** 自定义主题输入(不限于期刊库那 70 个标签) */
  const [customTopic, setCustomTopic] = useState("");
  /** 自定义 RSS / 网页源 —— 后端管线早就有(每 6 小时抓一次落进 digest_items), 缺的只是这个入口 */
  const [feeds, setFeeds] = useState<Array<{ id: string; name: string; url: string; createdAt: string }>>([]);
  const [feedUrl, setFeedUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [feedMsg, setFeedMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showPrefs, setShowPrefs] = useState(false);
  const [days, setDays] = useState(7);
  /** 勾选态草稿 —— 只在「保存」时提交, 取消就丢弃 */
  const [pickTopics, setPickTopics] = useState<string[]>([]);
  const [pickJournals, setPickJournals] = useState<string[]>([]);
  const [expandedPaper, setExpandedPaper] = useState<string | null>(null);
  /** 偏好设置里的折叠分组: 学科名或 "topics" */
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(["topics"]));

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      // 缓存命中先渲染旧数据再后台刷新(stale-while-revalidate)—— 照 Respal 的做法:
      // 命中缓存时它不是等着转圈, 而是先把上次的结果显示出来。
      const cached = sessionStorage.getItem("sag_digest_cache_v1");
      if (cached && !digest) {
        try { setDigest(JSON.parse(cached)); } catch { /* 缓存坏了就当没有 */ }
      }
      const [d, s] = await Promise.all([
        api.digestGet(),
        api.digestTopicsGet(),
      ]);
      setDigest(d as Digest);
      setSub(s as Sub);
      setDays((s as Sub).days || 7);
      try { sessionStorage.setItem("sag_digest_cache_v1", JSON.stringify(d)); } catch { /* 配额满则跳过 */ }
      // 自定义源列表(轻量, 每次都拉 —— 用户刚加的源要立刻看得见)
      const token2 = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
      void fetch("/api/digest/feeds", { headers: token2 ? { Authorization: `Bearer ${token2}` } : {} })
        .then((r) => r.json()).then((f) => { if (Array.isArray(f?.feeds)) setFeeds(f.feeds); }).catch(() => {});
      // 目录(可选主题/期刊)只在首次拉 —— 它是静态的期刊库快照
      if (!catalog) {
        void fetch("/api/digest/catalog", {
          headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        }).then((r) => r.json()).then((c) => { if (c?.fields) setCatalog(c as Catalog); }).catch(() => { /* 目录拉不到不影响主流程 */ });
      }
    } catch (e) {
      setErr((e as Error).message || "加载失败");
    } finally { setBusy(false); }
  }, [digest, catalog]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function doRefresh() {
    setRefreshing(true); setMsg(""); setErr("");
    try {
      const r = await api.digestRefresh() as { users: number; topics: number; inserted: number; summarized: number };
      setMsg(`抓取完成: ${r.topics} 个主题 → 新增 ${r.inserted} 条, 中文概括 ${r.summarized} 条`);
      await load();
    } catch (e) {
      setErr((e as Error).message || "抓取失败");
    } finally { setRefreshing(false); }
  }

  function openPrefs() {
    setPickTopics(sub?.topics ?? []);
    setPickJournals(sub?.preferredJournals ?? []);
    setShowPrefs((v) => !v);
  }
  function togglePick(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  }
  async function savePrefs() {
    try {
      const r = await api.digestTopicsSet({
        topics: pickTopics, preferredJournals: pickJournals, days,
      }) as Sub;
      setSub(r);
      setShowPrefs(false);
      setMsg(`偏好已保存：${pickTopics.length} 个主题、${pickJournals.length} 本期刊`);
      await load();
    } catch (e) { setErr((e as Error).message || "保存失败"); }
  }

  /** 试抓 + 保存自定义源。顺序是**先试抓再保存** —— 存一个抓不到东西的地址, 用户要等 6 小时才知道。 */
  async function addFeed() {
    const url = feedUrl.trim();
    if (!/^https?:[/][/]/.test(url)) { setFeedMsg("请填 http(s) 开头的地址"); return; }
    setFeedMsg("试抓中…");
    const tk = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    try {
      const pv = await fetch(`/api/digest/feed-preview?url=${encodeURIComponent(url)}`, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} }).then((r) => r.json());
      if (!pv?.ok) { setFeedMsg(`抓不到这个源：${pv?.error || "未知错误"}`); return; }
      if (!pv.count) { setFeedMsg("这个地址能打开，但里面没有解析出条目（可能不是 RSS/Atom）"); return; }
      const r = await fetch("/api/rss/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
        body: JSON.stringify({ url, name: feedName.trim() || pv.sample?.[0]?.slice(0, 20) || "自定义源" }),
      }).then((x) => x.json());
      if (!r?.ok) { setFeedMsg("保存失败"); return; }
      setFeedMsg(`已添加（可抓到 ${pv.count} 条，每 6 小时刷新一次）`);
      setFeedUrl(""); setFeedName("");
      await load();
    } catch (e) { setFeedMsg(`失败：${String((e as Error).message).slice(0, 80)}`); }
  }
  async function removeFeed(id: string) {
    const tk = localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || "";
    try {
      await fetch(`/api/digest/feeds/${id}`, { method: "DELETE", headers: tk ? { Authorization: `Bearer ${tk}` } : {} });
      setFeeds(feeds.filter((f) => f.id !== id));
    } catch { /* 删失败下次刷新会回来, 不谎报成功 */ }
  }

  /** 在线搜刊 —— 结果只用于**挑选**, 选中后进 pickJournals, 与本地刊名走同一条订阅路径 */
  async function searchJournals() {
    const q = journalQuery.trim();
    if (q.length < 2) return;
    setJournalSearching(true);
    try {
      const r = await fetch(`/api/digest/journal-search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
      }).then((x) => x.json());
      setJournalHits(Array.isArray(r?.results) ? r.results : []);
    } catch { setJournalHits([]); }
    finally { setJournalSearching(false); }
  }

  async function markAllRead() {
    try { await api.digestRead([]); await load(); } catch (e) { setErr((e as Error).message || "标记失败"); }
  }

  /** 全部条目(去重) —— 日期选择器、学科分组、统计都要在**全量**上算, 不能只在当前 chip 上 */
  const allPapers: Paper[] = useMemo(() => {
    if (!digest) return [];
    const m = new Map<string, Paper>();
    for (const v of Object.values(digest.topics)) for (const p of v) m.set(p.id, p);
    for (const v of Object.values(digest.journals)) for (const p of v) m.set(p.id, p);
    return [...m.values()];
  }, [digest]);

  /** 当前 tab 下要显示的列表。**主题 chip 切换是零请求的** —— 数据一次全取回,
   *  切换只改本地筛选(照 Respal 的接口形状: {topics:{主题:[Paper]}})。 */
  const lists: Array<{ key: string; label: string; papers: Paper[] }> = (() => {
    if (!digest) return [];
    const out: Array<{ key: string; label: string; papers: Paper[] }> = [];
    for (const [k, v] of Object.entries(digest.topics)) out.push({ key: `t:${k}`, label: k, papers: v });
    for (const [k, v] of Object.entries(digest.journals)) out.push({ key: `j:${k}`, label: `📖 ${k}`, papers: v });
    return out;
  })();

  const active = tab === "__all__"
    ? lists.flatMap((l) => l.papers)
    : (lists.find((l) => l.key === tab)?.papers ?? []);

  const dateOptions = useMemo(() => dateChoices(digest, allPapers), [digest, allPapers]);

  const filtered = useMemo(() => {
    let rows = active;
    // 按**条目日期**筛(fetchedAt 抓取日)。没有 publishedAt 兜底的缘故:
    //   期刊目录类条目的 publishedAt 是从标题里的年份推出来的(只有年), 用它筛"某天"会全落空。
    const day = (p: Paper) => (p.fetchedAt || "").slice(0, 10);
    if (from) rows = rows.filter((p) => day(p) >= from);
    if (to) rows = rows.filter((p) => day(p) <= to);
    if (batchDate) rows = rows.filter((p) => day(p) === batchDate);
    if (q.trim()) {
      const kw = q.trim().toLowerCase();
      rows = rows.filter((p) => `${p.title} ${p.journal} ${p.authors.join(" ")} ${p.abstract}`.toLowerCase().includes(kw));
    }
    return rows;
  }, [active, from, to, batchDate, q]);

  /**
   * 按**语言**分组, 组内按日期倒序。
   * 用户要的是"按学科全部分好为中英文" —— 学科由期刊的 field 承载(偏好设置里按学科分组),
   * 条目这一层能可靠拿到的只有语言(lang), 所以这里分中英, 学科在偏好设置里分。
   */
  const grouped = useMemo(() => {
    const zh = filtered.filter((p) => p.lang === "zh" || (!p.lang && /[一-龥]/.test(p.title)));
    const en = filtered.filter((p) => !(p.lang === "zh" || (!p.lang && /[一-龥]/.test(p.title))));
    const byDate = (a: Paper, b: Paper) => (b.publishedAt || b.fetchedAt).localeCompare(a.publishedAt || a.fetchedAt);
    return [
      { key: "zh", label: "中文文献", rows: [...zh].sort(byDate) },
      { key: "en", label: "English / 外文", rows: [...en].sort(byDate) },
    ].filter((g) => g.rows.length > 0);
  }, [filtered]);

  const fieldGroups = catalog?.fields ?? [];
  const topicOptions = catalog?.topics ?? [];

  return (
    <div className="space-y-3">
      <PanelHeader icon={<Newspaper className="h-4 w-4" />} title="研究速递" accent="violet" />

      {err && <PanelNotice type="err">{err}</PanelNotice>}
      {msg && <PanelNotice type="ok">{msg}</PanelNotice>}

      {/* ── 工具条 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 期刊 / 作者 / 摘要"
          className={cn(panelInputCls, "w-56")}
          data-control="digest:search"
        />
        <PanelButton onClick={() => void doRefresh()} disabled={refreshing} data-control="digest:refresh">
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {refreshing ? "抓取中…" : "立即刷新"}
        </PanelButton>
        <PanelButton onClick={openPrefs} data-control="digest:prefs">
          <Settings className="h-3 w-3" />偏好设置
        </PanelButton>
        <PanelButton onClick={() => void markAllRead()} data-control="digest:mark-all-read">
          <CheckCheck className="h-3 w-3" />全部已读
        </PanelButton>
        {digest && (
          <span className="text-xs text-muted-foreground">
            共 {digest.total} 篇
            {(from || to || batchDate) ? ` · 筛选后 ${filtered.length} 篇` : ""}
          </span>
        )}
      </div>

      {/* ── 日期(独立一行) ──
          ⚠ 它**不能**跟上面的搜索框/按钮挤同一行: 两个 <input type=date> 各有一整块
          原生控件宽度(年/月/日 三段), 挤进 flex-wrap 会被折成上下两行且互相错位(实测截图)。
          日历这类控件需要自己的横向空间。 */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CalendarDays className="h-3.5 w-3.5" />
        <input
          type="date" value={from} max={to || undefined}
          onChange={(e) => { setFrom(e.target.value); setBatchDate(""); }}
          className={cn(panelInputCls, "w-auto py-1")}
          data-control="digest:date-from"
          title="起始日期（含）"
        />
        <span>至</span>
        <input
          type="date" value={to} min={from || undefined}
          onChange={(e) => { setTo(e.target.value); setBatchDate(""); }}
          className={cn(panelInputCls, "w-auto py-1")}
          data-control="digest:date-to"
          title="结束日期（含）"
        />
        {([["近 7 天", 7], ["近 30 天", 30], ["本月", -1]] as const).map(([label, d]) => (
          <button
            key={label} type="button"
            onClick={() => {
              setBatchDate("");
              const today = new Date();
              const iso = (x: Date) => x.toISOString().slice(0, 10);
              if (d === -1) { setFrom(iso(new Date(today.getFullYear(), today.getMonth(), 1))); setTo(iso(today)); }
              else { setFrom(iso(new Date(Date.now() - d * 86_400_000))); setTo(iso(today)); }
            }}
            className="rounded border border-border px-1.5 py-0.5 hover:bg-accent"
            data-control={`digest:range-${d === -1 ? "month" : d}`}
          >{label}</button>
        ))}
        {dateOptions.length ? (
          <select
            value={batchDate}
            onChange={(e) => { setBatchDate(e.target.value); if (e.target.value) { setFrom(""); setTo(""); } }}
            className={cn(panelInputCls, "w-auto py-1")}
            data-control="digest:batch"
            title="按抓取批次看（某一次抓到的全部）"
          >
            <option value="">按批次…</option>
            {dateOptions.map((d) => <option key={d} value={d}>{d} 抓的</option>)}
          </select>
        ) : null}
        {(from || to || batchDate) ? (
          <button
            type="button"
            onClick={() => { setFrom(""); setTo(""); setBatchDate(""); }}
            className="rounded border border-border px-1.5 py-0.5 hover:bg-accent"
            data-control="digest:date-clear"
          >清除</button>
        ) : null}
      </div>
      {/* ── 偏好设置: 勾选式(2026-10-03 重做) ── */}
      {showPrefs && (
        <PanelCard title="订阅偏好">
          <div className="space-y-4 text-xs">
            <p className="text-muted-foreground">
              直接点选你要的主题与期刊。候选来自本站期刊库（{fieldGroups.reduce((n, f) => n + f.journals.length, 0)} 本，
              按学科分组）—— 手打刊名很容易打错，打错了就静默收不到内容。
            </p>

            {/* 研究主题 */}
            <div>
              <button
                type="button"
                onClick={() => setOpenGroups((s) => { const n = new Set(s); n.has("topics") ? n.delete("topics") : n.add("topics"); return n; })}
                className="mb-1.5 flex w-full items-center gap-1 text-left font-medium"
              >
                {openGroups.has("topics") ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                研究主题
                <span className="ml-1 text-muted-foreground">已选 {pickTopics.length} / {topicOptions.length}</span>
              </button>
              {openGroups.has("topics") ? (
                /* 主题**也按学科分组**(用户要求"按学科全部分好")。一个主题横跨多学科时
                   归到它出现最多的那个(后端 dominantField), 见 /api/digest/catalog 的说明。 */
                <div className="max-h-60 space-y-1 overflow-y-auto rounded border border-border p-1.5">
                  {topicOptions.length === 0 ? (
                    <span className="text-muted-foreground">目录加载中…（拉不到时可先保存，稍后重试）</span>
                  ) : [...new Set(topicOptions.map((t) => t.field))].sort((a, b) => {
                    const ia = FIELD_ORDER.indexOf(a), ib = FIELD_ORDER.indexOf(b);
                    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                  }).map((field) => {
                    const list = topicOptions.filter((t) => t.field === field);
                    const picked = list.filter((t) => pickTopics.includes(t.name)).length;
                    return (
                      <div key={field}>
                        <div className="px-1 py-0.5 text-[10px] text-muted-foreground/70">
                          {field} <span className="opacity-60">{list.length} 个主题{picked ? ` · 已选 ${picked}` : ""}</span>
                        </div>
                        <div className="flex flex-wrap gap-1 px-1 pb-1">
                          {list.map((t) => {
                            const on = pickTopics.includes(t.name);
                            return (
                              <button
                                key={t.name} type="button"
                                onClick={() => togglePick(pickTopics, setPickTopics, t.name)}
                                data-control="digest:pick-topic"
                                title={`${t.journalCount} 本刊覆盖此主题`}
                                className={cn(
                                  "rounded-full border px-2 py-0.5 transition-colors",
                                  on ? "border-violet-400/60 bg-violet-500/20 text-violet-200" : "border-border text-muted-foreground hover:bg-accent"
                                )}
                              >{on ? "✓ " : ""}{t.name} <span className="opacity-60">{t.journalCount}</span></button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {/* 期刊: 按学科分组 */}
            <div>
              <div className="mb-1.5 font-medium">订阅期刊 <span className="ml-1 text-muted-foreground">已选 {pickJournals.length} 本</span></div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded border border-border p-1.5">
                {fieldGroups.length === 0 ? (
                  <div className="text-muted-foreground">目录加载中…</div>
                ) : [...fieldGroups].sort((a, b) => {
                  const ia = FIELD_ORDER.indexOf(a.field), ib = FIELD_ORDER.indexOf(b.field);
                  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                }).map((g) => {
                  const open = openGroups.has(g.field);
                  const picked = g.journals.filter((j) => pickJournals.includes(j.name)).length;
                  return (
                    <div key={g.field}>
                      <button
                        type="button"
                        onClick={() => setOpenGroups((s) => { const n = new Set(s); n.has(g.field) ? n.delete(g.field) : n.add(g.field); return n; })}
                        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left hover:bg-accent/40"
                      >
                        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        <BookOpen className="h-3 w-3 text-muted-foreground" />
                        <span className="font-medium">{g.field}</span>
                        <span className="text-muted-foreground">{g.journals.length} 本{picked ? ` · 已选 ${picked}` : ""}</span>
                      </button>
                      {open ? (
                        <div className="flex flex-wrap gap-1 px-4 pb-1.5">
                          {g.journals.map((j) => {
                            const on = pickJournals.includes(j.name);
                            return (
                              <button
                                key={j.name} type="button"
                                onClick={() => togglePick(pickJournals, setPickJournals, j.name)}
                                data-control="digest:pick-journal"
                                title={j.level ? `收录级别：${j.level}` : undefined}
                                className={cn(
                                  "rounded border px-1.5 py-0.5 transition-colors",
                                  on ? "border-violet-400/60 bg-violet-500/20 text-violet-200" : "border-border text-muted-foreground hover:bg-accent"
                                )}
                              >{on ? "✓ " : ""}{j.name}{j.level ? <span className="ml-1 opacity-55">{j.level}</span> : null}</button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 自定义主题(2026-10-03): 上面那批勾选项来自期刊库的 topic_tags, 是**他人预设的标签**,
                不该是上限。这里允许直接输入任意研究方向 —— 抓取链会拿它去 OpenAlex/Crossref/期刊库三路检索。 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={customTopic}
                onChange={(e) => setCustomTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const v = customTopic.trim();
                  if (v && !pickTopics.includes(v)) setPickTopics([...pickTopics, v]);
                  setCustomTopic("");
                }}
                placeholder="自定义主题，回车添加（不限于上面的标签）"
                className={cn(panelInputCls, "w-64 py-1")}
                data-control="digest:topic-custom"
              />
              <button
                type="button"
                onClick={() => { const v = customTopic.trim(); if (v && !pickTopics.includes(v)) setPickTopics([...pickTopics, v]); setCustomTopic(""); }}
                className="rounded border border-border px-2 py-1 hover:bg-accent"
                data-control="digest:topic-add"
              >添加</button>
              {pickTopics.filter((t) => !topicOptions.some((o) => o.name === t)).map((t) => (
                <span key={t} className="flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-0.5 text-violet-200">
                  {t}
                  <button type="button" onClick={() => setPickTopics(pickTopics.filter((x) => x !== t))} title="移除">×</button>
                </span>
              ))}
            </div>

            {/* 期刊在线搜索(2026-10-03): 本库只有 80 本马理论刊, 订《经济研究》这类刊时
                在界面上**根本看不到刊名**。这里接 OpenAlex(中文召回好, 1345 本中国刊)+Crossref。 */}
            <div>
              <div className="mb-1.5 font-medium">按刊名在线搜索 <span className="ml-1 text-muted-foreground">（本站库之外的刊也能订）</span></div>
              <div className="flex gap-1.5">
                <input
                  value={journalQuery}
                  onChange={(e) => setJournalQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void searchJournals(); }}
                  placeholder="输入刊名，如「经济研究」「社会学研究」"
                  className={cn(panelInputCls, "flex-1 py-1")}
                  data-control="digest:journal-query"
                />
                <button
                  type="button"
                  onClick={() => void searchJournals()}
                  disabled={journalSearching}
                  className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50"
                  data-control="digest:journal-search"
                >{journalSearching ? "搜索中…" : "搜索"}</button>
              </div>
              {journalHits.length ? (
                <div className="mt-1.5 flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded border border-border p-1.5">
                  {journalHits.map((h) => {
                    const on = pickJournals.includes(h.name);
                    return (
                      <button
                        key={h.name + h.source} type="button"
                        onClick={() => togglePick(pickJournals, setPickJournals, h.name)}
                        data-control="digest:journal-hit"
                        title={`来源 ${h.source}${h.works ? ` · ${h.works} 篇` : ""}`}
                        className={cn(
                          "rounded border px-1.5 py-0.5 transition-colors",
                          on ? "border-violet-400/60 bg-violet-500/20 text-violet-200" : "border-border text-muted-foreground hover:bg-accent"
                        )}
                      >{on ? "✓ " : ""}{h.name}
                        {h.level ? <span className="ml-1 text-[10px] text-emerald-300">{h.level}</span> : null}
                        <span className="ml-1 text-[10px] opacity-50">{h.source === "openalex" ? "OA" : "CR"}</span>
                      </button>
                    );
                  })}
                </div>
              ) : journalQuery && !journalSearching ? <div className="mt-1 text-muted-foreground/70">点「搜索」查询在线期刊库</div> : null}
            </div>

            {/* 已选但不在本站库里的刊 —— 抓取时只能靠主题命中的刊目动态, 要如实说明 */}
            {pickJournals.some((j) => !(catalog?.fields ?? []).some((g) => g.journals.some((x) => x.name === j))) ? (
              <PanelNotice type="warn">
                这些刊不在本站期刊库内，只能靠 OpenAlex/Crossref 的在线检索取到内容，命中率低于库内刊物：
                {pickJournals.filter((j) => !(catalog?.fields ?? []).some((g) => g.journals.some((x) => x.name === j))).join("、")}
              </PanelNotice>
            ) : null}

            {/* 自定义 RSS / 网页源(2026-10-03)。后端管线早就有 —— 写 sources.metadata、
                每 6 小时抓一次、结果落进 digest_items; 缺的只是让你能填地址的地方。 */}
            <div>
              <div className="mb-1.5 font-medium">自定义源 <span className="ml-1 text-muted-foreground">（RSS / Atom）</span></div>
              <div className="flex flex-wrap gap-1.5">
                <input
                  value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)}
                  placeholder="https://…（RSS/Atom 地址）"
                  className={cn(panelInputCls, "min-w-[16rem] flex-1 py-1")}
                  data-control="digest:feed-url"
                />
                <input
                  value={feedName} onChange={(e) => setFeedName(e.target.value)}
                  placeholder="名称（可空）"
                  className={cn(panelInputCls, "w-32 py-1")}
                  data-control="digest:feed-name"
                />
                <button type="button" onClick={() => void addFeed()}
                  className="rounded border border-border px-2 py-1 hover:bg-accent"
                  data-control="digest:feed-add"
                >试抓并添加</button>
              </div>
              {feedMsg ? <div className="mt-1 text-muted-foreground">{feedMsg}</div> : null}
              {feeds.length ? (
                <div className="mt-1.5 space-y-1 rounded border border-border p-1.5">
                  {feeds.map((f) => (
                    <div key={f.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="min-w-0 flex-[2] truncate font-mono text-[10px] text-muted-foreground/60">{f.url}</span>
                      <button type="button" onClick={() => void removeFeed(f.id)}
                        className="shrink-0 rounded border border-border px-1.5 py-0.5 hover:bg-accent"
                        data-control="digest:feed-remove"
                      >移除</button>
                    </div>
                  ))}
                </div>
              ) : <div className="mt-1 text-muted-foreground/70">未添加自定义源。实测可用：<code className="text-[10px]">http://www.qstheory.cn/rss/qstheory.xml</code>（求是网）</div>}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">展示最近</span>
              <input
                type="number" min={1} max={30} value={days}
                onChange={(e) => setDays(Math.min(30, Math.max(1, Number(e.target.value) || 7)))}
                className={cn(panelInputCls, "w-20")}
                data-control="digest:prefs-days"
              />
              <span className="text-muted-foreground">
                天（抓取窗口固定至少 90 天 —— 外文库对中文社科索引滞后，只抓 7 天常常什么都抓不到）
              </span>
            </div>

            {sub?.uncoveredJournals?.length ? (
              <PanelNotice type="warn">
                以下期刊本站暂无动态数据, 订阅了也收不到内容: {sub.uncoveredJournals.join("、")}
                。期刊库覆盖 80 本马理论相关刊物, 库外的刊请改用主题订阅。
              </PanelNotice>
            ) : null}

            <div className="flex gap-2">
              <PanelButton onClick={() => void savePrefs()} data-control="digest:prefs-save">保存</PanelButton>
              <PanelButton onClick={() => setShowPrefs(false)}>取消</PanelButton>
            </div>
          </div>
        </PanelCard>
      )}

      {/* ── 主题 / 期刊 chip ── */}
      {lists.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setTab("__all__")}
            className={cn(
              "rounded px-2.5 py-1 text-xs",
              tab === "__all__" ? "bg-violet-500/20 text-violet-200" : "text-muted-foreground hover:bg-white/5"
            )}
            data-control="digest:chip-all"
          >全部</button>
          {lists.map((l) => (
            <button
              key={l.key}
              onClick={() => setTab(l.key)}
              className={cn(
                "rounded px-2.5 py-1 text-xs",
                tab === l.key ? "bg-violet-500/20 text-violet-200" : "text-muted-foreground hover:bg-white/5"
              )}
              data-control={`digest:chip-${l.key}`}
            >{l.label} ({l.papers.length})</button>
          ))}
        </div>
      )}

      {/* ── 卡片流 ── */}
      {busy && !digest && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />加载中…
        </div>
      )}

      {!busy && filtered.length === 0 && (
        <PanelEmpty>
          {(() => {
            // 空的原因有几种, **必须分开说** —— 只说"还没有内容"会让用户以为抓取坏了。
            if (!sub || (sub.topics.length === 0 && sub.preferredJournals.length === 0)) {
              return "还没有设置订阅。点上方「偏好设置」勾选研究主题或订阅期刊, 然后点「立即刷新」抓取。";
            }
            if (batchDate) return `${batchDate} 这一次抓取没有内容。换一个批次看看, 或点「清除」。`;
            if (from || to) return `所选区间（${from || "最早"} ~ ${to || "今天"}）内没有内容。放宽区间试试，或点「清除」。`;
            if (sub.topics.length === 0) {
              return "你只订阅了期刊。期刊动态按刊推送, 若下方提示某些刊暂无数据, 可另外加几个研究主题。";
            }
            if (digest && digest.total === 0) {
              return "订阅已设置, 但库里还没有抓到的内容。点「立即刷新」抓取一次; 若仍为空, 请看下方「抓取台账」里各源是否失败。";
            }
            return "当前筛选下没有匹配的文献。";
          })()}
        </PanelEmpty>
      )}

      {/* 按语言分组渲染 */}
      {grouped.map((g) => (
        <div key={g.key} className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Languages className="h-3.5 w-3.5" />
            {g.label}
            <span className="opacity-60">{g.rows.length} 篇</span>
          </div>
          {g.rows.map((p) => {
            const expanded = expandedPaper === p.id;
            const hasLongAbs = p.abstract.length > 220;
            return (
              <PanelCard key={p.id + p.topics.join(",")}>
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium leading-snug">{p.title}</div>
                    {!p.read && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" title="未读" />}
                  </div>

                  {/* 作者 / 期刊 / 日期 / 来源 —— 用户点名要的字段 */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    {p.authors.length > 0 ? (
                      <span className="text-foreground/70">{p.authors.slice(0, 3).join("、")}{p.authors.length > 3 ? ` 等 ${p.authors.length} 人` : ""}</span>
                    ) : <span className="opacity-60">作者未详</span>}
                    {p.journal && <span className="rounded bg-white/5 px-1.5 py-0.5">{p.journal}</span>}
                    {/* 出版日与抓取日**分开显示**: 期刊动态里常见"今天抓到 2021 年的目录",
                        只显示一个日期会让用户以为那是新内容 */}
                    <span title="出版日期">{fmtDate(p.publishedAt)}</span>
                    <span className="opacity-60" title="抓取日期">抓于 {p.fetchedAt.slice(0, 10)}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5">{SOURCE_LABEL[p.source] || p.source}</span>
                  </div>

                  {/* 摘要原文 —— 优先显示中文概括, 没有则显示原文摘要 */}
                  {p.cnSummary ? (
                    <div className="text-xs leading-relaxed text-foreground/80">{p.cnSummary}</div>
                  ) : null}
                  {p.abstract ? (
                    <div className="text-xs leading-relaxed text-foreground/60">
                      {expanded ? p.abstract : p.abstract.slice(0, 220)}
                      {hasLongAbs ? (
                        <button
                          onClick={() => setExpandedPaper(expanded ? null : p.id)}
                          className="ml-1 text-violet-300 hover:underline"
                          data-control="digest:expand-abstract"
                        >{expanded ? "收起" : "展开全文"}</button>
                      ) : null}
                    </div>
                  ) : null}
                  {!p.abstract && !p.cnSummary ? (
                    <div className="text-[11px] text-muted-foreground/60">该来源未提供摘要（期刊目录/征稿类条目通常只有标题与链接）</div>
                  ) : null}

                  {p.url && (
                    <a
                      href={p.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />跳转正文
                    </a>
                  )}
                </div>
              </PanelCard>
            );
          })}
        </div>
      ))}

      {/* ── 抓取台账 ── */}
      {digest?.runs?.length ? (
        <PanelCard title="抓取台账">
          <div className="space-y-1 text-[11px] text-muted-foreground">
            {digest.runs.slice(0, 5).map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span>{fmtDateLong(r.startedAt)}</span>
                <span className={r.ok ? "text-emerald-400" : "text-amber-400"}>{r.ok ? "成功" : "有源失败"}</span>
                <span>新增 {r.inserted}</span>
                {r.perSource.map((s) => (
                  <span key={s.source} className={s.ok ? "" : "text-amber-400"}>
                    {SOURCE_LABEL[s.source] || s.source} {s.fetched}条{s.ok ? "" : `(${s.error || "失败"})`}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </PanelCard>
      ) : null}

      {/* 库外的刊提醒 —— 放在末尾也显示一次, 免得用户只看到空列表 */}
      {digest?.uncoveredJournals?.length ? (
        <PanelNotice type="warn">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          订阅的 {digest.uncoveredJournals.join("、")} 暂无动态数据。
        </PanelNotice>
      ) : null}
    </div>
  );
}
