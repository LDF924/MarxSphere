// WritingOutputToolsPanel.tsx — 论文写作输出专属能力交互面板（S51-S55）
// 综述生成(五段结构) / 段落扩写(口语检测) / 学术要件(模板) / 引文格式化(三格式) / 语体适配(规则库)
import { useState, useEffect, type FC } from "react";
import { Loader2, Play, AlertTriangle, BookOpen, PenLine, FileText, Library, GraduationCap, Cpu, Copy, Check } from "lucide-react";
import { cn } from "../lib/utils";
import { LiteraturePreviewPanel, extractLiteratureRefs } from "./LiteraturePreviewPanel";

const API_BASE = "/api/writing-out";
const PROJECT_ID = "c609acbf-1d6e-4bd5-9ae1-92fa6c64021a";

interface WritingOutputToolsPanelProps {
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

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
      className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
      title="复制"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

const TOOLS: ToolDef[] = [
  {
    id: "S51",
    title: "综述生成 · 五段结构",
    desc: "输入主题，按 研究缘起→发展脉络→学派分歧→研究共识→现存不足 生成综述初稿，每观点标注来源",
    icon: <BookOpen className="h-4 w-4" />,
    fields: [
      { key: "topic", label: "综述主题", placeholder: "如：资本下乡的乡村治理效应", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.error && <div className="rounded bg-red-500/10 p-2 text-xs text-red-400">{r.error}</div>}
        {r.review?.sections?.map((s: any, i: number) => (
          <div key={i} className="rounded border p-2">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700">{i + 1}</span>
              {s.section}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{s.content}</p>
          </div>
        ))}
        {r.review?.citations?.length > 0 && (
          <div className="rounded bg-muted/30 p-2">
            <div className="text-xs font-semibold">引用文献（{r.review.citations.length}）</div>
            {r.review.citations.map((c: string, i: number) => <p key={i} className="mt-0.5 text-[10px] text-muted-foreground">• {c}</p>)}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S52",
    title: "段落扩写 · 口语检测",
    desc: "输入核心观点，扩写为严谨学术段落 + 算法扫描口语化/主观化表达并给出规范改写",
    icon: <PenLine className="h-4 w-4" />,
    fields: [
      { key: "coreIdea", label: "核心观点", placeholder: "如：资本下乡具有产业带动效应", type: "text" },
      { key: "topic", label: "研究主题（可选）", placeholder: "如：资本下乡", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.paragraph && (
          <div className="rounded border p-2">
            <div className="flex items-center gap-2 text-xs font-semibold">扩写段落</div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.paragraph}</p>
          </div>
        )}
        {r.informalDetected?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">口语化检测（{r.informalDetected.length} 处）</div>
            {r.informalDetected.map((d: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• "{d.text}"（{d.type}）</p>
            ))}
          </div>
        )}
        {r.theoryBasis && (
          <div className="rounded bg-muted/30 p-2">
            <div className="text-xs font-semibold">补充的理论依据</div>
            <p className="mt-1 text-[11px] text-muted-foreground">{r.theoryBasis}</p>
          </div>
        )}
        {r.improvements?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">表达规范对照</div>
            {r.improvements.map((imp: any, i: number) => (
              <div key={i} className="mt-1 text-[11px]">
                <span className="text-red-600 line-through">{imp.original}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                <span className="text-green-700">{imp.revised}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S53",
    title: "学术要件 · 模板生成",
    desc: "输入论文信息，按模板生成 摘要/关键词/引言/结论/英文摘要",
    icon: <FileText className="h-4 w-4" />,
    fields: [
      { key: "title", label: "论文标题", placeholder: "如：资本下乡的乡村治理效应研究", type: "text" },
      { key: "topic", label: "研究主题", placeholder: "如：资本下乡与乡村治理", type: "text" },
      { key: "method", label: "研究方法", placeholder: "如：案例研究法", type: "text" },
      { key: "findings", label: "核心发现", placeholder: "如：资本下乡通过产业带动重塑乡村治理结构", type: "text" },
      { key: "type", label: "类型", placeholder: "期刊论文 / 学位论文", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-2">
        {r.components?.abstract && (
          <div className="rounded border p-2">
            <div className="flex items-center gap-2 text-xs font-semibold"><span className="rounded bg-primary/10 px-1 py-0.5 text-[10px]">摘要</span>中文摘要 <Copyable text={r.components.abstract} /></div>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{r.components.abstract}</p>
          </div>
        )}
        {r.components?.keywords && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">关键词</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.components.keywords.split(/[；;]/).filter(Boolean).map((k: string, i: number) => (
                <span key={i} className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-700">{k}</span>
              ))}
            </div>
          </div>
        )}
        {r.components?.introduction && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">引言</div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.components.introduction}</p>
          </div>
        )}
        {r.components?.conclusion && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">结论</div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.components.conclusion}</p>
          </div>
        )}
        {r.components?.abstractEn && (
          <div className="rounded border p-2">
            <div className="flex items-center gap-2 text-xs font-semibold"><span className="rounded bg-primary/10 px-1 py-0.5 text-[10px]">EN</span>英文摘要 <Copyable text={r.components.abstractEn} /></div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.components.abstractEn}</p>
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S54",
    title: "引文格式化 · 三格式",
    desc: "粘贴参考文献，算法自动转换 GB/T 7714 / APA / MLA 格式 + LLM 核对修正",
    icon: <Library className="h-4 w-4" />,
    fields: [
      { key: "rawText", label: "参考文献原文", placeholder: "每行一条，如：张三. 资本下乡的治理效应[J]. 农业经济问题, 2023, 44(3): 56-68.", type: "textarea" },
      { key: "format", label: "目标格式", placeholder: "GB/T 7714 / APA / MLA", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.autoConverted?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">算法自动转换（{r.autoConverted.length} 条）→ {r.format}</div>
            {r.autoConverted.map((c: any, i: number) => (
              <div key={i} className="mb-1.5 rounded border p-1.5">
                <p className="text-[10px] text-muted-foreground line-through">{c.original}</p>
                <p className="mt-0.5 text-[11px] text-green-700">{c.converted}</p>
              </div>
            ))}
          </div>
        )}
        {r.llmConverted && (
          <div className="rounded border border-violet-200 p-2">
            <div className="text-xs font-semibold">LLM 完整转换</div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.llmConverted}</p>
          </div>
        )}
        {r.errors?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">核对发现问题</div>
            {r.errors.map((e: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {e.issue} → {e.fix}</p>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S55",
    title: "语体适配 · 五场景规则库",
    desc: "粘贴文本 + 选场景（期刊/学位/会议/宣传/课程），按规则库改写 + 口语检测",
    icon: <GraduationCap className="h-4 w-4" />,
    fields: [
      { key: "text", label: "原文", placeholder: "粘贴待适配的文本…", type: "textarea" },
      { key: "scene", label: "目标场景", placeholder: "期刊论文 / 学位论文 / 会议论文 / 理论宣传文稿 / 课程论文", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.style && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">语体规则：{r.scene}</div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{r.style.level}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.style.rules.map((rl: string, i: number) => (
                <span key={i} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700">{rl}</span>
              ))}
            </div>
          </div>
        )}
        {r.informalDetected?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">口语化检测（{r.informalDetected.length} 处）</div>
            {r.informalDetected.map((d: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• "{d.text}"（{d.type}）</p>
            ))}
          </div>
        )}
        {r.rewritten && (
          <div className="rounded border border-green-200 p-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-green-700">改写后 <Copyable text={r.rewritten} /></div>
            <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{r.rewritten}</p>
          </div>
        )}
        {r.adjustments?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">调整对照</div>
            {r.adjustments.map((a: any, i: number) => (
              <div key={i} className="mt-1 text-[11px]">
                <span className="text-muted-foreground">{a.aspect}：</span>
                <span className="text-red-600 line-through">{a.from}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                <span className="text-green-700">{a.to}</span>
              </div>
            ))}
          </div>
        )}
        {r.notes && <p className="text-[10px] text-muted-foreground">{r.notes}</p>}
      </div>
    ),
  },
];

export const WritingOutputToolsPanel: FC<WritingOutputToolsPanelProps> = ({ scenarioId }) => {
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
      const path = scenarioId === "S51" ? "/review"
        : scenarioId === "S52" ? "/paragraph"
        : scenarioId === "S53" ? "/components"
        : scenarioId === "S54" ? "/citation"
        : "/style";
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
          {loading ? "生成中…" : "开始生成"}
        </button>
      </div>


      {result && (
        <div className="mt-3 max-h-96 overflow-y-auto">
          {result.error && !result.review && !result.paragraph && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {typeof result.error === "string" ? result.error : JSON.stringify(result.error).slice(0, 200)}
            </div>
          )}
          {tool.render(result)}
          {/* 文献预览（检索/分析用到的文献可预览+标注） */}
          <LiteraturePreviewPanel references={extractLiteratureRefs(result)} storageKeyPrefix="lit-WritingOutput-" />

        </div>
      )}
    </div>
  );
};
