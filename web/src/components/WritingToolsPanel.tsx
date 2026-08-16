// WritingToolsPanel.tsx — 论文写作与研究设计专属能力交互面板（S46-S50）
// 问题凝练(主题覆盖矩阵) / 框架设计(模板匹配) / 论证补全(断层检测) / 方法适配(特征映射) / 反方视角(前提弱化检测)
import { useState, useEffect, type FC } from "react";
import { Loader2, Play, AlertTriangle, Lightbulb, PenLine, Scale, FlaskConical, Users, Cpu, ShieldAlert, BookOpen, Target } from "lucide-react";
import { cn } from "../lib/utils";
import { LiteraturePreviewPanel, extractLiteratureRefs } from "./LiteraturePreviewPanel";

const API_BASE = "/api/writing";
const PROJECT_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

interface WritingToolsPanelProps {
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
    id: "S46",
    title: "问题凝练 · 主题覆盖矩阵",
    desc: "输入研究主题，LLM 总结已解决/争议/空白 + 算法统计主题覆盖度（高/中/低 → 空白方向）",
    icon: <Lightbulb className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "研究主题", placeholder: "如：资本下乡的乡村治理效应", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.gap?.solved?.length > 0 && (
          <div className="rounded border border-green-200 p-2">
            <div className="text-xs font-semibold text-green-700">已解决问题</div>
            {r.gap.solved.map((s: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {s}</p>)}
          </div>
        )}
        {r.gap?.gaps?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">研究空白</div>
            {r.gap.gaps.map((s: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {s}</p>)}
          </div>
        )}
        {r.gap?.researchQuestions?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">研究问题建议</div>
            {r.gap.researchQuestions.map((q: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border border-violet-200 p-2">
                <div className="text-[11px] font-medium">{q.question}</div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">价值：{q.rationale}</p>
                {q.novelty && <span className="mt-0.5 inline-block rounded bg-violet-100 px-1 py-0.5 text-[10px] text-violet-700">创新：{q.novelty}</span>}
              </div>
            ))}
          </div>
        )}
        {r.coverage?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">主题覆盖矩阵（{r.totalDocs} 篇文献）</div>
            <div className="space-y-1">
              {r.coverage.map((c: any, i: number) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="w-24 truncate">{c.keyword}</span>
                  <div className="h-2 flex-1 rounded bg-muted">
                    <div className={cn("h-2 rounded", c.docCount >= 4 ? "bg-green-500/60" : c.docCount === 3 ? "bg-amber-500/60" : "bg-red-400/60")}
                      style={{ width: `${Math.min(100, c.docCount * 15)}%` }} />
                  </div>
                  <span className={cn("w-32 shrink-0 text-right text-[10px]", c.docCount >= 4 ? "text-green-600" : c.docCount === 3 ? "text-amber-600" : "text-red-500")}>
                    {c.coverage}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S47",
    title: "框架设计 · 结构模板",
    desc: "输入研究问题 + 类型，算法匹配结构模板（理论研究/实证/历史/比较/文本/政策）+ LLM 拆解章节任务",
    icon: <PenLine className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "研究问题", placeholder: "如：资本下乡的乡村治理效应研究", type: "text" },
      { key: "researchType", label: "研究类型", placeholder: "理论研究/实证研究/历史研究/比较研究/文本研究/政策研究", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.template && (
          <div className="rounded border p-2">
            <div className="flex items-center gap-1 text-xs font-semibold">
              <BookOpen className="h-3.5 w-3.5 text-violet-500" /> 结构模板：{r.template.name}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.template.structure.map((s: string, i: number) => (
                <span key={i} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700">{s}</span>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">适用：{r.template.suited}</p>
          </div>
        )}
        {r.framework?.chapters?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">章节论证任务（{r.framework.chapters.length}）</div>
            {r.framework.chapters.map((ch: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border p-2">
                <div className="flex items-center gap-2 text-[11px] font-medium">
                  <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px]">{i + 1}</span>
                  {ch.title}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{ch.task}</p>
                {ch.logic && <p className="mt-0.5 text-[10px] text-primary/60">逻辑：{ch.logic}</p>}
              </div>
            ))}
          </div>
        )}
        {r.framework?.logicSkeleton && (
          <div className="rounded bg-muted/30 p-2">
            <div className="text-xs font-semibold">整体逻辑骨架</div>
            <p className="mt-1 text-[11px] text-muted-foreground">{r.framework.logicSkeleton}</p>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S48",
    title: "论证补全 · 断层检测",
    desc: "输入核心论点与结论，LLM 梳理推理链条 + 算法量化断层度（缺失环节高亮）",
    icon: <Scale className="h-4 w-4" />,
    fields: [
      { key: "claim", label: "核心论点", placeholder: "如：资本下乡具有产业带动效应", type: "text" },
      { key: "conclusion", label: "结论", placeholder: "如：资本下乡会重塑乡村治理结构", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.gapVerdict && (
          <div className={cn("rounded p-2 text-xs font-medium",
            r.gapScore === 0 ? "bg-green-50 text-green-700" : r.gapScore < 40 ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700")}>
            断层度 {r.gapScore}% — {r.gapVerdict}
          </div>
        )}
        {r.chain?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">推理链条（{r.chain.length} 步）</div>
            {r.chain.map((c: any, i: number) => (
              <div key={i} className="mb-1 flex items-start gap-2 text-[11px]">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[9px] font-bold text-primary">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.step}</div>
                  <div className="text-[10px] text-muted-foreground">{c.from} → {c.to}</div>
                  {c.gap && <div className="mt-0.5 flex items-center gap-1 rounded bg-red-50 px-1 py-0.5 text-[10px] text-red-600"><ShieldAlert className="h-3 w-3" />断层：{c.gap}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        {r.supplements?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">需补充的微观机制</div>
            {r.supplements.map((s: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-amber-200 p-1.5 text-[11px]">
                <b>{s.mechanism}</b>
                {s.evidence && <span className="text-muted-foreground"> — 需{s.evidence}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S49",
    title: "方法适配 · 特征映射",
    desc: "输入主题 + 类型，算法按关键词匹配方法（文本/比较/历史/质性/定量/辩证）+ LLM 细化建议",
    icon: <FlaskConical className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "研究主题", placeholder: "如：资本下乡的历史演变与治理效应", type: "text" },
      { key: "researchType", label: "研究类型", placeholder: "理论研究/实证研究/历史研究等", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.matchedMethods?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">方法特征匹配</div>
            {r.matchedMethods.map((m: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border p-2">
                <div className="flex items-center gap-2 text-[11px] font-medium">
                  <Target className="h-3.5 w-3.5 text-violet-500" /> {m.name}
                  <span className="text-[10px] font-normal text-muted-foreground">适用：{m.suited}</span>
                </div>
                <p className="mt-0.5 text-[10px] text-amber-600">边界：{m.boundary}</p>
                <p className="mt-0.5 text-[10px] text-red-500">误区：{m.pitfalls}</p>
              </div>
            ))}
          </div>
        )}
        {r.recommendations?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">方法推荐（LLM 细化）</div>
            {r.recommendations.map((rec: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border border-violet-200 p-2">
                <div className="text-[11px] font-medium">{rec.method}</div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">理由：{rec.rationale}</p>
                {rec.operations && <p className="mt-0.5 text-[10px]">操作：{rec.operations}</p>}
                {rec.pitfalls && <p className="mt-0.5 text-[10px] text-red-500">误区：{rec.pitfalls}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S50",
    title: "反方视角 · 前提弱化检测",
    desc: "输入论点 + 论证文本，LLM 生成批评/反例/前提质疑 + 算法扫描绝对化表述（易攻击点）",
    icon: <Users className="h-4 w-4" />,
    fields: [
      { key: "claim", label: "核心论点", placeholder: "如：资本下乡必然促进乡村现代化", type: "text" },
      { key: "argumentText", label: "论证文本", placeholder: "粘贴你的论证段落…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.weakVerdict && (
          <div className={cn("rounded p-2 text-xs font-medium",
            r.weakPoints?.length === 0 ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700")}>
            {r.weakVerdict}
          </div>
        )}
        {r.weakPoints?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <ShieldAlert className="h-3.5 w-3.5 text-red-500" /> 前提弱化检测（易被攻击）
            </div>
            {r.weakPoints.map((w: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-red-200 p-1.5 text-[11px]">
                <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-700">{w.type}</span>
                <span className="ml-1 font-mono">"{w.text}"</span>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{w.attack}</p>
              </div>
            ))}
          </div>
        )}
        {r.counter?.criticisms?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">对立批评</div>
            {r.counter.criticisms.map((c: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[11px]">
                {c.view}
                {c.source && <span className="ml-1 text-[10px] text-muted-foreground">（{c.source}）</span>}
              </div>
            ))}
          </div>
        )}
        {r.counter?.counterExamples?.length > 0 && (
          <div className="rounded border border-red-200 p-2">
            <div className="text-xs font-semibold text-red-700">逻辑反例</div>
            {r.counter.counterExamples.map((c: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c}</p>)}
          </div>
        )}
        {r.counter?.responses?.length > 0 && (
          <div className="rounded border border-green-200 p-2">
            <div className="text-xs font-semibold text-green-700">回应建议</div>
            {r.counter.responses.map((c: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c}</p>)}
          </div>
        )}
      </div>
    ),
  },
];

export const WritingToolsPanel: FC<WritingToolsPanelProps> = ({ scenarioId }) => {
  const tool = TOOLS.find((t) => t.id === scenarioId);
  if (!tool) return null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    fetch("/api/llm/models").then((r) => r.json()).then((j) => {
      const list = j.models ?? [];
      setModels(list);
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
      const body: Record<string, unknown> = { sourceId: PROJECT_ID, model: model || undefined };
      for (const f of tool.fields) {
        if (values[f.key]) body[f.key] = values[f.key];
      }
      const path = scenarioId === "S46" ? "/gap"
        : scenarioId === "S47" ? "/framework"
        : scenarioId === "S48" ? "/argument-chain"
        : scenarioId === "S49" ? "/method"
        : "/counter";
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
          {result.error && !result.gap && !result.framework && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {typeof result.error === "string" ? result.error : JSON.stringify(result.error).slice(0, 200)}
            </div>
          )}
          {tool.render(result)}
          {/* 文献预览（检索/分析用到的文献可预览+标注） */}
          <LiteraturePreviewPanel references={extractLiteratureRefs(result)} storageKeyPrefix="lit-Writing-" />

        </div>
      )}
    </div>
  );
};
