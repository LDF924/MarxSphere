// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// NavRail.tsx — 实证工作台左侧功能导航（V380+）
// 12 区段: 研究流程 11 项 + 方法执行(右侧工作区内嵌 16 方法网格)
import { ClipboardList, ScanSearch, FlaskConical, Stethoscope, Database, Wand2, ListChecks, Workflow, LineChart, FileText, BookMarked, PlaySquare } from "lucide-react";

export type SectionId =
  | "overview" | "generator" | "recognize" | "reliability" | "diagnosis" | "imputation"
  | "variables" | "pipeline" | "regression" | "interpretation" | "ledger" | "methods";

const SECTIONS: { id: SectionId; label: string; icon: any; ready?: boolean }[] = [
  { id: "overview", label: "工作台概览", icon: ClipboardList },
  { id: "generator", label: "问卷生成器", icon: Wand2 },
  { id: "recognize", label: "问卷识别", icon: ScanSearch },
  { id: "reliability", label: "信效度", icon: FlaskConical },
  { id: "diagnosis", label: "数据诊断", icon: Stethoscope },
  { id: "imputation", label: "LLM插补", icon: Database },
  { id: "variables", label: "变量敲定", icon: ListChecks },
  { id: "pipeline", label: "数据管道", icon: Workflow },
  { id: "regression", label: "回归", icon: LineChart },
  { id: "interpretation", label: "结果解释", icon: FileText },
  { id: "ledger", label: "证据账本", icon: BookMarked },
  { id: "methods", label: "方法执行", icon: PlaySquare },
];

export function NavRail({ active, onSelect, ready }: { active: SectionId; onSelect: (s: SectionId) => void; ready?: (id: SectionId) => boolean }) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 px-1 text-[10px] font-semibold text-muted-foreground">研究流程</div>
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        const isReady = ready ? ready(s.id) : true;
        return (
          <button
            key={s.id}
            onClick={() => isReady && onSelect(s.id)}
            disabled={!isReady}
            title={!isReady ? "前置闸门未通过" : undefined}
            className={`mb-0.5 flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${
              active === s.id
                ? "border-emerald-500/50 bg-emerald-500/10"
                : isReady
                  ? "hover:bg-accent"
                  : "cursor-not-allowed opacity-40"
            }`}
          >
            <Icon className={`h-3 w-3 shrink-0 ${active === s.id ? "text-emerald-600" : "text-muted-foreground"}`} />
            <span className="text-[11px] font-medium">{s.label}</span>
            {!isReady && <span className="ml-auto rounded bg-amber-100 px-1 text-[8px] text-amber-700">🔒</span>}
          </button>
        );
      })}
    </div>
  );
}
