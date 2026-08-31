// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ToolRunner.tsx — 通用工具执行组件(内嵌到各归属面板)
// 用法: <ToolRunner tool="pdf_convert" title="文档转换" fields={[...]} hint="..." />
import { useState, type FC } from "react";
import { Loader2, Play } from "lucide-react";
import { cn } from "../lib/utils";

export interface ToolField {
  key: string;
  label: string;
  placeholder?: string;
  type?: "text" | "textarea" | "select";
  options?: string[];
}

interface ToolRunnerProps {
  tool: string;
  title: string;
  fields: ToolField[];
  hint?: string;
  compact?: boolean;
}

export const ToolRunner: FC<ToolRunnerProps> = ({ tool, title, fields, hint, compact }) => {
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const run = async () => {
    setLoading(true); setError(""); setResult("");
    try {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        const v = form[f.key];
        if (f.type === "select" && (f.options?.[0] === "true" || f.options?.[0] === "false")) body[f.key] = v === "true";
        else if (v) body[f.key] = v;
      }
      const res = await fetch(`/api/agent/tools/${tool}/run`, {
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

  return (
    <div className={cn("rounded-lg border bg-card", compact ? "p-2.5" : "p-3")}>
      <div className={cn("flex items-center justify-between", compact ? "mb-1.5" : "mb-2")}>
        <div className="text-xs font-semibold">{title}</div>
        <button
          onClick={run}
          disabled={loading}
          className="flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          {loading ? "执行中…" : "执行"}
        </button>
      </div>
      <div className="space-y-1.5">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
            {f.type === "select" ? (
              <select
                value={form[f.key] ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
              >
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
      </div>
      {error && <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-400">{error}</div>}
      {result && (
        <div className="mt-2 rounded-md border bg-muted/20 p-2">
          {hint && <div className="mb-1 text-[10px] font-medium text-muted-foreground">{hint}</div>}
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-5">{result}</pre>
        </div>
      )}
    </div>
  );
};
