// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EcoMethodPane.tsx — 计量因果 19 法执行面板(2026-09-09 统一分析台融合)
// 数据: 上层共享 parsed(行数据) — POST /api/empirical/run → 轮询 taskId → 结果(cols/rows 表 + svg 图)
import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Loader2, RotateCcw } from "lucide-react";
import { ECO_SCHEMAS, type EcoField } from "./econometricSchema";

export interface EcoMethod {
  id: string;
  label: string;
  desc: string;
  engine: string;
  category: string;
  skills: string[];
}

export interface EcoShared {
  parsed: { columnOrder: string[]; rows: (string | number | null)[][] } | null;
  csvText: string;
  preprocess: { winsorize: string[]; log: string[]; standardize: string[] };
  projectId?: string;
}

function fmtNum(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return v === null ? "" : String(v);
  const a = Math.abs(v);
  if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(3);
  if (a > 0 && a < 0.01) return v.toFixed(4);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

export default function EcoMethodPane({ method, data }: { method: EcoMethod; data: EcoShared }) {
  const schema = ECO_SCHEMAS[method.id] ?? { fields: [] };
  const [params, setParams] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [preprocess, setPreprocess] = useState(data.preprocess);

  useEffect(() => { setParams({}); setResult(null); setError(""); }, [method.id]);
  useEffect(() => { setPreprocess(data.preprocess); }, [data.preprocess]);

  const setP = (k: string, v: string) => setParams((p) => ({ ...p, [k]: v }));

  const hasData = !!data.parsed && data.parsed.rows.length > 0;
  const cols = data.parsed?.columnOrder ?? [];

  function renderField(f: EcoField) {
    const v = params[f.key] ?? "";
    if (f.kind === "col") {
      return (
        <label key={f.key} className="block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
          <select value={v} onChange={(e) => setP(f.key, e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]">
            <option value="">{cols.length ? "(选择列)" : "(先加载数据)"}</option>
            {cols.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      );
    }
    if (f.kind === "cols") {
      return (
        <label key={f.key} className="block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
          <input value={v} onChange={(e) => setP(f.key, e.target.value)} placeholder={f.placeholder} className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]" />
        </label>
      );
    }
    if (f.kind === "num") {
      return (
        <label key={f.key} className="block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
          <input type="number" value={v} onChange={(e) => setP(f.key, e.target.value)} placeholder={f.placeholder} className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]" />
        </label>
      );
    }
    if (f.kind === "select") {
      return (
        <label key={f.key} className="block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
          <select value={v || f.options?.[0]?.value} onChange={(e) => setP(f.key, e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-[11px]">
            {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      );
    }
    if (f.kind === "json") {
      return (
        <label key={f.key} className="block">
          <span className="mb-0.5 block text-[10px] font-medium text-muted-foreground">{f.label}</span>
          <textarea value={v} onChange={(e) => setP(f.key, e.target.value)} placeholder={f.placeholder} spellCheck={false}
            className="h-20 w-full rounded-md border bg-background p-2 font-mono text-[11px]" />
        </label>
      );
    }
    return null;
  }

  async function run() {
    if (!data.parsed || !data.parsed.rows.length) { setError("请先加载数据"); return; }
    setRunning(true); setError(""); setResult(null);
    try {
      const runParams: Record<string, unknown> = { ...params };
      // JSON 字段解析
      if (method.id === "genvars" && runParams.formulas) { try { runParams.formulas = JSON.parse(String(runParams.formulas)); } catch { setError("公式 JSON 格式错误"); setRunning(false); return; } }
      if (method.id === "filter" && runParams.conditions) { try { runParams.conditions = JSON.parse(String(runParams.conditions)); } catch { setError("条件 JSON 格式错误"); setRunning(false); return; } }
      // xs 逗号分隔 → 数组
      if (runParams.xs) runParams.xs = String(runParams.xs).split(",").map((x: string) => x.trim()).filter(Boolean);
      if (runParams.instruments) runParams.instruments = String(runParams.instruments).split(",").map((x: string) => x.trim()).filter(Boolean);
      // 数值化
      for (const k of ["cutoff", "treated_unit", "treatment_time"]) {
        if (runParams[k] !== undefined && runParams[k] !== "") runParams[k] = Number(runParams[k]);
      }
      const r = await fetch("/api/empirical/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        body: JSON.stringify({ data: data.parsed, method: method.id, params: runParams, preprocess, projectId: data.projectId }),
      }).then((res) => res.json()).catch(() => ({ ok: false, error: "请求失败" }));
      if (!r.ok || !r.taskId) { setError(r.error ?? "任务创建失败"); setRunning(false); return; }
      // 轮询
      const tid = r.taskId;
      for (let i = 0; i < 180; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const s = await fetch(`/api/empirical/result/${tid}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem("skf_auth_token") || localStorage.getItem("sag_token") || ""}` },
        }).then((res) => res.json()).catch(() => ({ status: "running" }));
        if (s.status === "done") { setResult(s.result ?? {}); setRunning(false); return; }
        if (s.status === "failed") { setError(s.error ?? "分析失败"); setRunning(false); return; }
      }
      setRunning(false); setError("分析超时");
    } catch (e: any) {
      setRunning(false); setError(String(e?.message ?? e));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{method.label}</div>
          <div className="text-[10px] text-muted-foreground">{method.desc} · 引擎: {method.engine}</div>
        </div>
        {hasData && <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[9px] text-emerald-700">{data.parsed!.rows.length} 行数据已加载</span>}
      </div>

      {!hasData && <div className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-700">⚠ 尚未加载数据 — 请先用统一数据栏上传/粘贴 CSV</div>}

      {schema.fields.length > 0 && (
        <div className="space-y-1.5 rounded-lg border p-2">
          {schema.fields.map(renderField)}
        </div>
      )}

      {(schema.extra ?? []).map((e, i) => (
        e.key === "_note" ? <div key={i} className="rounded bg-blue-500/5 px-2 py-1 text-[10px] text-blue-700">{e.label}</div>
          : <div key={i} className="rounded bg-blue-500/5 px-2 py-1 text-[10px] text-blue-700">{e.label}</div>
      ))}

      {method.id !== "descriptive" && schema.fields.length > 0 && (
        <div className="mt-2 rounded-lg border border-dashed p-2">
          <div className="mb-1 text-[10px] font-semibold text-muted-foreground">数据预处理 (可选)</div>
          <div className="flex flex-wrap gap-3">
            {(["winsorize", "log", "standardize"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-1 text-[10px]">
                <input type="checkbox" className="accent-emerald-600" checked={(preprocess[kind]?.length ?? 0) > 0}
                  onChange={(e) => setPreprocess((p) => ({ ...p, [kind]: e.target.checked ? (cols ?? []) : [] }))} />
                {kind === "winsorize" ? "Winsorize 1%/99%" : kind === "log" ? "取对数" : "标准化"}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={running || !hasData} onClick={() => void run()}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} 执行分析
        </button>
        <button type="button" onClick={() => setParams({})} className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[10px] hover:bg-accent">
          <RotateCcw className="h-3 w-3" /> 重置参数
        </button>
      </div>
      {error && <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-600">⚠ {error}</div>}

      {running && <div className="mt-3 flex items-center justify-center gap-2 py-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin text-emerald-600" /><span className="text-[10px]">沙箱执行中…</span></div>}

      {result && (
        <div className="mt-3 space-y-2">
          {result.tables?.map((t: any, i: number) => (
            <div key={i} className="overflow-x-auto rounded-lg border bg-card/50">
              {t.title && <div className="border-b bg-muted/20 px-2 py-1 text-[10px] font-medium">{t.title}</div>}
              <table className="w-full text-[10px]">
                <thead><tr className="border-b bg-muted/10 text-left">{(t.cols ?? []).map((c: string, ci: number) => <th key={ci} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
                <tbody>{(t.rows ?? []).map((r: any[], ri: number) => (
                  <tr key={ri} className="border-b last:border-0 odd:bg-muted/5">{(r ?? []).map((v, ci) => <td key={ci} className={`px-2 py-1 ${ci === 0 ? "font-medium" : ""}`}>{fmtNum(v)}</td>)}</tr>
                ))}</tbody>
              </table>
              {t.notes && <div className="border-t bg-muted/10 px-2 py-1 text-[9px] text-muted-foreground">{t.notes}</div>}
            </div>
          ))}
          {result.figures?.map((f: any, i: number) => (
            <div key={i} className="rounded-lg border bg-card/50 p-1.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium">{f.title}</span>
              </div>
              <div dangerouslySetInnerHTML={{ __html: f.svg ?? "" }} />
            </div>
          ))}
          {result.diagnostics?.map((d: any, i: number) => (
            <div key={i} className="rounded-lg border bg-muted/20 p-2 text-[10px]">
              <span className="font-medium">{d.name}:</span> <span className="text-muted-foreground">{d.verdict}</span>
            </div>
          ))}
          {!result.tables?.length && !result.figures?.length && <div className="py-3 text-center text-[10px] text-muted-foreground">{result.warnings?.length ? result.warnings.join("; ") : "无输出内容"}</div>}
        </div>
      )}
    </div>
  );
}
