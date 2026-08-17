// ScenariosWorkbench.tsx — 全屏场景工作台（V256）
// 形态2：左侧场景信息+步骤向导（可勾选进度），右侧当前步骤的工具操作指引（用哪个工具/做什么/怎么操作）
// 每步可一键跳转到对应工具页面执行
import { useState, type FC } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, ChevronRight, Wrench, ExternalLink, RotateCcw } from "lucide-react";
import { cn } from "../lib/utils";
import { ClassicalToolsPanel } from "./ClassicalToolsPanel";
import { AcademicToolsPanel } from "./AcademicToolsPanel";
import { WritingToolsPanel } from "./WritingToolsPanel";
import { WritingOutputToolsPanel } from "./WritingOutputToolsPanel";
import { QualityCheckToolsPanel } from "./QualityCheckToolsPanel";
import { TheoryToolsPanel } from "./TheoryToolsPanel";
import { DocumentReader } from "./DocumentReader";
import { DragHandle } from "./ui/DragHandle";

/** 场景研究步骤：工具指引 + 可选跳转 */
export interface ScenarioStep {
  title: string;
  desc: string;
  /** 用哪个工具（可跳转的目标视图） */
  tool: "reason" | "literature" | "ask" | "truth" | "sciverse" | "skills" | "graph" | "policy" | "vault" | "jobs" | "documents" | "cjournal";
  toolLabel: string;
  /** 操作指引（怎么做） */
  how: string;
}

export interface ScenarioGuide {
  id: string;
  title: string;
  group: string;
  goal: string;
  steps: ScenarioStep[];
}

const TOOL_NAMES: Record<ScenarioStep["tool"], string> = {
  reason: "推理工作台",
  literature: "文献库",
  ask: "Ask 检索",
  truth: "知识页",
  sciverse: "外部检索",
  skills: "技能库",
  graph: "知识图谱",
  policy: "政策库",
  vault: "资料库",
  jobs: "Jobs 自动化",
  documents: "文档管理",
  cjournal: "政经C刊科研"
};

interface Props {
  guide: ScenarioGuide;
  onBack: () => void;
  onNavigate: (view: ScenarioStep["tool"]) => void;
}

