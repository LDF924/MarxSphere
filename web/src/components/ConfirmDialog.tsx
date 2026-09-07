// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ConfirmDialog.tsx — 统一确认弹层(替代 window.confirm, UI审计T17)
// 用法: const [ask, setAsk] = useState<ConfirmSpec | null>(null);
//   <ConfirmDialog spec={ask} onDone={(ok) => { if (ok) doIt(); setAsk(null); }} />
//   setAsk({ title: "删除文档?", desc: "将永久删除该文档及全部版本", confirmText: "删除", danger: true });
import { AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";

export interface ConfirmSpec {
  title: string;
  desc?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function ConfirmDialog({ spec, onDone }: { spec: ConfirmSpec | null; onDone: (ok: boolean) => void }) {
  if (!spec) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={() => onDone(false)}>
      <div className="w-full max-w-sm rounded-xl border border-slate-600/60 bg-slate-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-2.5">
          <AlertTriangle className={cn("mt-0.5 h-5 w-5 shrink-0", spec.danger ? "text-rose-400" : "text-amber-400")} />
          <div>
            <p className="text-sm font-semibold text-slate-100">{spec.title}</p>
            {spec.desc && <p className="mt-1 text-xs leading-relaxed text-slate-400">{spec.desc}</p>}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => onDone(false)}
            className="rounded-lg border border-slate-600/60 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">
            {spec.cancelText ?? "取消"}
          </button>
          <button onClick={() => onDone(true)}
            className={cn("rounded-lg px-3 py-1.5 text-xs font-medium text-white",
              spec.danger ? "bg-rose-600 hover:bg-rose-500" : "bg-cyan-600 hover:bg-cyan-500")}>
            {spec.confirmText ?? "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
