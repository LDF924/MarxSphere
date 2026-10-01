// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// PPTWorkbenchPanel.tsx — PPT 生成工作台(2026-10-01, 旧项目 M9 模块的对位重建)
//
// 由来: 旧项目 AItoolman 的 M9 是它**最大的模块**(111/606 个符号) —— 大纲→脚本→配图→导出,
//   带单页重生/风格模仿/参考图/批注重绘/版本管理。本仓原先只有 `exportOutlinePptx`
//   (封面 + 每章一页), 没有工作台。
//
// ⚠ 配图**不是 AI 插画**: 本仓没有接生图服务, 服务端用本地渲染的示意图代替,
//   返回里带 `imageSource: "placeholder"`。界面上如实标注, 不把示意图说成 AI 生成。
//
// ═══ 第一版为什么丑 ═══
//   "左栏一串标题 + 右侧一列裸卡片" —— 看不出这是个**演示文稿**, 更像一个任务日志。
//   改成: 顶部四步进度条(一眼知道走到哪) + 左侧任务卡(带状态徽章与进度) +
//   右侧**16:9 缩略图网格**(幻灯片本来就该长这样) + 点开单页看要点与讲稿。
import { useEffect, useState } from "react";
import {
  Presentation, Plus, Download, RefreshCw, Trash2, Loader2, Image as ImageIcon,
  CheckCircle2, Circle, Clock, AlertTriangle, Layers,
} from "lucide-react";
import {
  PanelHeader, PanelCard, PanelButton, PanelEmpty, panelInputCls, StatTile, panelAccent, PillGroup,
} from "./PanelShell";
import { PptSkillPathPanel } from "./PptSkillPathPanel";
import { cn } from "../lib/utils";

interface Job { id: string; title: string; status: string; stage?: string; progress?: number; updatedAt?: string; slideCount?: number }
interface Page {
  seq: number; kind: string; title: string; bullets?: string[];
  notes?: string; imageSource?: string | null; locked?: boolean;
}

