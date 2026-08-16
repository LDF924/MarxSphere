// LlmModelSelector.tsx — LLM 模型选择组件（2026-08-07）
// 展示可用模型 + 角色映射，用户可切换各角色使用的模型
// v4: 支持 roles 参数按任务上下文过滤角色（Ask 全套 / Sciverse 仅检索 / 知网知识页仅 Claude 执行）
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

interface ModelOption {
  id: string;
  label: string;
  provider: "deepseek" | "dashscope" | "claude";
  desc: string;
  roles: string[];
}

const ROLE_LABELS: Record<string, string> = {
  reason: "推理合成", judge: "评测打分", review: "评审", plan: "规划", verify: "题型复核", strategy: "策略决策",
};

/** 任务上下文 → 可用角色（组件按需过滤，不复用同一套） */
export const TASK_ROLES = {
  /** Ask/推理完整链路：推理合成 + 评测 + 评审 + 规划 */
  full: ["reason", "judge", "review", "plan", "verify", "strategy"] as const,
  /** 外部检索/知网/知识页/技能页：仅查询改写 */
  search: ["reason"] as const,
  /** 自主任务：仅规划 */
  task: ["plan"] as const,
};

export function LlmModelSelector({ roles = TASK_ROLES.full, compact = false }: { roles?: readonly string[]; compact?: boolean }) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [roleMap, setRoleMap] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 点击外部关闭（弹层 portal 到 body，需同时排除按钮和弹层自身）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      const inRoot = rootRef.current && t instanceof Node && rootRef.current.contains(t);
      const inPanel = panelRef.current && t instanceof Node && panelRef.current.contains(t);
      if (!inRoot && !inPanel) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    fetch("/api/llm/models")
      .then((r) => r.json())
      .then((d) => {
        setModels(d.models || []);
        setRoleMap(d.roleMap || {});
      })
      .catch(() => {});
    // 2026-08-07 全局同步：任意选择器改模型 → 其他面板实时刷新
    const onModelChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { role: string; modelId: string };
      if (detail) setRoleMap((prev) => ({ ...prev, [detail.role]: detail.modelId }));
    };
    window.addEventListener("sag-model-change", onModelChange);
    return () => window.removeEventListener("sag-model-change", onModelChange);
  }, []);

  const setRole = async (role: string, modelId: string) => {
    // 2026-08-07 实时同步：本地立即更新 + 广播全局事件（其他面板同步）+ 后台持久化
    setRoleMap((prev) => ({ ...prev, [role]: modelId }));
    window.dispatchEvent(new CustomEvent("sag-model-change", { detail: { role, modelId } }));
    try {
      await fetch("/api/llm/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, modelId }),
      });
    } catch { /* 持久化失败不阻塞显示 */ }
  };

  const providerColor: Record<string, string> = {
    deepseek: "bg-blue-100 text-blue-700",
    dashscope: "bg-orange-100 text-orange-700",
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
          open ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
        )}
        title="LLM 模型选择（各角色独立配置）"
      >
        <Cpu className="h-3 w-3" />
        {!compact && <span>模型</span>}
        {/* 2026-08-07 显示该面板所有可见角色的模型（选哪个角色就显示哪个，实时同步） */}
        <span className="font-mono text-[10px]">
          {(() => {
            const visible = roles.length > 0 ? roles : (["reason"] as readonly string[]);
            const models = [...new Set(visible.map((r) => roleMap[r] || "deepseek-chat"))];
            return models.join(" · ");
          })()}
        </span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && createPortal(
        // createPortal 到 body：脱离所有玻璃框的 stacking context，永远置顶可点击
        <div
          ref={panelRef}
          className="fixed left-1/2 top-1/2 z-[9999] w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-3 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">LLM 模型选择</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              关闭 ✕
            </button>
          </div>
          <div className="mb-1.5 px-1 text-[10px] font-medium text-muted-foreground">可用模型</div>
          <div className="mb-2 grid grid-cols-2 gap-1">
            {models.map((m) => (
              <div key={m.id} className="rounded border border-border/60 px-1.5 py-1" title={m.desc}>
                <div className="flex items-center gap-1">
                  <span className="truncate font-mono text-[10px] text-foreground">{m.label}</span>
                  <span className={cn("ml-auto shrink-0 rounded px-1 py-0.5 text-[8px]", providerColor[m.provider])}>{m.provider}</span>
                </div>
                <div className="truncate text-[9px] text-muted-foreground/70">{m.desc}</div>
              </div>
            ))}
          </div>
          <div className="mb-1 px-1 text-[10px] font-medium text-muted-foreground">角色模型配置（切换立即生效）</div>
          {roles.length === 0 ? (
            <div className="text-[10px] text-muted-foreground/70">无可用角色（模型已全部改为 LLM API 直调）</div>
          ) : (
            <div className="space-y-1">
              {roles.map((role) => (
                <div key={role} className="flex items-center gap-1.5">
                  <span className="w-16 shrink-0 text-[10px] text-muted-foreground">{ROLE_LABELS[role] || role}</span>
                  <select
                    value={roleMap[role] || "deepseek-chat"}
                    onChange={(e) => void setRole(role, e.target.value)}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] text-foreground"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 border-t border-border/50 pt-1.5 text-[9px] text-muted-foreground/70">
            Claude Code 执行（面板 AI 按钮）使用注册表 claude 模型；切换推理/评审/规划角色模型后，后续调用立即生效
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
