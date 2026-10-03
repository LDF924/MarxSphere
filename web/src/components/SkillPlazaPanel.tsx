// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// SkillPlazaPanel.tsx — Skill 广场(2026-10-03)
//
// 由来(用户): 「不应该命名为技能货架, 应该是 skill 广场 —— 开放的、互动式的、交流的、
//   有讨论区的; 大家可以上传自己的 skill; 平台搜集所有科研学术相关的 skill 放进来;
//   加一个审核机制, 管理员审核通过才能上架, 用户这边有进度条可以查询」。
//
// ═══ 与原「货架」的关系 ═══
//   原 SkillShelfPanel 是**只读的本地浏览**(分类/标签/来源筛选 + 版本热度),
//   它回答的是"本机有哪些技能"。广场回答的是另一件事: **别人做了什么、谁在审、
//   谁在用、大家在聊什么**。两者不互相替代, 所以各自保留 —— 货架归到「技能库」
//   面板内部当浏览视图, 广场是它的门面。
//
// ═══ 三件用户点名要的能力, 各自的落点 ═══
//   · **上传自己的 skill** → 「上传」按钮 → 从本机技能注册表里挑一个 → POST /plaza/submit
//   · **审核机制 + 进度条** → 提交后每条卡片带六步进度条; 管理员在「待审核」页通过/驳回,
//     驳回**必须写意见**(服务端强制), 结论走站内信通知作者
//   · **搜集所有科研学术相关的 skill** → 管理员的「收录本机技能」按钮, 一次性把
//     本仓技能注册表里的技能以 official 来源上架
import { useEffect, useMemo, useState } from "react";
import {
  Store, Loader2, Upload, Search, MessagesSquare, Download, Check, X, Pin,
  AlertTriangle, Send, ShieldCheck, Sparkles, User as UserIcon, RefreshCw, ChevronRight,
} from "lucide-react";
import { cn } from "../lib/utils";
import { api } from "../lib/api";
import { PanelNotice, panelInputCls } from "./PanelShell";