export const ScenariosWorkbench: FC<Props> = ({ guide, onBack, onNavigate }) => {
  const [activeStep, setActiveStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());

  const toggleDone = (idx: number) => {
    setDoneSteps((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const step = guide.steps[activeStep];
  const progress = Math.round((doneSteps.size / guide.steps.length) * 100);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：返回 + 场景信息 + 进度 */}
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回场景列表
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">{guide.id}</span>
            <span className="text-sm font-medium text-foreground">{guide.title}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{guide.group}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{guide.goal}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{doneSteps.size}/{guide.steps.length} 步</span>
          <div className="h-1.5 w-24 overflow-hidden rounded bg-muted">
            <div className="h-full rounded bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* V399: 中列/右列分隔把手（能力面板 | 文献阅读器 可左右拉伸）；leftOffset=240 左列宽 */}
        <DragHandle leftVar="--guide-mid-w" defaultWidth={520} minWidth={300} maxWidth={1000} storageKey="scenarios-mid-width" offset={-9} leftOffset={240} />
        <div className="grid h-full min-h-0 grid-cols-[minmax(180px,240px)_minmax(0,1fr)] overflow-hidden xl:grid-cols-[minmax(180px,240px)_var(--guide-mid-w,minmax(0,1fr))_minmax(0,1fr)]">
        {/* 左：步骤向导（可勾选） */}
        <div className="min-h-0 overflow-y-auto border-r border-border/50 p-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">研究步骤</div>
          <div className="flex flex-col gap-1">
            {guide.steps.map((s, idx) => {
              const isActive = idx === activeStep;
              const isDone = doneSteps.has(idx);
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setActiveStep(idx)}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-2 text-left transition-colors",
                    isActive ? "bg-primary/10" : "hover:bg-accent/60"
                  )}
                >
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); toggleDone(idx); }}
                    className={cn("mt-0.5 shrink-0 cursor-pointer", isDone ? "text-green-600" : "text-muted-foreground/40 hover:text-muted-foreground")}
                    title={isDone ? "标记未完成" : "标记完成"}
                  >
                    {isDone ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className={cn("text-xs", isActive ? "font-medium text-foreground" : isDone ? "text-muted-foreground line-through" : "text-muted-foreground/80")}>
                      <span className="mr-1 font-mono text-[10px] text-primary/60">{idx + 1}</span>
                      {s.title}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground/60">{s.toolLabel}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 中：当前步骤详情 + 专属能力面板 + 工具指引 */}
        <div className="min-h-0 overflow-y-auto p-4">
          {/* 经典文本研究场景：专属能力交互面板（V349） */}
          {guide.group === "经典文本研究" && (
            <div className="mb-5">
              <ClassicalToolsPanel scenarioId={guide.id} />
            </div>
          )}
          {/* 学术研究场景：专属能力交互面板（S41-S45） */}
          {guide.group === "学术研究" && (
            <div className="mb-5">
              <AcademicToolsPanel scenarioId={guide.id} />
            </div>
          )}
          {/* 论文写作研究场景：专属能力交互面板（S46-S50） */}
          {guide.group === "论文写作研究" && (
            <div className="mb-5">
              <WritingToolsPanel scenarioId={guide.id} />
            </div>
          )}
          {/* 论文写作输出场景：专属能力交互面板（S51-S55） */}
          {guide.group === "论文写作输出" && (
            <div className="mb-5">
              <WritingOutputToolsPanel scenarioId={guide.id} />
            </div>
          )}
          {/* 论文质量检查场景：专属能力交互面板（S56-S60） */}
          {guide.group === "论文质量检查" && (
            <div className="mb-5">
              <QualityCheckToolsPanel scenarioId={guide.id} />
            </div>
          )}
          {/* 理论思辨拓展场景：专属能力交互面板（S61-S65） */}
          {guide.group === "理论思辨拓展" && (
            <div className="mb-5">
              <TheoryToolsPanel scenarioId={guide.id} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xl font-semibold text-primary/30">{String(activeStep + 1).padStart(2, "0")}</span>
            <div>
              <h3 className="text-lg font-semibold text-foreground">{step.title}</h3>
              <p className="text-xs text-muted-foreground">{step.desc}</p>
            </div>
          </div>

          <div className="mt-5 flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-primary">使用工具 · {TOOL_NAMES[step.tool]}</div>
              <p className="mt-1 text-sm leading-relaxed text-foreground/90">{step.how}</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate(step.tool)}
              className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              打开 {TOOL_NAMES[step.tool]}
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              disabled={activeStep === 0}
              onClick={() => setActiveStep((i) => Math.max(0, i - 1))}
              className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> 上一步
            </button>
            <button
              type="button"
              onClick={() => toggleDone(activeStep)}
              className={cn(
                "flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                doneSteps.has(activeStep)
                  ? "bg-green-600/15 text-green-700 hover:bg-green-600/25"
                  : "bg-accent text-muted-foreground hover:bg-accent/70"
              )}
            >
              {doneSteps.has(activeStep) ? <RotateCcw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {doneSteps.has(activeStep) ? "标记未完成" : "标记完成"}
            </button>
            <button
              type="button"
              disabled={activeStep === guide.steps.length - 1}
              onClick={() => setActiveStep((i) => Math.min(guide.steps.length - 1, i + 1))}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              下一步 <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 步骤导航（底部小点） */}
          <div className="mt-4 flex items-center gap-1">
            {guide.steps.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setActiveStep(idx)}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  idx === activeStep ? "w-6 bg-primary" : "w-2 bg-muted hover:bg-muted-foreground/40",
                  doneSteps.has(idx) && idx !== activeStep && "bg-green-500/60"
                )}
                title={`第 ${idx + 1} 步`}
              />
            ))}
          </div>
        </div>

        {/* 右：文献阅读器（全部 66 个场景统一，独立大栏）——检索文献→原文所见即所得标注 */}
        <div className="min-h-0 overflow-y-auto border-t border-border/50 p-3 xl:border-l xl:border-t-0">
          <DocumentReader storageKeyPrefix={`doc-${guide.id}`} />
        </div>
        </div>
      </div>
    </div>
  );
};
