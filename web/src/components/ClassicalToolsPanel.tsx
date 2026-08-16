// ClassicalToolsPanel.tsx — 经典文本研究专属能力交互面板（V349）
// 5 个场景的专属算法可视化：输入 → 调 /api/classical/* → 渲染结构化结果
// 概念溯源(语义漂移) / 论证拆解(论证树) / 互文对照(段落对齐) / 晦涩阐释(句级锚定) / 版本校勘(LCS diff)
import { useState, useEffect, type FC } from "react";
import { Loader2, Play, AlertTriangle, GitBranch, Link2, BookOpenCheck, Scale, Languages, Lightbulb, FileDiff, Cpu } from "lucide-react";
import { cn } from "../lib/utils";
import { LiteraturePreviewPanel, extractLiteratureRefs } from "./LiteraturePreviewPanel";

const API_BASE = "/api/classical";
const PROJECT_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

interface ClassicalToolsPanelProps {
  scenarioId: string;
}

interface ToolDef {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
  fields: Array<{ key: string; label: string; placeholder: string; type?: "text" | "textarea" }>;
  render: (result: any) => React.ReactNode;
}

async function callApi(path: string, body: Record<string, unknown>) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

const TOOLS: ToolDef[] = [
  {
    id: "S36",
    title: "概念溯源 · 语义漂移",
    desc: "输入概念名，检索跨文档出现段落，LLM 归纳语义演变阶段 + 算法检测时间窗质心漂移",
    icon: <BookOpenCheck className="h-4 w-4" />,
    fields: [
      { key: "concept", label: "概念名", placeholder: "如：资本下乡 / 资本 / 意识形态", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.stages?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">语义演变阶段（{r.stages.length}）</div>
            <div className="space-y-2">
              {r.stages.map((s: any, i: number) => (
                <div key={i} className="rounded border p-2">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px]">{i + 1}</span>
                    {s.name}
                    {s.era && <span className="text-[10px] text-muted-foreground">{s.era}</span>}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.meaning}</p>
                  {s.quote && <p className="mt-1 border-l-2 border-primary/30 pl-2 text-[11px] italic text-muted-foreground/70">"{s.quote}"</p>}
                  {s.source && <p className="mt-0.5 text-[10px] text-primary/70">出处：{s.source}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
        {r.drift?.windows?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">语义漂移检测（embedding 质心）</div>
            <div className="flex items-end gap-2">
              {r.drift.windows.map((w: any, i: number) => (
                <div key={i} className="flex flex-col items-center">
                  <div
                    className="w-12 rounded-t bg-gradient-to-t from-violet-500/40 to-violet-500"
                    style={{ height: Math.max(8, (w.centroidDist ?? 0.05) * 120) }}
                  />
                  <span className="mt-1 text-[10px] text-muted-foreground">{w.label}</span>
                  <span className="text-[10px]">{w.centroidDist === null ? "首窗" : w.centroidDist.toFixed(3)}</span>
                  <span className="text-[9px] text-muted-foreground">{w.count}条</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">{r.drift.driftSummary}</p>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S37",
    title: "论证拆解 · 论证树",
    desc: "输入文档 ID，LLM 拆解前提-结论链条，论证树落库可查询",
    icon: <Scale className="h-4 w-4" />,
    fields: [
      { key: "documentId", label: "文档 ID", placeholder: "从文档管理复制文档 UUID", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.treeId && <div className="rounded bg-green-50 p-2 text-[11px] text-green-700">论证树已落库 treeId={r.treeId.slice(0, 8)}…</div>}
        {r.argument?.premises?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">前提（{r.argument.premises.length}）</div>
            {r.argument.premises.map((p: any, i: number) => (
              <div key={i} className="mb-1 rounded border-l-2 border-violet-300 bg-muted/20 p-1.5 text-xs">
                {p.text}
                {p.source && <span className="ml-1 text-[10px] text-primary/60">← {p.source}</span>}
              </div>
            ))}
          </div>
        )}
        {r.argument?.chain?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">论证链条（{r.argument.chain.length} 环）</div>
            <div className="space-y-1">
              {r.argument.chain.map((c: any, i: number) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px]">
                  <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-700">{c.type}</span>
                  <span className="min-w-0 flex-1 truncate">{c.step}</span>
                  {i < r.argument.chain.length - 1 && <span className="text-muted-foreground">↓</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S38",
    title: "互文对照 · 段落对齐",
    desc: "输入主题 + 两个文档 ID，LLM 对比表述差异 + 算法对齐对应段落",
    icon: <Languages className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "对照主题", placeholder: "如：资本 / 土地流转", type: "text" },
      { key: "docA", label: "文档 A ID", placeholder: "文档 UUID", type: "text" },
      { key: "docB", label: "文档 B ID", placeholder: "文档 UUID", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.alignments?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <Link2 className="h-3.5 w-3.5 text-violet-500" /> 段落对齐（{r.alignments.length} 对）
            </div>
            {r.alignments.map((a: any, i: number) => (
              <div key={i} className="mb-2 rounded border p-2">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{a.aHeading} ↔ {a.bHeading}</span>
                  <span className="rounded bg-violet-500/10 px-1 py-0.5 text-violet-700">sim {a.similarity}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{a.aText}</p>
                <p className="mt-0.5 line-clamp-2 border-t border-dashed pt-1 text-[11px] text-muted-foreground/70">{a.bText}</p>
              </div>
            ))}
          </div>
        )}
        {r.comparisons?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">表述差异分析（{r.comparisons.length}）</div>
            {r.comparisons.map((c: any, i: number) => (
              <div key={i} className="mb-2 rounded border p-2">
                <div className="text-xs font-medium">{c.aspect}</div>
                <p className="mt-1 text-[11px] text-muted-foreground">{c.difference}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S39",
    title: "晦涩阐释 · 句级锚定",
    desc: "粘贴晦涩段落，LLM 命题拆解 + 通俗重述，每命题硬绑定原文句",
    icon: <Lightbulb className="h-4 w-4" />,
    fields: [
      { key: "text", label: "原文段落", placeholder: "粘贴晦涩的原文段落…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.exegesis?.propositions?.map((p: any, i: number) => (
          <div key={i} className={cn("rounded border p-2", p.anchored ? "border-green-200" : "border-red-200")}>
            <div className="flex items-center gap-2">
              <span className={cn("rounded px-1 py-0.5 text-[10px]", p.anchored ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700")}>
                {p.anchored ? "✓ 已锚定原文" : "✗ 脱离文本"}
              </span>
              <span className="text-xs font-medium">{p.text}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{p.meaning}</p>
            {p.original && <p className="mt-1 border-l-2 border-green-300 pl-2 text-[10px] italic text-muted-foreground/70">原文："{p.original}"</p>}
          </div>
        ))}
        {r.exegesis?.plainRestatement && (
          <div className="rounded bg-amber-50 p-2">
            <div className="text-xs font-semibold text-amber-800">通俗化重述</div>
            <p className="mt-1 text-[11px] leading-5 text-amber-900">{r.exegesis.plainRestatement}</p>
          </div>
        )}
        {r.exegesis?.controversies?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">争议点</div>
            {r.exegesis.controversies.map((c: string, i: number) => (
              <p key={i} className="mt-1 text-[11px] text-muted-foreground">• {c}</p>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S40",
    title: "版本校勘 · LCS diff",
    desc: "输入著作名（需 ≥2 版本入库），LCS 算法逐段比对 + 差异类型自动分类",
    icon: <FileDiff className="h-4 w-4" />,
    fields: [
      { key: "documentGroup", label: "著作名", placeholder: "如：资本论（需 2 个版本标题含此名）", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.versions?.length > 0 && (
          <div className="text-[11px] text-muted-foreground">版本：{r.versions.join(" / ")}</div>
        )}
        {r.algorithmDiffs?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <GitBranch className="h-3.5 w-3.5 text-violet-500" /> 算法 diff（LCS，{r.algorithmDiffs.length} 处）
            </div>
            {r.algorithmDiffs.map((d: any, i: number) => (
              <div key={i} className="mb-2 rounded border p-2">
                <div className="flex items-center gap-2 text-[10px]">
                  <span className={cn(
                    "rounded px-1 py-0.5",
                    d.classification === "增补" ? "bg-green-100 text-green-700"
                    : d.classification === "删改" ? "bg-red-100 text-red-700"
                    : d.classification === "标点" ? "bg-gray-100 text-gray-600"
                    : "bg-amber-100 text-amber-700"
                  )}>{d.classification}</span>
                  <span className="truncate text-muted-foreground">{d.section}</span>
                </div>
                {d.oldText && <p className="mt-1 text-[11px] text-red-600 line-through">{d.oldText}</p>}
                {d.newText && <p className="mt-0.5 text-[11px] text-green-700">{d.newText}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
];

export const ClassicalToolsPanel: FC<ClassicalToolsPanelProps> = ({ scenarioId }) => {
  const tool = TOOLS.find((t) => t.id === scenarioId);
  if (!tool) return null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  // 模型选择（单次调用覆盖，不影响全局角色映射）
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    fetch("/api/llm/models").then((r) => r.json()).then((j) => {
      const list = j.models ?? [];
      setModels(list);
      // 默认用 reason 角色当前模型
      if (!model && list.length) {
        fetch("/api/llm/models").then((r) => r.json()).then((j2) => {
          const map = j2.roleMap ?? {};
          setModel(map.reason || list[0].id);
        }).catch(() => setModel(list[0].id));
      }
    }).catch(() => {});
  }, []);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      let body: Record<string, unknown> = { sourceId: PROJECT_ID, model: model || undefined };
      if (scenarioId === "S38") {
        body = { topic: values.topic, documentIds: [values.docA, values.docB].filter(Boolean), sourceId: PROJECT_ID, model: model || undefined };
      } else {
        for (const f of tool.fields) {
          if (values[f.key]) body[f.key] = values[f.key];
        }
      }
      const path = scenarioId === "S36" ? "/concept-trace"
        : scenarioId === "S37" ? "/argument-structure"
        : scenarioId === "S38" ? "/intertextual"
        : scenarioId === "S39" ? "/exegesis"
        : "/collation";
      const r = await callApi(path, body);
      setResult(r);
    } catch (e: any) {
      setResult({ error: String(e?.message || e) });
    }
    setLoading(false);
  };

  return (
    <div className="rounded-lg border bg-background/50 p-4">
      <div className="mb-3 flex items-center gap-2">
        {tool.icon}
        <span className="text-sm font-semibold">{tool.title}</span>
        <span className="text-[10px] text-muted-foreground">专属算法 · 可直接调用</span>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{tool.desc}</p>
      <div className="mb-3 space-y-2">
        {tool.fields.map((f) => (
          <div key={f.key}>
            <label className="mb-0.5 block text-[11px] text-muted-foreground">{f.label}</label>
            {f.type === "textarea" ? (
              <textarea
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                rows={3}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            ) : (
              <input
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              />
            )}
          </div>
        ))}
      </div>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded border border-border bg-[#161b2e] px-2 py-1">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="bg-[#161b2e] text-xs text-[#e6edf7] outline-none [color-scheme:dark] [&>option]:bg-[#161b2e] [&>option]:text-[#e6edf7]"
            title="分析模型（单次覆盖，不影响全局）"
          >
            <option value="">默认（reason 角色）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label.replace(/（.*?）/, "")}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => void run()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {loading ? "分析中…" : "开始分析"}
        </button>
      </div>


      {result && (
        <div className="mt-3 max-h-96 overflow-y-auto">
          {result.error && !result.stages && !result.argument && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {typeof result.error === "string" ? result.error : JSON.stringify(result.error).slice(0, 200)}
            </div>
          )}
          {tool.render(result)}
          {/* 文献预览（检索/分析用到的文献可预览+标注） */}
          <LiteraturePreviewPanel references={extractLiteratureRefs(result)} storageKeyPrefix="lit-Classical-" />

        </div>
      )}
    </div>
  );
};
