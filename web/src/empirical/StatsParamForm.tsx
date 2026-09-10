// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// StatsParamForm.tsx — 统计 17 法动态参数表单(React 版, 移植自 Vue ParamField)
// schema 定义在 methodParams.ts(fields: checkbox/radio/select/number/group/text/info + fromVars)
import type { ParamFieldDef, VarDef } from "./methodParams";
import { varTypeMeta } from "./methodParams";

interface Props {
  fields: ParamFieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, val: unknown) => void;
  vars?: VarDef[]; // fromVars 过滤来源(上传数据变量)
  /** 当前方法 id(供 filter 特殊条件行渲染) */
  methodId?: string;
}

export function varsForFilter(vars: VarDef[], filter?: string): VarDef[] {
  if (!filter || filter === "all") return vars;
  return vars.filter((v) => v.type === filter);
}

interface CondRow { variable: string; operator: string; value: string }

export default function StatsParamForm({ fields, values, onChange, vars = [], methodId }: Props) {
  const set = (k: string, v: unknown) => onChange(k, v);

  // ── filter 方法: 可视化条件行(变量/运算符/值 + AND/OR + 添加/删除) ──
  if (methodId === "filter") {
    const conds = (values.conditions as CondRow[] | undefined) ?? [];
    const logic = String(values.logic ?? "and");
    const setConds = (c: CondRow[]) => set("conditions", c);
    return (
      <div className="space-y-1.5 text-[11px]">
        {conds.map((c, i) => (
          <div key={i} className="flex items-center gap-1">
            <select
              className="w-[38%] rounded-md border bg-background px-1 py-1 text-[10px]"
              value={c.variable}
              onChange={(e) => setConds(conds.map((x, j) => (j === i ? { ...x, variable: e.target.value } : x)))}
            >
              <option value="">变量</option>
              {vars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
            <select
              className="w-[22%] rounded-md border bg-background px-1 py-1 text-[10px]"
              value={c.operator}
              onChange={(e) => setConds(conds.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))}
            >
              {[">=", ">", "<=", "<", "==", "!="].map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            <input
              className="min-w-0 flex-1 rounded-md border bg-background px-1.5 py-1 text-[10px]"
              placeholder="值"
              value={c.value}
              onChange={(e) => setConds(conds.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
            <button type="button" title="删除条件"
              onClick={() => setConds(conds.length > 1 ? conds.filter((_, j) => j !== i) : [{ variable: "", operator: ">=", value: "" }])}
              className="rounded p-0.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-600">✕</button>
          </div>
        ))}
        <div className="flex items-center gap-2 pt-0.5">
          <label className="flex cursor-pointer items-center gap-1">
            <input type="radio" className="accent-emerald-600" checked={logic === "and"} onChange={() => set("logic", "and")} />
            <span className="text-[10px]">AND(全部满足)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input type="radio" className="accent-emerald-600" checked={logic === "or"} onChange={() => set("logic", "or")} />
            <span className="text-[10px]">OR(任一满足)</span>
          </label>
          <button type="button"
            onClick={() => setConds([...conds, { variable: "", operator: ">=", value: "" }])}
            className="ml-auto rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-500/20">+ 添加条件</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 text-[11px]">
      {fields.map((f, fi) => {
        if (f.kind === "info") {
          return <p key={fi} className="text-[10px] leading-relaxed text-muted-foreground">{f.label}</p>;
        }
        if (f.kind === "checkbox" && !f.options) {
          const on = !!values[f.key];
          return (
            <label key={fi} className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" className="accent-emerald-600" checked={on} onChange={(e) => set(f.key, e.target.checked ? 1 : 0)} />
              <span>{f.label}</span>
            </label>
          );
        }
        if (f.kind === "checkbox" && f.options) {
          const arr = (values[f.key] as unknown[]) ?? [];
          return (
            <div key={fi}>
              <div className="mb-1 font-medium text-foreground/80">{f.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {f.options.map((o) => {
                  const on = arr.includes(o.value);
                  return (
                    <button
                      key={String(o.value)}
                      type="button"
                      onClick={() => {
                        const next = on ? arr.filter((v) => v !== o.value) : [...arr, o.value];
                        set(f.key, next);
                      }}
                      className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${on ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700" : "hover:bg-accent"}`}
                    >{o.label}</button>
                  );
                })}
              </div>
            </div>
          );
        }
        if (f.kind === "radio") {
          return (
            <div key={fi}>
              <div className="mb-1 font-medium text-foreground/80">{f.label}</div>
              <div className="flex flex-col gap-1">
                {f.options?.map((o) => (
                  <label key={String(o.value)} className="flex cursor-pointer items-center gap-1.5">
                    <input type="radio" className="accent-emerald-600" checked={String(values[f.key]) === String(o.value)} onChange={() => set(f.key, o.value)} />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        }
        if (f.kind === "number") {
          return (
            <div key={fi} className="flex items-center justify-between gap-2">
              <label className="shrink-0 text-foreground/80">{f.label}</label>
              <input
                type="number"
                min={f.min}
                max={f.max}
                className="w-28 rounded-md border bg-background px-2 py-1 text-[11px]"
                value={String(values[f.key] ?? f.default ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </div>
          );
        }
        if (f.kind === "select") {
          const list = f.fromVars ? varsForFilter(vars, f.fromVars.filter) : [];
          if (f.fromVars?.multi) {
            const arr = (values[f.key] as string[]) ?? [];
            return (
              <div key={fi}>
                <div className="mb-1 font-medium text-foreground/80">{f.label}</div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((v) => {
                    const on = arr.includes(v.name);
                    return (
                      <button
                        key={v.name}
                        type="button"
                        onClick={() => {
                          const next = on ? arr.filter((n) => n !== v.name) : [...arr, v.name];
                          set(f.key, next);
                        }}
                        className={`rounded-md border px-2 py-1 text-[10px] ${on ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700" : "hover:bg-accent"}`}
                      >
                        {v.name} <span className="opacity-60">({varTypeMeta(v.type).label})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          }
          return (
            <div key={fi} className="flex items-center justify-between gap-2">
              <label className="shrink-0 text-foreground/80">{f.label}</label>
              <select
                className="w-40 rounded-md border bg-background px-2 py-1 text-[11px]"
                value={String(values[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
              >
                <option value="">(未选择)</option>
                {list.map((v) => <option key={v.name} value={v.name}>{v.name} ({varTypeMeta(v.type).label})</option>)}
              </select>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
