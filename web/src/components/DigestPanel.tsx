// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// DigestPanel.tsx — 研究速递(2026-10-02)
//
// 由来: 对照旧项目 Respal 的「研究速递」测绘后补的。它每天 19:19 抓一次,
//   按用户订阅的主题分组推送, 界面是「日期 + 主题 chip + 卡片流 + 偏好设置」。
//
// ═══ 三个**有意不照抄**的地方(都是它实测踩到的坑, 见 migrations/174 头注释) ═══
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
import { useEffect, useState, useCallback } from "react";
import { Newspaper, RefreshCw, Settings, ExternalLink, CheckCheck, AlertTriangle, Loader2 } from "lucide-react";
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

/** 源的中文名 —— 显示给用户看的, 不是内部 id */
const SOURCE_LABEL: Record<string, string> = {
  "journal-updates": "期刊动态",
  openalex: "OpenAlex",
  crossref: "Crossref",
  rss: "订阅源",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "日期未详";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "日期未详";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DigestPanel() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [sub, setSub] = useState<Sub | null>(null);
  const [tab, setTab] = useState<string>("__all__");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showPrefs, setShowPrefs] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [journalDraft, setJournalDraft] = useState("");
  const [days, setDays] = useState(7);

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
    } catch (e) {
      setErr((e as Error).message || "加载失败");
    } finally { setBusy(false); }
  }, [digest]);

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

  async function savePrefs() {
    try {
      const topics = topicDraft.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
      const journals = journalDraft.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
      const r = await api.digestTopicsSet({ topics, preferredJournals: journals, days }) as Sub;
      setSub(r);
      setShowPrefs(false);
      setMsg("偏好已保存");
      await load();
    } catch (e) { setErr((e as Error).message || "保存失败"); }
  }

  async function markAllRead() {
    try { await api.digestRead([]); await load(); } catch (e) { setErr((e as Error).message || "标记失败"); }
  }

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

  const filtered = q.trim()
    ? active.filter((p) => `${p.title} ${p.journal} ${p.authors.join(" ")}`.toLowerCase().includes(q.trim().toLowerCase()))
    : active;

  return (
    <div className="space-y-3">
      <PanelHeader icon={<Newspaper className="h-4 w-4" />} title="研究速递" accent="violet" />

      {err && <PanelNotice type="err">{err}</PanelNotice>}
      {msg && <PanelNotice type="ok">{msg}</PanelNotice>}

      {/* ── 工具条 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题 / 期刊 / 作者"
          className={cn(panelInputCls, "w-64")}
          data-control="digest:search"
        />
        <PanelButton onClick={() => void doRefresh()} disabled={refreshing} data-control="digest:refresh">
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {refreshing ? "抓取中…" : "立即刷新"}
        </PanelButton>
        <PanelButton onClick={() => {
          setTopicDraft((sub?.topics ?? []).join("\n"));
          setJournalDraft((sub?.preferredJournals ?? []).join("\n"));
          setShowPrefs((v) => !v);
        }} data-control="digest:prefs">
          <Settings className="h-3 w-3" />偏好设置
        </PanelButton>
        <PanelButton onClick={() => void markAllRead()} data-control="digest:mark-all-read">
          <CheckCheck className="h-3 w-3" />全部已读
        </PanelButton>
        {digest && (
          <span className="text-xs text-muted-foreground">
            {digest.date} · 共 {digest.total} 篇
            {filtered.length !== active.length && ` · 筛选后 ${filtered.length} 篇`}
          </span>
        )}
      </div>

      {/* ── 偏好设置 ── */}
      {showPrefs && (
        <PanelCard title="订阅偏好">
          <div className="space-y-3 text-xs">
            <div>
              <div className="mb-1 text-muted-foreground">研究主题(每行一个)</div>
              <textarea
                value={topicDraft} onChange={(e) => setTopicDraft(e.target.value)} rows={4}
                className={cn(panelInputCls, "w-full")} placeholder={"地方政府行为\n政治经济学"}
                data-control="digest:prefs-topics"
              />
            </div>
            <div>
              <div className="mb-1 text-muted-foreground">
                订阅期刊(每行一个, 刊名需与本站期刊库一致)
              </div>
              <textarea
                value={journalDraft} onChange={(e) => setJournalDraft(e.target.value)} rows={3}
                className={cn(panelInputCls, "w-full")} placeholder={"党政研究\n马克思主义研究"}
                data-control="digest:prefs-journals"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">未读窗口</span>
              <input
                type="number" min={1} max={30} value={days}
                onChange={(e) => setDays(Math.min(30, Math.max(1, Number(e.target.value) || 7)))}
                className={cn(panelInputCls, "w-20")}
                data-control="digest:prefs-days"
              />
              <span className="text-muted-foreground">天</span>
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
            // 空的原因有三种, **必须分开说** —— 只说"还没有内容"会让用户以为抓取坏了。
            // 实测场景: 期刊条目按用户订阅的刊名过滤(条目表是全局的, 隔离靠这条 where),
            // 所以一个没设过订阅的用户即使库里有一堆内容, 看到的也是 0。
            if (!sub || (sub.topics.length === 0 && sub.preferredJournals.length === 0)) {
              return "还没有设置订阅。点上方「偏好设置」添加研究主题或订阅期刊, 然后点「立即刷新」抓取。";
            }
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

      <div className="space-y-2">
        {filtered.map((p) => (
          <PanelCard key={p.id + p.topics.join(",")}>
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium leading-snug">{p.title}</div>
                {!p.read && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" title="未读" />}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                {p.journal && <span>{p.journal}</span>}
                {p.authors.length > 0 && <span>{p.authors.slice(0, 3).join("、")}{p.authors.length > 3 ? " 等" : ""}</span>}
                {/* 出版日与抓取日**分开显示**: 期刊动态里常见"今天抓到 2021 年的目录",
                    只显示一个日期会让用户以为那是新内容 */}
                <span>{fmtDate(p.publishedAt)}</span>
                <span className="rounded bg-white/5 px-1.5 py-0.5">{SOURCE_LABEL[p.source] || p.source}</span>
              </div>
              {p.cnSummary && <div className="text-xs leading-relaxed text-foreground/80">{p.cnSummary}</div>}
              {!p.cnSummary && p.abstract && (
                <div className="text-xs leading-relaxed text-foreground/60">
                  {p.abstract.slice(0, 300)}{p.abstract.length > 300 ? "…" : ""}
                </div>
              )}
              {p.url && (
                <a
                  href={p.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />查看原文
                </a>
              )}
            </div>
          </PanelCard>
        ))}
      </div>

      {/* ── 抓取台账 ── */}
      {digest?.runs?.length ? (
        <PanelCard title="抓取台账">
          <div className="space-y-1 text-[11px] text-muted-foreground">
            {digest.runs.slice(0, 3).map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span>{r.startedAt.slice(0, 19).replace("T", " ")}</span>
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
