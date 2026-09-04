// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ReviewerCard.tsx — 审查结果卡片(移植自 ai4s-research/open-science, MIT)
// 消费 ```review fenced JSON(经 splitReviewFence 解析), 可折叠/逐条 dismiss。
// 类型内联(web 不 import 后端 src/, 与 FormatEvalPanel 同约定)。
import { useState } from "react";

type FindingLevel = "ok" | "warn" | "error";

interface ReviewFinding {
  level: FindingLevel;
  title: string;
  evidence?: string;
  check?: string;
  tag?: string;
}

export interface ReviewerBlock {
  kind: "reviewer";
  findings: ReviewFinding[];
  note?: string;
}

const LEVEL_CLS: Record<string, { label: string; chip: string; border: string }> = {
  error: { label: "违规", chip: "text-red-300", border: "border-red-500/30 bg-red-500/5" },
  warn: { label: "存疑", chip: "text-amber-300", border: "border-amber-400/25 bg-amber-400/5" },
  ok: { label: "通过", chip: "text-emerald-300", border: "border-emerald-400/25 bg-emerald-400/5" },
};

const CHECK_LABEL: Record<string, string> = {
  citation: "引文", number: "数值", figure: "图表", domain: "领域", integrity: "完整性", format: "格式",
};

export function ReviewerCard({ block }: { block: ReviewerBlock }) {
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  if (block.findings.length === 0 && !block.note) return null;

  const visible = block.findings.filter((_: ReviewFinding, i: number) => !dismissed.has(i));
  const errs = visible.filter((f: ReviewFinding) => f.level === "error").length;
  const warns = visible.filter((f: ReviewFinding) => f.level === "warn").length;

  return (
    <div className="rounded-lg border border-violet-400/25 bg-violet-400/5">
      <button type="button" onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-violet-300">
        <span>🔍 智能审查</span>
        {!collapsed && (
          <span className="text-[10px] font-normal text-muted-foreground">
            {errs} 违规 · {warns} 存疑 · {visible.length - errs - warns} 通过
            {block.note ? " · 附注" : ""}
          </span>
        )}
        <span className={`ml-auto transition-transform ${collapsed ? "" : "rotate-180"}`}>▾</span>
      </button>
      {!collapsed && (
        <div className="space-y-1.5 px-3 pb-3">
          {visible.map((f: ReviewFinding, i: number) => {
            const m = LEVEL_CLS[f.level] ?? LEVEL_CLS.warn;
            return (
              <div key={i} className={`rounded-md border px-2.5 py-1.5 text-xs ${m.border}`}>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${m.chip}`}>{m.label}</span>
                  {f.check && <span className="text-[9px] text-muted-foreground">{CHECK_LABEL[f.check]}</span>}
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{f.title}</span>
                  <button type="button" onClick={() => setDismissed((s) => new Set(s).add(i))}
                    className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground" title="忽略此条">✕</button>
                </div>
                {f.evidence && <p className="mt-0.5 pl-1 text-[10px] leading-4 text-muted-foreground">{f.evidence}</p>}
                {f.tag && <p className="pl-1 font-mono text-[9px] text-muted-foreground/50">{f.tag}</p>}
              </div>
            );
          })}
          {block.note && <p className="pt-1 text-[10px] italic text-muted-foreground/60">注: {block.note}</p>}
        </div>
      )}
    </div>
  );
}
