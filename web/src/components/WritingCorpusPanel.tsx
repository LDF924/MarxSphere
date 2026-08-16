// WritingCorpusPanel.tsx — 学术写作语料库（2026-08-16）
// 四大子库: 文本范例 / 核心概念 / 论证逻辑 / 词汇句式
// 工作流: 积累(粘贴+LLM辅助提取) → 整理(打标签/检索) → 应用(写作前调取)
import { useEffect, useState, type FC } from "react";
import { BookOpen, Search, Plus, Copy, Sparkles, Filter } from "lucide-react";
import { cn } from "../lib/utils";

// ═══ 类型 ═══
interface CorpusText { id: number; language: string; text: string; source?: string; writingModule: string; tags: string[]; note?: string; createdBy: string; createdAt: string; }
interface CorpusConcept { id: number; name: string; definition: string; proposer?: string; year?: string; evolution: Array<{ year: string; scholar: string; contribution: string }>; boundary?: string; related: string[]; tags: string[]; }
interface CorpusLogic { id: number; name: string; patternType: string; structure: Array<{ step: number; desc: string }>; example?: string; usageHint?: string; tags: string[]; }
interface CorpusExpression { id: number; semanticGroup: string; expression: string; zhMeaning?: string; enExample?: string; replaceFor?: string; language: string; }

const MODULES = ["引言", "综述", "实证分析", "结论", "讨论", "方法", "摘要"];
const SEMANTIC_GROUPS = ["因果", "对比", "研究缺口", "总结发现", "让步", "强调", "示例", "过渡"];
const LOGIC_TYPES = ["现象抽象", "多案例对比", "辩证结构", "实证递进", "归纳-演绎"];

type Kind = "texts" | "concepts" | "logics" | "expressions";

