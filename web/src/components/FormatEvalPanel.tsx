// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// FormatEvalPanel.tsx — 论文格式智能评测面板(2026-09-03)
// 输入: 模板选择(内置 6 个/自定义 localStorage) + 文本粘贴或 .md/.txt 上传
// 输出: 规则引擎违规清单(红/琥珀/蓝) + LLM 审校分区 + 模板人工核对提示
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, BookOpenCheck, CheckCircle2, FileText, Info,
  Loader2, Plus, RotateCcw, Settings2, Trash2, Upload, Wand2,
  School, Hammer, ClipboardCheck, Download, ShieldCheck,
} from "lucide-react";

// ─── 类型(与后端 format-eval-*.ts 契约一致, 此处内联避免动 types.ts) ───
interface FormatTemplate {
  id: string;
  name: string;
  scope: string;
  builtin: boolean;
  headingPattern: "chapter-x.x" | "cn-seq";
  abstract: { required: boolean; min: number; max: number };
  keywords: { required: boolean; min: number; max: number; separator: string };
  requiredSections: string[];
  citationStyle: "numeric" | "author-year";
  referencesRequired: boolean;
  figureCaptionBelow: boolean;
  sectionAliases?: Record<string, string[]>;
  humanCheckNotes: string[];
}

type IssueSeverity = "error" | "warning" | "info";

interface FormatIssue {
  ruleId: string;
  category: string;
  severity: IssueSeverity;
  message: string;
  paragraph: number;
  snippet: string;
  suggestion: string;
}

interface FormatEvalResult {
  ok: true;
  templateUsed: FormatTemplate;
  stats: { score: number; totalRules: number; passed: number; errors: number; warnings: number; infos: number; byCategory: Record<string, number> };
  ruleFindings: FormatIssue[];
  ruleStatuses?: RuleStatusEntry[];
  llmFindings: FormatIssue[];
  llmStatus: "ok" | "skipped" | "failed";
  humanCheckNotes: string[];
  // .docx 路径附加(样式级 findings 来自 python docx 检查器)
  styleFindings?: FormatIssue[];
  textFindings?: FormatIssue[];
  isDocx?: boolean;
}

type RuleStatus = "pass" | IssueSeverity;

interface RuleStatusEntry {
  ruleId: string;
  category: string;
  name: string;
  status: RuleStatus;
  desc?: string;       // 这条规则检测什么
  logic?: string;      // 怎么检测/怎么得出结论
  message?: string;
  suggestion?: string;
}

/** docx 路径(无 ruleStatuses)时, 由 style+text findings 反推 */
function synthesizeStatuses(f: FormatIssue[]): RuleStatusEntry[] {
  const byId = new Map<string, FormatIssue[]>();
  for (const x of f) {
    const list = byId.get(x.ruleId) ?? [];
    list.push(x);
    byId.set(x.ruleId, list);
  }
  const worst = (list: FormatIssue[]): RuleStatus => {
    if (list.some((x) => x.severity === "error")) return "error";
    if (list.some((x) => x.severity === "warning")) return "warning";
    return "info";
  };
  return [...byId.entries()].map(([ruleId, hits]) => ({
    ruleId, category: hits[0].category, name: ruleId, status: worst(hits),
    message: hits[0].message, suggestion: hits[0].suggestion,
  }));
}

const STATUS_META: Record<string, { label: string; cls: string; icon: string }> = {
  pass: { label: "通过", cls: "border-emerald-400/25 bg-emerald-400/5 text-emerald-300", icon: "✓" },
  error: { label: "违规", cls: "border-red-500/30 bg-red-500/10 text-red-300", icon: "✗" },
  warning: { label: "存疑", cls: "border-amber-400/25 bg-amber-400/10 text-amber-200", icon: "!" },
  info: { label: "提示", cls: "border-sky-400/25 bg-sky-400/5 text-sky-300", icon: "i" },
  pending: { label: "待检测", cls: "border-border/50 bg-background/30 text-muted-foreground", icon: "·" },
};

const SEVERITY_META: Record<IssueSeverity, { label: string; cls: string; chip: string }> = {
  error: { label: "违规", cls: "border-red-500/40 bg-red-500/10 text-red-300", chip: "text-red-300" },
  warning: { label: "存疑", cls: "border-amber-400/40 bg-amber-400/10 text-amber-200", chip: "text-amber-300" },
  info: { label: "提示", cls: "border-sky-400/30 bg-sky-400/5 text-sky-300", chip: "text-sky-300" },
};

const STORAGE_KEY = "format-eval:custom-templates:v1";
/** 评测结果持久化: 刷新/切换视图后仍保留(清除结果时同步移除) */
const RESULT_KEY = "format-eval:last-result:v1";

type PanelTab = "check" | "format" | "school";

interface FormatOutcome {
  scoreBefore?: number;
  scoreAfter?: number;
  improvement?: number;
  fingerprintMatched?: boolean;
  summary?: string;
}

