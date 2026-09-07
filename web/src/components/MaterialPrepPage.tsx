// MaterialPrepPage.tsx — SocialSci T7-2: 素材准备独立页(闭源 /workflow/materials 对齐)
// 分类卡(文献/表格/理论/数据分析/附件)按 kind 分组计数 + AI 生成/审视/编排 + 手动添加入口
// + 素材版本发布门禁("确认并进入创作" disabled 直到有素材且无生成中任务)
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft, BookOpen, Bot, CheckCircle2, ChevronDown, ChevronRight, Database, FileText, FlaskConical,
  Image as ImageIcon, Loader2, PenLine, Plus, RefreshCw, Sparkles, Upload, Wand2, X,
} from "lucide-react";
import { cn } from "../lib/utils";

interface Mat { id: string; kind: string; title: string; usage_status?: string; created_at: string; content_md?: string; section_ids?: string[] | null }
interface Sec { id: string; title: string; level: number; order?: number; children?: Sec[] }

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

const KIND_META: Record<string, { label: string; icon: React.ReactNode; sub: string }> = {
  citation: { label: "文献检索", icon: <BookOpen className="h-3.5 w-3.5" />, sub: "引用/文献条目" },
  table: { label: "表格素材", icon: <Database className="h-3.5 w-3.5" />, sub: "变量表/数据表" },
  theory: { label: "理论素材", icon: <FlaskConical className="h-3.5 w-3.5" />, sub: "理论框架/方法" },
  data_result: { label: "数据分析", icon: <FileText className="h-3.5 w-3.5" />, sub: "实证结果/图表" },
  figure: { label: "图表素材", icon: <ImageIcon className="h-3.5 w-3.5" />, sub: "科研图表" },
  file: { label: "附件素材", icon: <Upload className="h-3.5 w-3.5" />, sub: "参考文件" },
  note: { label: "笔记素材", icon: <PenLine className="h-3.5 w-3.5" />, sub: "要点记录" },
};

