// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// EduResultView.tsx — 教育结果结构化渲染器（复赛 UI 升级）
// 把 API 返回的 JSON 渲染为漂亮的卡片/列表/标签/键值面板，而非原始 JSON 文本。
// 规则：
//   数组 → 卡片列表（每项一个卡片，标题取 id/num/title/name/question/topic 等字段）
//   对象 → 键值面板（标签 + 值；值递归渲染）
//   标量 → 直接显示（布尔 → ✅/⚠️，数字 → 徽标）
import type { ReactNode } from "react";

/** 从对象中提取"标题"字段 */
function pickTitle(obj: Record<string, unknown>): string | null {
  for (const k of ["title", "name", "question", "topic", "knowledgePoint", "point", "term", "dimension", "level", "action", "task", "content", "q"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0 && v.length < 60) return v;
  }
  return null;
}

/** 标签化显示（把长字符串按句子切块） */
function chunkText(s: string): string[] {
  return s.split(/(?<=[。！？!?；;])/).filter((x) => x.trim().length > 0);
}

function Scalar({ v }: { v: unknown }) {
  if (typeof v === "boolean") return <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">{v ? "✓ 是" : "✗ 否"}</span>;
  if (typeof v === "number") return <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700">{v}</span>;
  if (typeof v === "string") {
    if (!v) return <span className="text-muted-foreground/50">—</span>;
    return <span className="leading-relaxed text-foreground/85">{v}</span>;
  }
  if (v === null || v === undefined) return <span className="text-muted-foreground/50">—</span>;
  return <span>{String(v)}</span>;
}

/** 键值面板 */
function KeyValue({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0));
  return (
    <div className="divide-y divide-border/60 rounded-md border border-border/60 bg-background/60">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[110px_1fr] gap-2 px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">{k}</span>
          <div className="min-w-0">{typeof v === "object" ? <EduNode data={v} depth={1} /> : <Scalar v={v} />}</div>
        </div>
      ))}
    </div>
  );
}

/** 递归渲染节点 */
export function EduNode({ data, depth = 0 }: { data: unknown; depth?: number }) {
  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-muted-foreground/50">（空）</span>;
    return (
      <div className={`grid gap-1.5 ${data.length > 1 ? "sm:grid-cols-2" : ""}`}>
        {data.map((item, i) => {
          if (typeof item === "object" && item !== null) {
            const title = pickTitle(item as Record<string, unknown>);
            return (
              <div key={i} className="rounded-md border border-border/70 bg-card p-2">
                {title && <div className="mb-1 truncate text-[12px] font-semibold text-foreground">{title}</div>}
                <EduNode data={item} depth={depth + 1} />
              </div>
            );
          }
          return <div key={i} className="rounded-md bg-muted/50 px-2 py-1 text-[12px]"><Scalar v={item} /></div>;
        })}
      </div>
    );
  }
  if (typeof data === "object" && data !== null) return <KeyValue obj={data as Record<string, unknown>} />;
  return <Scalar v={data} />;
}

/** 结果卡片容器（统一风格：标题 + 图标点 + 内容；可选图表区） */
export function EduResultCard({ title, data, error, chart }: { title: string; data?: unknown; error?: string; chart?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-xs font-semibold text-foreground">{title}</span>
      </div>
      <div className="max-h-[420px] overflow-auto p-3">
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>
        ) : data === undefined || data === null ? (
          <div className="py-4 text-center text-xs text-muted-foreground">点击上方按钮查看结果</div>
        ) : (
          <div className="space-y-3">
            {chart && <div>{chart}</div>}
            <EduNode data={data} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 对话流（苏格拉底等交互式输出的展示） */
export function ChatBubble({ role, text }: { role: "ai" | "user"; text: string }) {
  return (
    <div className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
        role === "user" ? "rounded-br-sm bg-emerald-600 text-white" : "rounded-bl-sm bg-muted/60 text-foreground/85"
      }`}>{text}</div>
    </div>
  );
}

/** 步骤条（学习计划/路径的步骤展示） */
export function StepFlow({ steps, titles }: { steps: unknown[]; titles: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {steps.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">{titles[i] ?? `第 ${i + 1} 步`}</span>
          {i < steps.length - 1 && <span className="text-muted-foreground/50">→</span>}
        </span>
      ))}
    </div>
  );
}

/** 把字符串数组/对象数组快速渲染为标签组 */
export function TagGroup({ tags }: { tags: Array<string | { [k: string]: unknown }> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t, i) => {
        const label = typeof t === "string" ? t : pickTitle(t) ?? String(t);
        return <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground/80">{label}</span>;
      })}
    </div>
  );
}

export default EduResultCard;
