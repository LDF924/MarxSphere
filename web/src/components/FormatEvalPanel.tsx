// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// FormatEvalPanel.tsx — 论文格式智能评测面板(2026-09-03)
// 输入: 模板选择(内置 6 个/自定义 localStorage) + 文本粘贴或 .md/.txt 上传
// 输出: 规则引擎违规清单(红/琥珀/蓝) + LLM 审校分区 + 模板人工核对提示
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, BookOpenCheck, CheckCircle2, FileText, Info,
  Loader2, Plus, RotateCcw, Settings2, Trash2, Upload, Wand2,
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
  stats: { score: number; totalRules: number; errors: number; warnings: number; infos: number; byCategory: Record<string, number> };
  ruleFindings: FormatIssue[];
  llmFindings: FormatIssue[];
  llmStatus: "ok" | "skipped" | "failed";
  humanCheckNotes: string[];
  // .docx 路径附加(样式级 findings 来自 python docx 检查器)
  styleFindings?: FormatIssue[];
  textFindings?: FormatIssue[];
  isDocx?: boolean;
}

const SEVERITY_META: Record<IssueSeverity, { label: string; cls: string; chip: string }> = {
  error: { label: "违规", cls: "border-red-500/40 bg-red-500/10 text-red-300", chip: "text-red-300" },
  warning: { label: "存疑", cls: "border-amber-400/40 bg-amber-400/10 text-amber-200", chip: "text-amber-300" },
  info: { label: "提示", cls: "border-sky-400/30 bg-sky-400/5 text-sky-300", chip: "text-sky-300" },
};

const STORAGE_KEY = "format-eval:custom-templates:v1";

export function FormatEvalPanel() {
  const [templates, setTemplates] = useState<FormatTemplate[]>([]);
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
  const [result, setResult] = useState<FormatEvalResult | null>(null);
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
  }, []);

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
        setResult({
          ok: true,
          isDocx: true,
          templateUsed: activeTemplate ?? { id: "undergrad-thesis", name: "本科毕业论文", scope: "本科", builtin: true, headingPattern: "chapter-x.x", abstract: { required: true, min: 200, max: 400 }, keywords: { required: true, min: 3, max: 5, separator: "；" }, requiredSections: [], citationStyle: "numeric", referencesRequired: true, figureCaptionBelow: true, humanCheckNotes: [] },
          stats: {
            score: 0,
            totalRules: styleF.length + textF.length,
            errors: styleF.filter((f) => f.severity === "error").length + textF.filter((f) => f.severity === "error").length,
            warnings: styleF.filter((f) => f.severity === "warning").length + textF.filter((f) => f.severity === "warning").length,
            infos: styleF.filter((f) => f.severity === "info").length + textF.filter((f) => f.severity === "info").length,
            byCategory: {},
          },
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
          {error && <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        </div>

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
                    <CheckCircle2 className="h-3 w-3" /> {result.stats.totalRules - errorFindings.length} 项合规
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

            {/* 问题清单 */}
            {findings.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">检测发现 {findings.length} 个问题</h3>
                {findings.map((f, i) => {
                  const meta = SEVERITY_META[f.severity];
                  return (
                    <div key={`${f.ruleId}-${i}`} className={`rounded-lg border p-3 ${meta.cls}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.chip}`}>{meta.label}</span>
                        <span className="text-[11px] font-medium">{f.category}</span>
                        {f.paragraph > 0 && <span className="text-[10px] text-muted-foreground">第 {f.paragraph} 行</span>}
                        <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">{f.ruleId}</span>
                      </div>
                      <p className="mt-1 text-xs leading-5">{f.message}</p>
                      {f.snippet && (
                        <p className="mt-1 rounded bg-black/20 px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">
                          “{f.snippet}”
                        </p>
                      )}
                      {f.suggestion && <p className="mt-1 text-[11px] text-emerald-200/80">建议: {f.suggestion}</p>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 合规提示 */}
            {findings.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm text-emerald-300">
                <CheckCircle2 className="h-5 w-5" /> 未发现格式问题!请结合下方"人工核对提示"在 Word 中最终确认。
              </div>
            )}

            {/* LLM 审校分区 */}
            {result.llmStatus === "ok" && result.llmFindings.length > 0 && (
              <div className="rounded-lg border border-violet-400/25 bg-violet-400/5 p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-violet-300">
                  <Wand2 className="h-3.5 w-3.5" /> LLM 审校发现
                </div>
                <div className="mt-2 space-y-2">
                  {result.llmFindings.map((f, i) => (
                    <div key={`llm-${i}`} className="rounded-md bg-background/40 p-2 text-xs leading-5">
                      <span className="mr-1.5 text-[10px] text-violet-300/80">[{f.category}]</span>
                      {f.message}
                      {f.suggestion && <span className="block text-[11px] text-emerald-200/70">建议: {f.suggestion}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 人工核对提示 */}
            {result.humanCheckNotes.length > 0 && (
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" /> 纯文本不可见项 · 请在 Word 中人工核对
                </div>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
                  {result.humanCheckNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
