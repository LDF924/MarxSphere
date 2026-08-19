// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// GateCard.tsx — 人工闸门卡片（V380+）: 选题/变量定义/识别策略/结果解释
// draft(可编辑, 编辑由各功能页的 upsert 处理) → locked → confirmed; 退回=回 draft + 级联回退
// 本组件只负责: 状态展示 + lock/confirm/reopen 动作 + 内容摘要 + 自定义渲染槽
import { useState } from "react";
import { Lock, CheckCircle2, RotateCcw, AlertTriangle } from "lucide-react";
import { apiEmpirical } from "../../lib/api";

export interface GateInfo { id: string; node: string; status: string; content: any; reopens: number; updated_at: string }

export function GateCard({
  gate, onRefresh, children,
}: { gate: GateInfo | null; onRefresh: () => void; children?: React.ReactNode }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nodeLabel: Record<string, string> = {
    topic: "选题", variable_definition: "变量定义", identification: "识别策略", result_interpretation: "结果解释",
  };

  const action = async (a: "lock" | "confirm" | "reopen") => {
    if (!gate) return;
    setBusy(true); setError("");
    try {
      await apiEmpirical.gateAction(gate.id, a, note);
      onRefresh(); setNote("");
    } catch (e: any) {
      setError(e?.message ?? "操作失败");
    } finally { setBusy(false); }
  };

  const statusStyle =
    gate?.status === "confirmed"
      ? "border-emerald-500/50 bg-emerald-500/5"
      : gate?.status === "locked"
        ? "border-amber-500/50 bg-amber-500/5"
        : "border-muted bg-card";

  return (
    <div className={`rounded-lg border p-2 ${statusStyle}`}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold">{nodeLabel[gate?.node ?? ""] ?? gate?.node}</span>
        <span className="rounded bg-black/5 px-1.5 py-0.5 text-[9px] font-medium">
          {gate?.status === "confirmed" ? "✅ 已确认" : gate?.status === "locked" ? "🔒 已锁定(待人工确认)" : "📝 草稿"}
        </span>
        {gate && gate.reopens > 0 && <span className="text-[9px] text-muted-foreground">退回 {gate.reopens} 次</span>}
        <div className="ml-auto flex gap-1">
          {gate?.status === "draft" && (
            <button className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] hover:bg-black/5" onClick={() => void action("lock")} disabled={busy}>
              <Lock className="h-3 w-3" /> 锁定
            </button>
          )}
          {gate?.status === "locked" && (
            <button className="flex items-center gap-1 rounded border border-emerald-600/30 bg-emerald-600/10 px-1.5 py-0.5 text-[9px] text-emerald-700 hover:bg-emerald-600/20" onClick={() => void action("confirm")} disabled={busy}>
              <CheckCircle2 className="h-3 w-3" /> 确认通过
            </button>
          )}
          {gate && gate.status !== "draft" && (
            <button className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] hover:bg-black/5" onClick={() => void action("reopen")} disabled={busy}>
              <RotateCcw className="h-3 w-3" /> 退回
            </button>
          )}
        </div>
      </div>

      {/* 内容渲染槽: 各功能页注入草稿编辑/内容展示 */}
      {children}

      {gate && gate.status !== "draft" && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            className="flex-1 rounded border bg-background px-1.5 py-0.5 text-[10px]"
            placeholder="退回原因(记录到审计日志)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      {error && <div className="mt-1 flex items-center gap-1 text-[10px] text-red-600"><AlertTriangle className="h-3 w-3" /> {error}</div>}
    </div>
  );
}
