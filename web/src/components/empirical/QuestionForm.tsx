// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// QuestionForm.tsx — 统一 Question 渲染/编辑（V380+）
import { useState } from "react";
import type { Question } from "../../lib/api";

export function QuestionForm({ q, onChange, readOnly }: { q: Question; onChange?: (q: Question) => void; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false);
  const canEdit = !readOnly;

  const set = (patch: Partial<Question>) => onChange?.({ ...q, ...patch });

  return (
    <div className="rounded-lg border bg-card p-2" onClick={() => canEdit && setEditing(true)}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{q.qid}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium">{q.stem}</span>
            <span className={`rounded px-1 py-0.5 text-[9px] ${
              q.type === "cat" ? "bg-blue-100 text-blue-700" :
              q.type === "ordinal" ? "bg-violet-100 text-violet-700" :
              q.type === "cont" ? "bg-emerald-100 text-emerald-700" :
              q.type === "multi" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-700"
            }`}>{q.type}</span>
            <span className="rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">{q.varName}</span>
            {q.skipLogic && <span className="rounded bg-rose-100 px-1 py-0.5 text-[9px] text-rose-700">跳转</span>}
          </div>
          {q.options && q.options.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {q.options.map((o) => (
                <span key={o.code} className="rounded bg-muted/50 px-1.5 py-0.5 text-[9px] text-muted-foreground">{o.code}={o.label}</span>
              ))}
            </div>
          )}
          {q.derived && <div className="mt-1 text-[9px] text-emerald-700">衍生: {q.derived}</div>}
        </div>
      </div>

      {editing && canEdit && (
        <div className="mt-2 space-y-1.5 border-t pt-2" onClick={(e) => e.stopPropagation()}>
          <label className="block">
            <span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">题号</span>
            <input className="w-full rounded border bg-background px-1.5 py-0.5 text-[11px]" value={q.qid} onChange={(e) => set({ qid: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">变量名</span>
            <input className="w-full rounded border bg-background px-1.5 py-0.5 font-mono text-[11px]" value={q.varName} onChange={(e) => set({ varName: e.target.value.replace(/[^a-z0-9_]/g, "") })} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">题干</span>
            <textarea className="h-14 w-full rounded border bg-background px-1.5 py-0.5 text-[11px]" value={q.stem} onChange={(e) => set({ stem: e.target.value })} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">类型</span>
            <select className="w-full rounded border bg-background px-1.5 py-0.5 text-[11px]" value={q.type} onChange={(e) => set({ type: e.target.value as Question["type"] })}>
              {["cat", "ordinal", "cont", "text", "multi"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[9px] font-medium text-muted-foreground">衍生变量建议</span>
            <input className="w-full rounded border bg-background px-1.5 py-0.5 text-[11px]" value={q.derived ?? ""} onChange={(e) => set({ derived: e.target.value })} />
          </label>
          <div className="flex gap-1">
            <button className="rounded border px-2 py-0.5 text-[10px] hover:bg-accent" onClick={() => setEditing(false)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );
}
