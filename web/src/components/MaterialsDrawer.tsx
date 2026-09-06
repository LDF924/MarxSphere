// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// MaterialsDrawer.tsx — SocialSci P0-2: 素材库抽屉(项目素材管理, DAG 节点工作界面联动)
// 形态对齐(闭源产品交互语义, 原创实现): 素材四类(文献/数据/图表/方法理论/文件/笔记)
//   - 从画布节点工作界面一键打开: 该节点产生的素材自动高亮
//   - 素材可编辑/删除/新建; 供写作节点上下文注入
import { useCallback, useEffect, useState } from "react";
import { BookOpen, Database, FileText, FlaskConical, Image as ImageIcon, Loader2, PenLine, Plus, Sparkles, Trash2, X } from "lucide-react";

export interface Material {
  id: string;
  project_id: string;
  kind: "note" | "citation" | "data_result" | "figure" | "file" | "theory";
  title: string;
  tags: string[];
  source_ref: string;
  produced_by_dag_node: string;
  created_at: string;
}

const KIND_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  note: { label: "笔记", color: "#94a3b8", icon: <PenLine className="h-3 w-3" /> },
  citation: { label: "文献引用", color: "#8b5cf6", icon: <BookOpen className="h-3 w-3" /> },
  data_result: { label: "数据结果", color: "#06b6d4", icon: <Database className="h-3 w-3" /> },
  figure: { label: "图表", color: "#ec4899", icon: <ImageIcon className="h-3 w-3" /> },
  file: { label: "文件", color: "#3b82f6", icon: <FileText className="h-3 w-3" /> },
  theory: { label: "理论/方法", color: "#10b981", icon: <FlaskConical className="h-3 w-3" /> },
};
const ALL_KINDS = Object.keys(KIND_META);

function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