export function MaterialPrepPage({ projectId, title, onBack, onConfirm, onMsg, onGotoAnalysis, onGotoViz }: {
  projectId: string; title: string;
  onBack: () => void; onConfirm: () => void;
  onMsg: (m: string) => void; onGotoAnalysis?: () => void; onGotoViz?: () => void;
}) {
  const [mats, setMats] = useState<Mat[]>([]);
  const [secs, setSecs] = useState<Sec[]>([]);
  // W3/W4: 4 步素材流程徽标 + 设计思路(analysis.logicChain 供素材对照)
  const [logicChain, setLogicChain] = useState("");
  const loadDesign = useCallback(async () => {
    try {
      const n = await j<{ node: { payload?: { logicChain?: string } } }>(`/api/research/projects/${projectId}/nodes/analysis`);
      if (n.node?.payload?.logicChain) setLogicChain(n.node.payload.logicChain);
    } catch { /* 无分析节点静默 */ }
  }, [projectId]);
  useEffect(() => { void loadDesign(); }, [loadDesign]);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set(Object.keys(KIND_META)));
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [err, setErr] = useState("");
  // W5/W6: 生成弹层(表格: 类型+章节树; 理论: 章节树) + 手动文献批量录入
  const [genDialog, setGenDialog] = useState<null | { kind: "table" | "theory"; tableType: string; sectionId: string }>(null);
  const [litDialog, setLitDialog] = useState(false);
  const [litBulk, setLitBulk] = useState("");
  const [litEntries, setLitEntries] = useState<Array<{ title: string; authors: string; source: string; year: string; doi: string; gb: string; note: string }>>([]);
  const litInit = () => ({ title: "", authors: "", source: "", year: "", doi: "", gb: "", note: "" });

  const load = useCallback(async () => {
    try {
      const [mr, sr] = await Promise.all([
        j<{ materials: Mat[] }>(`/api/research/materials?projectId=${encodeURIComponent(projectId)}`),
        j<{ node: { payload?: { sections?: Sec[] } } }>(`/api/research/projects/${encodeURIComponent(projectId)}/nodes/sections`).catch(() => ({ node: null })),
      ]);
      setMats(mr.materials ?? []);
      setSecs(sr?.node?.payload?.sections ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  // AI 生成(W5/W6: table/theory 走章节树弹层确认; 其余照旧直生成)
  const aiGenerate = async (kind: string, count = 3, opts?: { tableType?: string; sectionId?: string }) => {
    if (busy) return;
    if ((kind === "table" || kind === "theory") && !opts) {
      setGenDialog({ kind: kind as "table" | "theory", tableType: kind === "table" ? "comparison" : "", sectionId: "" });
      return;
    }
    setBusy(true); setBusyMsg(`正在生成${KIND_META[kind]?.label ?? kind}...`);
    try {
      const r = await j<{ materials?: Array<{ id: string }> }>("/api/research/materials/generate", {
        method: "POST",
        body: JSON.stringify({ projectId, kind: kind === "data_result" ? "data_result" : kind, count, targetSectionId: opts?.sectionId ?? secs.filter(s => s.level === 1)[0]?.id ?? "" }),
      });
      const n = r.materials?.length ?? 0;
      onMsg(n ? `已生成 ${n} 条${KIND_META[kind]?.label ?? ""}` : "生成失败");
      if (n) await load();
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); setBusyMsg(""); }
  };
  // 批量粘贴引用 → 解析为条目(每行一条, 支持 APA/GB/混合)
  const parseBulk = () => {
    const lines = litBulk.split("\n").map(l => l.trim()).filter(Boolean);
    const entries = lines.map((line) => {
      const m = line.match(/^\[?(\d+)\]?\s*(.+)$/);
      const body = m?.[2] ?? line;
      const gb = line.startsWith("[") ? line : "";
      const yearM = body.match(/(19|20)\d{2}/);
      const t = body.replace(/^(.*?)[,\.](.*)$/s, "$2").trim() || body;
      return { title: t.slice(0, 80), authors: body.split(/[,，]/)[0]?.slice(0, 40) ?? "", source: "", year: yearM?.[0] ?? "", doi: "", gb, note: "" };
    });
    setLitEntries((p) => [...p, ...entries]);
    setLitBulk("");
    onMsg(entries.length ? `批量解析 ${entries.length} 条(可在卡片中补全字段)` : "未解析到条目");
  };
  // 保存文献条目 → citation 素材(kind 白名单 citation)
  const saveLiterature = async () => {
    if (busy || !litEntries.length) return;
    setBusy(true); setBusyMsg("正在保存文献素材...");
    try {
      let n = 0;
      for (const e of litEntries) {
        if (!e.title.trim()) continue;
        const gbLine = e.gb || (e.authors && e.year ? `[${n + 1}] ${e.authors}. ${e.title}[J]. ${e.source || "期刊"}, ${e.year}.` : "");
        await j("/api/research/materials", {
          method: "POST",
          body: JSON.stringify({ projectId, kind: "citation", title: e.title, contentMd: gbLine, sourceRef: e.doi || e.source }),
        });
        n++;
      }
      onMsg(n ? `已保存 ${n} 条文献素材` : "没有可保存的条目(标题必填)");
      if (n) { setLitEntries([]); setLitDialog(false); await load(); }
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); setBusyMsg(""); }
  };
  // 审视全部
  const reviewAll = async () => {
    if (busy) return;
    setBusy(true); setBusyMsg("正在审视素材...");
    try {
      let reviewed = 0;
      for (const m of mats) {
        await j(`/api/research/materials/${m.id}/review`, { method: "POST", body: "{}" }).catch(() => {});
        reviewed++;
      }
      onMsg(`已审视 ${reviewed} 条素材(质量/相关性见卡)`);
      await load();
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); setBusyMsg(""); }
  };
  // 编排: 调分配接口并确认
  const allocate = async () => {
    if (busy) return;
    setBusy(true); setBusyMsg("AI 正在编排素材到章节...");
    try {
      const r = await j<{ suggestions?: Array<{ materialId: string; sectionId: string | null }> }>("/api/research/materials/allocate", {
        method: "POST", body: JSON.stringify({ projectId }),
      });
      const sug = r.suggestions ?? [];
      let adopted = 0;
      for (const s of sug) {
        if (!s.sectionId) continue;
        await j(`/api/research/materials/${s.materialId}/adopt`, { method: "POST", body: JSON.stringify({ sectionIds: [s.sectionId] }) });
        adopted++;
      }
      onMsg(sug.length ? `编排完成: ${adopted} 条已挂章` : "暂无待编排素材");
      await load();
    } catch (e) { onMsg((e as Error).message); } finally { setBusy(false); setBusyMsg(""); }
  };
  // 发布素材版本(门禁: 至少 1 素材且无挂章任务; 对齐闭源"素材版本待发布")
  const publish = async () => {
    if (publishing || !mats.length) return;
    setPublishing(true); setErr("");
    try {
      await j(`/api/research/projects/${projectId}`, { method: "PUT", body: JSON.stringify({ phase: 3, phase_label: "素材准备" }) });
      // 发布动作 = 记入项目快照(snapshot.materialsVersion)
      await j(`/api/research/projects/${projectId}/nodes/materials`, {
        method: "PUT", body: JSON.stringify({ payload: { version: "v" + Date.now().toString(36), publishedAt: new Date().toISOString(), materialIds: mats.map(m => m.id) }, sourceRole: "user", note: "发布素材版本" }),
      });
      setPublished(true);
      onMsg("素材版本已发布, 可进入创作");
    } catch (e) { setErr((e as Error).message); } finally { setPublishing(false); }
  };

  const toggle = (k: string) => setExpanded(p => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const byKind = (k: string) => mats.filter(m => m.kind === k);
  const adopted = mats.filter(m => m.usage_status === "adopted" || (m.section_ids?.length ?? 0) > 0).length;

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto bg-slate-950/98 backdrop-blur-sm">
      <div className="mx-auto max-w-4xl px-6 py-6">
        {/* 头 */}
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-100">素材准备</h2>
            <p className="mt-0.5 text-xs text-slate-500">{title} — 准备参考文献、图表、数据分析等素材。</p>
            <p className="mt-0.5 text-[11px] text-slate-600">共 {mats.length} 个素材 · 已挂章 {adopted} · 按流程完成素材整理后即可进入创作</p>
          </div>
          <button onClick={onBack} className="flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
            <ArrowLeft className="h-3.5 w-3.5" /> 返回章节清单
          </button>
        </div>
        {err && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{err}</div>}
        {busyMsg && <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-300"><Loader2 className="h-3 w-3 animate-spin" />{busyMsg}</div>}

        {/* 主工具条 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={() => aiGenerate("citation")} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
            <Bot className="h-3.5 w-3.5" /> 智能生成素材
          </button>
          <button onClick={reviewAll} disabled={busy || !mats.length}
            className="flex items-center gap-1 rounded-lg border border-red-500/50 bg-transparent px-3.5 py-2 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-40">
            <RefreshCw className="h-3.5 w-3.5" /> 审视素材
          </button>
          <button onClick={allocate} disabled={busy || !mats.length}
            className="flex items-center gap-1 rounded-lg border border-red-500/50 bg-transparent px-3.5 py-2 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-40">
            <Wand2 className="h-3.5 w-3.5" /> 编排素材
          </button>
          {/* 素材版本门禁 */}
          {published ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] text-emerald-300"><CheckCircle2 className="h-3 w-3" />素材版本已发布</span>
          ) : (
            <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-[10px] text-amber-300">素材版本待发布</span>
          )}
        </div>

        {/* W3: 4 步素材流程徽标(闭源 materials 实拍: 补充素材来源→智能生成素材→审视素材→编排素材) */}
        <div className="mb-3 flex items-center gap-1.5 rounded-xl border border-slate-700/40 bg-slate-900/40 px-3 py-2">
          {[["补充素材来源", "手动添加/从其他模块导入"], ["智能生成素材", "AI 按研究需求生成"], ["审视素材", "核验质量/采纳"], ["编排素材", "分配挂章到章节"]].map(([t, d], i, arr) => (
            <div key={t} className="flex flex-1 items-center gap-1.5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-slate-300">{i + 1}. {t}</p>
                <p className="truncate text-[8px] text-slate-600">{d}</p>
              </div>
              {i < arr.length - 1 && <Sparkles className="h-3 w-3 shrink-0 text-slate-600" />}
            </div>
          ))}
        </div>

        {/* W4: 设计思路(闭源: 展示研究逻辑全文供素材对照) */}
        {logicChain && (
          <div className="mb-3 rounded-xl border border-slate-700/40 bg-slate-900/40 p-3">
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
              <Sparkles className="h-3 w-3 text-amber-400" /> 设计思路
            </p>
            <p className="text-[10px] leading-relaxed text-slate-500">{logicChain}</p>
          </div>
        )}

        {/* 手动添加快捷卡 */}
        <div className="mb-3 grid grid-cols-5 gap-2">
          {Object.entries(KIND_META).slice(0, 4).map(([k, m]) => (
            <button key={k} onClick={() => aiGenerate(k)} disabled={busy}
              className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2 text-left hover:border-slate-500 disabled:opacity-40">
              <span className="flex items-center gap-1.5 text-[11px] text-slate-200">{m.icon}{m.label}<span className="text-[9px] text-slate-500">({byKind(k).length})</span></span>
              <Plus className="h-3 w-3 text-slate-500" />
            </button>
          ))}
          {/* W6: 手动添加文献入口(闭源: 弹层批量粘贴+条目卡) */}
          <button onClick={() => setLitDialog(true)}
            className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2 text-left hover:border-cyan-500/60">
            <span className="flex items-center gap-1.5 text-[11px] text-slate-200"><BookOpen className="h-3.5 w-3.5" />手动添加文献<span className="text-[9px] text-slate-500">({byKind("citation").length})</span></span>
            <Plus className="h-3 w-3 text-slate-500" />
          </button>
        </div>

        {/* 跨模块入口(对齐闭源: 数据分析/科研绘图产物可直接入素材) */}
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button onClick={onGotoAnalysis} className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2 text-left hover:border-cyan-500/60">
            <span className="text-[11px] text-slate-300">前往数据分析模块进行分析 ›</span>
          </button>
          <button onClick={onGotoViz} className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/40 px-3 py-2 text-left hover:border-pink-500/60">
            <span className="text-[11px] text-slate-300">前往科研绘图模块进行分析 ›</span>
          </button>
        </div>

        {/* 已整理素材(按 kind 分类折叠) */}
        <div className="space-y-2">
          {Object.entries(KIND_META).map(([k, meta]) => {
            const list = byKind(k);
            const open = expanded.has(k);
            return (
              <div key={k} className="overflow-hidden rounded-xl border border-slate-700/60 bg-slate-900/50">
                <button onClick={() => toggle(k)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-slate-800/40">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ backgroundColor: "#0ea5e9" + "22", color: "#0ea5e9" }}>{meta.icon}</span>
                  <span className="text-xs font-medium text-slate-200">{meta.label}</span>
                  <span className="text-[10px] text-slate-500">{list.length} 项</span>
                  <span className="ml-auto text-[10px] text-slate-600">{open ? "▲" : "▼"}</span>
                </button>
                {open && (
                  <div className="border-t border-slate-700/40 px-3 py-2">
                    {list.length === 0 ? (
                      <p className="py-2 text-center text-[10px] text-slate-600">暂无{meta.label}素材 — 点上方"智能生成素材"或手动添加</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-1.5">
                        {list.map(m => (
                          <div key={m.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
                            <p className="truncate text-[11px] font-medium text-slate-200">{m.title || "未命名"}</p>
                            <p className="mt-0.5 text-[9px] text-slate-500">{(m.section_ids?.length ?? 0) > 0 ? `已挂 ${m.section_ids!.length} 章` : "未挂章"}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* W5/W6: 生成弹层(表格类型+章节树 / 理论章节树) */}
        {genDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setGenDialog(null)}>
            <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-600/60 bg-slate-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-100">{genDialog.kind === "table" ? "生成表格素材" : "生成理论素材"}</p>
                <button onClick={() => setGenDialog(null)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
              </div>
              <p className="mb-2 text-[10px] text-slate-500">
                {genDialog.kind === "table" ? "将根据研究需求生成表格(Tab 分隔格式)" : "将根据研究主题整理相关理论模型和概念框架"}
              </p>
              {genDialog.kind === "table" && (
                <div className="mb-2">
                  <p className="mb-1 text-[10px] font-medium text-slate-400">生成要求</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[["comparison", "文本对比表"], ["data", "数据表(需提供数据)"]].map(([k, lb]) => (
                      <button key={k} onClick={() => setGenDialog((d) => d ? { ...d, tableType: k } : d)}
                        className={cn("rounded-lg border px-2 py-1.5 text-[10px]", genDialog.tableType === k ? "border-cyan-500/60 bg-cyan-600/15 text-cyan-200" : "border-slate-700/50 bg-slate-800 text-slate-400")}>
                        {lb as string}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mb-3">
                <p className="mb-1 text-[10px] font-medium text-slate-400">关联章节 *</p>
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-slate-700/50 bg-slate-950/60 p-2">
                  {secs.filter((s) => s.level === 1).map((s) => (
                    <div key={s.id}>
                      <button onClick={() => setGenDialog((d) => d ? { ...d, sectionId: s.id } : d)}
                        className={cn("flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px]", genDialog.sectionId === s.id ? "bg-cyan-600/20 text-cyan-200" : "text-slate-300 hover:bg-slate-800")}>
                        <ChevronDown className="h-2.5 w-2.5 text-slate-600" />
                        {s.title || `章节 ${(s.order ?? 1)}`}
                      </button>
                      {(s.children ?? []).map((c) => (
                        <button key={c.id} onClick={() => setGenDialog((d) => d ? { ...d, sectionId: c.id } : d)}
                          className={cn("ml-4 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded px-1.5 py-0.5 pl-4 text-left text-[10px]", genDialog.sectionId === c.id ? "bg-cyan-600/20 text-cyan-200" : "text-slate-500 hover:bg-slate-800")}>
                          <ChevronRight className="h-2 w-2 text-slate-700" />
                          {c.title || "子节"}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setGenDialog(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-slate-700">取消</button>
                <button onClick={() => { const d = genDialog; setGenDialog(null); void aiGenerate(d.kind === "table" ? "table" : "theory", 3, { tableType: d.tableType, sectionId: d.sectionId }); }}
                  className="rounded-lg bg-cyan-600 px-4 py-1.5 text-[11px] text-white hover:bg-cyan-500">开始生成</button>
              </div>
            </div>
          </div>
        )}

        {/* W6: 手动添加文献弹层(批量粘贴解析+条目卡) */}
        {litDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setLitDialog(false)}>
            <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-600/60 bg-slate-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-100">手动添加文献</p>
                <button onClick={() => setLitDialog(false)} className="text-slate-400 hover:text-slate-200"><X className="h-4 w-4" /></button>
              </div>
              <div className="mb-3">
                <p className="mb-1 text-[10px] font-medium text-slate-400">批量粘贴引用</p>
                <p className="mb-1 text-[9px] text-slate-600">每行或每段一条文献, 支持 APA / GB / 混合格式</p>
                <textarea value={litBulk} onChange={(e) => setLitBulk(e.target.value)} rows={3}
                  placeholder="[1] 作者. 题名[J]. 期刊, 2024(1): 1-10.&#10;Smith, J. (2023). Title. Journal, 45(2), 100-120."
                  className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-950/60 px-2 py-1.5 text-[10px] text-slate-200 placeholder:text-slate-600" />
                <button onClick={parseBulk} className="mt-1 rounded-lg bg-slate-700 px-3 py-1 text-[10px] text-slate-200 hover:bg-slate-600">批量解析</button>
              </div>
              <div className="space-y-2">
                {litEntries.length === 0 && <p className="py-4 text-center text-[10px] text-slate-600">粘贴引用后点"批量解析", 或点下方"添加一条文献"手动录入</p>}
                {litEntries.map((e, i) => (
                  <div key={i} className="rounded-lg border border-slate-700/50 bg-slate-800/40 p-2">
                    <p className="mb-1 text-[9px] font-semibold text-slate-500">文献条目 #{i + 1}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <input placeholder="文献标题 *" value={e.title} onChange={(ev) => setLitEntries((p) => p.map((x, xi) => xi === i ? { ...x, title: ev.target.value } : x))}
                        className="col-span-2 rounded border border-slate-600/60 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                      <input placeholder="作者 *" value={e.authors} onChange={(ev) => setLitEntries((p) => p.map((x, xi) => xi === i ? { ...x, authors: ev.target.value } : x))}
                        className="rounded border border-slate-600/60 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                      <input placeholder="年份" value={e.year} onChange={(ev) => setLitEntries((p) => p.map((x, xi) => xi === i ? { ...x, year: ev.target.value } : x))}
                        className="rounded border border-slate-600/60 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                      <input placeholder="期刊/来源" value={e.source} onChange={(ev) => setLitEntries((p) => p.map((x, xi) => xi === i ? { ...x, source: ev.target.value } : x))}
                        className="rounded border border-slate-600/60 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                      <input placeholder="DOI / 链接" value={e.doi} onChange={(ev) => setLitEntries((p) => p.map((x, xi) => xi === i ? { ...x, doi: ev.target.value } : x))}
                        className="rounded border border-slate-600/60 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                      <input placeholder="GB/T 引用格式" value={e.gb} onChange={(ev) => setLitEntries((p) => p.map((x, xi) => xi === i ? { ...x, gb: ev.target.value } : x))}
                        className="col-span-2 rounded border border-slate-600/60 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-between">
                <button onClick={() => setLitEntries((p) => [...p, litInit()])}
                  className="rounded-lg border border-slate-600/60 px-3 py-1.5 text-[10px] text-slate-300 hover:border-slate-500">+ 添加一条文献</button>
                <div className="flex gap-2">
                  <button onClick={() => setLitDialog(false)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-slate-700">取消</button>
                  <button onClick={() => void saveLiterature()} disabled={busy}
                    className="rounded-lg bg-cyan-600 px-4 py-1.5 text-[11px] text-white hover:bg-cyan-500 disabled:opacity-50">保存</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 底部: 返回 + 确认进入创作(素材版本已发布才可) */}
        <div className="sticky bottom-0 mt-4 flex items-center gap-2 border-t border-slate-700/60 bg-slate-950/95 py-3 backdrop-blur">
          <button onClick={onBack} className="rounded-lg border border-slate-600/60 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-700">返回章节清单</button>
          <button onClick={() => { if (published) onConfirm(); else void publish(); }}
            disabled={!mats.length || busy || publishing}
            className={cn("flex-1 rounded-lg px-6 py-2.5 text-sm font-medium text-white", (published || !mats.length) ? "bg-cyan-600 hover:bg-cyan-500" : "bg-red-600 hover:bg-red-500", !mats.length && "cursor-not-allowed opacity-40")}>
            {publishing ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : null}
            {published ? "确认并进入创作" : mats.length ? "发布素材版本, 进入创作" : "请先添加素材"}
          </button>
        </div>
      </div>
    </div>
  );
}
