// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// CJournalPanel.tsx — V395-20/21/22: 政经 C 刊科研（马理论选题方法论整合 · 精致版）
// 9 大工具: 四步法选题 / 选题矩阵 / 悖论选题 / 概念命名 / 跨学科 / 模板检测 / 编辑校验 / 外审翻译 / 参考数据
// 方法论来源: 八篇马理论 C 刊选题文章
import { useEffect, useMemo, useState, type FC } from "react";
import { Loader2, BookOpenCheck, Grid3X3, AlertTriangle, BadgeCheck, Library, Target, Sparkles, Wand2, GitMerge, ShieldAlert, MessagesSquare, BookMarked, ArrowRight, TrendingUp, FlaskConical, PenLine, CheckCircle2, XCircle, Layers, Link2, Route, Tags, Scale, Info, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";
import { LlmModelSelector, TASK_ROLES } from "./LlmModelSelector";

const TABS = [
  // V395-31: 刘衍峰式选题方法系统（置顶）
  { id: "liuyanfeng", label: "方法系统", icon: Info, desc: "刘衍峰式: 7特征+5思路+生产系统+告诫" },
  { id: "relational", label: "关系型选题", icon: Link2, desc: "热点A×热点B 关系即论文" },
  { id: "research-line", label: "研究主线", icon: Route, desc: "母题+子问题链条 稳定主线" },
  { id: "research-labels", label: "研究标签", icon: Tags, desc: "3-5核心词反复组合成标签" },
  { id: "scope", label: "尺度检验", icon: Scale, desc: "做窄做深 不建大体系" },
  { id: "series", label: "系列延伸", icon: Layers, desc: "一篇成功不换题 沿系列延伸" },
  // V395-33: 马原理 C 刊六趋势
  { id: "trends", label: "趋势选题", icon: TrendingUp, desc: "六趋势×热点 → 选题生成" },
  // V395-34: 经典马研究六方向
  { id: "classic", label: "经典马研究", icon: BookOpenCheck, desc: "文本阐释→时代化转化 转向诊断" },
  // V395-35: C 刊编辑视角六法
  { id: "editor", label: "编辑视角", icon: MessagesSquare, desc: "六法选题+三标准 编辑审稿思维" },
  // V395-36: 投稿五条军规
  { id: "rules", label: "投稿军规", icon: ShieldAlert, desc: "主线体检+十五五战略+新视角+匹配期刊" },
  // V395-37: 小新学姐 12 条科研经验
  { id: "experience", label: "科研经验", icon: Layers, desc: "对象检验/稿件梯队/代表作/外审/选刊" },
  { id: "fourstep", label: "四步法选题", icon: Target, desc: "热点→对象→理论→实践→机制" },
  { id: "matrix", label: "选题矩阵", icon: Grid3X3, desc: "核心概念×关系对象 系列开发" },
  { id: "paradox", label: "悖论选题", icon: AlertTriangle, desc: "为什么A却B · 张力即问题" },
  { id: "naming", label: "概念命名", icon: Wand2, desc: "现象→理论概念 数字官僚主义式" },
  { id: "cross", label: "跨学科嫁接", icon: GitMerge, desc: "马理论×经济×社会×公管×传播" },
  { id: "template", label: "模板检测", icon: ShieldAlert, desc: "识别价值意蕴/困境/路径模板" },
  { id: "validate", label: "编辑校验", icon: BadgeCheck, desc: "时代紧迫×理论解释×现实指导" },
  { id: "review", label: "外审翻译", icon: MessagesSquare, desc: "审稿意见→本质问题" },
  { id: "paradigm", label: "学者范式", icon: BookMarked, desc: "知网文献→范式提取→写作风格" },
  { id: "reference", label: "接口·期刊·种子", icon: BookMarked, desc: "理论接口表/期刊口味/选题库" },
] as const;

// V395-24: 学者方法类型（动态加载自后端）
interface ScholarMethod {
  id: string;
  scholar: string;
  concept: string;
  method: string;
  detail: string;
  builtin: boolean;
  paradigm?: any;  // V395-25: 写作范式
}

export const CJournalPanel: FC = () => {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("fourstep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 四步法
  const [hotTopic, setHotTopic] = useState("");
  const [method, setMethod] = useState("default");
  const [fourStep, setFourStep] = useState<any>(null);
  // 悖论
  const [phenomenon, setPhenomenon] = useState("");
  const [paradox, setParadox] = useState<any>(null);
  // 矩阵
  const [coreConcept, setCoreConcept] = useState("");
  const [matrix, setMatrix] = useState<any>(null);
  // 命名 / 跨学科 / 模板 / 外审
  const [namingInput, setNamingInput] = useState("");
  const [naming, setNaming] = useState<any>(null);
  const [crossInput, setCrossInput] = useState("");
  const [cross, setCross] = useState<any>(null);
  const [templateTopic, setTemplateTopic] = useState("");
  const [templateResult, setTemplateResult] = useState<any>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewResult, setReviewResult] = useState<any>(null);
  // 编辑校验
  const [checkTopic, setCheckTopic] = useState("");
  const [validation, setValidation] = useState<any>(null);
  // V395-31: 刘衍峰式方法系统
  const [lyfSystem, setLyfSystem] = useState<any>(null);  // 方法系统总览（当前选中的）
  const [lyfSystems, setLyfSystems] = useState<any[]>([]);  // V395-32: 全部方法体系
  const [lyfActiveId, setLyfActiveId] = useState("liuyanfeng");  // V395-32: 当前选中体系
  const [showLyfForm, setShowLyfForm] = useState(false);  // V395-32: 添加/编辑表单
  const [lyfForm, setLyfForm] = useState<any>(null);  // V395-32: 表单内容
  const [relHotA, setRelHotA] = useState("");
  const [relHotB, setRelHotB] = useState("");
  const [relational, setRelational] = useState<any>(null);
  const [linePhenomenon, setLinePhenomenon] = useState("");
  const [researchLine, setResearchLine] = useState<any>(null);
  const [labelFocus, setLabelFocus] = useState("");
  const [researchLabels, setResearchLabels] = useState<any>(null);
  const [scopeTopic, setScopeTopic] = useState("");
  const [scopeResult, setScopeResult] = useState<any>(null);
  const [seriesTitle, setSeriesTitle] = useState("");
  const [seriesPublished, setSeriesPublished] = useState("");
  const [seriesResult, setSeriesResult] = useState<any>(null);
  // V395-33: 马原理 C 刊六趋势
  const [trendSystem, setTrendSystem] = useState<any>(null);  // 六趋势总览
  const [trendId, setTrendId] = useState("classic");  // 选中趋势
  const [trendHot, setTrendHot] = useState("");
  const [trendResult, setTrendResult] = useState<any>(null);
  // V395-34: 经典马研究六方向
  const [classicSystem, setClassicSystem] = useState<any>(null);  // 六方向总览
  const [diagTopic, setDiagTopic] = useState("");
  const [diagResult, setDiagResult] = useState<any>(null);
  const [classicDirId, setClassicDirId] = useState("productive-force");
  const [classicPhenomenon, setClassicPhenomenon] = useState("");
  const [classicResult, setClassicResult] = useState<any>(null);
  // V395-35: 编辑视角六法
  const [editorSystem, setEditorSystem] = useState<any>(null);  // 六法总览
  const [editorMethodId, setEditorMethodId] = useState("question-first");
  const [editorInput, setEditorInput] = useState("");
  const [editorResult, setEditorResult] = useState<any>(null);
  // V395-36: 投稿五条军规
  const [rulesSystem, setRulesSystem] = useState<any>(null);  // 军规总览
  const [mainlineTopic, setMainlineTopic] = useState("");
  const [mainlineResult, setMainlineResult] = useState<any>(null);
  const [strategyName, setStrategyName] = useState("高水平社会主义市场经济体制");
  const [strategyPhenomenon, setStrategyPhenomenon] = useState("");
  const [strategyResult, setStrategyResult] = useState<any>(null);
  const [angleTopic, setAngleTopic] = useState("");
  const [angleResult, setAngleResult] = useState<any>(null);
  // V395-37: 小新学姐 12 条经验
  const [xiaoxinSystem, setXiaoxinSystem] = useState<any>(null);  // 12条总览
  const [specTopic, setSpecTopic] = useState("");  // 对象特殊性检验
  const [specResult, setSpecResult] = useState<any>(null);
  const [ladderItems, setLadderItems] = useState("");  // 稿件梯队
  const [ladderResult, setLadderResult] = useState<any>(null);
  const [selTopic, setSelTopic] = useState("");  // 写前选刊
  const [selResult, setSelResult] = useState<any>(null);
  const [repPapers, setRepPapers] = useState("");  // 代表作诊断
  const [repResult, setRepResult] = useState<any>(null);
  // 参考数据
  const [interfaces, setInterfaces] = useState<any[]>([]);
  const [seeds, setSeeds] = useState<string[]>([]);
  const [journals, setJournals] = useState<any[]>([]);
  // V395-38: 期刊动态库（80本真实目录 + 更新管道）
  const [journalLevel, setJournalLevel] = useState("全部");
  const [journalUpdates, setJournalUpdates] = useState<any[]>([]);
  const [activeJournalUpdatesId, setActiveJournalUpdatesId] = useState("");
  const [syncInfo, setSyncInfo] = useState("");
  // V395-24: 学者库（动态）
  const [scholars, setScholars] = useState<ScholarMethod[]>([]);
  // V395-24: 学者录入表单
  const [showScholarForm, setShowScholarForm] = useState(false);
  const [scholarForm, setScholarForm] = useState({ id: "", scholar: "", concept: "", method: "", detail: "" });
  // V395-25: 学者范式提取
  const [paradigmScholarId, setParadigmScholarId] = useState("");
  const [paradigmDir, setParadigmDir] = useState("");
  const [paradigmScan, setParadigmScan] = useState<any[]>([]);
  const [paradigm, setParadigm] = useState<any>(null);
  // V395-29: 数据源（pg 三库 / dir md目录）
  const [paradigmSource, setParadigmSource] = useState<"pg" | "dir">("pg");
  // V395-30: 含知识图谱数据（Graphiti/Cognee, 服务不可用自动降级）
  const [paradigmGraph, setParadigmGraph] = useState(true);
  // V395-30: 图谱数据预览/状态
  const [paradigmGraphInfo, setParadigmGraphInfo] = useState("");
  // V395-26: 范式提取模型（plan 角色, 声明于 state 区保证编译稳定性）
  const [paradigmModel, setParadigmModel] = useState("");
  // V395-26: 当前选中学者的已提取范式
  const selectedScholar = scholars.find((s) => s.id === paradigmScholarId);

  useEffect(() => {
    void fetch("/api/cjournal/interfaces").then((r) => r.json()).then((d) => setInterfaces(d.interfaces || [])).catch(() => {});
    void fetch("/api/cjournal/seeds").then((r) => r.json()).then((d) => setSeeds(d.seeds || [])).catch(() => {});
    // V395-38: 期刊动态库（80本真实目录: 南核/北核/C扩）
    void fetch("/api/cjournal/journals").then((r) => r.json()).then((d) => setJournals(d.journals || [])).catch(() => {});
    // V395-31/32: 方法体系（列表 + 当前选中）
    void fetch("/api/cjournal/liuyanfeng-system").then((r) => r.json()).then((d) => {
      setLyfSystems(d.systems || []);
      setLyfSystem(d.system || null);
    }).catch(() => {});
    // V395-33: 马原理 C 刊六趋势
    void fetch("/api/cjournal/marx-trends").then((r) => r.json()).then((d) => setTrendSystem(d.system || null)).catch(() => {});
    // V395-34: 经典马研究六方向
    void fetch("/api/cjournal/classic-marx").then((r) => r.json()).then((d) => setClassicSystem(d.system || null)).catch(() => {});
    // V395-35: 编辑视角六法
    void fetch("/api/cjournal/editor-system").then((r) => r.json()).then((d) => setEditorSystem(d.system || null)).catch(() => {});
    // V395-36: 投稿五条军规
    void fetch("/api/cjournal/rules-system").then((r) => r.json()).then((d) => setRulesSystem(d.system || null)).catch(() => {});
    // V395-37: 小新学姐 12 条经验
    void fetch("/api/cjournal/xiaoxin-system").then((r) => r.json()).then((d) => setXiaoxinSystem(d.system || null)).catch(() => {});
    void loadScholars();
  }, []);

  const loadScholars = async () => {
    try {
      const r = await fetch("/api/cjournal/scholars");
      setScholars((await r.json()).scholars || []);
    } catch { /* 学者加载失败 */ }
  };
  const saveScholar = async () => {
    if (!scholarForm.id.trim() || !scholarForm.scholar.trim() || !scholarForm.concept.trim() || !scholarForm.method.trim()) {
      setError("id/学者名/方法概念/方法框架 必填");
      return;
    }
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/cjournal/scholars", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scholarForm),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setScholarForm({ id: "", scholar: "", concept: "", method: "", detail: "" });
      setShowScholarForm(false);
      await loadScholars();
    } catch (e: any) { setError(e.message || "保存失败"); }
    finally { setBusy(false); }
  };
  const removeScholar = async (id: string) => {
    if (!confirm("确定删除该学者方法？")) return;
    const r = await fetch(`/api/cjournal/scholars/${id}`, { method: "DELETE" });
    const d = await r.json();
    if (d.error) { setError(d.error); return; }
    await loadScholars();
  };

  const call = async (url: string, body: Record<string, string>) => {
    setBusy(true); setError("");
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.error) { setError(d.error); return null; }
      return d.result;
    } catch (e: any) { setError(e.message || "调用失败"); return null; }
    finally { setBusy(false); }
  };

  const stats = useMemo(() => [
    { label: "理论接口", value: interfaces.length, icon: BookOpenCheck, color: "from-blue-500 to-cyan-400" },
    { label: "种子选题", value: seeds.length, icon: Sparkles, color: "from-violet-500 to-fuchsia-400" },
    { label: "期刊画像", value: journals.length, icon: Library, color: "from-amber-500 to-orange-400" },
    { label: "选题工具", value: TABS.length, icon: Wand2, color: "from-emerald-500 to-teal-400" },
  ], [interfaces.length, seeds.length, journals.length]);

  const activeTab = TABS.find((t) => t.id === tab)!;
  const input = "min-w-0 flex-1 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-xs shadow-sm outline-none transition-all placeholder:text-muted-foreground/40 focus:border-primary/50 focus:ring-2 focus:ring-primary/20";
  const btn = "flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-xs font-medium text-white shadow-[0_0_14px_hsl(270_70%_55%/0.35)] transition-all duration-300 hover:shadow-[0_0_20px_hsl(270_70%_55%/0.55)] hover:brightness-110 active:scale-[0.97] disabled:opacity-40 disabled:shadow-none";

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        {/* ═══ Hero 区 ═══ */}
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-background/60 to-violet-500/10 p-5">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-violet-500/10 blur-3xl" />
          <div className="absolute -bottom-20 -left-10 h-40 w-40 rounded-full bg-blue-500/10 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-[0_0_16px_hsl(270_70%_55%/0.4)]">
                <PenLine className="h-5 w-5" />
              </div>
              <div>
                <h2 className="bg-gradient-to-r from-violet-300 via-foreground to-blue-300 bg-clip-text text-xl font-bold text-transparent">政经 C 刊科研</h2>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-white/10 bg-background/50 px-3 py-2 text-[11px] leading-5 text-muted-foreground backdrop-blur">
              <span className="font-medium text-primary">核心公式</span>：经典理论 × 时代问题 × 中国实践 × 具体机制
              <span className="mx-2 text-border">|</span>
              <span className="font-medium text-primary">方法</span>：四步法 / 选题矩阵 / 悖论 / 命名 / 跨学科 / 编辑校验
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="group relative overflow-hidden rounded-xl border border-border/50 bg-background/50 p-3 backdrop-blur transition-all hover:border-primary/40 hover:shadow-lg">
                  <div className={cn("absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r", s.color)} />
                  <div className="flex items-center gap-2">
                    <div className={cn("flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br text-white", s.color)}>
                      <s.icon className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <div className="text-lg font-bold leading-none">{s.value}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">{s.label}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ═══ 工具 Tab（统一金色系: 未激活=琥珀描边浅底, 激活=金色渐变实底）═══ */}
        <div className="flex flex-wrap gap-1.5 rounded-xl border border-border/50 bg-background/40 p-1.5 backdrop-blur">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} title={t.desc}
              className={cn("flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-[11px] font-medium transition-all",
                tab === t.id
                  ? "border-amber-300/70 bg-gradient-to-r from-amber-400 to-orange-400 text-amber-950 shadow-[0_0_12px_hsl(40_90%_55%/0.45)]"
                  : "border-amber-400/30 bg-amber-400/5 text-amber-200/80 hover:border-amber-400/60 hover:bg-amber-400/15 hover:text-amber-100")}>
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>

        {/* 当前工具说明 */}
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/25 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
          <activeTab.icon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="font-medium text-primary">{activeTab.label}</span>
          <span>{activeTab.desc}</span>
        </div>

        {error && <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}

        {/* ═══ 四步法 ═══ */}
        {tab === "fourstep" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-background/40 p-4 shadow-sm">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input value={hotTopic} onChange={(e) => setHotTopic(e.target.value)} placeholder="输入时代热点/政策概念（如 人工智能、算力、耐心资本）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && hotTopic.trim()) void runFourStep(); }} />
                <button type="button" onClick={() => void runFourStep()} disabled={busy || !hotTopic.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成选题
                </button>
              </div>
              {/* 三学者方法选择（V395-24: 动态学者库） */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {scholars.map((m) => (
                  <button key={m.id} type="button" onClick={() => setMethod(m.id)} title={m.concept}
                    className={cn("rounded-lg border px-2.5 py-1.5 text-[10px] transition-all",
                      method === m.id ? "border-violet-400/60 bg-violet-500/15 text-violet-300 shadow-[0_0_10px_hsl(270_70%_55%/0.2)]" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                    <span className="font-medium">{m.scholar.replace(/（.*?）/, "")}</span>
                    <span className="ml-1 text-[9px] opacity-70">{m.concept}</span>
                  </button>
                ))}
                {/* V395-24: 添加学者按钮 */}
                <button type="button" onClick={() => setShowScholarForm(true)}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-primary/40 px-2.5 py-1.5 text-[10px] text-primary hover:bg-primary/5">
                  ＋ 添加学者
                </button>
              </div>
              {/* V395-23/24: 学者方法论详解表（动态学者库, 可添加） */}
              <div className="mt-3 overflow-hidden rounded-xl border border-violet-400/20">
                <div className="flex items-center gap-2 border-b border-violet-400/20 bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 px-3 py-2">
                  <BookOpenCheck className="h-3.5 w-3.5 text-violet-400" />
                  <span className="text-[11px] font-medium">学者方法论库（{scholars.length}）</span>
                  <span className="text-[9px] text-muted-foreground">选择方法 → 生成对应风格选题</span>
                </div>
                <div className="grid gap-px bg-border/30 md:grid-cols-3">
                  {scholars.map((m) => (
                    <button key={m.id} type="button" onClick={() => setMethod(m.id)}
                      className={cn("bg-background/60 p-2.5 text-left transition-all hover:bg-violet-500/5",
                        method === m.id && "bg-violet-500/10 ring-1 ring-inset ring-violet-400/40")}>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-semibold">{m.scholar}</span>
                        {!m.builtin && (
                          <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[8px] text-amber-400" onClick={(e) => { e.stopPropagation(); void removeScholar(m.id); }}>✕</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] font-medium text-violet-300">{m.concept}</div>
                      <div className="mt-1 text-[9px] leading-4 text-muted-foreground">{m.method}</div>
                    </button>
                  ))}
                </div>
              </div>
              {/* V395-24: 学者录入表单 */}
              {showScholarForm && (
                <div className="mt-3 rounded-xl border border-violet-400/30 bg-violet-500/5 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                    <span className="text-[11px] font-medium">录入新学者方法</span>
                    <button type="button" onClick={() => setShowScholarForm(false)} className="ml-auto text-[10px] text-muted-foreground hover:text-foreground">✕</button>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    <input value={scholarForm.id} onChange={(e) => setScholarForm({ ...scholarForm, id: e.target.value })} placeholder="方法 id（如 wangxiaoming）" className={input} />
                    <input value={scholarForm.scholar} onChange={(e) => setScholarForm({ ...scholarForm, scholar: e.target.value })} placeholder="学者名（如 王晓明（人民大学））" className={input} />
                    <input value={scholarForm.concept} onChange={(e) => setScholarForm({ ...scholarForm, concept: e.target.value })} placeholder="方法概念（如 现象要理论化）" className={input} />
                    <input value={scholarForm.method} onChange={(e) => setScholarForm({ ...scholarForm, method: e.target.value })} placeholder="方法框架（如 现实现象→范畴重释→机制重构）" className={input} />
                  </div>
                  <textarea value={scholarForm.detail} onChange={(e) => setScholarForm({ ...scholarForm, detail: e.target.value })}
                    placeholder="方法详解（文章原文级, 将注入选题生成 prompt）"
                    className="mt-1.5 min-h-20 w-full rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-xs shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
                  <div className="mt-2 flex gap-1.5">
                    <button type="button" onClick={() => void saveScholar()} disabled={busy}
                      className="flex items-center gap-1 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 py-1.5 text-[10px] font-medium text-white hover:brightness-110 disabled:opacity-40">
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} 保存学者
                    </button>
                    <button type="button" onClick={() => setShowScholarForm(false)}
                      className="rounded-xl border border-border px-3 py-1.5 text-[10px] text-muted-foreground hover:bg-accent">取消</button>
                  </div>
                </div>
              )}
            </div>
            {fourStep && (
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-4">
                  <div className="absolute right-3 top-3 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-medium text-emerald-400">四步法生成</div>
                  <div className="text-[10px] font-medium text-emerald-500">选题</div>
                  <div className="mt-1 text-base font-semibold leading-6">《{fourStep.topic}》</div>
                </div>
                {/* V395-23: 三学者方法详解（文章原文级详细呈现） */}
                {fourStep.methodDetail && (
                  <div className="relative overflow-hidden rounded-xl border border-violet-400/25 bg-gradient-to-br from-violet-500/8 via-background/50 to-fuchsia-500/8 p-4">
                    <div className="flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/25 to-fuchsia-500/25">
                        <BookOpenCheck className="h-3.5 w-3.5 text-violet-300" />
                      </div>
                      <div>
                        <span className="text-[11px] font-semibold text-violet-300">{fourStep.methodScholar}</span>
                        <span className="ml-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-violet-300">{fourStep.methodConcept}</span>
                      </div>
                    </div>
                    <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{fourStep.methodDetail}</div>
                  </div>
                )}
                {/* 步骤条 */}
                <div className="grid gap-2 md:grid-cols-5">
                  {fourStep.steps?.map((s: any, i: number) => (
                    <div key={i} className="group relative rounded-xl border border-border/50 bg-background/40 p-3 transition-all hover:border-primary/40 hover:shadow-md">
                      <div className="flex items-center gap-1.5">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[9px] font-bold text-white">{i + 1}</span>
                        <span className="text-[10px] font-medium text-primary">{s.step}</span>
                      </div>
                      <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{s.content}</div>
                    </div>
                  ))}
                </div>
                {fourStep.candidates?.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground">备选题目</div>
                    <div className="space-y-1.5">
                      {fourStep.candidates.map((c: string, i: number) => (
                        <div key={i} className="group flex items-center gap-2 rounded-lg border border-border/40 px-2.5 py-1.5 text-xs transition-all hover:border-primary/40 hover:bg-primary/5">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400" />
                          <span className="min-w-0 flex-1 truncate">《{c}》</span>
                          <div className="flex shrink-0 gap-1">
                            <button type="button" onClick={() => { setCheckTopic(c); setTab("template"); }} title="模板检测"
                              className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-amber-500">模板</button>
                            <button type="button" onClick={() => { setCheckTopic(c); setTab("validate"); }} title="编辑校验"
                              className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-emerald-500">校验</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ 选题矩阵 ═══ */}
        {tab === "matrix" && (
          <div className="space-y-3">
            <ToolInput icon={Grid3X3} title="选题矩阵" desc="核心概念 × 关系对象 → 连续开发（刘衍峰式）"
              placeholder="输入核心概念（如 人工智能、数字资本）" value={coreConcept} onChange={setCoreConcept}
              onRun={() => void runMatrix()} busy={busy} btnLabel="生成矩阵" />
            {matrix && (
              <div className="space-y-3">
                {matrix.motherTopic && (
                  <div className="relative overflow-hidden rounded-xl border border-purple-400/30 bg-gradient-to-r from-purple-500/10 via-background/60 to-fuchsia-500/10 p-4">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-purple-400" />
                      <span className="text-[11px] font-medium text-purple-400">研究主线（母题）</span>
                    </div>
                    <div className="mt-1.5 text-sm font-medium">{matrix.motherTopic}</div>
                  </div>
                )}
                <div className="grid gap-2 md:grid-cols-2">
                  {matrix.matrix?.map((m: any, i: number) => (
                    <div key={i} className="group rounded-xl border border-border/50 bg-background/40 p-3 transition-all hover:border-primary/40 hover:shadow-md">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">{m.dimension}</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
                      </div>
                      <div className="mt-1.5 text-xs leading-5">《{m.topic}》</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ 悖论 ═══ */}
        {tab === "paradox" && (
          <div className="space-y-3">
            <ToolInput icon={AlertTriangle} title="悖论选题" desc="'为什么 A 却 B'——张力即问题"
              placeholder="输入现象（如 数字政务效率提升却增加基层负担）" value={phenomenon} onChange={setPhenomenon}
              onRun={() => void runParadox()} busy={busy} btnLabel="生成悖论" />
            {paradox && (
              <div className="space-y-2">
                <div className="rounded-xl border border-amber-400/30 bg-gradient-to-br from-amber-500/10 via-background/60 to-orange-500/10 p-4">
                  <div className="text-[10px] font-medium text-amber-500">悖论问题</div>
                  <div className="mt-1 text-sm font-semibold">{paradox.paradox}</div>
                </div>
                <div className="rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-4">
                  <div className="text-[10px] font-medium text-emerald-500">论文题目</div>
                  <div className="mt-1 text-sm font-semibold">《{paradox.topic}》</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ 概念命名 ═══ */}
        {tab === "naming" && (
          <div className="space-y-3">
            <ToolInput icon={Wand2} title="概念命名" desc="现实事件 → 典型现象 → 理论概念（数字官僚主义式）"
              placeholder="输入现象（如 平台软件持续塑造用户行为偏好）" value={namingInput} onChange={setNamingInput}
              onRun={() => void runNaming()} busy={busy} btnLabel="命名" />
            {naming && (
              <div className="space-y-2">
                <div className="relative overflow-hidden rounded-xl border border-violet-400/30 bg-gradient-to-br from-violet-500/15 via-background/60 to-fuchsia-500/15 p-4 text-center">
                  <div className="absolute left-3 top-3 rounded-full bg-violet-500/15 px-2 py-0.5 text-[9px] text-violet-300">理论概念</div>
                  <div className="mt-2 text-2xl font-bold tracking-wide">「{naming.concept}」</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">一看到标题，就知道在解释什么新问题</div>
                </div>
                <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                  <div className="text-[11px] font-medium text-muted-foreground">三步转换推导</div>
                  <div className="mt-1 text-xs leading-5">{naming.reasoning}</div>
                </div>
                {naming.candidates?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {naming.candidates.map((c: string, i: number) => (
                      <span key={i} className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-2.5 py-1 text-[11px] text-violet-300">「{c}」</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ 跨学科 ═══ */}
        {tab === "cross" && (
          <div className="space-y-3">
            <ToolInput icon={GitMerge} title="跨学科嫁接" desc="马理论×经济×社会×公管×传播 选题空间"
              placeholder="输入核心概念（如 算法、人工智能、数字平台）" value={crossInput} onChange={setCrossInput}
              onRun={() => void runCross()} busy={busy} btnLabel="嫁接" />
            {cross?.matrix && (
              <div className="grid gap-2 md:grid-cols-2">
                {cross.matrix.map((m: any, i: number) => (
                  <div key={i} className="group rounded-xl border border-border/50 bg-background/40 p-3 transition-all hover:border-primary/40 hover:shadow-md">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-md bg-gradient-to-r from-blue-500/15 to-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-400">{m.discipline}</span>
                      <GitMerge className="h-3 w-3 text-muted-foreground/40" />
                    </div>
                    <div className="mt-1.5 text-xs leading-5">《{m.topic}》</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ 模板检测 ═══ */}
        {tab === "template" && (
          <div className="space-y-3">
            <ToolInput icon={ShieldAlert} title="模板反例检测" desc="识别'价值意蕴/困境/路径'四段模板（只有新对象没有新问题）"
              placeholder="输入题目（如 人工智能赋能高质量发展的价值意蕴与实践路径）" value={templateTopic} onChange={setTemplateTopic}
              onRun={() => void runTemplateCheck()} busy={busy} btnLabel="检测" instant />
            {templateResult && (
              <div className={cn("rounded-xl border p-4 text-xs leading-5",
                templateResult.isTemplate
                  ? "border-red-400/40 bg-gradient-to-br from-red-500/10 via-background/60 to-rose-500/10 text-red-500"
                  : "border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 text-emerald-600")}>
                <div className="flex items-center gap-2">
                  {templateResult.isTemplate ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                  <span className="font-medium">{templateResult.isTemplate ? "模板化风险" : "结构健康"}</span>
                </div>
                <div className="mt-1.5">{templateResult.advice}</div>
                {templateResult.hits?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {templateResult.hits.map((h: string, i: number) => (
                      <span key={i} className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] text-red-400">命中 {h}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ 编辑校验 ═══ */}
        {tab === "validate" && (
          <div className="space-y-3">
            <ToolInput icon={BadgeCheck} title="编辑三标准校验" desc="时代紧迫性 × 理论解释力 × 现实指导价值"
              placeholder="输入选题标题（如 人工智能时代劳动形态变迁的政经分析）" value={checkTopic} onChange={setCheckTopic}
              onRun={() => void runValidate()} busy={busy} btnLabel="校验" />
            {validation && (
              <div className="space-y-2">
                <div className={cn("rounded-xl border p-4 text-sm font-medium",
                  validation.verdict?.includes("通过") ? "border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 to-teal-500/10 text-emerald-600"
                    : validation.verdict?.includes("不建议") ? "border-red-400/40 bg-gradient-to-br from-red-500/10 to-rose-500/10 text-red-500"
                    : "border-amber-400/30 bg-gradient-to-br from-amber-500/10 to-orange-500/10 text-amber-600")}>
                  {validation.verdict}
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  {validation.checks?.map((c: any, i: number) => (
                    <div key={i} className="rounded-xl border border-border/50 bg-background/40 p-3">
                      <div className="flex items-center gap-1.5">
                        {c.passed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                        <span className="text-[11px] font-medium">{c.standard}</span>
                      </div>
                      <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{c.feedback}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ 外审翻译 ═══ */}
        {tab === "review" && (
          <div className="space-y-3">
            <ToolInput icon={MessagesSquare} title="外审意见翻译" desc="把审稿意见翻译成本质问题（'创新不足'→你与现有研究有何不同？）"
              placeholder="粘贴外审意见（如 本文创新不足、理论深度不够）" value={reviewComment} onChange={setReviewComment}
              onRun={() => void runReviewTranslate()} busy={busy} btnLabel="翻译" />
            {reviewResult && (
              <div className="space-y-2">
                <div className="rounded-xl border border-amber-400/30 bg-gradient-to-br from-amber-500/10 via-background/60 to-orange-500/10 p-4">
                  <div className="text-[10px] font-medium text-amber-500">本质问题</div>
                  <div className="mt-1 text-xs leading-5">{reviewResult.translation}</div>
                </div>
                <div className="rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-4">
                  <div className="text-[10px] font-medium text-emerald-500">修改动作</div>
                  <div className="mt-1 text-xs leading-5">{reviewResult.action}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ V395-31: 刘衍峰式方法系统总览（7特征+5思路+生产系统+告诫）═══ */}
        {tab === "liuyanfeng" && lyfSystem && (
          <div className="space-y-3">
            {/* V395-32: 方法体系切换器（可添加/替换/删除） */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="flex items-center gap-2">
                <BookOpenCheck className="h-4 w-4 text-primary" />
                <span className="text-[11px] font-medium">方法体系库（{lyfSystems.length}）</span>
                <span className="text-[9px] text-muted-foreground">选择体系 → 查看其选题方法; 可添加自己的体系</span>
                <button type="button" onClick={() => { setLyfForm({ id: "", name: "", features: [], ideas: [], productionChain: [], warnings: [] }); setShowLyfForm(true); }}
                  className="ml-auto flex items-center gap-1 rounded-lg border border-dashed border-primary/40 px-2.5 py-1.5 text-[10px] text-primary hover:bg-primary/5">
                  ＋ 添加方法体系
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {lyfSystems.map((s: any) => (
                  <div key={s.id} className="flex items-center gap-1">
                    <button type="button" onClick={() => void switchLyfSystem(s.id)}
                      className={cn("rounded-lg border px-2.5 py-1.5 text-[10px] transition-all",
                        lyfActiveId === s.id ? "border-violet-400/60 bg-violet-500/15 text-violet-300 shadow-[0_0_10px_hsl(270_70%_55%/0.2)]" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                      <span className="font-medium">{s.name}</span>
                      {s.builtin && <span className="ml-1 text-[8px] opacity-60">内置</span>}
                    </button>
                    {!s.builtin && (
                      <div className="flex gap-0.5">
                        <button type="button" title="编辑"
                          onClick={() => { setLyfForm({ id: s.id, name: s.name, features: s.features, ideas: s.ideas, productionChain: s.productionChain, warnings: s.warnings }); setShowLyfForm(true); }}
                          className="rounded border border-border/50 px-1.5 py-1 text-[9px] text-muted-foreground hover:text-primary">✎</button>
                        <button type="button" title="删除" onClick={() => void deleteLyfSystem(s.id)}
                          className="rounded border border-border/50 px-1.5 py-1 text-[9px] text-muted-foreground hover:text-red-400">✕</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {/* V395-32: 添加/编辑表单 */}
              {showLyfForm && lyfForm && (
                <div className="mt-3 rounded-xl border border-violet-400/30 bg-violet-500/5 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                    <span className="text-[11px] font-medium">{lyfForm.id ? "编辑方法体系" : "添加新方法体系"}</span>
                    <button type="button" onClick={() => setShowLyfForm(false)} className="ml-auto text-[10px] text-muted-foreground hover:text-foreground">✕</button>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    <input value={lyfForm.id} onChange={(e) => setLyfForm({ ...lyfForm, id: e.target.value })} placeholder="体系 id（如 wangxiaoming）" className={input} disabled={!!lyfForm.id && lyfSystems.find((s: any) => s.id === lyfForm.id)?.builtin} />
                    <input value={lyfForm.name} onChange={(e) => setLyfForm({ ...lyfForm, name: e.target.value })} placeholder="体系名称（如 王晓明式选题方法）" className={input} />
                  </div>
                  <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                    <div>
                      <div className="mb-0.5 text-[9px] text-muted-foreground">特征（每行一条: 标题 | 说明 | 示例）</div>
                      <textarea value={(lyfForm.features || []).map((f: any) => `${f.title}|${f.desc}|${f.example}`).join("\n")}
                        onChange={(e) => setLyfForm({ ...lyfForm, features: e.target.value.split("\n").filter((l: string) => l.trim()).map((l: string) => { const [title, desc, example] = l.split("|"); return { title: (title || "").trim(), desc: (desc || "").trim(), example: (example || "").trim() }; }) })}
                        placeholder={"追政策但不止于政策解释|热点之间的关系才是论文|新质生产力 × 内卷式竞争\n给现象命名|现实事件→理论概念|数字官僚主义"} className="min-h-20 w-full rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
                    </div>
                    <div>
                      <div className="mb-0.5 text-[9px] text-muted-foreground">思路（每行一条: 标题 | 说明）</div>
                      <textarea value={(lyfForm.ideas || []).map((f: any) => `${f.title}|${f.desc}`).join("\n")}
                        onChange={(e) => setLyfForm({ ...lyfForm, ideas: e.target.value.split("\n").filter((l: string) => l.trim()).map((l: string) => { const [title, desc] = l.split("|"); return { title: (title || "").trim(), desc: (desc || "").trim() }; }) })}
                        placeholder={"政策解读型|中央文件出现即跟进\n现象命名型|从现实事件提炼概念"} className="min-h-20 w-full rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
                    </div>
                  </div>
                  <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                    <div>
                      <div className="mb-0.5 text-[9px] text-muted-foreground">生产链（每行一条: 环节 | 说明）</div>
                      <textarea value={(lyfForm.productionChain || []).map((f: any) => `${f.step}|${f.detail}`).join("\n")}
                        onChange={(e) => setLyfForm({ ...lyfForm, productionChain: e.target.value.split("\n").filter((l: string) => l.trim()).map((l: string) => { const [step, detail] = l.split("|"); return { step: (step || "").trim(), detail: (detail || "").trim() }; }) })}
                        placeholder={"热点观察|持续追踪政策新现象\n理论接口|热点找经典理论"} className="min-h-16 w-full rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
                    </div>
                    <div>
                      <div className="mb-0.5 text-[9px] text-muted-foreground">告诫（每行一条: 文本 | danger/key）</div>
                      <textarea value={(lyfForm.warnings || []).map((f: any) => `${f.text}|${f.type || "key"}`).join("\n")}
                        onChange={(e) => setLyfForm({ ...lyfForm, warnings: e.target.value.split("\n").filter((l: string) => l.trim()).map((l: string) => { const [text, type] = l.split("|"); return { text: (text || "").trim(), type: (type || "key").trim() === "danger" ? "danger" : "key" }; }) })}
                        placeholder={"不要只有热点没有问题|danger\n3-5个核心关键词反复组合|key"} className="min-h-16 w-full rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
                    </div>
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <button type="button" onClick={() => void saveLyfSystem()} disabled={busy}
                      className="flex items-center gap-1 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 py-1.5 text-[10px] font-medium text-white hover:brightness-110 disabled:opacity-40">
                      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} 保存体系
                    </button>
                    <button type="button" onClick={() => setShowLyfForm(false)}
                      className="rounded-xl border border-border px-3 py-1.5 text-[10px] text-muted-foreground hover:bg-accent">取消</button>
                  </div>
                </div>
              )}
            </div>
            {/* 7 大特征 */}
            <div className="overflow-hidden rounded-xl border border-primary/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-primary/15 bg-gradient-to-r from-primary/10 to-fuchsia-500/10 px-3 py-2">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] font-medium">{lyfSystems.find((s: any) => s.id === lyfActiveId)?.name || "选题方法"} · 特征（{lyfSystem.features?.length || 0} 个）</span>
              </div>
              <div className="grid gap-px bg-border/30 md:grid-cols-2">
                {lyfSystem.features?.map((f: any, i: number) => (
                  <div key={i} className="bg-background/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[9px] font-bold text-white">{i + 1}</span>
                      <span className="text-[11px] font-semibold">{f.title}</span>
                    </div>
                    <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{f.desc}</div>
                    <div className="mt-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-300">例：{f.example}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 5 种思路 */}
            <div className="overflow-hidden rounded-xl border border-sky-400/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-sky-400/15 bg-gradient-to-r from-sky-500/10 to-cyan-500/10 px-3 py-2">
                <Wand2 className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-[11px] font-medium">选题思路（{lyfSystem.ideas?.length || 0} 种）</span>
              </div>
              <div className="grid gap-px bg-border/30 sm:grid-cols-2 md:grid-cols-5">
                {lyfSystem.ideas?.map((s: any, i: number) => (
                  <div key={i} className="bg-background/60 p-2.5">
                    <div className="text-[10px] font-semibold text-sky-300">{s.title}</div>
                    <div className="mt-0.5 text-[9px] leading-4 text-muted-foreground">{s.desc}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* 选题生产系统 */}
            <div className="overflow-hidden rounded-xl border border-emerald-400/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-emerald-400/15 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 px-3 py-2">
                <Route className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-[11px] font-medium">选题生产系统（{lyfSystem.productionChain?.length || 0} 环核心链条）</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 p-3">
                {lyfSystem.productionChain?.map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2.5 py-1.5">
                      <div className="text-[10px] font-medium text-emerald-300">{i + 1}. {c.step}</div>
                      <div className="mt-0.5 max-w-[160px] text-[8px] leading-3 text-muted-foreground">{c.detail}</div>
                    </div>
                    {i < (lyfSystem.productionChain?.length || 0) - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-emerald-400/50" />}
                  </div>
                ))}
              </div>
            </div>
            {/* 关键告诫 */}
            <div className="overflow-hidden rounded-xl border border-amber-400/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-amber-400/15 bg-gradient-to-r from-amber-500/10 to-orange-500/10 px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-[11px] font-medium">关键告诫（{lyfSystem.warnings?.length || 0} 条）</span>
              </div>
              <div className="space-y-1.5 p-3">
                {lyfSystem.warnings?.map((w: any, i: number) => (
                  <div key={i} className={cn("rounded-lg border px-3 py-2 text-[11px] leading-5",
                    w.type === "danger" ? "border-red-400/25 bg-red-500/5 text-red-300" : "border-emerald-400/25 bg-emerald-500/5 text-emerald-300")}>
                    {w.type === "danger" ? <ShieldAlert className="mr-1.5 inline h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" />}
                    {w.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══ V395-31: 关系型选题（热点A×热点B）═══ */}
        {tab === "relational" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-background/40 p-4 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Link2 className="h-4 w-4 text-violet-400" />
                <div>
                  <div className="text-sm font-medium">关系型选题</div>
                  <div className="text-[10px] text-muted-foreground">追政策但不止于政策解释 — 热点之间的关系才是论文（新质生产力×内卷式竞争）</div>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input value={relHotA} onChange={(e) => setRelHotA(e.target.value)} placeholder="热点 A（如 新质生产力）" className={input} />
                <input value={relHotB} onChange={(e) => setRelHotB(e.target.value)} placeholder="热点 B（如 内卷式竞争, 留空自动选）" className={input} />
                <button type="button" onClick={() => void runRelational()} disabled={busy || !relHotA.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成关系选题
                </button>
              </div>
            </div>
            {relational && (
              <div className="space-y-2">
                <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-4">
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-emerald-400" />
                    <span className="text-[11px] font-medium text-emerald-400">关系命题</span>
                    <span className="ml-auto rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] text-emerald-300">{relational.relation}</span>
                  </div>
                  <div className="mt-2 text-base font-semibold leading-6">《{relational.topic}》</div>
                  <div className="mt-1.5 text-[10px] text-muted-foreground">机制：{relational.mechanism}</div>
                </div>
                {relational.steps?.length > 0 && (
                  <div className="grid gap-2 md:grid-cols-3">
                    {relational.steps.map((s: any, i: number) => (
                      <div key={i} className="rounded-xl border border-border/50 bg-background/40 p-3">
                        <div className="flex items-center gap-1.5">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[9px] font-bold text-white">{i + 1}</span>
                          <span className="text-[10px] font-medium text-primary">{s.step}</span>
                        </div>
                        <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{s.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ V395-31: 研究主线（母题+子问题链条）═══ */}
        {tab === "research-line" && (
          <div className="space-y-3">
            <ToolInput icon={Route} title="研究主线设计" desc="稳定研究主线 — 一个母题 + 子问题链条, 每篇推进一环（数字技术→资本逻辑→劳动控制→时间规训）"
              placeholder="输入现象起点（如 数字零工经济、平台劳动）" value={linePhenomenon} onChange={setLinePhenomenon}
              onRun={() => void runResearchLine()} busy={busy} btnLabel="设计主线" />
            {researchLine && (
              <div className="space-y-2">
                {researchLine.motherTopic && (
                  <div className="relative overflow-hidden rounded-xl border border-purple-400/30 bg-gradient-to-r from-purple-500/10 via-background/60 to-fuchsia-500/10 p-4">
                    <div className="text-[10px] font-medium text-purple-400">母题（研究主线）</div>
                    <div className="mt-1 text-sm font-semibold">{researchLine.motherTopic}</div>
                  </div>
                )}
                {researchLine.chain?.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {researchLine.chain.map((c: any, i: number) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <div className="rounded-lg border border-violet-400/25 bg-violet-500/10 px-2.5 py-2 text-center">
                          <div className="text-[10px] font-medium text-violet-300">{c.node}</div>
                          <div className="mt-0.5 max-w-[140px] text-[8px] leading-3 text-muted-foreground">{c.question}</div>
                        </div>
                        {i < researchLine.chain.length - 1 && <ArrowRight className="h-3 w-3 shrink-0 text-violet-400/50" />}
                      </div>
                    ))}
                  </div>
                )}
                {researchLine.matrix?.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground">沿主线的系列论文</div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {researchLine.matrix.map((m: any, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 px-2.5 py-2 text-xs">
                          <span className="mr-1.5 rounded bg-purple-500/15 px-1 py-0.5 text-[9px] text-purple-300">{m.dimension}</span>
                          《{m.topic}》
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {researchLine.advice && (
                  <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-3 text-[11px] leading-5 text-amber-300">
                    💡 开发建议：{researchLine.advice}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ V395-31: 研究标签（3-5 核心关键词反复组合）═══ */}
        {tab === "research-labels" && (
          <div className="space-y-3">
            <ToolInput icon={Tags} title="研究标签生成" desc="3-5 个长期核心关键词反复组合 — 形成你在学术共同体的辨识度标签"
              placeholder="输入研究领域/兴趣（如 数字劳动与平台资本）" value={labelFocus} onChange={setLabelFocus}
              onRun={() => void runResearchLabels()} busy={busy} btnLabel="生成标签" />
            {researchLabels && (
              <div className="space-y-2">
                {researchLabels.labels?.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground">核心关键词（研究标签）</div>
                    <div className="flex flex-wrap gap-1.5">
                      {researchLabels.labels.map((l: any, i: number) => (
                        <div key={i} title={l.why} className="group relative cursor-help rounded-lg border border-violet-400/30 bg-violet-500/10 px-2.5 py-1.5">
                          <span className="text-[11px] font-medium text-violet-300">{l.keyword}</span>
                          <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden w-44 -translate-x-1/2 rounded-lg border border-border bg-background p-2 text-[9px] leading-3 text-muted-foreground shadow-lg group-hover:block">
                            {l.why}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {researchLabels.combinations?.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground">关键词两两组合 → 选题</div>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {researchLabels.combinations.map((c: any, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 px-2.5 py-2 text-xs">
                          <span className="mr-1.5 rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] text-emerald-300">{c.combo}</span>
                          《{c.topic}》
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {researchLabels.advice && (
                  <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-3 text-[11px] leading-5 text-amber-300">
                    💡 标签定位：{researchLabels.advice}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ V395-31: 尺度检验（做窄做深）═══ */}
        {tab === "scope" && (
          <div className="space-y-3">
            <ToolInput icon={Scale} title="题目尺度检验" desc="做窄做深 — 不做《新时代马政经体系建构研究》; 一个机制问题+一个理论接口+一个具体场景"
              placeholder="输入论文题目（如 新时代马克思主义政治经济学理论体系建构研究）" value={scopeTopic} onChange={setScopeTopic}
              onRun={() => void runScopeCheck()} busy={busy} btnLabel="检验" instant />
            {scopeResult && (
              <div className={cn("rounded-xl border p-4", scopeResult.tooBroad ? "border-red-400/30 bg-gradient-to-br from-red-500/10 via-background/60 to-orange-500/10" : "border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10")}>
                <div className={cn("text-[11px] font-medium", scopeResult.tooBroad ? "text-red-400" : "text-emerald-500")}>
                  {scopeResult.tooBroad ? <XCircle className="mr-1.5 inline h-4 w-4" /> : <CheckCircle2 className="mr-1.5 inline h-4 w-4" />}
                  {scopeResult.tooBroad ? "尺度过大" : "尺度适中"}
                </div>
                {scopeResult.reasons?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {scopeResult.reasons.map((r: string, i: number) => (
                      <div key={i} className="text-[11px] text-red-300">• {r}</div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{scopeResult.advice}</div>
                {scopeResult.narrowed?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="text-[10px] font-medium text-muted-foreground">收窄建议：</div>
                    {scopeResult.narrowed.map((n: string, i: number) => (
                      <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-1.5 text-[10px] text-muted-foreground">→ {n}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ V395-31: 系列延伸（一篇成功不换题）═══ */}
        {tab === "series" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-background/40 p-4 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Layers className="h-4 w-4 text-violet-400" />
                <div>
                  <div className="text-sm font-medium">系列延伸</div>
                  <div className="text-[10px] text-muted-foreground">一篇成功不换题 — 沿研究主线推进下一篇（读者认知/审稿人印象/理论纵深都在累积）</div>
                </div>
              </div>
              <div className="grid gap-2">
                <input value={seriesTitle} onChange={(e) => setSeriesTitle(e.target.value)} placeholder="现有论文题目（如 数字零工弹性劳动的自由时间现象）" className={input} />
                <input value={seriesPublished} onChange={(e) => setSeriesPublished(e.target.value)} placeholder="已发论文（可选, 如 《算法管理重构平台劳动时间的政治经济学逻辑》）" className={input} />
                <button type="button" onClick={() => void runSeriesExtend()} disabled={busy || !seriesTitle.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成系列延伸
                </button>
              </div>
            </div>
            {seriesResult && (
              <div className="space-y-2">
                <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-4">
                  <div className="text-[10px] font-medium text-emerald-400">延伸方向</div>
                  <div className="mt-0.5 text-xs">{seriesResult.extension}</div>
                  <div className="mt-2 text-[10px] font-medium text-emerald-400">下一篇题目</div>
                  <div className="mt-1 text-base font-semibold leading-6">《{seriesResult.nextTopic}》</div>
                </div>
                {seriesResult.seriesPlan?.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground">系列规划（按顺序写）</div>
                    <div className="space-y-1.5">
                      {seriesResult.seriesPlan.map((s: any, i: number) => (
                        <div key={i} className="flex items-center gap-2 rounded-lg border border-border/40 px-2.5 py-2 text-xs">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-[9px] font-bold text-white">{s.order || i + 1}</span>
                          《{s.topic}》
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {seriesResult.advice && (
                  <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-3 text-[11px] leading-5 text-amber-300">
                    💡 {seriesResult.advice}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ═══ V395-33: 马原理 C 刊六趋势选题 ═══ */}
        {tab === "trends" && trendSystem && (
          <div className="space-y-3">
            {/* 六趋势选择器 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                <span className="text-[11px] font-medium">马原理 C 刊选题六大趋势</span>
                <span className="text-[9px] text-muted-foreground">选趋势 → 输入热点 → 按趋势要领生成选题</span>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3">
                {trendSystem.trends?.map((t: any) => (
                  <button key={t.id} type="button" onClick={() => setTrendId(t.id)}
                    className={cn("rounded-xl border p-2.5 text-left transition-all",
                      trendId === t.id ? "border-amber-400/60 bg-amber-400/10 shadow-[0_0_10px_hsl(40_90%_55%/0.2)]" : "border-border/40 hover:border-primary/40")}>
                    <div className="flex items-center gap-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{t.key}</span>
                      <span className={cn("text-[11px] font-medium", trendId === t.id ? "text-amber-300" : "")}>{t.title}</span>
                    </div>
                    <div className="mt-1 text-[9px] leading-3.5 text-muted-foreground">{t.desc}</div>
                    <div className="mt-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[8px] text-amber-300/80">例：{t.example}</div>
                  </button>
                ))}
              </div>
              {/* 热点输入 + 生成 */}
              <div className="mt-2.5 flex gap-2">
                <input value={trendHot} onChange={(e) => setTrendHot(e.target.value)} placeholder="输入热点/方向（如 新质生产力、AI劳动、数字资本、共同富裕…）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && trendHot.trim()) void runTrendTopic(); }} />
                <button type="button" onClick={() => void runTrendTopic()} disabled={busy || !trendHot.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成选题
                </button>
              </div>
            </div>
            {/* 生成结果 */}
            {trendResult && (
              <div className="space-y-2">
                <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-4">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">{trendResult.trendTitle}</span>
                    <span className="text-[10px] text-muted-foreground">趋势选题生成</span>
                  </div>
                  <div className="mt-2 text-base font-semibold leading-6">《{trendResult.topic}》</div>
                  {trendResult.reasoning && <div className="mt-1 text-[10px] text-muted-foreground">理由：{trendResult.reasoning}</div>}
                </div>
                {trendResult.steps?.length > 0 && (
                  <div className="grid gap-2 md:grid-cols-4">
                    {trendResult.steps.map((s: any, i: number) => (
                      <div key={i} className="rounded-xl border border-border/50 bg-background/40 p-3">
                        <div className="flex items-center gap-1.5">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{i + 1}</span>
                          <span className="text-[10px] font-medium text-primary">{s.step}</span>
                        </div>
                        <div className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{s.content}</div>
                      </div>
                    ))}
                  </div>
                )}
                {trendResult.candidates?.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3">
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground">备选题目</div>
                    <div className="space-y-1.5">
                      {trendResult.candidates.map((c: string, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 px-2.5 py-1.5 text-xs">《{c}》</div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* 三规律 + 2026 布局 */}
            <div className="grid gap-3 md:grid-cols-2">
              {/* 三条选题规律 */}
              <div className="overflow-hidden rounded-xl border border-sky-400/20 bg-background/40 shadow-sm">
                <div className="flex items-center gap-2 border-b border-sky-400/15 bg-gradient-to-r from-sky-500/10 to-cyan-500/10 px-3 py-2">
                  <BookOpenCheck className="h-3.5 w-3.5 text-sky-400" />
                  <span className="text-[11px] font-medium">三条选题基本规律</span>
                </div>
                <div className="space-y-1.5 p-3">
                  {trendSystem.laws?.map((l: any, i: number) => (
                    <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-2">
                      <div className="text-[10px] font-semibold text-sky-300">{i + 1}. {l.title}</div>
                      <div className="mt-0.5 text-[9px] leading-4 text-muted-foreground">{l.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* 2026 布局清单 */}
              <div className="overflow-hidden rounded-xl border border-emerald-400/20 bg-background/40 shadow-sm">
                <div className="flex items-center gap-2 border-b border-emerald-400/15 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 px-3 py-2">
                  <Target className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-[11px] font-medium">2026 布局清单（5 重点 + 5 关注）</span>
                </div>
                <div className="space-y-2 p-3">
                  <div>
                    <div className="mb-1 text-[10px] font-semibold text-emerald-300">★ 重点布局</div>
                    {trendSystem.layout2026?.focus?.map((f: string, i: number) => (
                      <div key={i} className="rounded border border-emerald-400/20 bg-emerald-500/5 px-2 py-1 text-[9px] leading-4 text-muted-foreground">★ {f}</div>
                    ))}
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] font-semibold text-amber-300">○ 重点关注</div>
                    {trendSystem.layout2026?.watch?.map((w: string, i: number) => (
                      <div key={i} className="rounded border border-amber-400/20 bg-amber-500/5 px-2 py-1 text-[9px] leading-4 text-muted-foreground">○ {w}</div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══ V395-34: 经典马研究六方向（转向诊断 + 方向深化）═══ */}
        {tab === "classic" && classicSystem && (
          <div className="space-y-3">
            {/* 核心转向 */}
            <div className="relative overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-r from-primary/10 via-background/60 to-fuchsia-500/10 p-4">
              <div className="text-[10px] font-medium text-primary">核心转向（《马克思主义研究》26年第7期）</div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
                <span className="rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1 text-red-300 line-through decoration-red-400/50">{classicSystem.coreShift?.from}</span>
                <ArrowRight className="h-4 w-4 text-primary" />
                <span className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">{classicSystem.coreShift?.to}</span>
              </div>
              <div className="mt-2 text-[11px] leading-5 text-muted-foreground">{classicSystem.coreShift?.desc}</div>
            </div>
            {/* 六方向对照卡 */}
            <div className="grid gap-1.5 md:grid-cols-2">
              {classicSystem.directions?.map((d: any) => (
                <div key={d.id} className="rounded-xl border border-border/50 bg-background/40 p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{d.key}</span>
                    <span className="text-[11px] font-semibold">{d.title}</span>
                    <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[8px] font-medium",
                      d.importance === "潜力最大" ? "bg-fuchsia-500/15 text-fuchsia-300" : d.importance === "重点" ? "bg-amber-400/15 text-amber-300" : "bg-sky-500/15 text-sky-300")}>{d.importance}</span>
                  </div>
                  <div className="mt-1.5 space-y-1 text-[9px] leading-4">
                    <div className="text-red-400/70 line-through decoration-red-400/40">✗ {d.traditional}</div>
                    <div className="text-emerald-300">✓ {d.deep}</div>
                  </div>
                  <div className="mt-1.5 space-y-0.5">
                    {d.examples?.map((ex: string, i: number) => (
                      <div key={i} className="truncate rounded bg-background/60 px-1.5 py-0.5 text-[8px] text-muted-foreground">《{ex}》</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {/* 转向诊断 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-400" />
                <span className="text-[11px] font-medium">转向诊断</span>
                <span className="text-[9px] text-muted-foreground">输入题目 → 判断是否停在"文本阐释" → 给出时代化深化版</span>
              </div>
              <div className="flex gap-2">
                <input value={diagTopic} onChange={(e) => setDiagTopic(e.target.value)} placeholder="输入论文题目（如 马克思劳动价值论研究、马克思资本批判思想研究）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && diagTopic.trim()) void runClassicDiagnose(); }} />
                <button type="button" onClick={() => void runClassicDiagnose()} disabled={busy || !diagTopic.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 诊断
                </button>
              </div>
              {diagResult && (
                <div className="mt-2 space-y-1.5">
                  <div className={cn("rounded-lg border px-3 py-2 text-[11px] leading-5",
                    diagResult.stillExegesis ? "border-red-400/25 bg-red-500/5 text-red-300" : "border-emerald-400/25 bg-emerald-500/5 text-emerald-300")}>
                    {diagResult.stillExegesis ? <XCircle className="mr-1.5 inline h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" />}
                    {diagResult.stillExegesis ? "仍停留在文本阐释" : "已实现时代化转化"}
                    {diagResult.signal && <span className="ml-2 text-[9px] opacity-80">（{diagResult.signal}）</span>}
                  </div>
                  {diagResult.matchedDirection && (
                    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-[10px] text-muted-foreground">命中的方向：{diagResult.matchedDirection}</div>
                  )}
                  {diagResult.deepVersion && (
                    <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/5 px-3 py-2">
                      <div className="text-[9px] font-medium text-emerald-400">深化版题目</div>
                      <div className="mt-0.5 text-xs font-medium">《{diagResult.deepVersion}》</div>
                      {diagResult.mechanism && <div className="mt-1 text-[9px] text-muted-foreground">应回答的机制：{diagResult.mechanism}</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 方向深化生成 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Wand2 className="h-4 w-4 text-violet-400" />
                <span className="text-[11px] font-medium">方向深化生成</span>
                <span className="text-[9px] text-muted-foreground">选方向 → 输入当代现象 → 按深化写法生成</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {classicSystem.directions?.map((d: any) => (
                  <button key={d.id} type="button" onClick={() => setClassicDirId(d.id)}
                    className={cn("rounded-lg border px-2 py-1 text-[9px] transition-all",
                      classicDirId === d.id ? "border-amber-400/60 bg-amber-400/10 text-amber-300" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                    {d.key}. {d.title}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input value={classicPhenomenon} onChange={(e) => setClassicPhenomenon(e.target.value)} placeholder="输入当代现象（如 大模型训练数据、平台零工、AI换脸…）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && classicPhenomenon.trim()) void runClassicDirection(); }} />
                <button type="button" onClick={() => void runClassicDirection()} disabled={busy || !classicPhenomenon.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成
                </button>
              </div>
              {classicResult && (
                <div className="mt-2 space-y-1.5">
                  <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">{classicResult.directionTitle}</span>
                      <span className="text-[9px] text-muted-foreground">深化写法：{classicResult.deepApproach}</span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold leading-6">《{classicResult.topic}》</div>
                    {classicResult.reasoning && <div className="mt-1 text-[9px] text-muted-foreground">深化理由：{classicResult.reasoning}</div>}
                  </div>
                  {classicResult.candidates?.length > 0 && (
                    <div className="space-y-1">
                      {classicResult.candidates.map((c: string, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-1.5 text-[10px]">《{c}》</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 三条规律 */}
            <div className="overflow-hidden rounded-xl border border-sky-400/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-sky-400/15 bg-gradient-to-r from-sky-500/10 to-cyan-500/10 px-3 py-2">
                <BookOpenCheck className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-[11px] font-medium">三条规律（与前两篇完全一致）</span>
              </div>
              <div className="space-y-1.5 p-3">
                {classicSystem.laws?.map((l: any, i: number) => (
                  <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-2">
                    <div className="text-[10px] font-semibold text-sky-300">{i + 1}. {l.title}</div>
                    <div className="mt-0.5 text-[9px] leading-4 text-muted-foreground">{l.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══ V395-35: C 刊编辑视角六法（六法总览 + ①②④生成 + 复用跳转）═══ */}
        {tab === "editor" && editorSystem && (
          <div className="space-y-3">
            {/* 六法总览 */}
            <div className="overflow-hidden rounded-xl border border-primary/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-primary/15 bg-gradient-to-r from-primary/10 to-fuchsia-500/10 px-3 py-2">
                <MessagesSquare className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] font-medium">C 刊编辑视角 · 选题六法</span>
                <span className="text-[9px] text-muted-foreground">"我和几位 C 刊编辑交流"——编辑审稿标准倒推选题</span>
              </div>
              <div className="grid gap-px bg-border/30 md:grid-cols-2">
                {editorSystem.methods?.map((m: any) => (
                  <div key={m.id} className="bg-background/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{m.key}</span>
                      <span className="text-[11px] font-semibold">{m.title}</span>
                      {m.reuse ? (
                        <span className="ml-auto rounded bg-sky-500/15 px-1.5 py-0.5 text-[8px] text-sky-300">已复用现有工具</span>
                      ) : (
                        <span className="ml-auto rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[8px] text-fuchsia-300">本页可生成</span>
                      )}
                    </div>
                    <div className="mt-1 text-[9px] leading-4 text-muted-foreground">{m.core}</div>
                    <div className="mt-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[8px] text-amber-300/80">例：{m.example}</div>
                    {m.reuse ? (
                      <button type="button" onClick={() => setTab(m.reuse.tab)}
                        className="mt-1.5 rounded-lg border border-sky-400/30 bg-sky-500/10 px-2 py-1 text-[9px] text-sky-300 hover:bg-sky-500/20">
                        → 去 {m.reuse.label}（{m.reuse.desc}）
                      </button>
                    ) : (
                      <button type="button" onClick={() => { setEditorMethodId(m.id); setEditorInput(m.key === 1 ? "" : m.key === 2 ? "中国式现代化" : "AI推动产业升级"); }}
                        className="mt-1.5 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 px-2 py-1 text-[9px] text-fuchsia-300 hover:bg-fuchsia-500/20">
                        用此方法生成 ↓
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* ①②④ 生成器 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-fuchsia-400" />
                <span className="text-[11px] font-medium">编辑视角生成</span>
                <span className="text-[9px] text-muted-foreground">当前方法：{editorSystem.methods?.find((m: any) => m.id === editorMethodId)?.title}</span>
              </div>
              <div className="flex gap-2">
                <input value={editorInput} onChange={(e) => setEditorInput(e.target.value)}
                  placeholder={editorMethodId === "question-first" ? "输入宽泛/领域式题目（如 人工智能发展研究）" : editorMethodId === "national-proposition" ? "输入重大命题（如 中国式现代化、共同富裕）" : "输入政策热点话语（如 AI推动产业升级）"}
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && editorInput.trim()) void runEditorTopic(); }} />
                <button type="button" onClick={() => void runEditorTopic()} disabled={busy || !editorInput.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成
                </button>
              </div>
              {editorResult && (
                <div className="mt-2 space-y-1.5">
                  <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-medium text-fuchsia-300">{editorResult.methodTitle}</span>
                      <span className="text-[9px] text-muted-foreground">编辑视角生成</span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold leading-6">《{editorResult.topic}》</div>
                    {editorResult.reasoning && <div className="mt-1 text-[9px] text-muted-foreground">推演：{editorResult.reasoning}</div>}
                  </div>
                  {editorResult.steps?.length > 0 && (
                    <div className="grid gap-2 md:grid-cols-3">
                      {editorResult.steps.map((s: any, i: number) => (
                        <div key={i} className="rounded-xl border border-border/50 bg-background/40 p-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{i + 1}</span>
                            <span className="text-[10px] font-medium text-primary">{s.step}</span>
                          </div>
                          <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{s.content}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {editorResult.candidates?.length > 0 && (
                    <div className="space-y-1">
                      {editorResult.candidates.map((c: string, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-1.5 text-[10px]">《{c}》</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 编辑三标准 */}
            <div className="overflow-hidden rounded-xl border border-emerald-400/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-emerald-400/15 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 px-3 py-2">
                <BadgeCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-[11px] font-medium">编辑三标准（审稿人问的三个问题）</span>
                <button type="button" onClick={() => setTab("validate")}
                  className="ml-auto rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[9px] text-emerald-300 hover:bg-emerald-500/20">
                  → 去编辑校验打分
                </button>
              </div>
              <div className="grid gap-px bg-border/30 sm:grid-cols-3">
                {editorSystem.standards?.map((s: any, i: number) => (
                  <div key={i} className="bg-background/60 p-3">
                    <div className="text-[10px] font-semibold text-emerald-300">{i + 1}. {s.name}</div>
                    <div className="mt-0.5 text-[10px] text-amber-300/90">问：{s.question}</div>
                    <div className="mt-0.5 text-[9px] leading-4 text-muted-foreground">通过 = {s.pass}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══ V395-36: C 刊投稿五条军规 ═══ */}
        {tab === "rules" && rulesSystem && (
          <div className="space-y-3">
            {/* 五军规总览 */}
            <div className="overflow-hidden rounded-xl border border-primary/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-primary/15 bg-gradient-to-r from-primary/10 to-fuchsia-500/10 px-3 py-2">
                <ShieldAlert className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] font-medium">C 刊投稿五条军规</span>
                <span className="text-[9px] text-muted-foreground">投稿经验要点 · 期刊要生存, 优先录用能带来下载量引用量的选题</span>
              </div>
              <div className="grid gap-px bg-border/30 md:grid-cols-2">
                {rulesSystem.rules?.map((r: any) => (
                  <div key={r.id} className="bg-background/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{r.key}</span>
                      <span className="text-[11px] font-semibold">{r.title}</span>
                      {r.reuse ? (
                        <span className="ml-auto rounded bg-sky-500/15 px-1.5 py-0.5 text-[8px] text-sky-300">已复用现有工具</span>
                      ) : (
                        <span className="ml-auto rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[8px] text-fuchsia-300">本页可生成</span>
                      )}
                    </div>
                    <div className="mt-1 text-[9px] leading-4 text-muted-foreground">{r.core}</div>
                    <div className="mt-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[8px] text-amber-300/80">例：{r.example}</div>
                    {r.reuse ? (
                      <button type="button" onClick={() => setTab(r.reuse.tab)}
                        className="mt-1.5 rounded-lg border border-sky-400/30 bg-sky-500/10 px-2 py-1 text-[9px] text-sky-300 hover:bg-sky-500/20">
                        → 去 {r.reuse.label}（{r.reuse.desc}）
                      </button>
                    ) : (
                      <button type="button" onClick={() => {
                        if (r.id === "mainline") setMainlineTopic("");
                        if (r.id === "national-strategy") setStrategyPhenomenon("");
                        if (r.id === "new-angle") setAngleTopic("");
                      }} className="mt-1.5 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 px-2 py-1 text-[9px] text-fuchsia-300 hover:bg-fuchsia-500/20">
                        用此军规生成 ↓
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* 军规① 主线体检 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 text-emerald-400" />
                <span className="text-[11px] font-medium">军规① 主线体检</span>
                <span className="text-[9px] text-muted-foreground">核心范畴：{rulesSystem.mainlineCore?.zhuhu?.join(" / ")}</span>
              </div>
              <div className="flex gap-2">
                <input value={mainlineTopic} onChange={(e) => setMainlineTopic(e.target.value)} placeholder="输入论文题目（如 数字资本主义批判、算法治理的西方理论应用）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && mainlineTopic.trim()) void runMainlineCheck(); }} />
                <button type="button" onClick={() => void runMainlineCheck()} disabled={busy || !mainlineTopic.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 体检
                </button>
              </div>
              {mainlineResult && (
                <div className="mt-2 space-y-1.5">
                  <div className={cn("rounded-lg border px-3 py-2 text-[11px] leading-5",
                    mainlineResult.onMainline ? "border-emerald-400/25 bg-emerald-500/5 text-emerald-300" : "border-red-400/25 bg-red-500/5 text-red-300")}>
                    {mainlineResult.onMainline ? <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" /> : <XCircle className="mr-1.5 inline h-3.5 w-3.5" />}
                    {mainlineResult.onMainline ? "主线内" : "有偏离风险"}：{mainlineResult.assessment}
                  </div>
                  {mainlineResult.coreCategory && (
                    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-[10px] text-muted-foreground">命中核心范畴：{mainlineResult.coreCategory}</div>
                  )}
                  {mainlineResult.activation && (
                    <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/5 px-3 py-1.5 text-[10px] text-emerald-300">激活建议：{mainlineResult.activation}</div>
                  )}
                </div>
              )}
            </div>
            {/* 军规② 十五五国家战略 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Target className="h-4 w-4 text-amber-400" />
                <span className="text-[11px] font-medium">军规② 回应"十五五"国家战略</span>
                <span className="text-[9px] text-muted-foreground">理论解释现实 + 现实反哺理论 双向循环</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rulesSystem.nationalStrategy?.map((s: any) => (
                  <button key={s.name} type="button" onClick={() => setStrategyName(s.name)} title={s.theory}
                    className={cn("rounded-lg border px-2 py-1 text-[9px] transition-all",
                      strategyName === s.name ? "border-amber-400/60 bg-amber-400/10 text-amber-300" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                    {s.name}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input value={strategyPhenomenon} onChange={(e) => setStrategyPhenomenon(e.target.value)} placeholder="具体现象/场景（可选, 如 全国统一大市场建设中的地方保护）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && strategyName.trim()) void runNationalStrategy(); }} />
                <button type="button" onClick={() => void runNationalStrategy()} disabled={busy || !strategyName.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成
                </button>
              </div>
              {strategyResult && (
                <div className="mt-2 space-y-1.5">
                  <div className="relative overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/10 via-background/60 to-teal-500/10 p-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">{strategyResult.strategy}</span>
                      <span className="text-[9px] text-muted-foreground">理论接口：{strategyResult.theory}</span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold leading-6">《{strategyResult.topic}》</div>
                    {strategyResult.bidirectional && (
                      <div className="mt-1 rounded bg-background/50 px-2 py-1 text-[9px] leading-4 text-muted-foreground">双向循环：{strategyResult.bidirectional}</div>
                    )}
                  </div>
                  {strategyResult.candidates?.length > 0 && (
                    <div className="space-y-1">
                      {strategyResult.candidates.map((c: string, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-1.5 text-[10px]">《{c}》</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 军规④ 新视角 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Wand2 className="h-4 w-4 text-fuchsia-400" />
                <span className="text-[11px] font-medium">军规④ 新视角重构</span>
                <span className="text-[9px] text-muted-foreground">人文经济学标识性概念 / 中国人经济的人民性 / 数智时代领导力</span>
              </div>
              <div className="flex gap-2">
                <input value={angleTopic} onChange={(e) => setAngleTopic(e.target.value)} placeholder="输入老问题/老选题（如 平台经济的资本逻辑批判）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && angleTopic.trim()) void runNewAngle(); }} />
                <button type="button" onClick={() => void runNewAngle()} disabled={busy || !angleTopic.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 重构
                </button>
              </div>
              {angleResult && (
                <div className="mt-2 space-y-1.5">
                  <div className="relative overflow-hidden rounded-xl border border-fuchsia-400/30 bg-gradient-to-br from-fuchsia-500/10 via-background/60 to-purple-500/10 p-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-medium text-fuchsia-300">新视角：{angleResult.angle}</span>
                      <span className="text-[9px] text-muted-foreground">来源：{angleResult.source}</span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold leading-6">《{angleResult.topic}》</div>
                    {angleResult.reasoning && <div className="mt-1 text-[9px] text-muted-foreground">重构理由：{angleResult.reasoning}</div>}
                  </div>
                  {angleResult.candidates?.length > 0 && (
                    <div className="space-y-1">
                      {angleResult.candidates.map((c: string, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-2.5 py-1.5 text-[10px]">《{c}》</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ V395-37: 小新学姐 12 条科研生产系统经验 ═══ */}
        {tab === "experience" && xiaoxinSystem && (
          <div className="space-y-3">
            {/* 12 条总览 */}
            <div className="overflow-hidden rounded-xl border border-primary/20 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-primary/15 bg-gradient-to-r from-primary/10 to-fuchsia-500/10 px-3 py-2">
                <Layers className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] font-medium">{xiaoxinSystem.summary}</span>
              </div>
              <div className="grid gap-px bg-border/30 md:grid-cols-2">
                {xiaoxinSystem.items?.map((it: any) => (
                  <div key={it.id} className="bg-background/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-400 text-[9px] font-bold text-amber-950">{it.key}</span>
                      <span className="text-[11px] font-semibold">{it.title}</span>
                      {it.reuse ? (
                        <span className="ml-auto rounded bg-sky-500/15 px-1.5 py-0.5 text-[8px] text-sky-300">可跳转</span>
                      ) : (
                        <span className="ml-auto rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[8px] text-fuchsia-300">本页工具</span>
                      )}
                    </div>
                    <div className="mt-1 text-[9px] leading-4 text-muted-foreground">{it.desc}</div>
                    {it.reuse ? (
                      <button type="button" onClick={() => setTab(it.reuse.tab)}
                        className="mt-1.5 rounded-lg border border-sky-400/30 bg-sky-500/10 px-2 py-1 text-[9px] text-sky-300 hover:bg-sky-500/20">
                        → 去 {it.reuse.label}
                      </button>
                    ) : (
                      <button type="button" onClick={() => {
                        if (it.id === "representative") setRepPapers("");
                        if (it.id === "pre-select-journal") setSelTopic("");
                      }} className="mt-1.5 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 px-2 py-1 text-[9px] text-fuchsia-300 hover:bg-fuchsia-500/20">
                        用此工具 ↓
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* 对象特殊性检验（V395-21 已有, 补前端入口） */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-violet-400" />
                <span className="text-[11px] font-medium">对象特殊性检验</span>
                <span className="text-[9px] text-muted-foreground">换掉研究对象小标题还成立 = 模板化（深地经济→极端环境/地下通信; 智算→异构算力/算力交易）</span>
              </div>
              <div className="flex gap-2">
                <input value={specTopic} onChange={(e) => setSpecTopic(e.target.value)} placeholder="输入论文题目（如 智算经济发展的政治经济学分析）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && specTopic.trim()) void runSpecCheck(); }} />
                <button type="button" onClick={() => void runSpecCheck()} disabled={busy || !specTopic.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 检验
                </button>
              </div>
              {specResult && (
                <div className="mt-2 space-y-1.5">
                  <div className={cn("rounded-lg border px-3 py-2 text-[11px] leading-5",
                    specResult.generic ? "border-red-400/25 bg-red-500/5 text-red-300" : "border-emerald-400/25 bg-emerald-500/5 text-emerald-300")}>
                    {specResult.generic ? <XCircle className="mr-1.5 inline h-3.5 w-3.5" /> : <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" />}
                    {specResult.generic ? "框架模板化（换对象小标题仍成立）" : "对象特殊性充分"}
                    {specResult.assessment && <span className="ml-2 text-[9px] opacity-80">（{specResult.assessment}）</span>}
                  </div>
                  {specResult.specificFeatures?.length > 0 && (
                    <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-1.5">
                      <div className="text-[9px] font-medium text-muted-foreground">该对象应有的特殊性维度（写框架时嵌入）：</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {specResult.specificFeatures.map((f: string, i: number) => (
                          <span key={i} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[9px] text-violet-300">{f}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* 稿件梯队（V395-21 已有, 补前端入口） */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-sky-400" />
                <span className="text-[11px] font-medium">稿件梯队管理</span>
                <span className="text-[9px] text-muted-foreground">一篇在写/在改/在投/在审 + 分层（冲击型/稳健型/阶段成果）</span>
              </div>
              <textarea value={ladderItems} onChange={(e) => setLadderItems(e.target.value)}
                placeholder={"每行一条: 标题|阶段|层级\n数字劳动时间规训的政治经济学分析|writing|impact\n平台算法与劳动过程重构|revising|stable\n县域数字治理的政经逻辑|submitting|stage"}
                className="min-h-16 w-full rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
              <div className="mt-1.5 flex items-center gap-1.5">
                <button type="button" onClick={() => void runLadder()} disabled={busy || !ladderItems.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 生成梯队
                </button>
                <span className="text-[8px] text-muted-foreground">阶段: writing/revising/submitting/reviewing/published · 层级: impact/stable/stage</span>
              </div>
              {ladderResult && (
                <div className="mt-2 space-y-1.5">
                  <div className="rounded-lg border border-sky-400/25 bg-sky-500/5 px-3 py-2 text-[11px] text-sky-300">{ladderResult.overview}</div>
                  {ladderResult.tips?.length > 0 && ladderResult.tips.map((t: string, i: number) => (
                    <div key={i} className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-300">💡 {t}</div>
                  ))}
                </div>
              )}
            </div>
            {/* 写前选刊 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Library className="h-4 w-4 text-amber-400" />
                <span className="text-[11px] font-medium">写前选刊</span>
                <span className="text-[9px] text-muted-foreground">边写边想投哪：期刊重点/题目结构/理论vs实证/是否发过类似主题</span>
              </div>
              <div className="flex gap-2">
                <input value={selTopic} onChange={(e) => setSelTopic(e.target.value)} placeholder="输入论文题目（如 高水平社会主义市场经济体制的政经阐释）"
                  className={input} onKeyDown={(e) => { if (e.key === "Enter" && selTopic.trim()) void runJournalSelection(); }} />
                <button type="button" onClick={() => void runJournalSelection()} disabled={busy || !selTopic.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 选刊
                </button>
              </div>
              {selResult && (
                <div className="mt-2 space-y-1.5">
                  <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/5 px-3 py-2">
                    <div className="text-[9px] font-medium text-emerald-400">匹配期刊</div>
                    <div className="mt-0.5 text-xs font-semibold">{selResult.matchedJournal}</div>
                    {selResult.matchReason && <div className="mt-0.5 text-[9px] text-muted-foreground">{selResult.matchReason}</div>}
                  </div>
                  {selResult.focusPoints?.length > 0 && (
                    <div className="space-y-1">
                      {selResult.focusPoints.map((f: any, i: number) => (
                        <div key={i} className="rounded-lg border border-border/40 bg-background/50 px-3 py-1.5">
                          <span className="text-[9px] font-medium text-amber-300">{f.point}：</span>
                          <span className="text-[9px] text-muted-foreground">{f.assessment}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {selResult.advice && (
                    <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-300">💡 {selResult.advice}</div>
                  )}
                </div>
              )}
            </div>
            {/* 代表作意识诊断 */}
            <div className="rounded-xl border border-border/60 bg-background/40 p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <Target className="h-4 w-4 text-fuchsia-400" />
                <span className="text-[11px] font-medium">代表作意识诊断</span>
                <span className="text-[9px] text-muted-foreground">稳定产出 + 一两篇冲代表作</span>
              </div>
              <textarea value={repPapers} onChange={(e) => setRepPapers(e.target.value)}
                placeholder={"每行一篇论文题目（已发/在写均可）\n数字劳动时间规训的政治经济学分析\n平台算法与劳动过程重构"}
                className="min-h-12 w-full rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-[10px] shadow-sm outline-none placeholder:text-muted-foreground/40 focus:border-primary/50" />
              <div className="mt-1.5">
                <button type="button" onClick={() => void runRepresentative()} disabled={busy || !repPapers.trim()} className={btn}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 诊断
                </button>
              </div>
              {repResult && (
                <div className="mt-2 space-y-1.5">
                  <div className={cn("rounded-lg border px-3 py-2 text-[11px] leading-5",
                    repResult.hasRepresentative ? "border-emerald-400/25 bg-emerald-500/5 text-emerald-300" : "border-amber-400/25 bg-amber-500/5 text-amber-300")}>
                    {repResult.hasRepresentative ? <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" /> : <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />}
                    {repResult.hasRepresentative ? "代表作结构健康" : "缺少代表作结构"}
                    {repResult.assessment && <span className="ml-2 text-[9px] opacity-80">（{repResult.assessment}）</span>}
                  </div>
                  {repResult.gap && <div className="rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-[10px] text-muted-foreground">差距：{repResult.gap}</div>}
                  {repResult.advice && <div className="rounded-lg border border-amber-400/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-300">💡 {repResult.advice}</div>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══ 学者范式提取（V395-25）═══ */}
        {tab === "paradigm" && (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/60 bg-background/40 p-4 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20">
                  <BookMarked className="h-4 w-4 text-violet-400" />
                </div>
                <div>
                  <div className="text-sm font-medium">学者文献范式提取</div>
                  <div className="text-[10px] text-muted-foreground">知网下载 → PDF转md → 入库 → 从文献提炼写作范式 → 回填学者库</div>
                </div>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-[1fr_1fr_auto]">
                <select value={paradigmScholarId} onChange={(e) => setParadigmScholarId(e.target.value)} className={input}>
                  <option value="">选择学者…</option>
                  {scholars.filter((s) => s.id !== "default").map((s) => (
                    <option key={s.id} value={s.id}>{s.scholar}{s.paradigm ? "（已提取范式）" : ""}</option>
                  ))}
                </select>
                <input value={paradigmDir} onChange={(e) => setParadigmDir(e.target.value)} placeholder={paradigmSource === "pg" ? "PG三库模式（自动查库, 无需目录）" : "学者文献 md 目录（pdf2obsidian 产物）"} className={input} disabled={paradigmSource === "pg"} />
                <button type="button" onClick={() => void scanParadigmDir()} disabled={busy || paradigmSource === "pg" || !paradigmDir.trim()}
                  className="flex items-center gap-1 rounded-xl border border-primary/40 px-3 py-2 text-[11px] text-primary hover:bg-primary/5 disabled:opacity-40">
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <BookMarked className="h-3 w-3" />} 扫描
                </button>
              </div>
              {/* V395-29: 数据源选择 */}
              <div className="mt-2 flex items-center gap-2">
                <span className="shrink-0 text-[10px] text-muted-foreground">数据源</span>
                <button type="button" onClick={() => setParadigmSource("pg")}
                  className={cn("rounded-lg border px-2.5 py-1 text-[10px] transition-all",
                    paradigmSource === "pg" ? "border-violet-400/60 bg-violet-500/15 text-violet-300" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                  PG 三库（实体/事件/切片/章节）
                </button>
                <button type="button" onClick={() => setParadigmSource("dir")}
                  className={cn("rounded-lg border px-2.5 py-1 text-[10px] transition-all",
                    paradigmSource === "dir" ? "border-violet-400/60 bg-violet-500/15 text-violet-300" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                  md 目录
                </button>
                {/* V395-30: 图谱补充源开关（Graphiti 超边/社区 + Cognee 实体关系） */}
                <button type="button" onClick={() => setParadigmGraph(!paradigmGraph)} title={paradigmGraph ? "关闭图谱补充（Graphiti/Cognee）" : "开启图谱补充（Graphiti/Cognee）"}
                  className={cn("rounded-lg border px-2.5 py-1 text-[10px] transition-all",
                    paradigmGraph ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-300" : "border-border/50 text-muted-foreground hover:border-primary/40")}>
                  {paradigmGraph ? "✓ 图谱补充" : "图谱补充"}
                </button>
                {paradigmGraph && (
                  <span className="text-[9px] text-muted-foreground">Graphiti 超边/社区 + Cognee 实体关系{paradigmGraphInfo ? ` · ${paradigmGraphInfo}` : ""}</span>
                )}
              </div>
              {/* V395-26: 提取模型选择 */}
              <div className="mt-2 flex items-center gap-2">
                <span className="shrink-0 text-[10px] text-muted-foreground">提取模型</span>
                <LlmModelSelector roles={TASK_ROLES.task} compact />
              </div>
              {/* V395-26: 选中学者的已提取范式（实时显示） */}
              {selectedScholar?.paradigm && (
                <div className="mt-2 rounded-xl border border-emerald-400/25 bg-emerald-500/5 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-[11px] font-medium text-emerald-400">{selectedScholar.scholar} 已提取范式</span>
                    <span className="text-[9px] text-muted-foreground">四步法将按此风格生成</span>
                  </div>
                  <ParadigmDetail paradigm={selectedScholar.paradigm} />
                </div>
              )}
              {paradigmScan.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-[10px] text-muted-foreground">扫描到 {paradigmScan.length} 篇文献:</div>
                  <div className="max-h-24 space-y-0.5 overflow-y-auto rounded-lg border border-border/40 p-1.5">
                    {paradigmScan.slice(0, 8).map((d: any, i: number) => (
                      <div key={i} className="truncate text-[10px] text-muted-foreground">• {d.title}</div>
                    ))}
                    {paradigmScan.length > 8 && <div className="text-[9px] text-muted-foreground/50">…共 {paradigmScan.length} 篇</div>}
                  </div>
                  <button type="button" onClick={() => void extractParadigm()} disabled={busy || !paradigmScholarId}
                    className="mt-2 flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-xs font-medium text-white shadow-[0_0_14px_hsl(270_70%_55%/0.35)] hover:brightness-110 disabled:opacity-40">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} 提取范式并回填学者库
                  </button>
                </div>
              )}
              {/* V395-29: PG 三库模式直接提取（免扫描） */}
              {paradigmSource === "pg" && paradigmScholarId && (
                <button type="button" onClick={() => void extractParadigm()} disabled={busy}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-xs font-medium text-white shadow-[0_0_14px_hsl(270_70%_55%/0.35)] hover:brightness-110 disabled:opacity-40">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  从 PG 三库提取范式并回填{paradigmGraph ? "（含图谱: 超边/社区/实体关系）" : "（实体/事件/切片/章节 + 全文）"}
                </button>
              )}
            </div>
            {paradigm && (
              <div className="space-y-2">
                <div className="overflow-hidden rounded-xl border border-violet-400/25">
                  <div className="flex items-center gap-2 border-b border-violet-400/20 bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 px-3 py-2">
                    <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                    <span className="text-[11px] font-medium">写作范式分析结果</span>
                    <span className="text-[9px] text-muted-foreground">已回填学者库 · 四步法将按此风格生成</span>
                  </div>
                  <ParadigmDetail paradigm={paradigm} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══ 参考数据 ═══ */}
        {tab === "reference" && (
          <div className="space-y-3">
            {/* 理论接口表 */}
            <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-border/40 bg-gradient-to-r from-primary/10 to-violet-500/10 px-4 py-2.5">
                <BookOpenCheck className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">理论接口映射表</span>
                <span className="text-[10px] text-muted-foreground">热点 → 政经对象 → 经典理论 → 示例</span>
              </div>
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="sticky top-0 bg-background/90 backdrop-blur">
                    <tr className="border-b border-border/40 text-muted-foreground">
                      <th className="px-4 py-2 font-medium">热点</th>
                      <th className="px-2 py-2 font-medium">政经对象</th>
                      <th className="px-2 py-2 font-medium">经典理论</th>
                      <th className="px-4 py-2 font-medium">示例题目</th>
                    </tr>
                  </thead>
                  <tbody>
                    {interfaces.map((row, i) => (
                      <tr key={i} className={cn("border-b border-border/20 transition-colors last:border-0 hover:bg-primary/5", i % 2 === 1 && "bg-muted/20")}>
                        <td className="px-4 py-2 font-medium">{row.hot}</td>
                        <td className="px-2 py-2">{row.object}</td>
                        <td className="px-2 py-2 text-muted-foreground">{row.theory}</td>
                        <td className="px-4 py-2 text-muted-foreground">{row.example}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {/* 种子选题 */}
            <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-border/40 bg-gradient-to-r from-violet-500/10 to-fuchsia-500/10 px-4 py-2.5">
                <Sparkles className="h-4 w-4 text-violet-400" />
                <span className="text-sm font-medium">2026 布局种子选题</span>
                <span className="text-[10px] text-muted-foreground">{seeds.length} 条 · 点击填入四步法</span>
              </div>
              <div className="grid gap-1.5 p-3 sm:grid-cols-2">
                {seeds.map((s, i) => (
                  <button key={i} type="button" onClick={() => { setHotTopic(s.replace(/《|》/g, "").slice(0, 20)); setTab("fourstep"); }}
                    className="group flex items-center gap-2 rounded-lg border border-border/40 px-2.5 py-2 text-left text-[11px] transition-all hover:border-violet-400/50 hover:bg-violet-500/5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 text-[9px] font-bold text-violet-400">{i + 1}</span>
                    <span className="min-w-0 flex-1 leading-4">{s}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-violet-400" />
                  </button>
                ))}
              </div>
            </div>
            {/* 期刊匹配（V395-38: 动态库 80 本真实目录 + 最新热点 + 同步） */}
            <div className="overflow-hidden rounded-xl border border-border/60 bg-background/40 shadow-sm">
              <div className="flex items-center gap-2 border-b border-border/40 bg-gradient-to-r from-amber-500/10 to-orange-500/10 px-4 py-2.5">
                <Library className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-medium">期刊定位匹配</span>
                <span className="text-[10px] text-muted-foreground">国内马理论相关期刊全库（{journals.length} 本 · 南核/北核/C扩）· 投稿前先匹配期刊口味</span>
                <button type="button" onClick={() => void syncJournalsNow()} disabled={busy}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-300 hover:bg-amber-500/20 disabled:opacity-40">
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} 同步最新
                </button>
              </div>
              {/* 级别筛选 */}
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border/30 px-3 py-2">
                {["全部", "南核", "北核", "C扩"].map((lv) => (
                  <button key={lv} type="button" onClick={() => setJournalLevel(lv)}
                    className={cn("rounded-lg border px-2 py-1 text-[9px] transition-all",
                      journalLevel === lv ? "border-amber-400/60 bg-amber-400/10 text-amber-300" : "border-border/40 text-muted-foreground hover:border-primary/40")}>
                    {lv}{lv !== "全部" && `（${journals.filter((j: any) => j.level === lv).length}）`}
                  </button>
                ))}
                {syncInfo && <span className="ml-auto text-[9px] text-emerald-400">{syncInfo}</span>}
              </div>
              <div className="space-y-1.5 p-3">
                {filteredJournals().map((j: any) => (
                  <div key={j.id} className="rounded-lg border border-border/40 px-3 py-2 transition-colors hover:bg-primary/5">
                    <div className="flex items-center gap-2">
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[8px] font-bold",
                        j.level === "南核" ? "bg-red-500/15 text-red-300" : j.level === "北核" ? "bg-blue-500/15 text-blue-300" : "bg-emerald-500/15 text-emerald-300")}>{j.level}</span>
                      <span className="shrink-0 text-xs font-medium">{j.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{j.style}</span>
                      {j.lastSyncStatus === "ok" && (
                        <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[8px] text-emerald-300" title="官网实时抓取">●官网</span>
                      )}
                      <div className="flex shrink-0 gap-1">
                        <button type="button" title="该刊最新热点" onClick={() => void loadJournalUpdates(j.id)}
                          className="rounded border border-border/50 px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-amber-400">热点</button>
                        <button type="button" title="把该刊选题标签填入四步法"
                          onClick={() => { setHotTopic((j.topicTags || [])[0] || j.name); setTab("fourstep"); }}
                          className="rounded border border-border/50 px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-primary">选题</button>
                      </div>
                    </div>
                    {j.topicTags?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {j.topicTags.slice(0, 4).map((t: string, ti: number) => (
                          <span key={ti} className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[8px] text-amber-300/80">{t}</span>
                        ))}
                      </div>
                    )}
                    {activeJournalUpdatesId === j.id && (
                      <div className="mt-1.5 space-y-0.5 rounded-lg bg-background/60 p-1.5">
                        <div className="text-[8px] font-medium text-amber-400">该刊最新热点/选题方向（自动同步）：</div>
                        {journalUpdates.length === 0 && <div className="text-[8px] text-muted-foreground">暂无更新（可点顶部"同步最新"）</div>}
                        {journalUpdates.slice(0, 6).map((u: any, ui: number) => (
                          <div key={ui} className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                            <span className="h-1 w-1 shrink-0 rounded-full bg-amber-400" />{u.title}
                            {u.source_url && <span className="text-[8px] text-sky-400/70">(官网)</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {filteredJournals().length === 0 && <div className="text-[10px] text-muted-foreground">该级别暂无期刊</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );

  async function runFourStep() {
    const r = await call("/api/cjournal/four-step", { hotTopic, method });
    if (r) setFourStep(r);
  }
  async function runParadox() {
    const r = await call("/api/cjournal/paradox", { phenomenon });
    if (r) setParadox(r);
  }
  async function runMatrix() {
    const r = await call("/api/cjournal/matrix", { coreConcept });
    if (r) setMatrix(r);
  }
  async function runNaming() {
    const r = await call("/api/cjournal/naming", { phenomenon: namingInput });
    if (r) setNaming(r);
  }
  async function runCross() {
    const r = await call("/api/cjournal/cross-disciplinary", { coreConcept: crossInput });
    if (r) setCross(r);
  }
  async function runTemplateCheck() {
    setError("");
    try {
      const r = await fetch("/api/cjournal/template-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: templateTopic }) });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setTemplateResult(d.result);
    } catch (e: any) { setError(e.message || "检测失败"); }
  }
  async function runValidate() {
    const r = await call("/api/cjournal/validate", { topic: checkTopic });
    if (r) setValidation(r);
  }
  async function runReviewTranslate() {
    const r = await call("/api/cjournal/review-translate", { comment: reviewComment });
    if (r) setReviewResult(r);
  }
  // V395-31: 刘衍峰式方法系统工具
  async function runRelational() {
    const r = await call("/api/cjournal/relational", { hotA: relHotA, hotB: relHotB });
    if (r) setRelational(r);
  }
  async function runResearchLine() {
    const r = await call("/api/cjournal/research-line", { corePhenomenon: linePhenomenon });
    if (r) setResearchLine(r);
  }
  async function runResearchLabels() {
    const r = await call("/api/cjournal/research-labels", { researchFocus: labelFocus });
    if (r) setResearchLabels(r);
  }
  async function runScopeCheck() {
    setError("");
    try {
      const r = await fetch("/api/cjournal/scope-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: scopeTopic }) });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setScopeResult(d.result);
    } catch (e: any) { setError(e.message || "检验失败"); }
  }
  async function runSeriesExtend() {
    const r = await call("/api/cjournal/series-extend", { paperTitle: seriesTitle, published: seriesPublished });
    if (r) setSeriesResult(r);
  }
  // V395-33: 六趋势选题
  async function runTrendTopic() {
    const r = await call("/api/cjournal/trend-topic", { trendId, hotTopic: trendHot });
    if (r) setTrendResult(r);
  }
  // V395-34: 经典马研究（转向诊断 + 方向深化）
  async function runClassicDiagnose() {
    const r = await call("/api/cjournal/classic-diagnose", { topic: diagTopic });
    if (r) setDiagResult(r);
  }
  async function runClassicDirection() {
    const r = await call("/api/cjournal/classic-direction", { directionId: classicDirId, phenomenon: classicPhenomenon });
    if (r) setClassicResult(r);
  }
  // V395-35: 编辑视角选题生成
  async function runEditorTopic() {
    const r = await call("/api/cjournal/editor-topic", { methodId: editorMethodId, topic: editorInput });
    if (r) setEditorResult(r);
  }
  // V395-36: 投稿军规生成器
  async function runMainlineCheck() {
    const r = await call("/api/cjournal/mainline-check", { topic: mainlineTopic });
    if (r) setMainlineResult(r);
  }
  async function runNationalStrategy() {
    const r = await call("/api/cjournal/national-strategy", { strategy: strategyName, phenomenon: strategyPhenomenon });
    if (r) setStrategyResult(r);
  }
  async function runNewAngle() {
    const r = await call("/api/cjournal/new-angle", { topic: angleTopic });
    if (r) setAngleResult(r);
  }
  // V395-37: 小新学姐工具
  async function runSpecCheck() {
    const r = await call("/api/cjournal/object-specificity", { topic: specTopic });
    if (r) setSpecResult(r);
  }
  async function runLadder() {
    // 解析: 每行"标题|阶段|层级"（阶段: writing/revising/submitting/reviewing/published; 层级: impact/stable/stage）
    const items = ladderItems.split("\n").filter((l: string) => l.trim()).map((l: string) => {
      const [title, stage, tier] = l.split("|").map((x: string) => x?.trim());
      return { title: title || "", stage: (stage || "writing") as any, tier: (tier || "stable") as any };
    });
    const r = await call("/api/cjournal/manuscript-ladder", { items: JSON.stringify(items) });
    if (r) setLadderResult(r);
  }
  async function runJournalSelection() {
    const r = await call("/api/cjournal/journal-selection", { topic: selTopic });
    if (r) setSelResult(r);
  }
  async function runRepresentative() {
    const papers = repPapers.split("\n").filter((l: string) => l.trim());
    const r = await call("/api/cjournal/representative", { papers: JSON.stringify(papers) });
    if (r) setRepResult(r);
  }
  // V395-38: 期刊动态库（筛选/热点/同步）
  // 注意: 组件 return 之后的 const 声明不执行, 用函数替代 useMemo
  function filteredJournals() {
    if (journalLevel === "全部") return journals;
    return journals.filter((j: any) => j.level === journalLevel);
  }
  async function loadJournalUpdates(journalId: string) {
    try {
      const r = await fetch(`/api/cjournal/journal-updates?journalId=${journalId}&limit=10`);
      const d = await r.json();
      setJournalUpdates(d.updates || []);
      setActiveJournalUpdatesId(journalId === activeJournalUpdatesId ? "" : journalId);
    } catch { /* 更新加载失败 */ }
  }
  async function syncJournalsNow() {
    setBusy(true); setSyncInfo("");
    try {
      const r = await fetch("/api/cjournal/journal-sync", { method: "POST" });
      const d = await r.json();
      const res = d.result || {};
      setSyncInfo(`已同步 ${res.synced ?? 0} 条更新 · ${res.total ?? 0} 本期刊`);
      // 刷新期刊列表
      const jr = await fetch("/api/cjournal/journals");
      const jd = await jr.json();
      setJournals(jd.journals || []);
    } catch (e: any) { setError(e.message || "同步失败"); }
    finally { setBusy(false); }
  }
  // V395-32: 方法体系管理（切换/添加/编辑/删除）
  // 注意: 必须用 async function 声明(会被提升), 不能用 const 箭头函数——
  // 组件 return 之后的 const 声明不会执行, 会导致 switchLyfSystem is not defined
  async function loadLyfSystems() {
    try {
      const r = await fetch("/api/cjournal/method-systems");
      const d = await r.json();
      setLyfSystems(d.systems || []);
      return d.systems || [];
    } catch { return []; }
  }
  async function switchLyfSystem(id: string) {
    setLyfActiveId(id);
    const list = lyfSystems.length ? lyfSystems : await loadLyfSystems();
    const sys = list.find((s: any) => s.id === id);
    if (sys) {
      setLyfSystem({
        features: sys.features, ideas: sys.ideas,
        productionChain: sys.productionChain, warnings: sys.warnings,
      });
    }
  }
  async function saveLyfSystem() {
    if (!lyfForm?.id?.trim() || !lyfForm?.name?.trim()) { setError("体系 id/名称必填"); return; }
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/cjournal/method-systems", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lyfForm),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      const list = await loadLyfSystems();
      setShowLyfForm(false);
      await switchLyfSystem(lyfForm.id.trim());
      setLyfSystems(list);
    } catch (e: any) { setError(e.message || "保存失败"); }
    finally { setBusy(false); }
  }
  async function deleteLyfSystem(id: string) {
    if (!confirm("确定删除该方法体系？")) return;
    const r = await fetch(`/api/cjournal/method-systems/${id}`, { method: "DELETE" });
    const d = await r.json();
    if (d.error) { setError(d.error); return; }
    const list = await loadLyfSystems();
    setLyfSystems(list);
    await switchLyfSystem("liuyanfeng");
  }
  // V395-25: 范式提取
  async function scanParadigmDir() {
    if (!paradigmDir.trim()) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/cjournal/paradigm/scan?dir=${encodeURIComponent(paradigmDir.trim())}`);
      const d = await r.json();
      if (d.error) { setError(d.error); setParadigmScan([]); return; }
      setParadigmScan(d.docs || []);
    } catch (e: any) { setError(e.message || "扫描失败"); }
    finally { setBusy(false); }
  }
  async function extractParadigm() {
    if (!paradigmScholarId.trim()) { setError("请选择学者"); return; }
    if (paradigmSource === "dir" && !paradigmDir.trim()) { setError("md 目录模式请先输入文献目录"); return; }
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/cjournal/paradigm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scholarId: paradigmScholarId.trim(), docsDir: paradigmSource === "dir" ? paradigmDir.trim() : undefined, model: paradigmModel, source: paradigmSource, graph: paradigmGraph }),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setParadigm(d.paradigm);
      setParadigmScan([]);
      // V395-30: 图谱数据状态
      setParadigmGraphInfo(d.graphInfo || "");
      if (d.graphInfo && d.graphInfo.includes("不可用")) setError(`图谱服务不可用, 已降级为${d.sourceInfo || "纯PG"}提取`);
      await loadScholars();
    } catch (e: any) { setError(e.message || "提取失败"); }
    finally { setBusy(false); }
  }
};

/** 通用工具输入卡片 */
function ToolInput({ icon: Icon, title, desc, placeholder, value, onChange, onRun, busy, btnLabel, instant }: {
  icon: any; title: string; desc: string; placeholder: string; value: string;
  onChange: (v: string) => void; onRun: () => void; busy: boolean; btnLabel: string; instant?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/40 p-4 shadow-sm">
      <div className="mb-2.5 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20">
          <Icon className="h-4 w-4 text-violet-400" />
        </div>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-[10px] text-muted-foreground">{desc}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className="min-w-0 flex-1 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-xs shadow-sm outline-none transition-all placeholder:text-muted-foreground/40 focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onRun(); }} />
        <button type="button" onClick={onRun} disabled={busy || !value.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-xs font-medium text-white shadow-[0_0_14px_hsl(270_70%_55%/0.35)] transition-all duration-300 hover:shadow-[0_0_20px_hsl(270_70%_55%/0.55)] hover:brightness-110 active:scale-[0.97] disabled:opacity-40 disabled:shadow-none">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />} {btnLabel}
        </button>
      </div>
    </div>
  );
}

/** V395-26: 范式详情组件（8 维完整展示） */
const PARADIGM_DIMS: Array<{ key: string; label: string; icon: any; color: string }> = [
  { key: "topicPattern", label: "选题方法", icon: Target, color: "text-violet-400" },
  { key: "titleStructure", label: "标题结构", icon: PenLine, color: "text-blue-400" },
  { key: "chapterFramework", label: "章节框架", icon: Layers, color: "text-emerald-400" },
  { key: "argumentStyle", label: "论证风格", icon: TrendingUp, color: "text-amber-400" },
  { key: "conceptNaming", label: "概念命名", icon: Wand2, color: "text-fuchsia-400" },
  { key: "journalPreference", label: "期刊偏好", icon: Library, color: "text-orange-400" },
];

/** V395-27: 维度卡片（总结 + 可折叠全部证据 + 内部滚动） */
function ParadigmDimCard({ dim, summary, evidence, color }: {
  dim: { key: string; label: string; icon: any; color: string };
  summary?: string; evidence?: any[]; color?: string;
}) {
  const [open, setOpen] = useState(false);
  const iconColor = color || dim.color;
  return (
    <div className="bg-background/60 p-3">
      <div className="flex items-center gap-1.5">
        <dim.icon className={cn("h-3.5 w-3.5", iconColor)} />
        <span className="text-[10px] font-medium text-muted-foreground">{dim.label}</span>
        {evidence && evidence.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)}
            className="ml-auto flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-accent">
            {open ? "收起" : `证据 ${evidence.length} 条`}
            <ArrowRight className={cn("h-2.5 w-2.5 transition-transform", open && "rotate-90")} />
          </button>
        )}
      </div>
      {summary && <div className="mt-1 text-[11px] leading-4 text-foreground/90">{summary}</div>}
      {open && evidence && evidence.length > 0 && (
        <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-border/40 bg-background/40 p-2">
          {evidence.map((ev: any, i: number) => (
            <div key={i} className="rounded border border-border/30 bg-background/60 p-1.5">
              <div className="flex items-center gap-1 text-[9px] font-medium text-primary/80">
                <BookMarked className="h-2.5 w-2.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">《{ev.title || `文献${i + 1}`}》</span>
              </div>
              <div className="mt-0.5 border-l-2 border-violet-400/30 pl-1.5 text-[10px] leading-4 text-muted-foreground">{ev.quote}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ParadigmDetail({ paradigm }: { paradigm: any }) {
  if (!paradigm) return null;
  return (
    <div>
      <div className="grid gap-px bg-border/30 md:grid-cols-2">
        <ParadigmDimCard dim={PARADIGM_DIMS[0]} summary={paradigm.topicPattern} evidence={paradigm.topicEvidence} />
        <ParadigmDimCard dim={PARADIGM_DIMS[1]} summary={paradigm.titleStructure} evidence={paradigm.titleEvidence} />
        <ParadigmDimCard dim={PARADIGM_DIMS[2]} summary={paradigm.chapterFramework} evidence={paradigm.chapterEvidence} />
        <ParadigmDimCard dim={PARADIGM_DIMS[3]} summary={paradigm.argumentStyle} evidence={paradigm.argumentEvidence} />
        <ParadigmDimCard dim={PARADIGM_DIMS[4]} summary={paradigm.conceptNaming} evidence={paradigm.conceptEvidence} />
        <ParadigmDimCard dim={PARADIGM_DIMS[5]} summary={paradigm.journalPreference} evidence={paradigm.journalEvidence} />
      </div>
      {paradigm.theoryInterfaces?.length > 0 && (
        <div className="border-t border-border/40 p-3">
          <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">常用理论接口</div>
          <div className="flex flex-wrap gap-1.5">
            {paradigm.theoryInterfaces.map((t: string, i: number) => (
              <span key={i} className="rounded-lg border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300">{t}</span>
            ))}
          </div>
          {paradigm.theoryEvidence?.length > 0 && (
            <div className="mt-2 max-h-32 space-y-1.5 overflow-y-auto rounded-lg border border-border/40 bg-background/40 p-2">
              {paradigm.theoryEvidence.map((ev: any, i: number) => (
                <div key={i} className="rounded border border-border/30 bg-background/60 p-1.5">
                  <div className="text-[9px] font-medium text-primary/80">《{ev.title || `文献${i + 1}`}》</div>
                  <div className="mt-0.5 border-l-2 border-violet-400/30 pl-1.5 text-[10px] leading-4 text-muted-foreground">{ev.quote}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {paradigm.sampleTitles?.length > 0 && (
        <div className="border-t border-border/40 p-3">
          <div className="mb-1.5 text-[10px] font-medium text-muted-foreground">代表文献</div>
          <div className="space-y-1">
            {paradigm.sampleTitles.map((t: string, i: number) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <BookMarked className="h-3 w-3 shrink-0 text-primary/60" />
                <span>《{t}》</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** V395-25: 范式信息格（保留兼容） */
function ParadigmCell({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="bg-background/60 p-3">
      <div className="text-[10px] font-medium text-violet-300">{label}</div>
      <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{value}</div>
    </div>
  );
}
