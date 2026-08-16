// TheoryToolsPanel.tsx — 理论思辨拓展专属能力交互面板（S61-S65）
// 前提反思(信号词库) / 跨学科(学科映射) / 理论现实联结(案例匹配) / 创新识别(信号扫描) / 体系建构(一致性检测)
import { useState, useEffect, type FC } from "react";
import { Loader2, Play, AlertTriangle, Scale, GitBranch, Lightbulb, Sparkles, Database, Cpu, ShieldAlert, Link2 } from "lucide-react";
import { cn } from "../lib/utils";
import { LiteraturePreviewPanel, extractLiteratureRefs } from "./LiteraturePreviewPanel";

const API_BASE = "/api/theory";

interface TheoryToolsPanelProps {
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
    id: "S61",
    title: "前提反思 · 信号词库",
    desc: "输入研究主张 + 文本，LLM 揭示理论预设/价值立场/认识论前提 + 算法按前提分类库扫描",
    icon: <Scale className="h-4 w-4" />,
    fields: [
      { key: "claim", label: "研究主张", placeholder: "如：市场能够自发调节资源配置", type: "text" },
      { key: "text", label: "研究文本", placeholder: "粘贴研究文本…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.detectedPremises?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" /> 算法检测：前提信号（{r.detectedPremises.length}）
            </div>
            {r.detectedPremises.map((p: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-amber-200 p-1.5 text-[11px]">
                <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-700">{p.type}</span>
                <b className="ml-1">{p.premise}</b>
                <span className="ml-1 font-mono text-[10px] text-muted-foreground">"{p.evidence}"</span>
              </div>
            ))}
          </div>
        )}
        {r.premises?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">前提分析（{r.premises.length}）</div>
            {r.premises.map((p: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[11px]">
                <b>{p.premise}</b> <span className="text-[10px] text-muted-foreground">（{p.type}）</span>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{p.rationale}</p>
              </div>
            ))}
          </div>
        )}
        {r.alternatives?.length > 0 && (
          <div className="rounded border border-violet-200 p-2">
            <div className="text-xs font-semibold text-violet-700">替代视角</div>
            {r.alternatives.map((a: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {a.view}（{a.paradigm}）</p>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S62",
    title: "跨学科 · 学科映射库",
    desc: "输入主题 + 学科，算法按学科映射库推荐交叉学科 + LLM 细化理论框架与应用",
    icon: <GitBranch className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "研究主题", placeholder: "如：资本下乡的乡村治理效应", type: "text" },
      { key: "discipline", label: "学科", placeholder: "如：政治经济学 / 经济学", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.mappedCandidates?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">学科映射候选（{r.mappedCandidates.length}）</div>
            {r.mappedCandidates.map((c: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[11px]">
                <b>{c.discipline}</b> <span className="text-violet-700">· {c.framework}</span>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{c.application}</p>
              </div>
            ))}
          </div>
        )}
        {r.perspectives?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">跨学科视角（LLM 细化）</div>
            {r.perspectives.map((p: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border border-violet-200 p-2">
                <div className="text-[11px] font-medium">{p.discipline} · {p.framework}</div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{p.application}</p>
                {p.insight && <p className="mt-0.5 text-[10px] text-violet-700">洞见：{p.insight}</p>}
              </div>
            ))}
          </div>
        )}
        {r.integration && <div className="rounded bg-muted/30 p-2 text-[11px] text-muted-foreground">整合建议：{r.integration}</div>}
        {r.boundaries && <p className="text-[10px] text-muted-foreground">边界：{r.boundaries}</p>}
      </div>
    ),
  },
  {
    id: "S63",
    title: "理论-现实联结 · 案例匹配",
    desc: "输入理论 + 现实案例（每行一条），算法 embedding 匹配最相关案例 + LLM 机制分析",
    icon: <Lightbulb className="h-4 w-4" />,
    fields: [
      { key: "theory", label: "理论", placeholder: "如：资本积累理论", type: "text" },
      { key: "claim", label: "理论命题", placeholder: "如：资本积累导致空间不均衡发展", type: "text" },
      { key: "realCases", label: "现实案例（每行一条）", placeholder: "乡村振兴中工商资本进入农村土地市场…\n平台经济快速扩张…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.algorithmMatched?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <Link2 className="h-3.5 w-3.5 text-violet-500" /> 算法案例匹配（{r.algorithmMatched.length}）
            </div>
            {r.algorithmMatched.map((m: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[11px]">
                <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[10px] text-violet-700">sim {m.similarity}</span>
                <span className="ml-1 line-clamp-2">{m.text}</span>
              </div>
            ))}
          </div>
        )}
        {r.caseAnalysis?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">案例机制分析</div>
            {r.caseAnalysis.map((c: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border border-violet-200 p-2">
                <div className="text-[11px] font-medium">{c.case}</div>
                <p className="mt-0.5 text-[10px] text-primary/70">匹配命题：{c.matchedProposition}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">机制：{c.mechanism}</p>
              </div>
            ))}
          </div>
        )}
        {r.bridge && <div className="rounded bg-muted/30 p-2 text-[11px] text-muted-foreground">联结逻辑：{r.bridge}</div>}
        {r.limits && <p className="text-[10px] text-muted-foreground">适用边界：{r.limits}</p>}
      </div>
    ),
  },
  {
    id: "S64",
    title: "创新识别 · 信号扫描",
    desc: "输入主题 + 研究文本，算法扫描创新信号词（空白/争议/延伸）+ LLM 识别四类创新点",
    icon: <Sparkles className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "研究主题", placeholder: "如：资本下乡", type: "text" },
      { key: "text", label: "研究文本", placeholder: "粘贴研究现状描述…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.signals?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">创新信号（{r.signals.length}）</div>
            {r.signals.map((s: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-amber-200 p-1.5 text-[11px]">
                <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-700">{s.type}</span>
                <span className="ml-1 text-muted-foreground">{s.evidence}</span>
              </div>
            ))}
          </div>
        )}
        {r.limitations?.length > 0 && (
          <div className="rounded border border-red-200 p-2">
            <div className="text-xs font-semibold text-red-700">理论局限</div>
            {r.limitations.map((l: any, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {l.limit}</p>)}
          </div>
        )}
        {r.innovations?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">创新点（{r.innovations.length}）</div>
            {r.innovations.map((inv: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border border-violet-200 p-2">
                <div className="flex items-center gap-2 text-[11px] font-medium">
                  {inv.point}
                  <span className="rounded bg-violet-500/10 px-1 py-0.5 text-[10px] text-violet-700">{inv.type}</span>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{inv.rationale}</p>
              </div>
            ))}
          </div>
        )}
        {r.positioning && <div className="rounded bg-muted/30 p-2 text-[11px] text-muted-foreground">创新定位：{r.positioning}</div>}
      </div>
    ),
  },
  {
    id: "S65",
    title: "体系建构 · 一致性检测",
    desc: "输入命题（每行一条），LLM 整合为理论框架 + 算法检测命题张力与术语不一致",
    icon: <Database className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "主题", placeholder: "如：资本下乡", type: "text" },
      { key: "propositions", label: "命题（每行一条）", placeholder: "资本下乡通过产业带动促进农村经济发展\n资本下乡重塑乡村治理结构", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.contradictionSignals?.length > 0 && (
          <div className="rounded border border-red-200 p-2">
            <div className="text-xs font-semibold text-red-700">命题张力</div>
            {r.contradictionSignals.map((c: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c.text}</p>
            ))}
          </div>
        )}
        {r.framework && (
          <div className="rounded border border-violet-200 p-2">
            <div className="text-xs font-semibold">理论体系框架</div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{r.framework}</p>
          </div>
        )}
        {r.coreConcepts?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">核心概念</div>
            {r.coreConcepts.map((c: any, i: number) => (
              <div key={i} className="mb-1 rounded border p-1.5 text-[11px]">
                <b>{c.concept}</b>：{c.definition}
              </div>
            ))}
          </div>
        )}
        {r.propositionLinks?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">命题逻辑关系</div>
            {r.propositionLinks.map((l: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {l.from} → {l.to}（{l.relation}）</p>
            ))}
          </div>
        )}
        {r.coherence && <div className="rounded bg-muted/30 p-2 text-[11px] text-muted-foreground">自洽性：{r.coherence}</div>}
        {r.gaps?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">薄弱环节</div>
            {r.gaps.map((g: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {g}</p>)}
          </div>
        )}
      </div>
    ),
  },
];

export const TheoryToolsPanel: FC<TheoryToolsPanelProps> = ({ scenarioId }) => {
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
      let body: Record<string, unknown> = { model: model || undefined };
      if (scenarioId === "S65") {
        body = {
          topic: values.topic,
          propositions: (values.propositions ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean),
          model: model || undefined,
        };
      } else {
        for (const f of tool.fields) {
          if (values[f.key]) body[f.key] = values[f.key];
        }
      }
      const path = scenarioId === "S61" ? "/premise"
        : scenarioId === "S62" ? "/interdisciplinary"
        : scenarioId === "S63" ? "/bridge"
        : scenarioId === "S64" ? "/innovation"
        : "/system";
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
          {result.error && !result.detectedPremises && !result.premises && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {typeof result.error === "string" ? result.error : JSON.stringify(result.error).slice(0, 200)}
            </div>
          )}
          {tool.render(result)}
          {/* 文献预览（检索/分析用到的文献可预览+标注） */}
          <LiteraturePreviewPanel references={extractLiteratureRefs(result)} storageKeyPrefix="lit-Theory-" />

        </div>
      )}
    </div>
  );
};
