import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * Card — 产品基座卡片（finesse 升级 2026-08-07）
 * glass 玻璃层 + hairline 边框 + 圆角 12px；不再叠加额外 glow（保持克制）
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border/80 glass", className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-border px-4 py-3", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0 p-4", className)} {...props} />;
}