/** 四步流水线 —— 界面上要能看出"走到哪一步了" */
const STEPS = [
  { key: "outline", label: "大纲", icon: Layers },
  { key: "scripts", label: "脚本", icon: Presentation },
  { key: "illustrate", label: "配图", icon: ImageIcon },
  { key: "export", label: "导出", icon: Download },
] as const;

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "border-slate-500/40 bg-slate-500/10 text-slate-300" },
  created: { label: "新建", cls: "border-slate-500/40 bg-slate-500/10 text-slate-300" },
  outline_ready: { label: "大纲就绪", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  scripting: { label: "生成脚本", cls: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
  rendering: { label: "配图", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  exporting: { label: "导出中", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  done: { label: "已完成", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  failed: { label: "失败", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
};

const KIND_LABEL: Record<string, string> = {
  cover: "封面", toc: "目录", section: "章节", content: "正文", end: "结束",
};

/** 当前走到哪一步(由页面内容推断, 比只看 job.status 准) */
function stepState(pages: Page[]): Record<(typeof STEPS)[number]["key"], "done" | "now" | "todo"> {
  const hasOutline = pages.length > 0;
  const hasScripts = pages.some((p) => (p.bullets?.length ?? 0) > 0 || !!p.notes);
  const hasImages = pages.some((p) => !!p.imageSource);
  const done = { outline: hasOutline, scripts: hasScripts, illustrate: hasImages, export: false };
  const firstTodo = (["outline", "scripts", "illustrate"] as const).find((k) => !done[k]);
  return {
    outline: done.outline ? "done" : firstTodo === "outline" ? "now" : "todo",
    scripts: done.scripts ? "done" : firstTodo === "scripts" ? "now" : "todo",
    illustrate: done.illustrate ? "done" : firstTodo === "illustrate" ? "now" : "todo",
    export: hasImages ? "now" : "todo",
  };
}

export function PPTWorkbenchPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  /** 两条生成路径 —— 见 PptSkillPathPanel 头部: 快路是自建管线, 技能路交给 Agent */
  const [path, setPath] = useState<"pipeline" | "skill">("pipeline");

  const token = () => localStorage.getItem("sag_token") || "";
  const H = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token()}` });

  const loadJobs = async () => {
    try { setJobs(((await (await fetch("/api/ppt/jobs", { headers: H() })).json()).jobs) ?? []); }
    catch { /* 列表失败不阻断 */ }
  };
  useEffect(() => { void loadJobs(); }, []);

  const openJob = async (id: string) => {
    setBusy("load"); setErr("");
    try {
      const r = await fetch(`/api/ppt/jobs/${encodeURIComponent(id)}`, { headers: H() });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "打开失败");
      setJob(d.job);
      const p = await (await fetch(`/api/ppt/jobs/${encodeURIComponent(id)}/pages`, { headers: H() })).json();
      setPages(p.pages ?? []);
      setOpenSeq(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const create = async () => {
    if (!topic.trim()) { setErr("请先填主题"); return; }
    setBusy("create"); setErr(""); setNote("");
    try {
      const d = await (await fetch("/api/ppt/jobs", {
        method: "POST", headers: H(), body: JSON.stringify({ topic, title: topic.slice(0, 60) }),
      })).json();
      if (!d.ok) throw new Error(d?.error?.message || d?.error || "建任务失败");
      setTopic("");
      // 服务端建任务时顺手生成了大纲 —— 说清页数, 否则"点完没反应"和"出了大纲"长得一样
      setNote(d.outlinePages ? `已生成 ${d.outlinePages} 页大纲` : "任务已建，但大纲没生成出来 —— 可点「重新生成大纲」");
      await loadJobs();
      await openJob(d.job.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };

  const call = async (url: string, label: string, body: Record<string, unknown> = {}) => {
    setBusy(label); setErr(""); setNote("");
    try {
      const r = await fetch(url, { method: "POST", headers: H(), body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message || d?.error || `${label} 失败`);
      return d;
    } catch (e) { setErr((e as Error).message); return null; } finally { setBusy(""); }
  };

  const doOutline = async () => {
    if (!job) return;
    const d = await call(`/api/ppt/jobs/${job.id}/outline`, "outline");
    if (d) { setNote(`已生成 ${d.pages} 页大纲`); await openJob(job.id); }
  };

  const doScripts = async () => {
    if (!job) return;
    const d = await call(`/api/ppt/jobs/${job.id}/scripts`, "scripts");
    if (d) { setNote(`脚本完成 ${d.done ?? 0}/${d.total ?? 0} 页`); await openJob(job.id); }
  };

  const doIllustrate = async () => {
    if (!job) return;
    const d = await call(`/api/ppt/jobs/${job.id}/illustrate`, "illustrate");
    if (d) {
      const ph = d.sources?.placeholder ?? 0;
      setNote(`配图完成 ${d.done ?? 0} 页${ph ? `（其中 ${ph} 页是本地示意图 —— 未接生图服务）` : ""}`);
      await openJob(job.id);
    }
  };

  const doExport = async () => {
    if (!job) return;
    const d = await call(`/api/ppt/jobs/${job.id}/export`, "export", { mode: "editable" });
    if (d?.base64) {
      const bin = atob(d.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
      a.download = `${job.title || "presentation"}.pptx`;
      a.click();
      URL.revokeObjectURL(a.href);
      setNote("已导出 .pptx");
    }
  };

  const regen = async (seq: number) => {
    if (!job) return;
    const d = await call(`/api/ppt/jobs/${job.id}/pages/${seq}/regen`, `regen-${seq}`);
    if (d) await openJob(job.id);
  };

  const del = async (id: string) => {
    await fetch(`/api/ppt/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: H() });
    if (job?.id === id) { setJob(null); setPages([]); }
    await loadJobs();
  };

  const a = panelAccent("sky");
  const steps = stepState(pages);
  const opened = pages.find((p) => p.seq === openSeq) ?? null;

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={<Presentation />} accent="sky" title="PPT 生成工作台"
        subtitle="由正文生成演示文稿：大纲 → 每页脚本与讲稿 → 配图 → 导出 .pptx。可单页重生、逐页锁版"
        actions={
          <>
            {/* 两条路径切换。默认在快路 —— 技能那条慢且花钱, 不该是默认落点。 */}
            <PillGroup accent="sky" value={path} onChange={setPath}
              options={[
                { value: "pipeline" as const, label: "大纲管线", hint: "几十秒出稿，逐页可改可重生" },
                { value: "skill" as const, label: "技能生成", hint: "交给外部 PPT 技能由 Agent 构建，慢但版式为技能作者的成品" },
              ]} />
            {path === "pipeline" && job ? <StatTile accent="sky" value={pages.length} label="页" /> : null}
          </>
        }
      />

      {path === "skill" ? <PptSkillPathPanel /> : (
      <>
      <div className="flex flex-wrap gap-2">
        <input value={topic} onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          placeholder="输入主题，例如「乡村振兴与农村集体经济」"
          className={panelInputCls + " min-w-[280px] flex-1"} />
        <PanelButton accent="sky" busy={busy === "create"} onClick={() => void create()}>
          <Plus className="h-3.5 w-3.5" />新建
        </PanelButton>
      </div>

      {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{err}</div>}
      {note && <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-300">{note}</div>}

      <div className="grid gap-3 lg:grid-cols-[240px_1fr]">
        {/* 左: 任务列表 */}
        <PanelCard title="我的演示任务">
          <div className="max-h-[520px] space-y-1 overflow-y-auto pr-1">
            {jobs.length === 0 && <p className="py-4 text-center text-[11px] text-muted-foreground">还没有任务</p>}
            {jobs.map((j) => {
              const st = STATUS[j.status] ?? STATUS.draft;
              const active = job?.id === j.id;
              return (
                <div key={j.id}
                  className={cn("group flex items-start gap-1.5 rounded-lg border px-2 py-1.5 transition-colors",
                    active ? "border-sky-500/50 bg-sky-500/10" : "border-border/50 hover:bg-accent/40")}>
                  <button type="button" onClick={() => void openJob(j.id)} className="min-w-0 flex-1 text-left">
                    <div className="truncate text-[11px] font-medium">{j.title}</div>
                    <div className="mt-0.5 flex items-center gap-1">
                      <span className={cn("rounded border px-1 py-px text-[9px]", st.cls)}>{st.label}</span>
                      {typeof j.progress === "number" && j.progress > 0 && j.progress < 100 && (
                        <span className="text-[9px] tabular-nums text-muted-foreground">{j.progress}%</span>
                      )}
                    </div>
                  </button>
                  <button type="button" onClick={() => void del(j.id)}
                    className="mt-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </PanelCard>

        {/* 右: 工作区 */}
        <div className="space-y-3">
          {!job ? (
            <PanelEmpty>左侧选一个任务，或在上方新建 —— 建完会自动生成大纲</PanelEmpty>
          ) : (
            <>
              {/* 四步进度 */}
              <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-card/60 p-2 backdrop-blur-sm">
                {STEPS.map((s, i) => {
                  const st = steps[s.key];
                  const Icon = s.icon;
                  return (
                    <div key={s.key} className="flex flex-1 items-center gap-1">
                      <div className={cn("flex flex-1 items-center gap-1.5 rounded-lg border px-2 py-1.5",
                        st === "done" ? "border-emerald-500/40 bg-emerald-500/10"
                          : st === "now" ? cn("border-sky-500/50", a.chip.replace("bg-", "bg-") + "/10")
                            : "border-border/40")}>
                        {st === "done" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                          : st === "now" ? <Circle className="h-3.5 w-3.5 text-sky-400" />
                            : <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />}
                        <Icon className={cn("h-3 w-3", st === "todo" ? "text-muted-foreground/50" : "text-foreground/70")} />
                        <span className={cn("text-[10px] font-medium", st === "todo" && "text-muted-foreground/60")}>{s.label}</span>
                      </div>
                      {i < STEPS.length - 1 && <span className="text-muted-foreground/40">›</span>}
                    </div>
                  );
                })}
              </div>

              {/* 动作条 */}
              <div className="flex flex-wrap items-center gap-2">
                <PanelButton accent="sky" variant="ghost" size="sm" busy={busy === "outline"} onClick={() => void doOutline()}>
                  <RefreshCw className="h-3 w-3" />重新生成大纲
                </PanelButton>
                <PanelButton accent="sky" variant="outline" size="sm" busy={busy === "scripts"} onClick={() => void doScripts()}>
                  生成脚本
                </PanelButton>
                <PanelButton accent="sky" variant="outline" size="sm" busy={busy === "illustrate"} onClick={() => void doIllustrate()}>
                  配图
                </PanelButton>
                <PanelButton accent="sky" size="sm" busy={busy === "export"} onClick={() => void doExport()}>
                  <Download className="h-3 w-3" />导出 pptx
                </PanelButton>
                {job.stage && <span className="ml-auto text-[10px] text-muted-foreground">{job.stage}</span>}
              </div>

              {/* 幻灯片缩略图网格 */}
              {pages.length === 0 ? (
                <PanelEmpty>还没有页面 —— 点「重新生成大纲」</PanelEmpty>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {pages.map((p) => {
                    const hasImg = !!p.imageSource;
                    const hasScript = (p.bullets?.length ?? 0) > 0 || !!p.notes;
                    return (
                      <button key={p.seq} type="button" onClick={() => setOpenSeq(openSeq === p.seq ? null : p.seq)}
                        className={cn("group flex flex-col overflow-hidden rounded-lg border text-left transition-all hover:border-sky-500/50",
                          openSeq === p.seq ? "border-sky-500/60 ring-1 ring-sky-500/30" : "border-border/50")}>
                        {/* 16:9 占位(真缩略图要服务端出图, 这里用版式意象) */}
                        <div className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-slate-800/60 to-slate-900/60 p-2">
                          <span className="text-[8px] uppercase tracking-wider text-muted-foreground/50">{KIND_LABEL[p.kind] ?? p.kind}</span>
                          <span className="absolute left-1.5 top-1.5 rounded bg-black/40 px-1 text-[9px] tabular-nums text-white/70">#{p.seq}</span>
                          <div className="absolute right-1.5 top-1.5 flex gap-1">
                            {hasScript && <span className="rounded bg-violet-500/25 px-1 text-[8px] text-violet-200" title="已有脚本与讲稿">脚本</span>}
                            {hasImg && <span className="rounded bg-amber-500/25 px-1 text-[8px] text-amber-200" title="已有配图">图</span>}
                            {p.imageSource === "placeholder" && (
                              <span className="rounded bg-amber-500/20 px-1 text-[8px] text-amber-300/90" title="本机未接生图服务，这是本地生成的示意图">示意</span>
                            )}
                          </div>
                          {p.locked && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/40 px-1 text-[8px] text-white/70">锁定</span>}
                        </div>
                        <div className="flex items-start gap-1 p-2">
                          <span className="line-clamp-2 flex-1 text-[11px] font-medium leading-4">{p.title || "(无标题)"}</span>
                          <span role="button" tabIndex={-1}
                            onClick={(e) => { e.stopPropagation(); void regen(p.seq); }}
                            title={p.locked ? "已锁定" : "只重生这一页"}
                            className={cn("mt-0.5 shrink-0 text-muted-foreground hover:text-foreground", p.locked && "opacity-30")}>
                            {busy === `regen-${p.seq}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 单页详情 */}
              {opened && (
                <PanelCard
                  icon={<Presentation />}
                  title={`#${opened.seq} ${opened.title}`}
                  actions={<span className="text-[10px] text-muted-foreground">{KIND_LABEL[opened.kind] ?? opened.kind}</span>}
                >
                  {opened.bullets?.length ? (
                    <ul className="space-y-1">
                      {opened.bullets.map((b, i) => (
                        <li key={i} className="flex gap-2 text-[11px] leading-5">
                          <span className={cn("mt-1.5 h-1 w-1 shrink-0 rounded-full", a.text.replace("text-", "bg-"))} />{b}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-[11px] text-muted-foreground">还没有要点 —— 点「生成脚本」</p>}
                  {opened.notes && (
                    <div className="mt-3 rounded-lg border border-border/50 bg-background/40 p-2.5">
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                        <Clock className="h-3 w-3" />讲稿（备注页）
                      </div>
                      <p className="whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{opened.notes}</p>
                    </div>
                  )}
                  {opened.imageSource === "placeholder" && (
                    <p className="mt-2 flex items-center gap-1 text-[10px] text-amber-400/80">
                      <AlertTriangle className="h-3 w-3" />本机的配图是<b>本地生成的示意图</b>，不是 AI 插画（未接生图服务）
                    </p>
                  )}
                </PanelCard>
              )}
            </>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
