// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// CapabilityToolsPanel.tsx — V400: V399+V400 能力统一操作面板
// 覆盖: 5 个 Agent 工具(pdf_convert/gongwen_draft/video_note/truth_narrative/chart_digitize)
//      + 4 个运行时状态(预算/Elicitation/审批/Guardian熔断)
import { useState, useEffect, type FC } from "react";
import { Loader2, FileText, FileSignature, Video, BookOpenText, ChartColumn, Activity, ShieldAlert, MessageCircleQuestion, Gauge } from "lucide-react";
import { cn } from "../lib/utils";

interface ToolDef {
  name: string;
  label: string;
  category: string;
  icon: React.ReactNode;
  fields: Array<{ key: string; label: string; placeholder: string; type?: "text" | "textarea" | "select"; options?: string[] }>;
  resultHint: string;
}

const CATEGORIES = ["文档处理", "写作辅助", "内容采集", "知识沉淀", "数据分析"];

const TOOLS: ToolDef[] = [
  {
    name: "pdf_convert", label: "文档转换", category: "文档处理",
    icon: <FileText className="h-4 w-4" />,
    fields: [
      { key: "filePath", label: "文档路径", placeholder: "D:/xxx.pdf (pdf/png/jpg/docx/pptx/xlsx)", type: "text" },
      { key: "mode", label: "模式", type: "select", options: ["auto", "agent", "precision"], placeholder: "" },
      { key: "ocr", label: "启用 OCR", type: "select", options: ["false", "true"], placeholder: "" },
    ],
    resultHint: "转换结果 Markdown",
  },
  {
    name: "gongwen_draft", label: "公文起草", category: "写作辅助",
    icon: <FileSignature className="h-4 w-4" />,
    fields: [
      { key: "task", label: "任务", placeholder: "起草一份关于资本下乡规范引导的通知", type: "textarea" },
      { key: "docType", label: "文种", type: "select", options: ["", "通知", "请示", "报告", "函", "纪要", "通报", "批复", "意见", "决定", "调研报告", "工作总结", "工作方案"], placeholder: "" },
    ],
    resultHint: "按 GB/T 9704 规范的公文草稿",
  },
  {
    name: "video_note", label: "视频笔记", category: "内容采集",
    icon: <Video className="h-4 w-4" />,
    fields: [
      { key: "platform", label: "平台", type: "select", options: ["bilibili", "douyin"], placeholder: "" },
      { key: "url", label: "视频链接", placeholder: "https://www.bilibili.com/video/BVxxx", type: "text" },
    ],
    resultHint: "Markdown 学习笔记",
  },
  {
    name: "view_truth_narrative", label: "叙事导出", category: "知识沉淀",
    icon: <BookOpenText className="h-4 w-4" />,
    fields: [
      { key: "title", label: "知识页标题/主题", placeholder: "资本下乡的规范引导路径", type: "text" },
    ],
    resultHint: "六段张力叙事 + 证据阶梯",
  },
  {
    name: "view_chart_digitize", label: "图表数字化", category: "数据分析",
    icon: <ChartColumn className="h-4 w-4" />,
    fields: [
      { key: "imagePath", label: "图表图片/PDF 路径", placeholder: "D:/figure.png", type: "text" },
      { key: "chartType", label: "图表类型", type: "select", options: ["", "bar", "line", "scatter", "histogram", "boxplot"], placeholder: "" },
    ],
    resultHint: "预检路由 → 坐标确认 → CSV",
  },
];

