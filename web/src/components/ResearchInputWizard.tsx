// ResearchInputWizard.tsx — SocialSci UI审计: 录入向导页(目录树+六字段+澄清)对齐闭源 ss_input
// 布局: 信息录入 → 目录大纲编辑器(树+模板+上移下移+清除) → 六字段卡(主题/字数/框架/方法/参考文件/补充)
//   → AI需求澄清(analysis+问题卡+回答) → 开始思考科研架构(写input节点+analysis)
import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, FileText, Loader2, Plus, RotateCcw, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { Node as FlowNode } from "@xyflow/react";

export interface WizardOutlineItem { id: string; title: string; level: number; children?: WizardOutlineItem[]; collapsed?: boolean; }

const WIZ_TEMPLATES = [
  // W1(闭源 input 实拍): "插入模板"一键铺 5章12节社科骨架(标题含中文序号"一、二..."结构)
  { name: "实证·经济管理", items: [
    { id: "t1", title: "引言", level: 1, children: [
      { id: "t1a", title: "问题提出与研究缘起", level: 2 }, { id: "t1b", title: "研究目的与意义", level: 2 }, { id: "t1c", title: "核心概念界定", level: 2 }] },
    { id: "t2", title: "文献综述与分析框架", level: 1, children: [
      { id: "t2a", title: "相关领域研究进展", level: 2 }, { id: "t2b", title: "现有研究的不足", level: 2 }, { id: "t2c", title: "本文的分析框架", level: 2 }] },
    { id: "t3", title: "现状描述或案例呈现", level: 1, children: [
      { id: "t3a", title: "数据来源与研究对象", level: 2 }, { id: "t3b", title: "主要特征与发展趋势", level: 2 }] },
    { id: "t4", title: "问题分析与对策建议", level: 1, children: [
      { id: "t4a", title: "存在的主要问题及成因", level: 2 }, { id: "t4b", title: "对策建议与路径选择", level: 2 }] },
    { id: "t5", title: "结语", level: 1, children: [
      { id: "t5a", title: "主要结论", level: 2 }, { id: "t5b", title: "研究局限与展望", level: 2 }] },
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
// W1(闭源 input 实拍): 页面初始=默认 3章6节占位骨架(标题留空由用户填); 清除目录=回此默认, 非清空
function defaultSkeleton(): WizardOutlineItem[] {
  return [
    { id: "d1", title: "", level: 1, children: [{ id: "d1a", title: "", level: 2 }, { id: "d1b", title: "", level: 2 }] },
    { id: "d2", title: "", level: 1, children: [{ id: "d2a", title: "", level: 2 }, { id: "d2b", title: "", level: 2 }] },
    { id: "d3", title: "", level: 1, children: [{ id: "d3a", title: "", level: 2 }, { id: "d3b", title: "", level: 2 }] },
  ];
}
function cn(...xs: Array<string | false | undefined>) { return xs.filter(Boolean).join(" "); }

// 研究领域预设(闭源 WorkflowHome 学科分组对齐, 原创列表)
const DOMAINS: Array<{ id: string; label: string; desc: string }> = [
  { id: "economics", label: "经济学", desc: "宏观/微观/金融" },
  { id: "management", label: "管理学", desc: "企业管理/公共管理" },
  { id: "sociology", label: "社会学", desc: "社会结构/政策" },
  { id: "law", label: "法学", desc: "民商/刑法/行政" },
  { id: "education", label: "教育学", desc: "教育理论/管理" },
  { id: "marxism", label: "马克思主义理论", desc: "政经/哲社" },
  { id: "cs", label: "计算机科学", desc: "软件/网络" },
  { id: "engineering", label: "工程学", desc: "机械/电子/土木" },
  { id: "medicine", label: "医学", desc: "临床/基础" },
  { id: "general", label: "通用社会科学", desc: "不限方向" },
];
// 二级领域(selectedField 语义, 闭源 domain→field 双选对齐)
const DOMAIN_FIELDS: Record<string, string[]> = {
  economics: ["宏观经济学", "微观经济学", "金融学", "产业经济学", "劳动经济学", "区域经济学"],
  management: ["企业管理", "公共管理", "市场营销", "会计学", "人力资源"],
  sociology: ["社会结构", "社会政策", "人口学", "城乡社会学"],
  law: ["民商法", "刑法", "行政法", "经济法", "宪法"],
  education: ["教育理论", "教育管理", "课程与教学", "高等教育"],
  marxism: ["政治经济学", "哲学", "科学社会主义", "中共党史"],
  cs: ["软件工程", "计算机网络", "人工智能", "数据科学"],
  engineering: ["机械工程", "电子工程", "土木工程", "材料"],
  medicine: ["临床医学", "基础医学", "公共卫生"],
  general: [],
};
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
  const [items, setItems] = useState<WizardOutlineItem[]>(() => defaultSkeleton());
  // W1: 行内标题编辑(闭源 input 行=可点击输入)
  const [editingId, setEditingId] = useState("");
  const renameTitle = (id: string, title: string) => {
    setItems((p) => p.map((it) => it.id === id ? { ...it, title } : { ...it, children: (it.children ?? []).map((c) => c.id === id ? { ...c, title } : c) }));
  };
  const [showTpl, setShowTpl] = useState(false);
  const [clarifyOpen, setClarifyOpen] = useState(false);
  const [clarifyData, setClarifyData] = useState<{ analysis: string; questions: Array<{ id: string; category: string; question: string; guidance: string; importance: string }> } | null>(null);
  const [clarifyAnswers, setClarifyAnswers] = useState<string[]>([]);
  const [clarifyBusy, setClarifyBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 研究领域(闭源 WorkflowHome 学科选择对齐): 预设社科/自然学科, 注入架构分析
  const [domain, setDomain] = useState("");
  const [field, setField] = useState("");

  const applyTemplate = (items: WizardOutlineItem[]) => {
    // 就地插入语义(闭源"插入模板"): 追加到现有目录末尾, 不替换不清空
    setItems((p) => [...p, ...JSON.parse(JSON.stringify(items))]);
    setShowTpl(false);
  };
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
        input: { title: topic, outline: outlineText, requirements: reqText || extraReq, researchMethod: method, totalWordCount: Number(targetWords) || 10000, sampleFiles: files, domain: domain || "", field: field || "" },
        selectedDomain: domain || "social", selectedField: field || "",
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
          <span className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            目录大纲编辑器
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[9px] font-normal text-slate-400">
              {items.length} 个一级 · {items.reduce((s, it) => s + (it.children?.length ?? 0), 0)} 个二级
            </span>
          </span>
          <div className="flex gap-1">
            <button onClick={() => setShowTpl((v) => !v)} className="rounded bg-indigo-600/30 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-600/50">📋 插入模板 {showTpl ? "▲" : "▼"}</button>
            <button onClick={addChapter} className="flex items-center gap-0.5 rounded bg-cyan-600 px-2 py-1 text-[10px] text-white hover:bg-cyan-500"><Plus className="h-2.5 w-2.5" />一级章节</button>
            <button onClick={() => { if (items.length && window.confirm("清除目录?")) setItems(defaultSkeleton()); }} className="rounded bg-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-600">清除目录</button>
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
          // R13(闭源 OutlineEditor 空态): 文案+红链插入模板按钮
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-slate-600">目录为空, 请添加章节或插入模板</p>
            <button onClick={() => applyTemplate(WIZ_TEMPLATES[0].items)}
              className="mt-1 text-[11px] text-rose-400 hover:text-rose-300">插入模板</button>
          </div>
        ) : (
          <div className="max-h-52 space-y-0.5 overflow-y-auto p-2">
            {items.map((it, idx) => (
              <div key={it.id}>
                <div className="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-800/60">
                  {/* W1(闭源): 中文序号"一、二..." + 行内标题(可点击编辑) */}
                  <span className="w-6 text-[10px] text-slate-500">{["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][idx] ?? idx + 1}</span>
                  <ChevronDown className="h-3 w-3 text-slate-500" />
                  {editingId === it.id ? (
                    <input autoFocus value={it.title} onChange={(e) => renameTitle(it.id, e.target.value)}
                      onBlur={() => setEditingId("")} onKeyDown={(e) => { if (e.key === "Enter") setEditingId(""); }}
                      placeholder="输入一级标题"
                      className="flex-1 rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500/60 focus:outline-none" />
                  ) : (
                    <button onClick={() => setEditingId(it.id)} className="flex-1 truncate text-left text-xs text-slate-200 hover:text-slate-100" title="点击编辑标题">
                      {it.title || <span className="text-slate-600">输入一级标题</span>}
                    </button>
                  )}
                  <button onClick={() => setItems((p) => p.map((x) => x.id === it.id ? { ...x, collapsed: !x.collapsed } : x))}
                    title={it.collapsed ? "展开" : "折叠"}
                    className="hidden text-slate-500 opacity-0 hover:text-slate-200 group-hover:inline group-hover:opacity-100">
                    {it.collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                  <button onClick={() => setItems((p) => [...p, { id: genId(), title: "", level: 1, children: [] }])} title="添加子节" className="hidden text-slate-500 opacity-0 hover:text-slate-200 group-hover:inline group-hover:opacity-100"><Plus className="h-3 w-3" /></button>
                  <button onClick={() => move(idx, -1)} disabled={idx === 0} title="上移"
                    className={cn("hidden opacity-0 group-hover:opacity-100 group-hover:inline text-slate-500 hover:text-slate-200", idx === 0 && "cursor-not-allowed opacity-30 hover:text-slate-500")}><RotateCcw className="h-3 w-3 -rotate-90" /></button>
                  <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1} title="下移"
                    className={cn("hidden opacity-0 group-hover:opacity-100 group-hover:inline text-slate-500 hover:text-slate-200", idx === items.length - 1 && "cursor-not-allowed opacity-30 hover:text-slate-500")}><RotateCcw className="h-3 w-3 rotate-90" /></button>
                  <button onClick={() => setItems((p) => p.filter((x) => x.id !== it.id))} title="删除" className="hidden opacity-0 group-hover:opacity-100 group-hover:inline text-rose-400 hover:text-rose-300"><Trash2 className="h-3 w-3" /></button>
                </div>
                {/* R13(闭源): collapsed 折叠子节 */}
                {!it.collapsed && (it.children ?? []).map((c, ci) => (
                  <div key={c.id} className="flex items-center gap-1 rounded px-7 py-0.5 hover:bg-slate-800/40">
                    <ChevronRight className="h-2.5 w-2.5 text-slate-600" />
                    {editingId === c.id ? (
                      <input autoFocus value={c.title} onChange={(e) => renameTitle(c.id, e.target.value)}
                        onBlur={() => setEditingId("")} onKeyDown={(e) => { if (e.key === "Enter") setEditingId(""); }}
                        placeholder="输入子节标题"
                        className="flex-1 rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300 placeholder:text-slate-600 focus:border-cyan-500/60 focus:outline-none" />
                    ) : (
                      <button onClick={() => setEditingId(c.id)} className="flex-1 truncate text-left text-[11px] text-slate-400 hover:text-slate-300" title="点击编辑标题">
                        {c.title || <span className="text-slate-600">输入子节标题</span>}
                      </button>
                    )}
                    <button onClick={() => setItems((p) => p.map((x) => x.id === it.id ? { ...x, children: [...(x.children ?? []), { id: genId(), title: "", level: 2 }] } : x))} title="追加子节" className="hidden text-slate-500 opacity-0 hover:text-slate-200 group-hover:inline group-hover:opacity-100"><Plus className="h-2.5 w-2.5" /></button>
                    <button onClick={() => setItems((p) => p.map((x) => x.id === it.id ? { ...x, children: (x.children ?? []).filter((y) => y.id !== c.id) } : x))} title="删除" className="hidden text-rose-400 opacity-0 hover:text-rose-300 group-hover:inline group-hover:opacity-100"><X className="h-2.5 w-2.5" /></button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 研究领域(闭源 WorkflowHome 学科选择对齐) */}
      <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
        <p className="mb-1 text-xs font-medium text-slate-300">研究领域 <span className="text-[9px] text-slate-600">(选填, AI 据此优化科研策略)</span></p>
        <div className="flex flex-wrap gap-1.5">
          {DOMAINS.map((d) => (
            <button key={d.id} onClick={() => setDomain(domain === d.id ? "" : d.id)}
              className={cn("rounded-lg border px-2.5 py-1 text-[11px]", domain === d.id ? "border-cyan-500/60 bg-cyan-600/20 text-cyan-200" : "border-slate-600/60 bg-slate-800 text-slate-400 hover:text-slate-200")}>
              {d.label}
              <span className="ml-1 hidden text-[8px] text-slate-600 sm:inline">{d.desc}</span>
            </button>
          ))}
        </div>
        {/* 二级领域(selectedField): 选主领域后出子域 chips */}
        {domain && DOMAIN_FIELDS[domain]?.length ? (
          <div className="mt-2">
            <p className="mb-1 text-[10px] text-slate-500">二级领域 <span className="text-[9px] text-slate-600">(可跳过, AI 自动识别)</span></p>
            <div className="flex flex-wrap gap-1.5">
              {DOMAIN_FIELDS[domain].map((f) => (
                <button key={f} onClick={() => setField(field === f ? "" : f)}
                  className={cn("rounded-full border px-2.5 py-0.5 text-[10px]", field === f ? "border-cyan-500/60 bg-cyan-600/20 text-cyan-200" : "border-slate-600/60 bg-slate-800 text-slate-500 hover:text-slate-300")}>
                  {f}
                </button>
              ))}
            </div>
          </div>
        ) : null}
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
          <p className="mb-1 text-xs font-medium text-slate-300">研究方法 <span className="text-[9px] text-slate-600">*</span></p>
          <div className="grid grid-cols-3 gap-2">
            {[["qualitative", "定性研究", "案例/访谈/文本分析\n理论阐释与深度分析"], ["quantitative", "定量研究", "问卷/实证/统计分析\n假设检验与数据驱动"], ["mixed", "混合方法", "定量+定性结合\n多维度综合分析"]].map(([k, lb, desc]) => (
              <button key={k} onClick={() => setMethod(method === k ? "" : k)}
                className={cn("rounded-xl border px-3 py-2.5 text-left transition", method === k ? "border-cyan-500 bg-cyan-600/15" : "border-slate-700/60 bg-slate-800/60 hover:border-slate-500")}>
                <p className={cn("text-[11px] font-semibold", method === k ? "text-cyan-200" : "text-slate-300")}>{lb}</p>
                <p className="mt-0.5 text-[9px] leading-relaxed whitespace-pre-line text-slate-500">{desc}</p>
              </button>
            ))}
          </div>
          <p className="mt-1 text-[9px] text-slate-600">选择后将用于 AI 智能体思考研究方法。不确定可跳过, 系统将根据标题和目录自动识别。</p>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/50 p-3">
          <p className="mb-1 text-xs font-medium text-slate-300">参考文件 (可选)</p>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-slate-600 bg-slate-800/30 px-4 py-6 text-[10px] text-slate-400 transition hover:border-cyan-500/60 hover:bg-slate-800/60">
            <Upload className="h-5 w-5 text-slate-500" />
            <span>点击或拖拽上传参考文件</span>
            <span className="text-[9px] text-slate-600">支持 PDF、Word、TXT、Markdown</span>
            <input type="file" className="hidden" multiple onChange={(e) => { const fs = Array.from(e.target.files ?? []); setFiles((p) => [...p, ...fs.map((f) => ({ name: f.name, state: "unread" as const }))]); }} />
          </label>
          {files.length > 0 && (
            <div className="mt-2 space-y-1">
              {files.map((f, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg bg-slate-800/70 px-2 py-1.5 text-[10px] text-slate-300">
                  <span className="truncate">{f.name}</span>
                  <span className={cn("ml-2 shrink-0 rounded px-1 py-0.5 text-[8px]", f.state === "read" ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-600/40 text-slate-400")}>{f.state === "read" ? "已读" : "未读"}</span>
                  <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}><X className="ml-1 h-3 w-3 text-slate-500 hover:text-red-400" /></button>
                </div>
              ))}
            </div>
          )}
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
