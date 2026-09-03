"use client";

import * as React from "react";
import { motion } from "motion/react";
import { CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";

export interface SourceLoadMetric {
  loaded: number;
  total: number;
  done: boolean;
  loading: boolean;
}

export interface SourceLoadProgress {
  sourceId: string;
  label: string;
  events: SourceLoadMetric;
  entities: SourceLoadMetric;
  allDone: boolean;
  loading: boolean;
}

const countFormatters = new Map<string, Intl.NumberFormat>();

function countFormatter(locale: string, compact: boolean) {
  const key = `${locale}:${compact ? "compact" : "standard"}`;
  const cached = countFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: 1,
  });
  countFormatters.set(key, formatter);
  return formatter;
}


const KNOWLEDGE_UNIVERSE_MESSAGES = {
  "loadProgress.rowAria": (label: string) => `${label}加载进度`,
  "loadProgress.complete": "已探索完整个时间范围，当前视图保持稳定",
  "loadProgress.loading": "正在预取相邻时间",
  "loadProgress.clickContinue": "在详情中选择“探索更多”",
  "loadProgress.browseContinue": "滚动继续探索时间；也可使用下方按钮精确前进或回退",
  "loadProgress.clickStart": "选择信息源开始探索",
  "loadProgress.browseStart": "选择信息源后，滚动进入时间探索",
  "loadProgress.title": "4D知识宇宙探索",
  "loadProgress.events": "已查询事件 / 来源总量",
  "loadProgress.entities": "当前缓存实体 / 来源总量",
};

function kuMessage(key: string, args?: Record<string, unknown>) {
  const entry = KNOWLEDGE_UNIVERSE_MESSAGES[key as keyof typeof KNOWLEDGE_UNIVERSE_MESSAGES];
  if (typeof entry === "function") return (entry as (label: string) => string)(args?.label as string);
  return entry as string;
}


export function compactCount(value: number, locale: string) {
  return countFormatter(locale, value >= 10_000).format(value);
}

const LoadProgressRow = React.memo(function LoadProgressRow({
  label,
  metric,
  tone,
}: {
  label: string;
  metric: SourceLoadMetric;
  tone: "entity" | "event";
}) {
  const locale = "zh-CN";
  const total = Math.max(metric.total, metric.loaded);
  const progress = total > 0
    ? Math.min(100, Math.max(0, metric.loaded / total * 100))
    : metric.done ? 100 : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-[10px] leading-none">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground/85">
          {compactCount(metric.loaded, locale)} / {compactCount(total, locale)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
        role="progressbar"
        aria-label={kuMessage("loadProgress.rowAria", { label })}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(metric.loaded, total)}
        data-loaded={metric.loaded}
        data-total={total}
      >
        <div
          data-tone={tone}
          className={cn(
            "h-full rounded-full transition-[width,filter] duration-500 ease-out",
            metric.loading && "brightness-110",
          )}
          style={{
            width: `${progress}%`,
            backgroundColor: "var(--universe-source-accent)",
            boxShadow: "0 0 10px color-mix(in srgb, var(--universe-source-accent), transparent 48%)",
          }}
        />
      </div>
    </div>
  );
});

export function UniverseLoadProgressPanel({
  progress,
  reducedMotion,
  explicitOnly,
}: {
  progress: SourceLoadProgress;
  reducedMotion: boolean;
  explicitOnly: boolean;
}) {
  const started = progress.events.loaded > 0 || progress.entities.loaded > 0;
  const status = progress.allDone
    ? kuMessage("loadProgress.complete")
    : progress.loading
      ? kuMessage("loadProgress.loading")
      : started
        ? explicitOnly ? kuMessage("loadProgress.clickContinue") : kuMessage("loadProgress.browseContinue")
        : explicitOnly ? kuMessage("loadProgress.clickStart") : kuMessage("loadProgress.browseStart");
  return (
    <motion.div
      data-universe-load-progress="true"
      data-source-id={progress.sourceId}
      data-load-state={progress.allDone ? "complete" : progress.loading ? "loading" : "idle"}
      role="status"
      aria-live="polite"
      className="pointer-events-none w-[min(15rem,calc(100vw-1.5rem))] rounded-md border border-border/60 bg-background/85 p-3 shadow-lg backdrop-blur-xl sm:w-64"
      style={{
        borderColor: "color-mix(in srgb, var(--universe-source-accent), transparent 62%)",
      }}
      initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.985 }}
      transition={{
        duration: reducedMotion ? 0 : 0.22,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-foreground/90" title={progress.label}>
            {kuMessage("loadProgress.title")}
          </p>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground" title={status}>
            {status}
          </p>
        </div>
        {progress.allDone ? (
          <CheckCircle2
            className="size-3.5 shrink-0"
            style={{ color: "var(--universe-source-accent)" }}
            aria-hidden="true"
          />
        ) : progress.loading ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin"
            style={{ color: "var(--universe-source-accent)" }}
            aria-hidden="true"
          />
        ) : (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{
              backgroundColor: "var(--universe-source-accent)",
              boxShadow: "0 0 7px color-mix(in srgb, var(--universe-source-accent), transparent 40%)",
            }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <LoadProgressRow label={kuMessage("loadProgress.events")} metric={progress.events} tone="event" />
        <LoadProgressRow label={kuMessage("loadProgress.entities")} metric={progress.entities} tone="entity" />
      </div>
    </motion.div>
  );
}

export function UniverseIconControl({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-10 border-border/70 bg-background/80 text-muted-foreground shadow-soft backdrop-blur-md hover:bg-background hover:text-foreground"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