export function FormatEvalPanel() {
  // ── 三视图切换: 检查 / 自动格式化 / 学校模板 ──
  const [tab, setTab] = useState<PanelTab>("check");
  // ── 自动格式化态 ──
  const [fmtDocxBase64, setFmtDocxBase64] = useState("");
  const [fmtDocxName, setFmtDocxName] = useState("");
  const [fmtGuideBase64, setFmtGuideBase64] = useState("");
  const [fmtGuideName, setFmtGuideName] = useState("");
  const [fmtOutcome, setFmtOutcome] = useState<FormatOutcome | null>(null);
  const [fmtResultB64, setFmtResultB64] = useState("");
  const [fmtLoading, setFmtLoading] = useState(false);
  const fmtPaperRef = useRef<HTMLInputElement>(null);
  const fmtGuideRef = useRef<HTMLInputElement>(null);
  // ── 学校模板提取态 ──
  const [schoolBase64, setSchoolBase64] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [schoolRules, setSchoolRules] = useState<Record<string, unknown> | null>(null);
  const [schoolLoading, setSchoolLoading] = useState(false);
  const [schoolWarnings, setSchoolWarnings] = useState<string[]>([]);
  const schoolRef = useRef<HTMLInputElement>(null);
  const [templates, setTemplates] = useState<FormatTemplate[]>([]);
  const [ruleCatalog, setRuleCatalog] = useState<RuleStatusEntry[]>([]);  // 规则目录(评测前常驻展示)
  const [expandedRule, setExpandedRule] = useState<string | null>(null);   // 展开的规则卡 ruleId
  const [expandedFinding, setExpandedFinding] = useState<number | null>(null); // 展开的问题卡序号
  const [expandedLlm, setExpandedLlm] = useState<number | null>(null);    // 展开的 LLM 条目序号
  const [templateId, setTemplateId] = useState("undergrad-thesis");
  const [customTemplates, setCustomTemplates] = useState<FormatTemplate[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as FormatTemplate[]) : [];
    } catch { return []; }
  });
  const [showCustom, setShowCustom] = useState(false);
  const [customJson, setCustomJson] = useState("");
  const [customName, setCustomName] = useState("");
  const [text, setText] = useState("");
  const [docxFileName, setDocxFileName] = useState("");
  const [docxBase64, setDocxBase64] = useState("");
  const [useLlm, setUseLlm] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FormatEvalResult | null>(() => {
    try {
      const raw = localStorage.getItem(RESULT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as FormatEvalResult;
      return parsed?.ok ? parsed : null;
    } catch { return null; }
  });
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/format-eval/templates");
        const data = await res.json();
        if (Array.isArray(data?.templates)) setTemplates(data.templates);
      } catch { /* 面板仍可用自定义模板 */ }
    })();
    // 规则目录(评测前常驻清单)
    void (async () => {
      try {
        const res = await fetch("/api/format-eval/rules");
        const data = await res.json();
        if (Array.isArray(data?.rules)) setRuleCatalog(data.rules);
      } catch { /* 目录缺失时隐藏常驻清单 */ }
    })();
  }, []);

  // 评测结果变化即持久化(localStorage), 刷新/切换视图后自动恢复
  useEffect(() => {
    try {
      if (result) localStorage.setItem(RESULT_KEY, JSON.stringify(result));
      else localStorage.removeItem(RESULT_KEY);
    } catch { /* 存储满/隐私模式忽略 */ }
  }, [result]);

  const allTemplates = useMemo(() => [...templates, ...customTemplates], [templates, customTemplates]);
  const activeTemplate = allTemplates.find((t) => t.id === templateId)
    ?? allTemplates.find((t) => t.id === "undergrad-thesis");

  // localStorage 持久化自定义模板
  const persistCustom = useCallback((list: FormatTemplate[]) => {
    setCustomTemplates(list);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
  }, []);

  const loadBuiltinAsCustom = () => {
    const base = templates.find((t) => t.id === templateId);
    if (!base) return;
    setCustomJson(JSON.stringify({ ...base, builtin: false }, null, 2));
    setCustomName(base.name + "(我校版)");
    setShowCustom(true);
  };

  const saveCustom = () => {
    try {
      const parsed = JSON.parse(customJson) as Partial<FormatTemplate>;
      const name = customName.trim() || parsed.name || "自定义模板";
      const id = parsed.id && /^[a-z0-9-]+$/.test(parsed.id) ? parsed.id : `custom-${Date.now().toString(36)}`;
      const entry: FormatTemplate = {
        id, name, scope: parsed.scope ?? "自定义", builtin: false,
        headingPattern: parsed.headingPattern === "cn-seq" ? "cn-seq" : "chapter-x.x",
        abstract: { required: true, min: 0, max: 0, ...(parsed.abstract ?? {}) },
        keywords: { required: true, min: 0, max: 0, separator: "；", ...(parsed.keywords ?? {}) },
        requiredSections: Array.isArray(parsed.requiredSections) ? parsed.requiredSections : ["摘要", "参考文献"],
        citationStyle: parsed.citationStyle === "author-year" ? "author-year" : "numeric",
        referencesRequired: parsed.referencesRequired ?? true,
        figureCaptionBelow: parsed.figureCaptionBelow ?? true,
        sectionAliases: parsed.sectionAliases,
        humanCheckNotes: Array.isArray(parsed.humanCheckNotes) ? parsed.humanCheckNotes : [],
      };
      const next = customTemplates.filter((t) => t.id !== id);
      next.push(entry);
      persistCustom(next);
      setTemplateId(id);
      setCustomJson("");
      setCustomName("");
      setShowCustom(false);
    } catch (e) {
      setError(`自定义模板 JSON 无效: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const removeCustom = (id: string) => {
    persistCustom(customTemplates.filter((t) => t.id !== id));
    if (templateId === id) setTemplateId("undergrad-thesis");
  };

  const runCheck = async () => {
    // .docx 路径: 样式级(python) + 文本级(TS 引擎)
    if (docxBase64) {
      setLoading(true);
      setError("");
      setResult(null);
      try {
        const isCustom = customTemplates.some((t) => t.id === templateId);
        const res = await fetch("/api/format-eval/check-docx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docxBase64,
            fileName: docxFileName || undefined,
            templateId: isCustom ? undefined : templateId,
            template: isCustom ? activeTemplate : undefined,
            preset: "ncwu",
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error?.message ?? `docx 评测失败: HTTP ${res.status}`);
          return;
        }
        const styleF = (data.styleFindings ?? []) as FormatIssue[];
        const textF = (data.textFindings ?? []) as FormatIssue[];
        const docxStatuses = (data.ruleStatuses ?? synthesizeStatuses([...styleF, ...textF])) as RuleStatusEntry[];
        const docxStats = data.stats as FormatEvalResult["stats"] | undefined;
        setResult({
          ok: true,
          isDocx: true,
          templateUsed: activeTemplate ?? { id: "undergrad-thesis", name: "本科毕业论文", scope: "本科", builtin: true, headingPattern: "chapter-x.x", abstract: { required: true, min: 200, max: 400 }, keywords: { required: true, min: 3, max: 5, separator: "；" }, requiredSections: [], citationStyle: "numeric", referencesRequired: true, figureCaptionBelow: true, humanCheckNotes: [] },
          // 后端真实统计(score/违规数等), 不再前端硬编码
          stats: docxStats ?? {
            score: 0,
            totalRules: styleF.length + textF.length,
            passed: 0,
            errors: styleF.filter((f) => f.severity === "error").length + textF.filter((f) => f.severity === "error").length,
            warnings: styleF.filter((f) => f.severity === "warning").length + textF.filter((f) => f.severity === "warning").length,
            infos: styleF.filter((f) => f.severity === "info").length + textF.filter((f) => f.severity === "info").length,
            byCategory: {},
          },
          ruleStatuses: docxStatuses,
          ruleFindings: [],
          llmFindings: [],
          llmStatus: "skipped",
          humanCheckNotes: activeTemplate?.humanCheckNotes ?? [],
          styleFindings: styleF,
          textFindings: textF,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!text.trim()) { setError("请先粘贴论文文本或上传文件"); return; }
    if (text.trim().length < 50) { setError("文本过短, 至少 50 字才能评测"); return; }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const isCustom = customTemplates.some((t) => t.id === templateId);
      const res = await fetch("/api/format-eval/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          templateId: isCustom ? undefined : templateId,
          template: isCustom ? activeTemplate : undefined,
          llm: useLlm,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error?.message ?? `评测失败: HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });

  /** 自动格式化: docx + 可选格式指南 → 格式化 docx + 指纹报告 */
  const runFormat = async () => {
    if (!fmtDocxBase64) { setError("请先上传要格式化的论文 .docx"); return; }
    setFmtLoading(true);
    setError("");
    setFmtOutcome(null);
    setFmtResultB64("");
    try {
      const res = await fetch("/api/format-eval/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docxBase64: fmtDocxBase64,
          formatGuideBase64: fmtGuideBase64 || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? `格式化失败: HTTP ${res.status}`); return; }
      setFmtResultB64(data.formattedBase64 ?? "");
      setFmtOutcome(data.report ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFmtLoading(false);
    }
  };

  /** 学校模板提取: 上传学校模板 docx → 规则 JSON(可另存自定义模板) */
  const runSchoolExtract = async () => {
    if (!schoolBase64) { setError("请先上传学校格式模板 .docx"); return; }
    setSchoolLoading(true);
    setError("");
    setSchoolRules(null);
    setSchoolWarnings([]);
    try {
      const res = await fetch("/api/format-eval/extract-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docxBase64: schoolBase64 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? `模板提取失败: HTTP ${res.status}`); return; }
      setSchoolRules(data.rules ?? null);
      setSchoolWarnings(data.warnings ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSchoolLoading(false);
    }
  };

  /** 学校规则 → 自定义 FormatTemplate JSON(填到自定义模板编辑区) */
  const adoptSchoolRules = () => {
    if (!schoolRules) return;
    const styles = (schoolRules as { styles?: Array<{ name?: string; font?: string; size?: number }> }).styles ?? [];
    const bodyStyle = styles.find((s) => /正文|body/i.test(s.name ?? "")) ?? styles[0];
    const headingStyle = styles.find((s) => /标题|heading|题目/i.test(s.name ?? ""));
    const candidate: Record<string, unknown> = {
      id: `school-${Date.now().toString(36)}`,
      name: schoolName ? `${schoolName}规则` : "学校模板规则",
      scope: "学校",
      builtin: false,
      headingPattern: "cn-seq",
      abstract: { required: true, min: 200, max: 400 },
      keywords: { required: true, min: 3, max: 5, separator: "；" },
      requiredSections: ["摘要", "目录", "引言", "结论", "参考文献"],
      citationStyle: "numeric",
      referencesRequired: true,
      figureCaptionBelow: true,
      humanCheckNotes: bodyStyle?.size
        ? [`正文建议字号 ${bodyStyle.size}pt${bodyStyle.font ? `, 字体 ${bodyStyle.font}` : ""}(以 Word 样式为准)`]
        : [],
    };
    if (headingStyle?.size || headingStyle?.font) {
      candidate.humanCheckNotes = [
        ...(candidate.humanCheckNotes as string[]),
        `标题样式参考: ${headingStyle.name ?? "一级标题"}${headingStyle.size ? ` ${headingStyle.size}pt` : ""}${headingStyle.font ? ` ${headingStyle.font}` : ""}`,
      ];
    }
    setCustomJson(JSON.stringify(candidate, null, 2));
    setCustomName(String(candidate.name));
    setShowCustom(true);
  };

  const onFile = (file: File) => {
    const isDocx = /\.docx$/i.test(file.name);
    if (isDocx) {
      if (file.size > 40 * 1024 * 1024) { setError("docx 超过 40MB, 请精简后重试"); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result ?? "").split(",")[1] ?? "";
        setDocxBase64(b64);
        setDocxFileName(file.name);
        setText("");
      };
      reader.readAsDataURL(file);
      return;
    }
    if (file.size > 2 * 1024 * 1024) { setError("文件超过 2MB, 请分段粘贴文本"); return; }
    setDocxBase64("");
    setDocxFileName("");
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  const findings = useMemo(() => {
    if (!result) return [];
    if (result.isDocx) return [...(result.styleFindings ?? []), ...(result.textFindings ?? [])];
    return [...result.ruleFindings, ...result.llmFindings];
  }, [result]);

  /** 规则清单(全量状态, 含通过项); docx 路径无 ruleStatuses 时反推 */
  const ruleStatuses = useMemo<RuleStatusEntry[]>(() => {
    if (!result) return ruleCatalog.map((r) => ({ ...r, status: "pending" as RuleStatus }));
    if (result.ruleStatuses && result.ruleStatuses.length > 0) return result.ruleStatuses;
    if (result.isDocx) return synthesizeStatuses(findings.filter((f) => f.ruleId !== "llm-review"));
    return synthesizeStatuses(findings.filter((f) => f.ruleId !== "llm-review"));
  }, [result, findings, ruleCatalog]);

  const passedCount = ruleStatuses.filter((s) => s.status === "pass").length;
  const nonPassFindings = findings.filter((f) => f.ruleId !== "llm-review");
  const errorFindings = findings.filter((f) => f.severity === "error");
  const warnFindings = findings.filter((f) => f.severity === "warning");
  const infoFindings = findings.filter((f) => f.severity === "info");

  return (
    <section className="h-full">
      <div className="mx-auto max-w-[1200px] space-y-4">
        {/* 标题行 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BookOpenCheck className="h-5 w-5 text-[#6ee7b7]" />
            <h2 className="text-lg font-semibold">论文格式智能评测</h2>
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
              规则引擎 + LLM 双层
            </span>
          </div>
          {result && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              评测于 {new Date().toLocaleTimeString("zh-CN")}
              <button type="button" className="inline-flex items-center gap-1 text-muted-foreground/70 hover:text-foreground" onClick={() => setResult(null)}>
                <RotateCcw className="h-3 w-3" /> 清除结果
              </button>
            </div>
          )}
        </div>

        {/* 三视图切换 */}
        <div className="flex flex-wrap gap-1 rounded-lg border border-border/60 bg-card/40 p-1 text-xs">
          {([
            { key: "check", label: "格式检查", icon: ClipboardCheck },
            { key: "format", label: "自动格式化", icon: Hammer },
            { key: "school", label: "学校模板提取", icon: School },
          ] as const).map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
                  tab === t.key ? "bg-emerald-500/15 text-emerald-300" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                }`}>
                <Icon className="h-3.5 w-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        {/* ── Tab1: 格式检查 ── */}
        {tab === "check" && (
        <>
        {/* 输入卡 */}
        <div className="rounded-lg border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-muted-foreground">检测模板</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="h-8 rounded-md border border-border/70 bg-background px-2 text-xs"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
              {customTemplates.map((t) => (
                <option key={t.id} value={t.id}>⭐ {t.name}(自定义)</option>
              ))}
            </select>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={loadBuiltinAsCustom}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground">
                <Plus className="h-3 w-3" /> 存为自定义
              </button>
              <button type="button" onClick={() => setShowCustom((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/40 hover:text-foreground">
                <Settings2 className="h-3 w-3" /> 自定义模板
              </button>
            </div>
            <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)}
                className="h-3.5 w-3.5 accent-emerald-500" />
              LLM 审校(软性项)
            </label>
            <button type="button" onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-3 py-1.5 text-xs hover:bg-accent/40">
              <Upload className="h-3.5 w-3.5" /> 上传 .md/.txt/.docx
            </button>
            <input ref={fileRef} type="file" accept=".md,.txt,.markdown,.docx,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
          </div>

          {/* 自定义模板编辑区 */}
          {showCustom && (
            <div className="mt-3 rounded-md border border-emerald-400/25 bg-emerald-400/[0.03] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <input value={customName} onChange={(e) => setCustomName(e.target.value)}
                  placeholder="模板名称(如: XX大学本科毕业论文)"
                  className="h-7 w-56 rounded-md border border-border/70 bg-background px-2 text-xs" />
                <span className="text-[10px] text-muted-foreground">
                  编辑 JSON(必填: headingPattern/abstract/keywords/requiredSections/citationStyle)
                </span>
                <span className="ml-auto flex gap-1.5">
                  <button type="button" onClick={saveCustom}
                    className="rounded-md bg-emerald-500/90 px-2.5 py-1 text-[11px] text-white hover:bg-emerald-400">保存</button>
                  <button type="button" onClick={() => { setShowCustom(false); setCustomJson(""); }}
                    className="rounded-md border border-border/70 px-2.5 py-1 text-[11px] text-muted-foreground">取消</button>
                </span>
              </div>
              {customTemplates.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {customTemplates.map((t) => (
                    <span key={t.id} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[11px]">
                      ⭐ {t.name}
                      <button type="button" onClick={() => removeCustom(t.id)} title="删除模板"
                        className="text-muted-foreground/60 hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
              )}
              <textarea value={customJson} onChange={(e) => setCustomJson(e.target.value)}
                spellCheck={false}
                placeholder='{"id":"my-undergrad","headingPattern":"chapter-x.x","abstract":{"required":true,"min":200,"max":400},…}'
                className="mt-2 h-40 w-full rounded-md border border-border/70 bg-background/90 p-2 font-mono text-[11px] outline-none focus:border-emerald-400/50" />
            </div>
          )}

          {/* docx 已载入提示 */}
          {docxFileName && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs text-violet-200">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{docxFileName}</span>
              <span className="rounded bg-violet-400/20 px-1.5 py-0.5 text-[10px]">Word 样式级 + 文本级双层检查</span>
              <button type="button" onClick={() => { setDocxFileName(""); setDocxBase64(""); }}
                className="shrink-0 text-violet-300/70 hover:text-white" title="移除文件">✕</button>
            </div>
          )}

          {/* 文本输入 */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="粘贴论文全文(标题层级/摘要/关键词/正文/参考文献需完整), 或上传 .md/.txt 文件; 上传 .docx 将额外做 Word 样式级检查(页边距/字体/行距等)。"
            className="mt-3 h-52 w-full resize-y rounded-md border border-border/70 bg-background/80 p-3 text-xs leading-5 outline-none focus:border-emerald-400/40"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {text.length.toLocaleString()} 字 {activeTemplate ? `· 模板: ${activeTemplate.name}` : ""}
              {text.length > 0 && text.length < 50 ? " · 文本过短(<50 字无法评测)" : ""}
            </span>
            <button type="button" onClick={runCheck} disabled={loading || (text.trim().length < 50 && !docxBase64)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              {loading ? "评测中…" : "开始格式评测"}
            </button>
          </div>
          {error && tab === "check" && <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        </div>
        {/* ↑ 输入卡结束 */}

        {/* 常驻规则清单: 评测前显示规则目录(待检测), 评测后显示结果状态 */}
        {ruleStatuses.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-card/60 p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">规则清单({ruleStatuses.length} 项)</h3>
              {result ? (
                <span className="text-[10px] text-muted-foreground/70">
                  通过 {passedCount} · 违规 {ruleStatuses.filter((s) => s.status === "error").length} · 存疑 {ruleStatuses.filter((s) => s.status === "warning").length} · 提示 {ruleStatuses.filter((s) => s.status === "info").length}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground/70">点开任意规则查看检测逻辑 · 开始评测后逐条判定</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {ruleStatuses.map((s) => {
                const m = STATUS_META[s.status] ?? STATUS_META.pending;
                const open = expandedRule === s.ruleId;
                return (
                  <button key={s.ruleId} type="button" onClick={() => setExpandedRule(open ? null : s.ruleId)}
                    className={`rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors hover:brightness-110 ${m.cls}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="w-4 text-center font-bold">{m.icon}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                      <span className="shrink-0 text-[9px] opacity-70">{m.label}</span>
                      <span className={`shrink-0 text-[9px] transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                    </div>
                    {open && (
                      <div className="mt-1.5 space-y-1 border-t border-current/10 pt-1.5 text-left">
                        {s.desc && <p className="text-[10px] leading-4 opacity-80"><b>检测:</b> {s.desc}</p>}
                        {s.logic && <p className="text-[10px] leading-4 opacity-80"><b>逻辑:</b> {s.logic}</p>}
                        {s.message && (
                          <p className="text-[10px] leading-4 opacity-90"><b>本稿结论:</b> {s.message}</p>
                        )}
                        {s.suggestion && <p className="text-[10px] leading-4 text-emerald-200/80"><b>建议:</b> {s.suggestion}</p>}
                        {!result && (
                          <p className="text-[10px] leading-4 opacity-60">尚未评测 — 粘贴论文并点击「开始格式评测」后此条将判定为 通过/违规/提示</p>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 结果区 */}
        {result && (
          <>
            {/* 总览条 */}
            <div className="rounded-lg border border-border/70 bg-card/60 p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-baseline gap-1">
                  <span className={`text-4xl font-bold tabular-nums ${result.stats.score >= 90 ? "text-emerald-300" : result.stats.score >= 70 ? "text-amber-300" : "text-red-300"}`}>
                    {result.stats.score}
                  </span>
                  <span className="text-xs text-muted-foreground">/ 100 分</span>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-emerald-300">
                    <CheckCircle2 className="h-3 w-3" /> {passedCount} 项通过
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-red-300">
                    <AlertTriangle className="h-3 w-3" /> {result.stats.errors} 违规
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-2.5 py-1 text-amber-300">
                    <Info className="h-3 w-3" /> {result.stats.warnings} 存疑
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/25 bg-sky-400/10 px-2.5 py-1 text-sky-300">
                    <Info className="h-3 w-3" /> {result.stats.infos} 提示
                  </span>
                </div>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {result.templateUsed.name} · 规则 {result.ruleFindings.length} 条
                  {result.llmStatus === "ok" && ` · LLM 审校 ${result.llmFindings.length} 条`}
                  {result.llmStatus === "failed" && " · LLM 审校暂不可用(已跳过, 不影响规则结果)"}
                </span>
              </div>
              {Object.keys(result.stats.byCategory).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(result.stats.byCategory).map(([cat, n]) => (
                    <span key={cat} className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {cat} ×{n}
                    </span>
                  ))}
                </div>
              )}
            </div>


          </>
        )}
        </>
        )}

        {/* 检测发现(常驻): 评测前占位说明, 评测后填充问题列表 */}
        {result && findings.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">检测发现 {findings.length} 个问题</h3>
            {findings.map((f, i) => {
              const meta = SEVERITY_META[f.severity];
              const ruleInfo = ruleStatuses.find((s) => s.ruleId === f.ruleId);
              const open = expandedFinding === i;
              return (
                <button key={`${f.ruleId}-${i}`} type="button" onClick={() => setExpandedFinding(open ? null : i)}
                  className={`block w-full rounded-lg border p-3 text-left transition-colors hover:brightness-110 ${meta.cls}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.chip}`}>{meta.label}</span>
                    <span className="text-[11px] font-medium">{f.category}</span>
                    {f.paragraph > 0 && <span className="text-[10px] text-muted-foreground">第 {f.paragraph} 行</span>}
                    <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">{f.ruleId}</span>
                    <span className={`text-[10px] text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                  </div>
                  <p className="mt-1 text-xs leading-5">{f.message}</p>
                  {!open && f.snippet && (
                    <p className="mt-1 rounded bg-black/20 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">
                      “{f.snippet}”
                    </p>
                  )}
                  {!open && f.suggestion && <p className="mt-1 text-[11px] text-emerald-200/80">建议: {f.suggestion}</p>}
                  {open && (
                    <div className="mt-2 space-y-1.5 rounded-md bg-black/10 p-2 text-left">
                      {ruleInfo?.desc && <p className="text-[11px] leading-5 opacity-90"><b>这条规则检测:</b> {ruleInfo.desc}</p>}
                      {ruleInfo?.logic && <p className="text-[11px] leading-5 opacity-90"><b>判定逻辑:</b> {ruleInfo.logic}</p>}
                      <p className="text-[11px] leading-5 opacity-90"><b>本稿证据:</b> {f.message}</p>
                      {f.snippet && (
                        <p className="rounded bg-black/20 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">原文: “{f.snippet}”</p>
                      )}
                      {f.paragraph > 0 && <p className="text-[10px] leading-4 opacity-70">定位: 第 {f.paragraph} 行{ruleInfo?.name ? ` · 规则「${ruleInfo.name}」` : ""}</p>}
                      {f.suggestion && <p className="text-[11px] leading-5 text-emerald-200/80"><b>建议:</b> {f.suggestion}</p>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/50 bg-background/20 p-4 text-center text-xs text-muted-foreground/70">
            <AlertTriangle className="mx-auto mb-1.5 h-4 w-4 opacity-50" />
            检测发现 — 待评测: 粘贴论文全文并点击「开始格式评测」后, 此处列出逐条违规/存疑/提示(可点击展开每条规则的检测逻辑与本稿证据)
          </div>
        )}

        {/* 合规提示(有结果且无问题时显示) */}
        {result && findings.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm text-emerald-300">
            <CheckCircle2 className="h-5 w-5" /> 未发现格式问题!请结合下方"人工核对提示"在 Word 中最终确认。
          </div>
        )}

            {/* LLM 审校分区(常驻) */}
            {result && result.llmStatus === "ok" && result.llmFindings.length > 0 && (
              <div className="rounded-lg border border-violet-400/25 bg-violet-400/5 p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-violet-300">
                  <Wand2 className="h-3.5 w-3.5" /> LLM 审校发现
                  <span className="text-[9px] font-normal text-muted-foreground/60">点击条目展开审校说明</span>
                </div>
                <div className="mt-2 space-y-2">
                  {result.llmFindings.map((f, i) => {
                    const open = expandedLlm === i;
                    return (
                      <button key={`llm-${i}`} type="button" onClick={() => setExpandedLlm(open ? null : i)}
                        className={`block w-full rounded-md bg-background/40 p-2 text-left text-xs leading-5 transition-colors hover:brightness-110 ${open ? "ring-1 ring-violet-400/30" : ""}`}>
                        <div className="flex items-center gap-1.5">
                          <span className="mr-1 text-[10px] text-violet-300/80">[{f.category}]</span>
                          <span className="min-w-0 flex-1 truncate">{f.message}</span>
                          <span className={`shrink-0 text-[10px] text-violet-300/60 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
                        </div>
                        {!open && f.suggestion && <span className="block pl-1 text-[11px] text-emerald-200/70">建议: {f.suggestion}</span>}
                        {open && (
                          <div className="mt-1.5 space-y-1.5 rounded-md bg-black/10 p-2 text-left">
                            <p className="text-[10px] leading-4 opacity-70"><b>审校方式:</b> 将论文文本采样(前 15% + 后 20% 章节, 全文 ≤8000 字)发送给 LLM(deepseek), 按审校要点逐项核查后返回结构化结论</p>
                            <p className="text-[10px] leading-4 opacity-70"><b>审校要点:</b> ①摘要四要素是否齐全 ②术语一致性(同一概念用词是否统一) ③标题措辞是否规范 ④图表编号与正文引用一致性 ⑤关键词与摘要主题相符性</p>
                            <p className="text-[10px] leading-4 opacity-80"><b>本稿结论:</b> [{f.category}] {f.message}</p>
                            {f.suggestion && <p className="text-[10px] leading-4 text-emerald-200/70"><b>建议:</b> {f.suggestion}</p>}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 人工核对提示 */}
            {result && result.humanCheckNotes.length > 0 && (
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" /> 纯文本不可见项 · 请在 Word 中人工核对
                </div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
                  {result.humanCheckNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}

        {/* ── Tab2: 自动格式化 ── */}
        {tab === "format" && (
          <div className="rounded-lg border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-200/90">
              <Hammer className="h-4 w-4" /> 自动格式化(内容指纹保护)
            </div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              上传论文 .docx(可附学校格式指南), 自动套用标题层级/字体/页边距等格式, 全程不改动正文一个字——一旦算法试图改动正文, 内容指纹校验即失败中止。
            </p>
            <div className="mt-3 space-y-3">
              {/* 论文上传 */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-emerald-300" />
                <span className="w-16 shrink-0 text-[11px] text-muted-foreground">论文</span>
                <span className={`min-w-0 flex-1 truncate text-xs ${fmtDocxName ? "text-foreground" : "text-muted-foreground/60"}`}>
                  {fmtDocxName || "未选择(必填 .docx)"}
                </span>
                <button type="button" onClick={() => fmtPaperRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] hover:bg-accent/40">
                  <Upload className="h-3 w-3" /> {fmtDocxName ? "更换" : "选择"}
                </button>
                {fmtDocxName && (
                  <button type="button" onClick={() => { setFmtDocxName(""); setFmtDocxBase64(""); }}
                    className="shrink-0 text-muted-foreground/60 hover:text-red-400" title="移除">✕</button>
                )}
                <input ref={fmtPaperRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      if (f.size > 40 * 1024 * 1024) { setError("docx 超过 40MB, 请精简后重试"); return; }
                      try { setFmtDocxBase64(await fileToBase64(f)); setFmtDocxName(f.name); setError(""); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
                    }
                    e.target.value = "";
                  }} />
              </div>
              {/* 指南上传(可选) */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2">
                <School className="h-4 w-4 shrink-0 text-sky-300" />
                <span className="w-16 shrink-0 text-[11px] text-muted-foreground">格式指南</span>
                <span className={`min-w-0 flex-1 truncate text-xs ${fmtGuideName ? "text-foreground" : "text-muted-foreground/60"}`}>
                  {fmtGuideName || "可选: 学校格式指南 .docx/.doc/.txt(不选则用算法内置规则)"}
                </span>
                <button type="button" onClick={() => fmtGuideRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] hover:bg-accent/40">
                  <Upload className="h-3 w-3" /> {fmtGuideName ? "更换" : "选择"}
                </button>
                {fmtGuideName && (
                  <button type="button" onClick={() => { setFmtGuideName(""); setFmtGuideBase64(""); }}
                    className="shrink-0 text-muted-foreground/60 hover:text-red-400" title="移除">✕</button>
                )}
                <input ref={fmtGuideRef} type="file" accept=".docx,.doc,.txt,.md" className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      if (f.size > 40 * 1024 * 1024) { setError("指南文件超过 40MB"); return; }
                      try { setFmtGuideBase64(await fileToBase64(f)); setFmtGuideName(f.name); setError(""); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
                    }
                    e.target.value = "";
                  }} />
              </div>
              <div className="flex items-center justify-end gap-2">
                {error && tab === "format" && <span className="mr-auto text-[11px] text-red-300">{error}</span>}
                <button type="button" onClick={runFormat} disabled={fmtLoading || !fmtDocxBase64}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40">
                  {fmtLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                  {fmtLoading ? "格式化中…(可达 3 分钟)" : "开始格式化"}
                </button>
              </div>
            </div>

            {/* 格式化结果 */}
            {fmtOutcome && (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-emerald-400/25 bg-emerald-400/5 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-300">
                    <ShieldCheck className="h-4 w-4" /> 格式化完成 · 内容指纹保护
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs">
                    {fmtOutcome.scoreBefore !== undefined && (
                      <span className="rounded bg-background/60 px-2 py-1">格式评分: {fmtOutcome.scoreBefore} → <b className={((fmtOutcome.scoreAfter ?? 0) - fmtOutcome.scoreBefore) >= 0 ? "text-emerald-300" : "text-red-300"}>{fmtOutcome.scoreAfter}</b></span>
                    )}
                    {fmtOutcome.improvement !== undefined && fmtOutcome.improvement !== 0 && (
                      <span className={`rounded bg-background/60 px-2 py-1 ${fmtOutcome.improvement > 0 ? "text-emerald-300" : "text-amber-300"}`}>
                        {fmtOutcome.improvement > 0 ? "+" : ""}{fmtOutcome.improvement} 分
                      </span>
                    )}
                    <span className={`rounded bg-background/60 px-2 py-1 ${fmtOutcome.fingerprintMatched === false ? "text-red-300" : "text-emerald-300"}`}>
                      正文指纹 {fmtOutcome.fingerprintMatched === false ? "不一致(已中止?)" : "已保护(未改动正文)"}
                    </span>
                  </div>
                  {fmtOutcome.summary && <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{fmtOutcome.summary}</p>}
                </div>
                {fmtResultB64 && (
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={`data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${fmtResultB64}`}
                      download={`formatted_${fmtDocxName || "paper"}.docx`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-400">
                      <Download className="h-3.5 w-3.5" /> 下载格式化论文 .docx
                    </a>
                    <button type="button" onClick={() => setFmtResultB64("")}
                      className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-accent/40">
                      收起
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Tab3: 学校模板提取 ── */}
        {tab === "school" && (
          <div className="rounded-lg border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
            <div className="flex items-center gap-2 text-sm font-medium text-sky-200/90">
              <School className="h-4 w-4" /> 学校模板提取(规则 JSON)
            </div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              上传学校毕业论文格式模板 .docx, 自动提取页边距/字体字号/标题层级等结构规则(复用 thesis-format-fixer + china-thesis 提取器), 可直接转为自定义检测模板。
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2">
              <FileText className="h-4 w-4 shrink-0 text-sky-300" />
              <span className={`min-w-0 flex-1 truncate text-xs ${schoolName ? "text-foreground" : "text-muted-foreground/60"}`}>
                {schoolName || "未选择学校模板(.docx)"}
              </span>
              <button type="button" onClick={() => schoolRef.current?.click()}
                className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] hover:bg-accent/40">
                <Upload className="h-3 w-3" /> {schoolName ? "更换" : "选择"}
              </button>
              {schoolName && (
                <button type="button" onClick={() => { setSchoolName(""); setSchoolBase64(""); setSchoolRules(null); }}
                  className="shrink-0 text-muted-foreground/60 hover:text-red-400" title="移除">✕</button>
              )}
              <input ref={schoolRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 40 * 1024 * 1024) { setError("模板超过 40MB"); return; }
                    try { setSchoolBase64(await fileToBase64(f)); setSchoolName(f.name); setSchoolRules(null); setError(""); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
                  }
                  e.target.value = "";
                }} />
              <button type="button" onClick={runSchoolExtract} disabled={schoolLoading || !schoolBase64}
                className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40">
                {schoolLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Settings2 className="h-3.5 w-3.5" />}
                {schoolLoading ? "提取中…" : "提取规则"}
              </button>
            </div>
            {error && tab === "school" && <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}

            {/* 提取结果 */}
            {schoolRules && (
              <div className="mt-4 space-y-3">
                {schoolWarnings.length > 0 && (
                  <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
                    <b>提取提示:</b>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">{schoolWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </div>
                )}
                <div className="rounded-md border border-border/60 bg-background/50">
                  <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
                    <span className="text-[11px] font-medium text-sky-300">规则 JSON({schoolName})</span>
                    <span className="ml-auto flex gap-1.5">
                      <button type="button" onClick={adoptSchoolRules}
                        className="rounded-md bg-sky-500/90 px-2 py-1 text-[11px] text-white hover:bg-sky-400">
                        转自定义模板
                      </button>
                    </span>
                  </div>
                  <pre className="max-h-72 overflow-auto p-3 font-mono text-[10px] leading-4 text-muted-foreground">
                    {JSON.stringify(schoolRules, null, 2)}
                  </pre>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  提示: 点「转自定义模板」会把规则填入左侧自定义模板编辑区, 再点「保存」即可用于格式检查。
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