export const WritingCorpusPanel: FC = () => {
  const [kind, setKind] = useState<Kind>("texts");
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [msg, setMsg] = useState("");
  // 录入表单（通用）
  const [form, setForm] = useState<Record<string, string>>({});
  // LLM 提取
  const [extractText, setExtractText] = useState("");
  const [extracting, setExtracting] = useState(false);

  const load = async (k = kind, query = q, f = filter) => {
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (f) params.set(k === "texts" ? "module" : k === "expressions" ? "group" : "q", f);
      const r = await fetch(`/api/writing-corpus/${k}?${params}`);
      setItems((await r.json()).items || []);
    } catch { setItems([]); }
  };
  useEffect(() => { void load(); }, [kind]);

  const add = async () => {
    try {
      const payload: Record<string, unknown> = { ...form };
      // 结构化字段转换
      if (payload.tags) payload.tags = String(payload.tags).split(/[,，]/).map((s: string) => s.trim()).filter(Boolean);
      if (payload.related) payload.related = String(payload.related).split(/[,，]/).map((s: string) => s.trim()).filter(Boolean);
      if (payload.evolution) { try { payload.evolution = JSON.parse(String(payload.evolution)); } catch { payload.evolution = []; } }
      if (payload.structure) { try { payload.structure = JSON.parse(String(payload.structure)); } catch { payload.structure = []; } }
      const r = await fetch(`/api/writing-corpus/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.error) { setMsg(`❌ ${d.error}`); return; }
      setMsg("✅ 已入库");
      setShowAdd(false); setForm({});
      void load();
    } catch (e: any) { setMsg(`❌ ${e.message || "失败"}`); }
  };

  // LLM 辅助提取: 粘贴原文 → 结构化语料 → 填入表单
  const doExtract = async (k: Kind) => {
    if (!extractText.trim()) return;
    setExtracting(true);
    try {
      const r = await fetch("/api/writing-corpus/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: extractText, kind: k }),
      });
      const d = await r.json();
      if (!d.extracted) { setMsg("❌ 提取失败（LLM 不可用或格式不符）"); return; }
      const e = d.extracted;
      // 填充表单
      const next: Record<string, string> = {};
      for (const [k2, v] of Object.entries(e)) {
        next[k2] = typeof v === "string" ? v : Array.isArray(v) ? JSON.stringify(v) : String(v ?? "");
      }
      setForm(next);
      setMsg("✨ 已提取，请确认后入库");
    } catch (e: any) { setMsg(`❌ ${e.message || "提取失败"}`); }
    setExtracting(false);
  };

  // 复制应用（借鉴句式/结构）
  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setMsg("📋 已复制 — 请模仿句式/结构, 勿照抄原文");
  };

  const formFields: Record<Kind, Array<{ key: string; label: string; ph: string; area?: boolean }>> = {
    texts: [
      { key: "text", label: "段落原文*", ph: "粘贴高质量段落（中英文均可）", area: true },
      { key: "source", label: "出处", ph: "论文/专著/作者+年份" },
      { key: "writingModule", label: "适用写作模块", ph: "引言/综述/实证分析/结论/讨论/方法/摘要" },
      { key: "tags", label: "标签(逗号分隔)", ph: "主题/风格" },
      { key: "note", label: "使用说明", ph: "借鉴点（句式/结构亮点）", area: true },
    ],
    concepts: [
      { key: "name", label: "概念名*", ph: "如: 剩余价值" },
      { key: "definition", label: "定义*", ph: "精确定义表述", area: true },
      { key: "proposer", label: "提出学者", ph: "如: 马克思" },
      { key: "year", label: "年份", ph: "如: 1867" },
      { key: "evolution", label: "理论演进(JSON)", ph: '[{"year":"1867","scholar":"马克思","contribution":"..."}]', area: true },
      { key: "boundary", label: "适用边界", ph: "适用范围/局限", area: true },
      { key: "related", label: "关联概念(逗号分隔)", ph: "资本积累,利润率" },
    ],
    logics: [
      { key: "name", label: "范式名*", ph: "如: 现象→理论抽象" },
      { key: "patternType", label: "类型", ph: "现象抽象/多案例对比/辩证结构/实证递进/归纳-演绎" },
      { key: "structure", label: "结构步骤(JSON)", ph: '[{"step":1,"desc":"..."}]', area: true },
      { key: "example", label: "典型示例", ph: "简短示例", area: true },
      { key: "usageHint", label: "何时使用", ph: "解决什么问题" },
    ],
    expressions: [
      { key: "semanticGroup", label: "语义组", ph: "因果/对比/研究缺口/总结发现/让步/强调/示例/过渡" },
      { key: "expression", label: "高级表达*", ph: "如: This study attributes ... to ..." },
      { key: "zhMeaning", label: "中文释义", ph: "使用场景" },
      { key: "enExample", label: "英文例句", ph: "示例句", area: true },
      { key: "replaceFor", label: "替代的基础词", ph: "如: show" },
    ],
  };

  const filters: Record<Kind, { label: string; options: string[] }> = {
    texts: { label: "写作模块", options: MODULES },
    concepts: { label: "标签", options: [] },
    logics: { label: "类型", options: LOGIC_TYPES },
    expressions: { label: "语义组", options: SEMANTIC_GROUPS },
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">学术写作语料库</h2>
        <span className="text-xs text-muted-foreground">积累 → 整理 → 应用 · 只借鉴逻辑与句式, 不照搬原文</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input value={q} onChange={(e) => { setQ(e.target.value); void load(kind, e.target.value, filter); }}
              placeholder="检索语料…" className="w-40 bg-transparent text-xs outline-none placeholder:text-muted-foreground" />
          </div>
          <button type="button" aria-label="新增语料" onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-1 rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20">
            <Plus className="h-3.5 w-3.5" /> 录入语料
          </button>
        </div>
      </div>
      {msg && <div className="rounded border border-primary/30 bg-primary/5 px-3 py-2 text-xs">{msg}</div>}

      {/* 子库切换 */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border pb-1">
        {([["texts", "文本范例", "高质量段落"], ["concepts", "核心概念", "理论/模型谱系"], ["logics", "论证逻辑", "论证范式"], ["expressions", "词汇句式", "高级表达"]] as const).map(([id, label, desc]) => (
          <button key={id} type="button" aria-label={`切换${label}库`} aria-selected={kind === id}
            onClick={() => { setKind(id); setFilter(""); setForm({}); setItems([]); /* 切库清空, 防旧库数据在渲染时字段缺失崩溃 */ }}
            className={cn("shrink-0 rounded-md px-3 py-1.5 text-xs transition-colors",
              kind === id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground")}>
            {label}
            <span className="ml-1 text-[9px] text-muted-foreground/70">{desc}</span>
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">{items.length} 条</span>
      </div>

      {/* 过滤 + 录入 */}
      <div className="flex items-center gap-2">
        <Filter className="h-3 w-3 text-muted-foreground" />
        <select value={filter} onChange={(e) => { setFilter(e.target.value); void load(kind, q, e.target.value); }}
          aria-label="按分类过滤"
          className="rounded border border-white/10 bg-slate-800 px-2 py-1 text-[11px] text-white">
          <option value="">全部{filters[kind].label}</option>
          {filters[kind].options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <span className="text-[10px] text-muted-foreground">
          {kind === "texts" ? "来源: manual(手动)/agent(自动沉淀)/pdf(管道)" : kind === "concepts" ? "含定义/提出者/演进/边界" : kind === "logics" ? "结构步骤可复用" : "按语义组分组的高级表达"}
        </span>
      </div>

      {/* 录入表单（含 LLM 辅助提取） */}
      {showAdd && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium">录入{({ texts: "文本范例", concepts: "核心概念", logics: "论证逻辑", expressions: "词汇句式" } as Record<Kind, string>)[kind]}</span>
            <span className="text-[10px] text-muted-foreground">* 必填 · 标签/结构 JSON 可留空</span>
          </div>
          {/* LLM 辅助提取 */}
          <div className="mb-2 flex items-start gap-2 rounded border border-dashed border-primary/30 p-2">
            <Sparkles className="mt-1 h-3.5 w-3.5 shrink-0 text-primary" />
            <div className="flex-1">
              <div className="mb-1 text-[10px] text-muted-foreground">粘贴原文 → LLM 自动提取为结构化语料（定义/学者/年份/标签…）</div>
              <div className="flex gap-2">
                <textarea value={extractText} onChange={(e) => setExtractText(e.target.value)} rows={2}
                  placeholder="粘贴论文/专著中的段落…" className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-xs text-white" />
                <button type="button" aria-label="LLM辅助提取" onClick={() => void doExtract(kind)} disabled={extracting}
                  className="shrink-0 rounded-md bg-primary/15 px-3 py-1.5 text-[11px] text-primary hover:bg-primary/25 disabled:opacity-50">
                  {extracting ? "提取中…" : "✨ 提取"}
                </button>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {formFields[kind].map((f) => (
              <div key={f.key} className={f.area ? "col-span-2" : ""}>
                <label className="mb-0.5 block text-[10px] text-muted-foreground">{f.label}</label>
                {f.area ? (
                  <textarea value={form[f.key] || ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    rows={2} placeholder={f.ph} className="w-full rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-xs text-white" />
                ) : (
                  <input value={form[f.key] || ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    placeholder={f.ph} className="w-full rounded-md border border-white/10 bg-slate-800 px-2 py-1 text-xs text-white" />
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" aria-label="保存语料" onClick={() => void add()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary/90">保存入库</button>
            <button type="button" onClick={() => setShowAdd(false)} className="rounded-md bg-muted px-3 py-1.5 text-xs">取消</button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {items.length === 0 && (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            暂无语料 — 点击「录入语料」粘贴原文，或让 Agent 任务自动沉淀
          </div>
        )}
        {kind === "texts" && items.map((t: CorpusText) => (
          <div key={t.id} className="rounded-lg border border-border/50 p-3">
            <div className="mb-1 flex items-center gap-2 text-[10px]">
              <span className={cn("rounded px-1.5 py-0.5 font-medium", t.language === "en" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700")}>{t.language === "en" ? "EN" : "中文"}</span>
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{t.writingModule}</span>
              {t.tags.map((tag: string) => <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{tag}</span>)}
              <span className="ml-auto text-muted-foreground/70">{t.source || ""} · {t.createdBy}</span>
            </div>
            <div className="text-[12px] leading-5 text-foreground/90">{t.text}</div>
            {t.note && <div className="mt-1 text-[10px] text-primary/80">💡 {t.note}</div>}
            <button type="button" aria-label="复制文本范例" onClick={() => copyText(t.text)}
              className="mt-1.5 flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
              <Copy className="h-2.5 w-2.5" /> 复制应用（模仿句式）
            </button>
          </div>
        ))}
        {kind === "concepts" && items.map((c: CorpusConcept) => (
          <div key={c.id} className="rounded-lg border border-border/50 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium">{c.name}</span>
              {c.proposer && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">{c.proposer}{c.year ? ` (${c.year})` : ""}</span>}
              {(c.related || []).map((r2: string) => <span key={r2} className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">↔ {r2}</span>)}
            </div>
            <div className="text-[12px] leading-5 text-foreground/90">{c.definition}</div>
            {(c.evolution || []).length > 0 && (
              <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                {(c.evolution || []).map((e, i) => <div key={i}>📜 {e.year} · {e.scholar}: {e.contribution}</div>)}
              </div>
            )}
            {c.boundary && <div className="mt-1 text-[10px] text-amber-600/80">边界: {c.boundary}</div>}
          </div>
        ))}
        {kind === "logics" && items.map((l: CorpusLogic) => (
          <div key={l.id} className="rounded-lg border border-border/50 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-medium">{l.name}</span>
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700">{l.patternType}</span>
              {l.usageHint && <span className="ml-auto text-[10px] text-muted-foreground">{l.usageHint}</span>}
            </div>
            <div className="mt-1 space-y-0.5">
              {(l.structure || []).map((s) => (
                <div key={s.step} className="flex gap-1.5 text-[11px] leading-4 text-muted-foreground">
                  <span className="shrink-0 text-primary/70">{s.step}.</span>{s.desc}
                </div>
              ))}
            </div>
            {l.example && <div className="mt-1.5 rounded bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">例: {l.example}</div>}
            <button type="button" aria-label="复制论证框架" onClick={() => copyText((l.structure || []).map((s) => s.desc).join(" → "))}
              className="mt-1.5 flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
              <Copy className="h-2.5 w-2.5" /> 复制框架
            </button>
          </div>
        ))}
        {kind === "expressions" && items.map((e: CorpusExpression) => (
          <div key={e.id} className="rounded-lg border border-border/50 p-3">
            <div className="mb-1 flex items-center gap-2 text-[10px]">
              <span className="rounded bg-cyan-100 px-1.5 py-0.5 font-medium text-cyan-700">{e.semanticGroup}</span>
              {e.replaceFor && <span className="text-muted-foreground">替代 "{e.replaceFor}"</span>}
            </div>
            <div className="text-[13px] font-medium text-primary/90">{e.expression}</div>
            {e.zhMeaning && <div className="mt-0.5 text-[10px] text-muted-foreground">{e.zhMeaning}</div>}
            {e.enExample && <div className="mt-1 text-[11px] italic leading-4 text-muted-foreground/80">{e.enExample}</div>}
            <button type="button" aria-label="复制句式表达" onClick={() => copyText(e.expression)}
              className="mt-1.5 flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
              <Copy className="h-2.5 w-2.5" /> 复制句式
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};
