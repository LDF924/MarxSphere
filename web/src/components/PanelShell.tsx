// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// PanelShell.tsx — 本次新增能力的统一外壳(2026-10-01)
//
// 由来: 第一版 7 个面板各写各的样式 —— 裸 `rounded-md` + 原生 input/select,
//   与项目其余面板(渐变头部 + 玻璃拟态卡片 + 胶囊 tab, 见 ImportsPanel)明显不是一个档次。
//   用户原话:"太简陋了太简单了太丑了"。
//
// 这里把**一套**外壳抽出来: 渐变头部(图标胶囊 + 标题 + 副标题 + 右侧动作) +
//   药丸式选项组 + 玻璃卡片 + 统一的输入/按钮/空态。各面板只填内容。
//   这样既统一, 也避免下次再各写各的。
//
// 配色按功能域取(与侧栏分类的 dot 色一致): 文献=emerald / 分析=violet /
//   写作=sky / 外部=amber / 生成=rose, 让用户扫一眼就知道自己在哪个域。
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

export type PanelAccent = "emerald" | "violet" | "sky" | "amber" | "rose" | "teal";

const ACCENT: Record<PanelAccent, { grad: string; icon: string; chip: string; ring: string; text: string }> = {
  emerald: {
    grad: "from-emerald-500/10 via-teal-500/5 to-transparent",
    icon: "from-emerald-500 to-teal-600 shadow-emerald-500/20",
    chip: "bg-emerald-600 text-white",
    ring: "border-emerald-500/30",
    text: "text-emerald-300",
  },
  violet: {
    grad: "from-violet-500/10 via-purple-500/5 to-transparent",
    icon: "from-violet-500 to-purple-600 shadow-violet-500/20",
    chip: "bg-violet-600 text-white",
    ring: "border-violet-500/30",
    text: "text-violet-300",
  },
  sky: {
    grad: "from-sky-500/10 via-cyan-500/5 to-transparent",
    icon: "from-sky-500 to-cyan-600 shadow-sky-500/20",
    chip: "bg-sky-600 text-white",
    ring: "border-sky-500/30",
    text: "text-sky-300",
  },
  amber: {
    grad: "from-amber-500/10 via-orange-500/5 to-transparent",
    icon: "from-amber-500 to-orange-600 shadow-amber-500/20",
    chip: "bg-amber-600 text-white",
    ring: "border-amber-500/30",
    text: "text-amber-300",
  },
  rose: {
    grad: "from-rose-500/10 via-pink-500/5 to-transparent",
    icon: "from-rose-500 to-pink-600 shadow-rose-500/20",
    chip: "bg-rose-600 text-white",
    ring: "border-rose-500/30",
    text: "text-rose-300",
  },
  teal: {
    grad: "from-teal-500/10 via-cyan-500/5 to-transparent",
    icon: "from-teal-500 to-cyan-600 shadow-teal-500/20",
    chip: "bg-teal-600 text-white",
    ring: "border-teal-500/30",
    text: "text-teal-300",
  },
};

export function panelAccent(a: PanelAccent) { return ACCENT[a]; }

/** 头部: 图标胶囊 + 标题 + 副标题 + 右侧动作 */
export function PanelHeader({
  icon, title, subtitle, accent = "emerald", actions,
}: {
  icon: ReactNode; title: string; subtitle?: string;
  accent?: PanelAccent; actions?: ReactNode;
}) {
  const a = ACCENT[accent];
  return (
    <div className={cn("relative overflow-hidden rounded-xl border bg-gradient-to-r p-3.5", a.grad)}>
      {/* 装饰光晕 —— 与 ImportsPanel 头部同一手法 */}
      <div className={cn("absolute -right-8 -top-8 h-28 w-28 rounded-full blur-2xl", a.icon.split(" ")[0].replace("from-", "bg-"))} style={{ opacity: 0.12 }} />
      <div className="relative flex flex-wrap items-center gap-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br shadow-lg", a.icon)}>
          <span className="text-white [&>svg]:h-4.5 [&>svg]:w-4.5">{icon}</span>
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** 药丸式选项组(替代原生 select 那种"随手一放"的观感) */
export function PillGroup<T extends string>({
  value, onChange, options, accent = "emerald", label,
}: {
  value: T; onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
  accent?: PanelAccent; label?: string;
}) {
  const a = ACCENT[accent];
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[10px] text-muted-foreground">{label}</span>}
      <div className="flex overflow-hidden rounded-lg border border-border/60">
        {options.map((o) => (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
            title={o.hint}
            className={cn(
              "px-2.5 py-1.5 text-[10px] font-medium transition-colors",
              value === o.value ? a.chip : "bg-background/60 text-muted-foreground hover:bg-accent",
            )}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 玻璃卡片 */
export function PanelCard({ title, icon, actions, children, className }: {
  title?: string; icon?: ReactNode; actions?: ReactNode;
  children: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex flex-col rounded-xl border bg-card/60 p-4 backdrop-blur-sm", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {icon && <span className="text-muted-foreground [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
          {title && <span className="text-xs font-semibold">{title}</span>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

/** 统一按钮 */
export function PanelButton({
  children, onClick, disabled, variant = "primary", accent = "emerald", busy, size = "md", type = "button", title, className,
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "primary" | "ghost" | "outline";
  accent?: PanelAccent; busy?: boolean; size?: "sm" | "md"; type?: "button" | "submit"; title?: string;
  className?: string;
}) {
  const a = ACCENT[accent];
  const base = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3.5 py-1.5 text-xs";
  const styles = variant === "primary"
    ? `bg-gradient-to-br ${a.icon} text-white shadow-md hover:brightness-110`
    : variant === "outline"
      ? `border ${a.ring} bg-transparent hover:bg-accent/40`
      : "border border-border/60 bg-background/60 hover:bg-accent";
  return (
    <button type={type} onClick={onClick} disabled={disabled || busy} title={title}
      className={cn("inline-flex items-center gap-1.5 rounded-lg font-medium transition-all disabled:opacity-50", base, styles, className)}>
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}

/** 统一输入 / 文本域 */
export const panelInputCls =
  "w-full rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs text-foreground " +
  "placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none backdrop-blur-sm";

/** 统一提示条 */
export function PanelNotice({ type, children }: { type: "ok" | "err" | "info" | "warn"; children: ReactNode }) {
  const cls = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    err: "border-red-500/30 bg-red-500/10 text-red-300",
    info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  }[type];
  return <div className={cn("rounded-lg border px-3 py-2 text-[11px] backdrop-blur-sm", cls)}>{children}</div>;
}

/** 空态 */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border/60 py-10 text-center">
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

/** 指标块(数字 + 说明) */
export function StatTile({ value, label, accent = "emerald" }: { value: ReactNode; label: string; accent?: PanelAccent }) {
  const a = ACCENT[accent];
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <div className={cn("text-lg font-bold tabular-nums", a.text)}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