export const CapabilityToolsPanel: FC = () => {
  const [activeTool, setActiveTool] = useState(TOOLS[0]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/agent/runtime-status");
        setStatus(await r.json());
      } catch { /* 状态不可用 */ }
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  const run = async () => {
    setLoading(true); setError(""); setResult("");
    try {
      const body: Record<string, unknown> = {};
      for (const f of activeTool.fields) {
        const v = form[f.key];
        if (f.type === "select" && (f.options?.[0] === "true" || f.options?.[0] === "false")) body[f.key] = v === "true";
        else if (v) body[f.key] = v;
      }
      const res = await fetch(`/api/agent/tools/${activeTool.name}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "执行失败"); return; }
      setResult(String(data.result || "").slice(0, 4000));
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 200));
    } finally {
      setLoading(false);
    }
  };

  const s = status as any;
  const guardian = s.guardian as any;
  const elicitation = s.elicitation as any;
  const reminders = s.reminders as any;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-violet-400" />
        <h2 className="text-sm font-semibold">工具集</h2>
      </div>

      {/* 运行时状态 — 内容级 */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><Gauge className="h-3.5 w-3.5 text-blue-400" />上下文预算提醒</div>
          <div className="mb-1 text-[10px] text-muted-foreground">窗口上限 {reminders?.contextWindowLimit?.toLocaleString() ?? "—"} · 提醒阈值 {reminders?.threshold?.toLocaleString() ?? "—"}</div>
          <div className="max-h-32 space-y-1 overflow-auto">
            {(reminders?.log || []).map((r: any, i: number) => (
              <div key={i} className="rounded bg-muted/20 px-2 py-1 text-[10px] leading-4">
                <span className="text-slate-500">[{r.at}] {r.kind}: </span>{r.message}
              </div>
            ))}
            {(reminders?.log || []).length === 0 && <div className="text-[10px] text-muted-foreground">（暂无提醒 — 任务运行时自动注入）</div>}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><MessageCircleQuestion className="h-3.5 w-3.5 text-amber-400" />Elicitation 澄清追问</div>
          <div className={cn("mb-1 text-[10px]", elicitation?.paused ? "text-amber-400" : "text-emerald-400")}>
            状态: {elicitation?.paused ? "工具等待用户追问中" : "正常（无待答追问）"}
          </div>
          <div className="max-h-32 space-y-1 overflow-auto">
            {(elicitation?.pending || []).map((p: any) => (
              <div key={p.id} className="rounded bg-amber-500/10 px-2 py-1 text-[10px]">{p.question}</div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><ShieldAlert className="h-3.5 w-3.5 text-orange-400" />审批三级链</div>
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between"><span className="text-muted-foreground">链路</span><span>PermissionHook → Guardian → User</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">审批缓存</span><span className="text-emerald-400">命令指纹已启用</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">高危工具</span><span>需经任务审批门</span></div>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold"><ShieldAlert className="h-3.5 w-3.5 text-red-400" />Guardian 熔断</div>
          <div className="space-y-1 text-[10px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">状态</span>
              <span className={cn("font-medium", guardian?.open ? "text-red-400" : "text-emerald-400")}>
                {guardian?.open ? "已触发（高危尝试已阻断）" : "正常"}
              </span>
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">连续拒绝</span><span>{guardian?.count ?? 0} / {guardian?.max ?? 3}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">复位</span><span>每轮任务开始自动重置</span></div>
          </div>
        </div>
      </div>

      {/* 工具选择 — 按类别分组 */}
      <div className="space-y-1.5">
        {CATEGORIES.map((cat) => {
          const tools = TOOLS.filter((t) => t.category === cat);
          if (tools.length === 0) return null;
          return (
            <div key={cat} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[10px] font-medium text-muted-foreground">{cat}</span>
              <div className="flex flex-wrap gap-1.5">
                {tools.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => { setActiveTool(t); setResult(""); setError(""); }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors",
                      activeTool.name === t.name ? "border-violet-500 bg-violet-500/10 text-violet-300" : "border-border bg-card text-muted-foreground hover:border-violet-500/50"
                    )}
                  >
                    {t.icon}{t.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* 表单 */}
      <div className="space-y-2 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold">{activeTool.icon}{activeTool.label}</div>
        {activeTool.fields.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
            {f.type === "select" ? (
              <select value={form[f.key] ?? ""} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} className="w-full rounded-md border bg-background px-2 py-1.5 text-xs">
                {f.options?.map((o) => <option key={o} value={o}>{o || "(默认)"}</option>)}
              </select>
            ) : (
              <textarea
                value={form[f.key] ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                rows={f.type === "textarea" ? 3 : 1}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
              />
            )}
          </label>
        ))}
        <button
          onClick={run}
          disabled={loading}
          className="mt-1 flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
          {loading ? "执行中…" : "执行"}
        </button>
        {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-400">{error}</div>}
        {result && (
          <div className="rounded-md border bg-muted/20 p-2">
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">{activeTool.resultHint}</div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-5">{result}</pre>
          </div>
        )}
      </div>
    </div>
  );
};