export interface PlazaItem {
  id: string; slug: string; title: string; summary: string; category: string;
  tags: string[]; origin: string; version: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  reviewNote: string; ownerId: string; ownerName: string;
  installCount: number; commentCount: number;
  submittedAt: string; reviewedAt: string | null;
  installed: boolean; mine: boolean;
}
interface PlazaStats { approved: number; pending: number; installs: number; contributors: number; comments: number; }
interface Comment {
  id: string; parentId: string | null; userId: string; author: string; body: string; createdAt: string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "审核中", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  approved: { label: "已上架", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  rejected: { label: "已驳回", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
  withdrawn: { label: "已撤回", cls: "border-border bg-muted/40 text-muted-foreground" },
};

/**
 * 六步进度条。
 *
 * ⚠ 步数由**服务端**给(`GET /plaza/:id` 回 currentStep), 前端不自己从 status 推 ——
 *   推的话两处各有一份判断, 改一处忘一处就会出现"卡片说已上架、进度条停在审核中"。
 *   列表页没有 currentStep, 所以这里只在**详情**里画进度条; 列表用状态徽章。
 */
const STEP_LABELS = ["提交", "审核中", "审核结论", "上架", "被使用", "讨论"];

function ProgressBar({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-1" data-control="plaza:progress">
      {STEP_LABELS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={label} className="flex flex-1 items-center gap-1">
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px]",
                done ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                  : active ? "border-primary/60 bg-primary/20 text-primary"
                  : "border-border bg-muted/30 text-muted-foreground"
              )}>
                {done ? <Check className="h-3 w-3" /> : i + 1}
              </div>
              <span className={cn("truncate text-[10px]", active ? "text-primary" : "text-muted-foreground")}>{label}</span>
            </div>
            {i < STEP_LABELS.length - 1 ? (
              <div className={cn("mb-4 h-px flex-1", done ? "bg-emerald-500/40" : "bg-border")} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SkillPlazaPanel({ onOpenSkill }: { onOpenSkill?: (slug: string) => void }) {
  const [scope, setScope] = useState<"" | "mine" | "pending">("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"new" | "hot" | "name">("new");
  const [items, setItems] = useState<PlazaItem[]>([]);
  const [counts, setCounts] = useState({ approved: 0, pending: 0, mine: 0 });
  const [stats, setStats] = useState<PlazaStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  /** 详情: 进度 + 讨论区 */
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ item: PlazaItem; currentStep: number } | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** 上传表单 */
  const [uploadOpen, setUploadOpen] = useState(false);
  /** 本机技能(上传时挑) */
  const [localSkills, setLocalSkills] = useState<Array<{ name: string; zhName?: string; zhDescription?: string; description?: string; zhCategory?: string; version?: string; tags?: string[] }>>([]);
  const [pick, setPick] = useState("");
  const [admin, setAdmin] = useState(false);

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const r = await api.getSkillPlaza({ scope, q: q.trim(), sort });
      setItems(r.items);
      setCounts(r.counts);
      const s = await api.getSkillPlazaStats().catch(() => null);
      if (s) setStats(s);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 160));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [scope, sort]);

  // 管理员判定: 能拉到待审列表就说明有权限(服务端对非管理员会退化成公开列表, 所以另看一眼)
  useEffect(() => {
    api.getSkillPlaza({ scope: "pending" })
      .then((r) => {
        // 非管理员时服务端把 pending 退化成 approved; 用"返回里有 pending 状态"反推
        setAdmin(r.items.some((x) => x.status === "pending"));
      })
      .catch(() => setAdmin(false));
  }, []);

  /** 打开详情: 取进度 + 讨论 */
  const openDetail = async (id: string) => {
    setOpenId(id); setDetail(null); setComments([]); setDraft("");
    try {
      const d = await api.getSkillSubmission(id);
      setDetail({ item: d.item, currentStep: d.currentStep });
      const c = await api.getSkillComments(id);
      setComments(c.comments);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 160));
    }
  };

  const doInstall = async (it: PlazaItem) => {
    setBusy(true); setErr("");
    try {
      const r = await api.installSkill(it.id);
      setMsg(r.already ? `「${it.title}」之前就装过了` : `已安装「${it.title}」`);
      await load();
      if (openId === it.id) await openDetail(it.id);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const doReview = async (it: PlazaItem, approve: boolean) => {
    let note = "";
    if (!approve) {
      // 驳回落意见 —— 服务端也强制, 但在这里就问一次, 免得用户提交完才发现被拒
      note = window.prompt("驳回理由(会通知作者, 他据此修改后可以重提):", "") ?? "";
      if (!note.trim()) { setErr("驳回必须写理由"); return; }
    }
    setBusy(true); setErr("");
    try {
      await api.reviewSkill(it.id, approve, note);
      setMsg(approve ? `已通过「${it.title}」` : `已驳回「${it.title}」`);
      await load();
      if (openId === it.id) { setOpenId(null); setDetail(null); }
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const doWithdraw = async (it: PlazaItem) => {
    if (!window.confirm(`撤回「${it.title}」？撤回后不再出现在广场上, 之后可以重新提交。`)) return;
    setBusy(true); setErr("");
    try {
      await api.withdrawSkill(it.id);
      setMsg(`已撤回「${it.title}」`);
      await load();
      setOpenId(null); setDetail(null);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const doComment = async () => {
    if (!openId || !draft.trim()) return;
    setBusy(true); setErr("");
    try {
      await api.addSkillComment(openId, draft.trim());
      setDraft("");
      const c = await api.getSkillComments(openId);
      setComments(c.comments);
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  /** 上传: 本机技能里挑一个 */
  const openUpload = async () => {
    setUploadOpen(true); setErr(""); setPick("");
    if (!localSkills.length) {
      try {
        const r = await api.listSkills();
        setLocalSkills((r?.skills ?? []) as typeof localSkills);
      } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    }
  };

  const doSubmit = async () => {
    const s = localSkills.find((x) => x.name === pick);
    if (!s) { setErr("先挑一个要上传的技能"); return; }
    setBusy(true); setErr("");
    try {
      await api.submitSkill({
        slug: s.name,
        title: s.zhName || s.name,
        summary: s.zhDescription || s.description || "",
        category: s.zhCategory || "",
        tags: s.tags ?? [],
        version: s.version,
      });
      setMsg(`「${s.zhName || s.name}」已提交, 等待管理员审核`);
      setUploadOpen(false); setScope("mine");
      await load();
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const doCurate = async () => {
    if (!window.confirm("把本机技能注册表里还没有提交记录的技能全部收录上架？(来源标为 official)")) return;
    setBusy(true); setErr("");
    try {
      const r = await api.curateSkills();
      setMsg(`收录完成: 新增 ${r.added} 条, 跳过 ${r.skipped} 条(已存在)`);
      await load();
    } catch (e) { setErr(String((e as Error)?.message ?? e).slice(0, 160)); }
    finally { setBusy(false); }
  };

  const shown = useMemo(() => items, [items]);

  return (
    <div className="space-y-3">
      {/* ── 头部: 名称 + 数字带 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Store className="h-4 w-4 text-primary" />Skill 广场
        </div>
        <span className="text-xs text-muted-foreground">学友互相分享科研技能的地方</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => void openUpload()} className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs text-primary hover:bg-primary/20" data-control="plaza:upload">
            <Upload className="h-3 w-3" />上传我的技能
          </button>
          <button type="button" onClick={() => void load()} className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent" data-control="plaza:refresh">
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {stats ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { n: stats.approved, l: "已上架技能" },
            { n: stats.contributors, l: "贡献学友" },
            { n: stats.installs, l: "累计安装" },
            { n: stats.comments, l: "广场讨论" },
            { n: stats.pending, l: "待审核" },
          ].map((x) => (
            <div key={x.l} className="rounded-md border border-border px-3 py-2 text-center">
              <div className="text-lg font-semibold text-accent-foreground">{x.n}</div>
              <div className="text-[10px] text-muted-foreground">{x.l}</div>
            </div>
          ))}
        </div>
      ) : null}

      {err ? <PanelNotice type="err">{err}</PanelNotice> : null}
      {msg ? <PanelNotice type="ok">{msg}</PanelNotice> : null}

      {/* ── 上传表单 ── */}
      {uploadOpen ? (
        <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="text-xs font-medium text-primary">上传我的技能到广场</div>
          <p className="text-[11px] text-muted-foreground">
            从本机技能里挑一个提交。提交后进入**管理员审核**, 通过才会上架 —— 在「我的提交」里能看到进度。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select value={pick} onChange={(e) => setPick(e.target.value)} className={cn(panelInputCls, "w-72 py-1")} data-control="plaza:pick-skill">
              <option value="">选择技能…</option>
              {localSkills.map((s) => <option key={s.name} value={s.name}>{s.zhName || s.name}</option>)}
            </select>
            <button type="button" onClick={() => void doSubmit()} disabled={busy || !pick} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" data-control="plaza:submit">
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}提交审核
            </button>
            <button type="button" onClick={() => setUploadOpen(false)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent">取消</button>
          </div>
        </div>
      ) : null}

      {/* ── 视图切换 + 搜索 ── */}
      <div className="flex flex-wrap items-center gap-2">
        {([["", `广场 ${counts.approved}`], ["mine", `我的提交 ${counts.mine}`]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setScope(k)} data-control={`plaza:scope-${k || "all"}`}
            className={cn("rounded-md border px-2.5 py-1 text-xs", scope === k ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
            {label}
          </button>
        ))}
        {admin ? (
          <button type="button" onClick={() => setScope("pending")} data-control="plaza:scope-pending"
            className={cn("inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs", scope === "pending" ? "border-amber-500/50 bg-amber-500/10 text-amber-300" : "border-border text-muted-foreground hover:bg-accent")}>
            <ShieldCheck className="h-3 w-3" />待审核 {counts.pending}
          </button>
        ) : null}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
            placeholder="搜索技能名 / 简介，回车" className="w-60 rounded-md border border-border bg-transparent py-1.5 pl-7 pr-2 text-xs" data-control="plaza:search" />
        </div>
        {([["new", "最新"], ["hot", "最多安装"], ["name", "按名称"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setSort(k)}
            className={cn("rounded-md border px-2 py-1 text-xs", sort === k ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
            {label}
          </button>
        ))}
        {admin ? (
          <button type="button" onClick={() => void doCurate()} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent" data-control="plaza:curate">
            <Sparkles className="h-3 w-3" />收录本机技能
          </button>
        ) : null}
      </div>

      {/* ── 列表 ── */}
      {loading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载广场…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          {scope === "mine" ? "你还没有提交过技能。点右上角「上传我的技能」试试。"
            : scope === "pending" ? "待审核队列是空的。"
            : "广场上还没有技能。管理员可以点「收录本机技能」把平台自带的科研技能放上来。"}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((it) => {
            const st = STATUS_META[it.status] ?? STATUS_META.withdrawn;
            return (
              <div key={it.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-3 transition-colors hover:border-primary/40" data-control="plaza:card">
                <div className="flex items-start gap-2">
                  <button type="button" onClick={() => void openDetail(it.id)} className="min-w-0 flex-1 text-left" data-control={`plaza:open-${it.slug}`}>
                    <div className="truncate text-sm font-medium">{it.title}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground/70">{it.slug}</div>
                  </button>
                  <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px]", st.cls)}>{st.label}</span>
                </div>
                <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{it.summary || "（作者没有写简介）"}</div>
                <div className="flex flex-wrap items-center gap-1">
                  {it.category ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{it.category}</span> : null}
                  {it.tags.slice(0, 3).map((t) => <span key={t} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">#{t}</span>)}
                  {it.version ? <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">v{it.version}</span> : null}
                  {it.origin === "official" ? <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-300">平台收录</span> : null}
                </div>
                {it.status === "rejected" && it.reviewNote ? (
                  <div className="rounded border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] text-red-300/90">
                    审核意见：{it.reviewNote}
                  </div>
                ) : null}
                <div className="mt-auto flex items-center gap-2 pt-1 text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5"><UserIcon className="h-2.5 w-2.5" />{it.ownerName}</span>
                  <span className="inline-flex items-center gap-0.5"><Download className="h-2.5 w-2.5" />{it.installCount}</span>
                  <span className="inline-flex items-center gap-0.5"><MessagesSquare className="h-2.5 w-2.5" />{it.commentCount}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {admin && it.status === "pending" ? (
                      <>
                        <button type="button" onClick={() => void doReview(it, true)} disabled={busy} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300 hover:bg-emerald-500/20" data-control={`plaza:approve-${it.slug}`}><Check className="h-3 w-3" /></button>
                        <button type="button" onClick={() => void doReview(it, false)} disabled={busy} className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-300 hover:bg-red-500/20" data-control={`plaza:reject-${it.slug}`}><X className="h-3 w-3" /></button>
                      </>
                    ) : null}
                    {it.mine && (it.status === "pending" || it.status === "approved") ? (
                      <button type="button" onClick={() => void doWithdraw(it)} disabled={busy} className="rounded border border-border px-1.5 py-0.5 hover:bg-accent" title="撤回">撤回</button>
                    ) : null}
                    {it.status === "approved" ? (
                      <button type="button" onClick={() => void doInstall(it)} disabled={busy}
                        className={cn("inline-flex items-center gap-0.5 rounded px-2 py-0.5", it.installed ? "border border-border text-muted-foreground" : "bg-primary text-primary-foreground")}
                        data-control={`plaza:install-${it.slug}`}>
                        {it.installed ? "已安装" : "安装"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 详情: 进度条 + 讨论区 ── */}
      {openId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { setOpenId(null); setDetail(null); }}>
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
              <Store className="h-4 w-4 text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium">{detail?.item.title ?? "加载中…"}</span>
              {detail ? <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", (STATUS_META[detail.item.status] ?? STATUS_META.withdrawn).cls)}>{(STATUS_META[detail.item.status] ?? STATUS_META.withdrawn).label}</span> : null}
              <button type="button" onClick={() => { setOpenId(null); setDetail(null); }} className="rounded p-1 hover:bg-accent" data-control="plaza:detail-close"><X className="h-4 w-4" /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!detail ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
              ) : (
                <div className="space-y-4">
                  {/* 进度条 —— 用户点名要的"可以查询的进度" */}
                  <div>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">上架进度</div>
                    <ProgressBar current={detail.currentStep} />
                    {detail.item.reviewNote ? (
                      <div className={cn("mt-2 rounded border px-2 py-1.5 text-[11px]",
                        detail.item.status === "rejected" ? "border-red-500/25 bg-red-500/10 text-red-300" : "border-border bg-muted/30 text-muted-foreground")}>
                        <span className="font-medium">审核意见：</span>{detail.item.reviewNote}
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                      <span>作者：{detail.item.ownerName}</span>
                      <span>版本：v{detail.item.version || "1.0.0"}</span>
                      <span>安装：{detail.item.installCount}</span>
                      <span>提交于：{(detail.item.submittedAt || "").slice(0, 10)}</span>
                    </div>
                  </div>

                  <div className="rounded border border-border bg-muted/20 p-3 text-xs leading-relaxed text-foreground/90">
                    {detail.item.summary || "（作者没有写简介）"}
                  </div>

                  {admin && detail.item.status === "pending" ? (
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => void doReview(detail.item, true)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300" data-control="plaza:detail-approve">
                        <Check className="h-3 w-3" />通过并上架
                      </button>
                      <button type="button" onClick={() => void doReview(detail.item, false)} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300" data-control="plaza:detail-reject">
                        <X className="h-3 w-3" />驳回
                      </button>
                    </div>
                  ) : null}

                  {/* 讨论区 */}
                  <div>
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                      <MessagesSquare className="h-3.5 w-3.5 text-primary" />讨论区（{comments.length}）
                    </div>
                    <div className="space-y-2">
                      {comments.length === 0 ? (
                        <div className="rounded border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                          还没有人聊这个技能。用法、踩坑、改进建议都可以写在这儿。
                        </div>
                      ) : comments.map((c) => (
                        <div key={c.id} className={cn("rounded border border-border p-2", c.parentId ? "ml-6 border-l-2 border-l-primary/30" : "")}>
                          <div className="mb-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="font-medium text-foreground/80">{c.author}</span>
                            <span>{(c.createdAt || "").slice(0, 16).replace("T", " ")}</span>
                          </div>
                          <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/90">{c.body}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-start gap-2">
                      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
                        placeholder="说点什么…（用法、坑、改进建议）"
                        className={cn(panelInputCls, "min-h-[3rem] flex-1 resize-y py-1.5")} data-control="plaza:comment-input" />
                      <button type="button" onClick={() => void doComment()} disabled={busy || !draft.trim()} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" data-control="plaza:comment-send">
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}发表
                      </button>
                    </div>
                  </div>

                  {onOpenSkill ? (
                    <button type="button" onClick={() => onOpenSkill(detail.item.slug)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      看这个技能的完整说明<ChevronRight className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        广场上的技能来自学友与平台收录, 上架前经过管理员审核；但请自行判断是否适合自己的研究场景。
      </div>
    </div>
  );
}

export default SkillPlazaPanel;
