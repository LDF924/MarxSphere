// ResearchInputWizard.tsx — SocialSci UI审计: 录入向导页(目录树+六字段+澄清)对齐闭源 ss_input
// 布局: 信息录入 → 目录大纲编辑器(树+模板+上移下移+清除) → 六字段卡(主题/字数/框架/方法/参考文件/补充)
//   → AI需求澄清(analysis+问题卡+回答) → 开始思考科研架构(写input节点+analysis)
import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, FileText, Loader2, Plus, RotateCcw, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { Node as FlowNode } from "@xyflow/react";

export interface WizardOutlineItem { id: string; title: string; level: number; children?: WizardOutlineItem[]; }

const WIZ_TEMPLATES = [
  { name: "实证·经济管理", items: [
    { id: "t1", title: "引言", level: 1, children: [
      { id: "t1a", title: "问题提出与研究缘起", level: 2 }, { id: "t1b", title: "研究目的与意义", level: 2 }, { id: "t1c", title: "核心概念界定", level: 2 }] },
    { id: "t2", title: "文献综述与分析框架", level: 1, children: [
      { id: "t2a", title: "相关领域研究进展", level: 2 }, { id: "t2b", title: "现有研究的不足", level: 2 }, { id: "t2c", title: "本文的分析框架", level: 2 }] },
    { id: "t3", title: "研究设计与数据", level: 1 },
    { id: "t4", title: "实证结果与分析", level: 1 },
    { id: "t5", title: "结论与政策建议", level: 1 },
  ]},
  { name: "理论思辨", items: [
    { id: "u1", title: "引言", level: 1 }, { id: "u2", title: "现象与问题域", level: 1 },
    { id: "u3", title: "理论谱系与解释框架", level: 1 }, { id: "u4", title: "机理分析", level: 1 },
    { id: "u5", title: "批判性讨论", level: 1 }, { id: "u6", title: "结语", level: 1 },
  ]},
  { name: "政策分析", items: [
    { id: "v1", title: "引言", level: 1, children: [{ id: "v1a", title: "背景与问题提出", level: 2 }] },
    { id: "v2", title: "现状与成效", level: 1 }, { id: "v3", title: "问题与挑战", level: 1 },
    { id: "v4", title: "对策建议", level: 1 }, { id: "v5", title: "结语", level: 1 },
  ]},
];

function genId(): string { return "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }
function tokenOf() { return localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""; }
async function j<T = unknown>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts.headers as Record<string, string>) ?? {}) };
  const t = tokenOf(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string })?.error || `请求失败 ${r.status}`);
  return body as T;
}

