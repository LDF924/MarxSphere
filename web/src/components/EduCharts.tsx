// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EduCharts.tsx — 教育结果可视化图表（纯 CSS/SVG，无外部依赖）
// 从 EducationPanel 提取并扩展：
//   DonutChart 环形图（掌握度分布等占比展示）
//   MasteryBars 掌握度进度条（知识点 → 百分比条）
//   Timeline 时间线（答题历史/进度记录）
//   SimpleBars 分组柱状条（错题数/次数对比）
import type { ReactNode } from "react";

/** 环形图（占比分布） */
export function DonutChart({ data, centerLabel, centerValue }: {
  data: Array<{ label: string; value: number; color: string }>;
  centerLabel?: string; centerValue?: string | number;
}) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  if (total <= 0) return <div className="py-4 text-center text-xs text-muted-foreground">暂无数据</div>;
  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width="110" height="110" viewBox="0 0 110 110" className="shrink-0">
        <circle cx="55" cy="55" r={R} fill="none" stroke="var(--muted)" strokeWidth="14" />
        {data.map((d, i) => {
          const frac = Math.max(0, d.value) / total;
          const dash = frac * C;
          const el = (
            <circle key={i} cx="55" cy="55" r={R} fill="none"
              stroke={d.color} strokeWidth="14" strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-offset} transform="rotate(-90 55 55)" strokeLinecap="butt" />
          );
          offset += dash;
          return el;
        })}
        <text x="55" y="52" textAnchor="middle" className="fill-foreground" fontSize="16" fontWeight="bold">{centerValue ?? total}</text>
        <text x="55" y="68" textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">{centerLabel ?? "总数"}</text>
      </svg>
      <div className="space-y-1">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[10px]">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
            <span className="text-muted-foreground">{d.label}</span>
            <span className="ml-auto font-medium">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 掌握度进度条（知识点 → 百分比） */
export function MasteryBars({ points }: { points: Array<{ knowledge_point?: string; point?: string; score?: number | string; mastery_level?: string }> }) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const levelColor = (lvl?: string) => lvl === "mastered" ? "bg-emerald-500" : lvl === "fuzzy" ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-1.5">
      {points.slice(0, 8).map((p, i) => {
        const name = p.knowledge_point ?? p.point ?? `知识点 ${i + 1}`;
        const score = Math.round(Number(p.score ?? 0) * 100);
        return (
          <div key={i}>
            <div className="mb-0.5 flex items-center justify-between text-[10px]">
              <span className="truncate text-muted-foreground">{name}</span>
              <span className="ml-2 shrink-0 font-medium">{score}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={`h-full rounded-full ${levelColor(p.mastery_level)} transition-all`} style={{ width: `${Math.min(100, score)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 分组柱状条（错题数/次数对比） */
export function SimpleBars({ data, color = "#188038" }: { data: Array<{ label: string; value: number }>; color?: string }) {
  if (!data || data.length === 0) return <div className="py-3 text-center text-xs text-muted-foreground">暂无数据</div>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-16 shrink-0 truncate text-[10px] text-muted-foreground">{d.label}</span>
          <div className="h-3 flex-1 overflow-hidden rounded bg-muted/60">
            <div className="flex h-full items-center rounded bg-emerald-500/80 px-1 transition-all" style={{ width: `${(d.value / max) * 100}%`, backgroundColor: color }}>
              <span className="text-[9px] font-medium text-white">{d.value > 0 ? d.value : ""}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 时间线（答题历史/进度记录） */
export function Timeline({ items }: { items: Array<{ time?: string; title: string; detail?: string; color?: string }> }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="relative space-y-3 pl-4">
      <div className="absolute bottom-1 left-[5px] top-1 w-px bg-border" />
      {items.map((it, i) => (
        <div key={i} className="relative">
          <span className={`absolute -left-4 top-1 h-2.5 w-2.5 rounded-full border-2 border-background ${it.color || "bg-primary"}`} />
          <div className="rounded-lg border border-border bg-card p-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium">{it.title}</span>
              {it.time && <span className="ml-auto text-[9px] text-muted-foreground">{it.time}</span>}
            </div>
            {it.detail && <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{it.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 统计卡片（数值 + 标签） */
export function StatCards({ stats }: { stats: Array<{ label: string; value: string | number; color?: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map((s, i) => (
        <div key={i} className="rounded-lg border border-border/70 bg-card p-2.5 text-center">
          <div className="text-lg font-bold" style={{ color: s.color || "var(--foreground)" }}>{s.value}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/** 结果容器：图表优先的结构化展示 */
export function EduChartsBlock({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <div className="space-y-3">
      {title && <div className="text-xs font-semibold text-foreground/90">{title}</div>}
      {children}
    </div>
  );
}
