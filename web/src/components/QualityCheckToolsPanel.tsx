// QualityCheckToolsPanel.tsx — 论文质量检查专属能力交互面板（S56-S60）
// 概念一致性(易混淆库) / 引文核查(模式统计) / 逻辑自洽(循环论证标记) / 学术不端(重合度) / 格式适配(规则库)
import { useState, useEffect, type FC } from "react";
import { Loader2, Play, AlertTriangle, Scale, Library, GitBranch, ShieldCheck, FileText, Cpu, ShieldAlert } from "lucide-react";
import { cn } from "../lib/utils";
import { LiteraturePreviewPanel, extractLiteratureRefs } from "./LiteraturePreviewPanel";

const API_BASE = "/api/quality";

interface QualityCheckToolsPanelProps {
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
    id: "S56",
    title: "概念一致性 · 易混淆库",
    desc: "粘贴论文文本，LLM 识别内涵不一致/偷换概念 + 算法按易混淆概念库（异化/物化、国家/政府等）扫描",
    icon: <Scale className="h-4 w-4" />,
    fields: [
      { key: "text", label: "论文文本", placeholder: "粘贴论文全文或段落…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.algorithmFlags?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <ShieldAlert className="h-3.5 w-3.5 text-red-500" /> 算法检测：易混淆概念对（{r.algorithmFlags.length}）
            </div>
            {r.algorithmFlags.map((f: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-amber-200 p-1.5 text-[11px]">
                <b>{f.pair}</b>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{f.diff}</p>
              </div>
            ))}
          </div>
        )}
        {r.inconsistencies?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">内涵不一致（{r.inconsistencies.length}）</div>
            {r.inconsistencies.map((inc: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-red-200 p-1.5 text-[11px]">
                <b>{inc.concept}</b>（{inc.location}）
                <p className="mt-0.5 text-[10px] text-muted-foreground">前：{inc.before}</p>
                <p className="text-[10px] text-muted-foreground">后：{inc.after}</p>
              </div>
            ))}
          </div>
        )}
        {r.confusions?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">混淆建议</div>
            {r.confusions.map((c: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c.concepts}：{c.suggestion}</p>
            ))}
          </div>
        )}
        {!r.algorithmFlags?.length && !r.inconsistencies?.length && !r.confusions?.length && (
          <div className="rounded bg-green-50 p-2 text-[11px] text-green-700">✓ 未发现概念一致性问题</div>
        )}
      </div>
    ),
  },
  {
    id: "S57",
    title: "引文核查 · 引用规范",
    desc: "粘贴论文文本 + 参考文献列表，LLM 核对引文一致性 + 算法统计直接/间接引用规范",
    icon: <Library className="h-4 w-4" />,
    fields: [
      { key: "text", label: "论文文本", placeholder: "粘贴含引文的正文…", type: "textarea" },
      { key: "referenceList", label: "参考文献列表", placeholder: "每行一条参考文献…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.stats && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">引文统计</div>
            <div className="mt-1 grid grid-cols-2 gap-1 text-[11px] text-muted-foreground">
              <span>直接引用：{r.stats.directQuotes}</span>
              <span>间接引用：{r.stats.indirectReferences}</span>
              <span>引文标记：{r.stats.citationMarkers}</span>
              <span>参考文献：{r.stats.referenceCount}</span>
            </div>
            <p className={cn("mt-1 text-[10px]", r.stats.quoteVerdict.includes("无") ? "text-red-600" : "text-green-600")}>{r.stats.quoteVerdict}</p>
          </div>
        )}
        {r.issues?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">引文问题（{r.issues.length}）</div>
            {r.issues.map((iss: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-red-200 p-1.5 text-[11px]">
                <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-700">{iss.problem}</span>
                <span className="ml-1">{iss.citation}</span>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{iss.detail}</p>
              </div>
            ))}
          </div>
        )}
        {r.mismatches?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">正文-文献对应</div>
            {r.mismatches.map((m: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">
                • {m.inText} ↔ {m.refList}（{m.status}）
              </p>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S58",
    title: "逻辑自洽 · 循环论证检测",
    desc: "粘贴论文文本，LLM 识别矛盾/循环/论据不足/推理跳跃 + 算法扫描循环论证信号词",
    icon: <GitBranch className="h-4 w-4" />,
    fields: [
      { key: "text", label: "论文文本", placeholder: "粘贴待检查文本…", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.algorithmFlags?.length > 0 && (
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-semibold">
              <ShieldAlert className="h-3.5 w-3.5 text-red-500" /> 算法检测：循环论证/矛盾信号（{r.algorithmFlags.length}）
            </div>
            {r.algorithmFlags.map((f: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-red-200 p-1.5 text-[11px]">
                <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-700">{f.type}</span>
                <span className="ml-1 font-mono text-[10px]">{f.text}</span>
              </div>
            ))}
          </div>
        )}
        {r.contradictions?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">逻辑矛盾（{r.contradictions.length}）</div>
            {r.contradictions.map((c: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-red-200 p-1.5 text-[11px]">
                <b>{c.position}</b>
                <p className="text-[10px] text-muted-foreground">{c.claim1} vs {c.claim2}</p>
              </div>
            ))}
          </div>
        )}
        {r.circular?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">循环论证（{r.circular.length}）</div>
            {r.circular.map((c: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c.argument}：{c.detail}</p>
            ))}
          </div>
        )}
        {r.jumps?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">推理跳跃</div>
            {r.jumps.map((j: any, i: number) => (
              <div key={i} className="mb-1 rounded border border-amber-200 p-1.5 text-[11px]">
                {j.from} → {j.to} <span className="text-[10px] text-muted-foreground">缺：{j.missing}</span>
              </div>
            ))}
          </div>
        )}
        {r.weakPoints?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">论据薄弱</div>
            {r.weakPoints.map((w: any, i: number) => (
              <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {w.claim}：{w.gap}</p>
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S59",
    title: "学术不端 · 重合度计算",
    desc: "粘贴论文 + 源文本，算法算 N-gram 重合度（6-gram 指纹）+ 定位长重合段 + LLM 提示引文位置",
    icon: <ShieldCheck className="h-4 w-4" />,
    fields: [
      { key: "text", label: "待查文本", placeholder: "粘贴论文片段…", type: "textarea" },
      { key: "sourceText", label: "源文本（疑似来源）", placeholder: "粘贴疑似来源文本（留空则只做内部检查）", type: "textarea" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.overlapRatio !== undefined && (
          <div className={cn("rounded p-2 text-xs font-medium",
            r.overlapRatio > 0.5 ? "bg-red-50 text-red-700" : r.overlapRatio > 0.2 ? "bg-amber-50 text-amber-700" : "bg-green-50 text-green-700")}>
            重合度 {r.overlapRatio} — {r.overlapVerdict}
          </div>
        )}
        {r.longMatches?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold">长段重合片段</div>
            {r.longMatches.map((m: any, i: number) => (
              <p key={i} className="mb-1 rounded border border-red-200 bg-red-50/50 p-1.5 text-[11px] text-red-700">"{m.segment}"</p>
            ))}
          </div>
        )}
        {r.unmarkedParagraphs?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">疑似未标注出处的段落</div>
            {r.unmarkedParagraphs.map((p: string, i: number) => (
              <p key={i} className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">• {p}</p>
            ))}
          </div>
        )}
        {r.citationNeeded?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">需补充引文的位置</div>
            {r.citationNeeded.map((c: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {c}</p>)}
          </div>
        )}
      </div>
    ),
  },
  {
    id: "S60",
    title: "格式适配 · 规则库",
    desc: "粘贴论文文本 + 选目标（期刊/学位/党校/高校学报），按规则库检测标题层级 + LLM 生成适配报告",
    icon: <FileText className="h-4 w-4" />,
    fields: [
      { key: "text", label: "论文文本", placeholder: "粘贴含标题的论文文本…", type: "textarea" },
      { key: "target", label: "目标格式", placeholder: "期刊论文 / 学位论文 / 党校期刊 / 高校学报", type: "text" },
    ],
    render: (r) => (
      <div className="space-y-3">
        {r.rules && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">格式规则：{r.target}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.rules.rules.map((rl: string, i: number) => (
                <span key={i} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-700">{rl}</span>
              ))}
            </div>
          </div>
        )}
        {r.detectedHeadings?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">检测到的标题层级</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.detectedHeadings.map((h: any, i: number) => (
                <span key={i} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{h.level}</span>
              ))}
            </div>
          </div>
        )}
        {r.headingIssues?.length > 0 && (
          <div className="rounded border border-amber-200 p-2">
            <div className="text-xs font-semibold text-amber-700">标题层级问题</div>
            {r.headingIssues.map((h: string, i: number) => <p key={i} className="mt-0.5 text-[11px] text-muted-foreground">• {h}</p>)}
          </div>
        )}
        {r.adjustments?.length > 0 && (
          <div className="rounded border p-2">
            <div className="text-xs font-semibold">格式调整对照</div>
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
        {r.formatNotes && <p className="text-[10px] text-muted-foreground">{r.formatNotes}</p>}
      </div>
    ),
  },
];

export const QualityCheckToolsPanel: FC<QualityCheckToolsPanelProps> = ({ scenarioId }) => {
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
      const body: Record<string, unknown> = { model: model || undefined };
      for (const f of tool.fields) {
        if (values[f.key]) body[f.key] = values[f.key];
      }
      const path = scenarioId === "S56" ? "/concept"
        : scenarioId === "S57" ? "/citation"
        : scenarioId === "S58" ? "/logic"
        : scenarioId === "S59" ? "/plagiarism"
        : "/format";
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
          {loading ? "检查中…" : "开始检查"}
        </button>
      </div>


      {result && (
        <div className="mt-3 max-h-96 overflow-y-auto">
          {result.error && !result.inconsistencies && !result.stats && (
            <div className="flex items-center gap-1.5 rounded bg-red-500/10 p-2 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {typeof result.error === "string" ? result.error : JSON.stringify(result.error).slice(0, 200)}
            </div>
          )}
          {tool.render(result)}
          {/* 文献预览（检索/分析用到的文献可预览+标注） */}
          <LiteraturePreviewPanel references={extractLiteratureRefs(result)} storageKeyPrefix="lit-QualityCheck-" />

        </div>
      )}
    </div>
  );
};