export function ResearchInputWizard(props: {
  projectId: string; title: string;
  onDone: () => void; onCancel: () => void; onMsg: (m: string) => void;
}) {
  const { projectId, onDone, onCancel, onMsg } = props;
  // 字段
  const [topic, setTopic] = useState(props.title);
  const [targetWords, setTargetWords] = useState("10000");
  const [method, setMethod] = useState("");
  const [extraReq, setExtraReq] = useState("");
  const [files, setFiles] = useState<Array<{ name: string; state: "read" | "unread" }>>([]);
  // 目录树
  const [items, setItems] = useState<WizardOutlineItem[]>([]);
  const [showTpl, setShowTpl] = useState(false);
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const [clarifyData, setClarifyData] = useState<{ analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } | null>(null);
  const [clarifyAnswers, setClarifyAnswers] = useState<string[]>([]);
  const [clarifyBusy, setClarifyBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const applyTemplate = (items: WizardOutlineItem[]) => { setItems(JSON.parse(JSON.stringify(items))); setShowTpl(false); };
  const addChapter = () => {
    const t = prompt("新章节标题:");
    if (!t?.trim()) return;
    setItems((p) => [...p, { id: genId(), title: t.trim(), level: 1 }]);
  };
  const move = (idx: number, dir: -1 | 1) => {
    setItems((p) => {
      const next = [...p]; const j = idx + dir;
      if (j < 0 || j >= next.length) return p;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };
  const outlineText = items.map((it, i) => {
    const zh = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
    const head = `${zh[i] ?? i + 1}、${it.title}`;
    const subs = (it.children ?? []).map((c, ci) => `  ${i + 1}.${ci + 1} ${c.title}`);
    return [head, ...subs].join("\n");
  }).join("\n");

  const runClarify = async () => {
    setClarifyBusy(true);
    try {
      const r = await j<{ success: boolean; data: { analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } }>("/api/clarify/generate", {
        method: "POST", body: JSON.stringify({ title: topic, outline: outlineText, researchMethod: method, totalWordCount: Number(targetWords) || 10000 }),
      });
      setClarifyData(r.data); setClarifyAnswers(new Array(r.data.questions.length).fill("")); setClarifyOpen(true);
    } catch (e) { onMsg((e as Error).message); } finally { setClarifyBusy(false); }
  };

  const submit = async () => {
    if (!topic.trim()) { onMsg("请填研究主题"); return; }
    if (!items.length && !outlineText.trim()) { onMsg("请先添加章节或套用模板"); return; }
    setSubmitting(true);
    try {
      // 1. input 节点持久化(六字段+目录树)
      const reqText = clarifyData ? `【AI需求澄清结果】\n${clarifyData.questions.map((q, i) => `Q(${q.category}): ${q.question}\n  → ${(clarifyAnswers[i] ?? "").trim() || "无"}`).join("\n")}` : "";
      const payload = {
        input: { title: topic, outline: outlineText, requirements: reqText || extraReq, researchMethod: method, totalWordCount: Number(targetWords) || 10000, sampleFiles: files },
        selectedDomain: "social", selectedField: "",
      };
      await j(`/api/research/projects/${projectId}/nodes/input`, {
        method: "PUT", body: JSON.stringify({ payload, sourceRole: "user", note: "录入向导提交" }),
      });
      // 2. sections 节点预填目录树(供后续架构分析使用)
      const secList = items.map((it, i) => ({
        id: it.id, title: it.title, level: 1, order: i + 1,
        children: (it.children ?? []).map((c) => ({ id: c.id, title: c.title, level: 2 })),
      }));
      await j(`/api/research/projects/${projectId}/nodes/sections`, {
        method: "PUT", body: JSON.stringify({ payload: { sections: secList }, sourceRole: "user", note: "录入向导目录" }),
      });
      // 3. 项目元信息
      await j(`/api/research/projects/${projectId}`, { method: "PUT", body: JSON.stringify({ topic, thesis: reqText || extraReq }) }).catch(() => {});
      onMsg("研究信息已录入, 进入科研工作台");
      onDone();
    } catch (e) { onMsg((e as Error).message); } finally { setSubmitting(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-1">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-100">研究信息录入</h3>
          <p className="text-[11px] text-slate-500">输入研究主题/目录/方法, AI 智能体将据此规划科研架构</p>
        </div>
        <button onClick={onCancel} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
          <ArrowLeft className="h-3 w-3" /> 返回项目列表
        </button>
      </div>

      {/* 目录大纲编辑器 */}
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/50">
        <div className="flex items-center justify-between border-b border-slate-700/50 px-3 py-2">
          <span className="text-xs font-semibold text-slate-200">目录大纲编辑器</span>
          <div className="flex gap-1">
            <button onClick={() => setShowTpl((v) => !v)} className="rounded bg-indigo-600/30 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-600/50">📋 模板 {showTpl ? "▲" : "▼"}</button>
            <button onClick={addChapter} className="flex items-center gap-0.5 rounded bg-cyan-600 px-2 py-1 text-[10px] text-white hover:bg-cyan-500"><Plus className="h-2.5 w-2.5" />一级章节</button>
            <button onClick={() => { if (items.length && window.confirm("清除目录?")) setItems([]); }} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-600">清除</button>
          </div>
        </div>
        {showTpl && (
          <div className="grid grid-cols-3 gap-1 border-b border-slate-700/40 p-2">
            {WIZ_TEMPLATES.map((t) => (
              <button key={t.name} onClick={() => applyTemplate(t.items)} className="rounded bg-slate-800/80 px-2 py-1.5 text-left hover:bg-slate-700">
                <p className="text-[10px] text-slate-200">{t.name}</p>
                <p className="text-[8px] text-slate-500">{t.items.length} 章</p>
              </button>
            ))}
          </div>
        )}
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-slate-600">目录为空 — 套用上方模板, 或点"一级章节"添加</p>
        ) : (
          <div className="max-h-52 space-y-0.5 overflow-y-auto p-2">
            {items.map((it, idx) => (
              <div key={it.id}>
                <div className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800/60">
                  <span className="w-6 text-[10px] text-slate-500">{idx + 1}</span>
                  <ChevronDown className="h-3 w-3 text-slate-500" />
                  <span className="flex-1 truncate text-xs text-slate-200">{it.title}</span>
                  <button onClick={() => move(idx, -1)} title="上移" className="hidden opacity-0 group-hover:opacity-100 group-hover:inline text-slate-500 hover:text-slate-200"><RotateCcw className="h-3 w-3 -rotate-90" /></button>
                  <button onClick={() => move(idx, 1)} title="下移" className="hidden opacity-0 group-hover:opacity-100 group-hover:inline text-slate-500 hover:text-slate-200"><RotateCcw className="h-3 w-3 rotate-90" /></button>
                  <button onClick={() => setItems((p) => p.filter((x) => x.id !== it.id))} title="删除" className="hidden opacity-0 group-hover:opacity-100 group-hover:inline text-rose-400 hover:text-rose-300"><Trash2 className="h-3 w-3" /></button>
                </div>
                {(it.children ?? []).map((c) => (
                  <div key={c.id} className="flex items-center gap-1 rounded px-7 py-0.5 hover:bg-slate-800/40">
                    <ChevronRight className="h-2.5 w-2.5 text-slate-600" />
                    <span className="flex-1 truncate text-[11px] text-slate-400">{c.title}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 六字段卡 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
          <p className="mb-1 text-xs font-medium text-slate-300">研究主题 *</p>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="例如: 数字经济背景下中小企业融资困境与对策研究"
            className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-2 text-xs text-slate-200 placeholder:text-slate-600" />
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
          <p className="mb-1 text-xs font-medium text-slate-300">全文目标字数</p>
          <input value={targetWords} onChange={(e) => setTargetWords(e.target.value)} type="number"
            className="w-full rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-2 text-xs text-slate-200" />
          <p className="mt-0.5 text-[9px] text-slate-600">AI 智能体将按此字数进行科研分配</p>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
          <p className="mb-1 text-xs font-medium text-slate-300">研究方法</p>
          <div className="grid grid-cols-3 gap-1">
            {[["qualitative", "定性"], ["quantitative", "定量"], ["mixed", "混合"]].map(([k, lb]) => (
              <button key={k} onClick={() => setMethod(method === k ? "" : k)}
                className={cn("rounded-lg py-1.5 text-[11px]", method === k ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200")}>{lb}</button>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-slate-600">不确定可跳过, 系统将自动识别</p>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
          <p className="mb-1 text-xs font-medium text-slate-300">参考文件 (可选)</p>
          <div className="flex flex-wrap gap-1">
            <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-dashed border-slate-600 bg-slate-800/50 px-2 py-1.5 text-[10px] text-slate-400 hover:border-cyan-500/50">
              <Upload className="h-3 w-3" /> 上传
              <input type="file" className="hidden" multiple onChange={(e) => { const fs = Array.from(e.target.files ?? []); setFiles((p) => [...p, ...fs.map((f) => ({ name: f.name, state: "unread" as const }))]); }} />
            </label>
            {files.map((f, i) => (
              <span key={i} className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px]", f.state === "read" ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700 text-slate-300")}>
                {f.name} <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}><X className="h-2.5 w-2.5" /></button>
              </span>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-slate-600">支持 PDF/Word/TXT/Markdown</p>
        </div>
      </div>
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
        <p className="mb-1 text-xs font-medium text-slate-300">额外要求 / 补充信息</p>
        <textarea value={extraReq} onChange={(e) => setExtraReq(e.target.value)} rows={2} placeholder="范围界定、核心问题、理论基础、创新聚焦、数据来源、章节逻辑…"
          className="w-full resize-none rounded-lg border border-slate-600/60 bg-slate-800 px-2.5 py-2 text-xs text-slate-200 placeholder:text-slate-600" />
      </div>

      {/* AI 需求澄清 */}
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
        <button onClick={runClarify} disabled={clarifyBusy}
          className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50">
          {clarifyBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} AI 需求澄清(选填, 最长约1分钟)
        </button>
        {clarifyData && (
          <div className="mt-2 space-y-1.5">
            <p className="text-[11px] leading-relaxed text-slate-400">{clarifyData.analysis}</p>
            {clarifyData.questions.map((q, qi) => (
              <div key={q.id} className="rounded bg-slate-800/60 p-2">
                <p className="flex items-start gap-1 text-[11px] text-slate-200">
                  <span className="rounded bg-sky-500/20 px-1 text-[9px] text-sky-300">{q.category}</span>
                  {qi + 1}. {q.question}
                </p>
                <p className="mt-0.5 text-[9px] text-slate-500">{q.guidance}</p>
                <input value={clarifyAnswers[qi] ?? ""} onChange={(e) => setClarifyAnswers((a) => { const n = [...a]; n[qi] = e.target.value; return n; })}
                  placeholder="回答(可选)" className="mt-1 w-full rounded border border-slate-600/50 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-600" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 提交 */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-slate-600">{items.length} 章 · {targetWords} 字 · {method || "方法未选(自动识别)"}</p>
        <button onClick={submit} disabled={submitting}
          className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-5 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50">
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookOpen className="h-3.5 w-3.5" />} 开始思考科研架构
        </button>
      </div>
    </div>
  );
}
