// QuickLinkPanel.tsx — 快速建联：粘贴文本 → 即时抽三元组
// 双模式：正则即时（零 LLM，~0.3ms）+ LLM 深度（识别复杂句式/语义关系）
// 关系类型可自定义（中文名 + 句式），localStorage 持久化
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, Plus, Settings2, Sparkles, Trash2 } from "lucide-react";
import { extractQuickLinks, loadRelationTypes, saveRelationTypes, type QuickLinkTriple, type RelationType } from "../lib/quick-links";
import { api } from "../lib/api";
import { useI18n } from "../i18n";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

const RELATION_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-green-100 text-green-700",
  "bg-amber-100 text-amber-700",
  "bg-purple-100 text-purple-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
  "bg-orange-100 text-orange-700",
  "bg-teal-100 text-teal-700"
];

export function QuickLinkPanel(props: {
  onShowInGraph: (triples: QuickLinkTriple[]) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [triples, setTriples] = useState<QuickLinkTriple[]>([]);
  const [relationTypes, setRelationTypes] = useState<RelationType[]>(() => loadRelationTypes());
  const [showEditor, setShowEditor] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [llmRunning, setLlmRunning] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // 防抖即时提取（200ms）
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setTriples(extractQuickLinks(text, relationTypes));
    }, 200);
    return () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); };
  }, [text, relationTypes]);

  const relationCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const triple of triples) map.set(triple.relationLabel, (map.get(triple.relationLabel) ?? 0) + 1);
    return map;
  }, [triples]);

  const colorFor = (relationId: string) => {
    const index = relationTypes.findIndex((rt) => rt.id === relationId);
    return RELATION_COLORS[Math.max(index, 0) % RELATION_COLORS.length];
  };

  const updateTypes = (next: RelationType[]) => {
    setRelationTypes(next);
    saveRelationTypes(next);
  };

  /** LLM 深度识别：用自定义关系类型让 LLM 抽取（识别正则抓不到的双宾语/复杂句式/语义关系） */
  const runLlmExtract = async () => {
    if (!text.trim()) return;
    setLlmRunning(true);
    setLlmError(null);
    try {
      const result = await api.llmExtractRelations({
        text,
        relationTypes: relationTypes.map((rt) => ({ id: rt.id, label: rt.label }))
      });
      const llmTriples: QuickLinkTriple[] = result.triples.map((t) => ({
        subject: t.subject,
        relation: t.relation,
        relationLabel: t.relationLabel,
        object: t.object
      }));
      // 合并正则结果 + LLM 结果（去重）
      setTriples((prev) => {
        const seen = new Set(prev.map((p) => `${p.subject}|${p.relation}|${p.object}`));
        const merged = [...prev];
        for (const t of llmTriples) {
          const key = `${t.subject}|${t.relation}|${t.object}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(t);
          }
        }
        return merged;
      });
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    } finally {
      setLlmRunning(false);
    }
  };

  const copyAll = async () => {
    const lines = triples.map((tr) => `${tr.subject} ${tr.relationLabel} ${tr.object}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setSaved("copied");
      setTimeout(() => setSaved(null), 1500);
    } catch {
      setSaved("copy-failed");
    }
  };

  /** 写入知识页时间线：匹配「快速建联」页或自动创建 */
  const saveToTruth = async () => {
    setSaving(true);
    try {
      const pageResult = await api.createTruthPage({ title: "快速建联", compiledTruth: "" });
      const content = triples.map((tr) => `${tr.subject} ${tr.relationLabel} ${tr.object}`).join("\n");
      await api.appendTruthEntry(pageResult.page.id, {
        content: `快速建联抽取：\n${content}`,
        entryType: "note",
        source: "实时建联",
        confidence: 0.5
      });
      setSaved("saved");
      setTimeout(() => setSaved(null), 2000);
    } catch {
      setSaved("save-failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 说明行 */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        {t("粘贴任意文本，即时抽取关系三元组", "Paste any text — extract relation triples instantly")}
        <Button size="sm" variant={llmRunning ? "default" : "outline"} onClick={() => void runLlmExtract()} disabled={llmRunning || !text.trim()}>
          {llmRunning ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Bot className="mr-1 h-3.5 w-3.5" />}
          {llmRunning ? t("LLM 识别中…", "LLM extracting…") : t("LLM 识别", "LLM extract")}
        </Button>
      </div>
      {llmError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">{llmError}</div>}

      {/* 关系类型工具栏（常驻可见） */}
      <div className="rounded-md border border-border bg-muted/20 p-2">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t("关系类型", "Relation types")}</span>
          <span className="text-xs text-muted-foreground">{t("正则 + LLM 共用，可自定义", "Shared by regex + LLM, customizable")}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setShowEditor((v) => !v)}>
              <Settings2 className="mr-1 h-3.5 w-3.5" /> {t("编辑句式", "Edit patterns")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => {
              updateTypes([...relationTypes, { id: `custom-${Date.now()}`, label: "", patterns: ["([一-龥]{2,5}(?:公司|合作社|村|镇)?)([一-龥]{2,6}(?:公司|合作社|村|镇)?)"] }]);
              // 新增后自动展开编辑器，方便立即改名+写句式
              setShowEditor(true);
            }}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {t("新增", "Add")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try { localStorage.removeItem("sag:quick-link-types:v1"); } catch { /* noop */ }
                setRelationTypes(loadRelationTypes());
              }}
            >
              {t("恢复默认", "Reset")}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {relationTypes.map((rt) => (
            <span key={rt.id} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${rt.label ? colorFor(rt.id) : "bg-muted text-muted-foreground"}`}>
              {rt.label || t("未命名", "Unnamed")}
              <button
                type="button"
                onClick={() => updateTypes(relationTypes.filter((r) => r.id !== rt.id))}
                className="text-muted-foreground/60 hover:text-red-600"
                title={t("删除", "Delete")}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 关系类型编辑器（点击展开编辑句式） */}
      {showEditor && (
        <Card className="max-h-64 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t("编辑句式正则", "Edit pattern regex")}</span>
            <span className="text-xs text-muted-foreground">{t("$1 主语，$2 宾语，每行一条", "Group 1 subject, group 2 object, one per line")}</span>
          </div>
          <div className="space-y-2">
            {relationTypes.map((rt, index) => (
              <div key={rt.id} className="flex items-start gap-2 rounded border border-border/60 p-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <input
                    value={rt.label}
                    onChange={(e) => {
                      const next = [...relationTypes];
                      next[index] = { ...rt, label: e.target.value };
                      updateTypes(next);
                    }}
                    className="rounded border border-border bg-background px-2 py-1 text-sm"
                    placeholder={t("关系中文名（如：资本注入）", "Relation name")}
                  />
                  <textarea
                    value={rt.patterns.join("\n")}
                    onChange={(e) => {
                      const next = [...relationTypes];
                      next[index] = { ...rt, patterns: e.target.value.split("\n").filter((p) => p.trim()) };
                      updateTypes(next);
                    }}
                    rows={2}
                    className="rounded border border-border bg-background px-2 py-1 text-xs font-mono"
                    placeholder={t("句式正则，每行一个（$1 主语，$2 宾语）", "Pattern regex, one per line")}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => updateTypes(relationTypes.filter((r) => r.id !== rt.id))}
                  className="shrink-0 rounded p-1 text-muted-foreground/50 hover:bg-red-50 hover:text-red-600"
                  title={t("删除", "Delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 输入区 */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("示例：甲公司投资了乙合作社。丙公司流转土地给丁村。资本下乡研究探讨了土地制度。", "Example: 甲公司投资了乙合作社。丙公司流转土地给丁村。")}
        rows={5}
        className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
      />

      {/* 关系统计 */}
      {text.trim() && (
        <div className="flex flex-wrap gap-2 text-xs">
          {relationTypes.filter((rt) => rt.label).map((rt) => (
            <span key={rt.id} className={`rounded px-1.5 py-0.5 ${colorFor(rt.id)}`}>
              {rt.label} ×{relationCount.get(rt.label) ?? 0}
            </span>
          ))}
        </div>
      )}

      {/* 结果列表 */}
      {triples.length > 0 ? (
        <Card className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-sm font-medium">{t("抽取结果", "Extracted triples")}</span>
            <span className="text-xs text-muted-foreground">{triples.length} {t("条", "items")}</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void copyAll()}>
                {t("复制", "Copy")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => props.onShowInGraph(triples)}>
                {t("在图里看看", "Show in graph")}
              </Button>
              <Button size="sm" onClick={() => void saveToTruth()} disabled={saving}>
                {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                {t("写入知识页", "Save to truth page")}
              </Button>
            </div>
            {saved && <span className="text-xs text-green-600">{saved === "copied" ? t("已复制", "Copied") : saved === "saved" ? t("已写入", "Saved") : saved === "copy-failed" ? t("复制失败", "Copy failed") : t("保存失败", "Save failed")}</span>}
          </div>
          <div className="space-y-1.5">
            {triples.map((tr, index) => (
              <div key={index} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-sm">
                <span className="font-medium">{tr.subject}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${colorFor(tr.relation)}`}>{tr.relationLabel}</span>
                <span className="font-medium">{tr.object}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : text.trim() ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {t("未抽到三元组（检查关系类型的句式是否匹配）", "No triples found (check relation type patterns)")}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {t("粘贴文本开始抽取…", "Paste text to start…")}
        </div>
      )}
    </div>
  );
}