export function MaterialsDrawer(props: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  highlightDagNode?: string | null;   // 高亮该画布节点产出的素材
}) {
  const { projectId, open, onClose, highlightDagNode } = props;
  const [materials, setMaterials] = useState<Material[]>([]);
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState<string>("citation");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await j<{ materials: Material[] }>(`/api/research/materials?projectId=${encodeURIComponent(projectId)}`);
      setMaterials(r.materials ?? []);
      setErr("");
    } catch (e) { setErr((e as Error).message); }
  }, [projectId]);

  useEffect(() => { if (open) void load(); }, [open, load]);
  if (!open) return null;

  const visible = kindFilter === "all" ? materials : materials.filter((m) => m.kind === kindFilter);
  const filtered = highlightDagNode ? visible.filter((m) => !highlightDagNode || m.produced_by_dag_node === highlightDagNode || m.produced_by_dag_node === "") : visible;
  const show = highlightDagNode ? filtered : visible;
  const isHighlighted = (m: Material) => highlightDagNode ? m.produced_by_dag_node === highlightDagNode : false;

  const createMaterial = async () => {
    if (!newTitle.trim()) { setErr("请填素材标题"); return; }
    setBusy(true); setErr("");
    try {
      await j("/api/research/materials", {
        method: "POST",
        body: JSON.stringify({
          projectId, kind: newKind, title: newTitle.trim(),
          contentMd: newContent.trim(),
          producedByDagNode: highlightDagNode ?? "",
        }),
      });
      setNewTitle(""); setNewContent(""); setCreating(false);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // UI审计T7: 文献粘贴解析(GB/T7714)
  const [showParse, setShowParse] = useState(false);
  const [parseText, setParseText] = useState("");
  const [parseResult, setParseResult] = useState<Array<{ no: number; authors: string; title: string; source: string; year: string; valid: boolean; raw: string }> | null>(null);
  const [parseBusy, setParseBusy] = useState(false);
  const parseRefs = async () => {
    if (!parseText.trim()) return;
    setParseBusy(true); setErr("");
    try {
      const r = await j<{ items: Array<{ no: number; authors: string; title: string; source: string; year: string; valid: boolean; raw: string }> }>("/api/research/references/parse", {
        method: "POST", body: JSON.stringify({ rawText: parseText }),
      });
      setParseResult(r.items ?? []);
      setErr(`解析完成: ${r.items.filter((i) => i.valid).length}/${r.items.length} 条有效`);
    } catch (e) { setErr((e as Error).message); } finally { setParseBusy(false); }
  };
  const saveParsedAsMaterial = async () => {
    if (!parseResult?.some((i) => i.valid)) return;
    setBusy(true); setErr("");
    try {
      const contentMd = parseResult.map((i) => `[${i.no}] ${i.raw}`).join("\n");
      await j("/api/research/materials", {
        method: "POST",
        body: JSON.stringify({ projectId, kind: "citation", title: "文献清单(批量解析)", contentMd, tags: [], producedByDagNode: highlightDagNode ?? "" }),
      });
      setErr(`已保存 ${parseResult.length} 条文献到素材库`);
      setShowParse(false); setParseResult(null); setParseText("");
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // SocialSci R3: AI 素材生成(按当前章节/主题)
  const [aiBusy, setAiBusy] = useState(false);
  // 体验厚度#3: AI 审视
  const [reviewingId, setReviewingId] = useState("");
  const [reviews, setReviews] = useState<Record<string, { quality: string; score: number; assessment: string; relevance: string; suggestions: string[] }>>({});
  const runReview = async (m: Material) => {
    if (reviewingId) return;
    setReviewingId(m.id); setErr("");
    try {
      const r = await j<{ review: { quality: string; score: number; assessment: string; relevance: string; suggestions: string[] } }>(`/api/research/materials/${m.id}/review`, {
        method: "POST", body: JSON.stringify({}),
      });
      setReviews((p) => ({ ...p, [m.id]: r.review }));
    } catch (e) { setErr((e as Error).message); } finally { setReviewingId(""); }
  };
  const [aiPrompt, setAiPrompt] = useState("");
  const aiGenerate = async () => {
    setAiBusy(true); setErr("");
    try {
      const r = await j<{ materials?: Array<{ id: string; title: string }> }>("/api/research/materials/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          targetSectionId: highlightDagNode ?? "",
          sectionTitle: highlightDagNode ? undefined : undefined,
          count: 3,
          prompt: aiPrompt.trim() || undefined,
        }),
      });
      const n = r.materials?.length ?? 0;
      setErr(n ? `已生成 ${n} 条素材` : "生成失败");
      if (n) { setAiPrompt(""); await load(); }
    } catch (e) { setErr((e as Error).message); } finally { setAiBusy(false); }
  };

  const saveEdit = async (m: Material) => {
    setBusy(true); setErr("");
    try {
      await j(`/api/research/materials/${m.id}`, { method: "PUT", body: JSON.stringify({ contentMd: editContent }) });
      setEditingId(null);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const startEdit = async (m: Material) => {
    if (editingId === m.id) { setEditingId(null); return; }
    setEditingId(m.id); setEditContent("");
    try {
      const r = await j<{ material: { content_md?: string } }>(`/api/research/materials/${m.id}`);
      setEditContent(r.material?.content_md ?? "");
    } catch (e) { setErr((e as Error).message); }
  };

  const removeMaterial = async (id: string) => {
    setBusy(true); setErr("");
    try {
      await j(`/api/research/materials/${id}`, { method: "DELETE" });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="absolute right-3 top-14 z-20 flex h-[calc(100%-5rem)] w-96 flex-col rounded-xl border border-slate-600/60 bg-slate-900/95 shadow-2xl backdrop-blur">
      {/* 头 */}
      <div className="flex items-center justify-between border-b border-slate-700/60 px-3 py-2.5">
        <span className="text-xs font-semibold text-slate-200">
          素材库 <span className="text-slate-500">({materials.length})</span>
          {highlightDagNode && <span className="ml-1.5 rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-300">节点素材</span>}
        </span>
        <div className="flex gap-1">
          <button onClick={() => setCreating((v) => !v)} title="新建素材"
            className="rounded p-1 text-slate-400 hover:bg-cyan-600/20 hover:text-cyan-300"><Plus className="h-3.5 w-3.5" /></button>
          <button onClick={load} title="刷新" className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200"><Loader2 className="h-3.5 w-3.5" /></button>
          <button onClick={onClose} title="关闭" className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* 类型筛选 */}
      <div className="flex gap-1 overflow-x-auto border-b border-slate-700/40 px-2 py-1.5">
        <button onClick={() => setKindFilter("all")}
          className={kindFilter === "all" ? "rounded-full bg-slate-600 px-2 py-0.5 text-[10px] text-white" : "rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"}>全部</button>
        {ALL_KINDS.map((k) => (
          <button key={k} onClick={() => setKindFilter(k)}
            className={kindFilter === k ? "rounded-full px-2 py-0.5 text-[10px] text-white" : "rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"}
            style={kindFilter === k ? { backgroundColor: KIND_META[k].color + "33", color: KIND_META[k].color } : undefined}>
            {KIND_META[k].label}
          </button>
        ))}
      </div>

      {/* UI审计T7: 文献粘贴解析 */}
      <div className="border-b border-slate-700/40 bg-slate-800/30 p-2">
        <button onClick={() => setShowParse((v) => !v)} className="mb-1 flex w-full items-center justify-between text-[11px] text-amber-300 hover:text-amber-200">
          <span>粘贴文献批量解析 (GB/T7714)</span><span>{showParse ? "▲" : "▼"}</span>
        </button>
        {showParse && (
          <div>
            <textarea value={parseText} onChange={(e) => setParseText(e.target.value)} rows={4} placeholder="[1] 李海波. 数字经济发展水平测度与时空分异特征[J]. 商展经济,2026(15):58-61.&#10;[2] …"
              className="w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
            <div className="mt-1 flex gap-1">
              <button onClick={parseRefs} disabled={parseBusy || !parseText.trim()}
                className="flex-1 rounded bg-amber-600 py-1 text-[10px] text-white hover:bg-amber-500 disabled:opacity-50">
                {parseBusy ? "解析中…" : "解析条目"}
              </button>
              {parseResult?.some((i) => i.valid) && (
                <button onClick={saveParsedAsMaterial} disabled={busy}
                  className="flex-1 rounded bg-emerald-600 py-1 text-[10px] text-white hover:bg-emerald-500 disabled:opacity-50">保存入素材库</button>
              )}
            </div>
            {parseResult && (
              <div className="mt-1.5 max-h-28 space-y-0.5 overflow-y-auto">
                {parseResult.map((r) => (
                  <div key={r.no} className={r.valid ? "rounded bg-slate-900/70 px-1.5 py-0.5 text-[9px] text-slate-400" : "rounded bg-rose-900/30 px-1.5 py-0.5 text-[9px] text-rose-300/80"}>
                    <span className="mr-1 font-bold text-slate-500">{r.no}</span>
                    {r.valid ? `${r.authors?.slice(0, 12)}… ${r.year} ${r.source?.slice(0, 18)}` : `⚠ 未识别: ${r.raw.slice(0, 50)}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* SocialSci R3: AI 素材生成(生成后入素材库) */}
      <div className="border-b border-slate-700/40 bg-slate-800/30 p-2">
        <input value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder={highlightDagNode ? "AI 按此节点主题生成素材…(可空)" : "AI 生成研究素材…(可填主题要求)"}
          onKeyDown={(e) => { if (e.key === "Enter") void aiGenerate(); }}
          className="mb-1.5 w-full rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500" />
        <button onClick={aiGenerate} disabled={aiBusy}
          className="w-full rounded-lg bg-purple-600 py-1 text-[11px] text-white hover:bg-purple-500 disabled:opacity-50">
          {aiBusy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : <Sparkles className="mr-1 inline h-3 w-3" />}AI 生成素材
        </button>
      </div>

      {err && <div className="mx-2 mt-1.5 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{err}</div>}

      {/* 新建表单 */}
      {creating && (
        <div className="border-b border-slate-700/40 bg-slate-800/40 p-2">
          <div className="mb-1.5 flex gap-1">
            {ALL_KINDS.map((k) => (
              <button key={k} onClick={() => setNewKind(k)}
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={newKind === k ? { backgroundColor: KIND_META[k].color + "33", color: KIND_META[k].color } : { color: "#64748b" }}>
                {KIND_META[k].label}
              </button>
            ))}
          </div>
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="素材标题"
            className="mb-1.5 w-full rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500" />
          <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={3} placeholder="内容(markdown/要点/来源摘录…)"
            className="mb-1.5 w-full resize-none rounded border border-slate-600/60 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500" />
          <button onClick={createMaterial} disabled={busy}
            className="w-full rounded bg-cyan-600 py-1 text-[11px] text-white hover:bg-cyan-500 disabled:opacity-50">
            {busy ? <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> : null}保存素材
          </button>
        </div>
      )}

      {/* 素材列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {show.length === 0 && (
          <div className="mt-8 flex flex-col items-center gap-1 text-slate-600">
            <Database className="h-8 w-8 opacity-30" />
            <p className="text-[11px]">暂无素材</p>
            <p className="text-[10px]">点 + 新建, 或从实证/审稿/绘图模块导入</p>
          </div>
        )}
        {show.map((m) => {
          const meta = KIND_META[m.kind] ?? KIND_META.note;
          const hl = isHighlighted(m);
          return (
            <div key={m.id}
              className={hl ? "mb-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-2" : "mb-1.5 rounded-lg border border-slate-700/50 bg-slate-800/40 p-2"}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: meta.color }}>
                  {meta.icon} {m.title || "未命名素材"}
                </span>
                <div className="flex gap-0.5">
                  {m.source_ref && <span className="rounded bg-slate-700/60 px-1 py-0.5 text-[9px] text-slate-400" title={`来源 ${m.source_ref}`}>src</span>}
                  <button onClick={() => startEdit(m)}
                    className="rounded p-0.5 text-slate-500 hover:text-slate-300" title="编辑"><PenLine className="h-3 w-3" /></button>
                  <button onClick={() => runReview(m)} disabled={!!reviewingId}
                    className="rounded p-0.5 text-slate-500 hover:text-purple-300" title="AI 审视素材">
                    {reviewingId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  </button>
                  <button onClick={() => removeMaterial(m.id)} disabled={busy}
                    className="rounded p-0.5 text-slate-500 hover:text-red-400" title="删除"><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
              {editingId === m.id ? (
                <div className="mt-1">
                  <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={3}
                    className="w-full resize-none rounded border border-slate-600/50 bg-slate-950 px-2 py-1 text-[11px] text-slate-300" />
                  <div className="mt-1 flex justify-end gap-1">
                    <button onClick={() => setEditingId(null)} className="rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-300">取消</button>
                    <button onClick={() => saveEdit(m)} disabled={busy} className="rounded bg-cyan-600 px-2 py-0.5 text-[10px] text-white disabled:opacity-50">保存</button>
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  <div className="truncate text-[10px] text-slate-500">{m.produced_by_dag_node && <span className="text-cyan-500/80">节点{m.produced_by_dag_node} · </span>}{m.tags?.join(" / ") || "—"}</div>
                  {reviews[m.id] && (
                    <div className="mt-1 space-y-1 rounded bg-slate-950/60 p-1.5">
                      <p className="flex items-center gap-1 text-[9px]">
                        <span className={reviews[m.id].quality === "high" ? "text-emerald-400" : reviews[m.id].quality === "medium" ? "text-amber-400" : "text-rose-400"}>
                          {reviews[m.id].quality === "high" ? "高质量" : reviews[m.id].quality === "medium" ? "中等" : "待改进"} · {reviews[m.id].score}分
                        </span>
                        <span className="text-slate-500">{reviews[m.id].assessment}</span>
                      </p>
                      {reviews[m.id].relevance && <p className="text-[9px] text-slate-400">匹配: {reviews[m.id].relevance}</p>}
                      {reviews[m.id].suggestions.map((sg, si) => <p key={si} className="text-[9px] text-purple-300/80">· {sg}</p>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
