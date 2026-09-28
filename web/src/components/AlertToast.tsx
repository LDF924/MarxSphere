// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// AlertToast.tsx — 全局告警 toast（V364）
// 轮询 /api/alerts 未读数 → 新告警弹 toast（警告黄/错误红/严重深红），点击跳告警中心
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, AlertOctagon, X } from "lucide-react";
import { cn } from "../lib/utils";

interface ToastItem {
  id: string;
  level: "warning" | "error" | "critical";
  message: string;
  category: string;
}

/**
 * V418: 分类 → 中文标签。**漏掉的分类会显示成"系统告警"**, 不会报错 ——
 * 所以新增分类时这里必须同步(原先是三元链, 加一类就要再套一层, 更容易漏)。
 */
const ALERT_CATEGORY_LABELS: Record<string, string> = {
  circuit_breaker: "熔断",
  degradation: "检索降级",
  reflection: "反思修正",
  token: "密钥",
};

export function AlertToast({ onOpenAlerts }: { onOpenAlerts?: () => void }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const lastMaxId = useRef<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch("/api/alerts?limit=10");
        const j = await r.json();
        const alerts = j.alerts ?? [];
        const maxId = alerts[0]?.id;
        // 只弹 warning 以上级别的新告警（info 不打扰）
        const meaningful = alerts.filter((a: any) => a.level !== "info");
        const newest = meaningful[0];
        if (newest && newest.id !== lastMaxId.current) {
          lastMaxId.current = newest.id;
          const toast: ToastItem = { id: newest.id + "-" + Date.now(), level: newest.level, message: newest.message, category: newest.category };
          setToasts((prev) => [...prev.slice(-2), toast]);
          // 8 秒自动消失
          setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), 8000);
        }
      } catch { /* 忽略 */ }
    };
    void check();
    const timer = window.setInterval(check, 6000);
    return () => window.clearInterval(timer);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border p-3 shadow-lg backdrop-blur",
            t.level === "critical" ? "border-red-600 bg-red-950/90 text-red-50"
            : t.level === "error" ? "border-red-400 bg-red-900/90 text-red-50"
            : "border-amber-400 bg-amber-950/90 text-amber-50"
          )}
        >
          {t.level === "critical" ? <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <button onClick={onOpenAlerts} className="min-w-0 flex-1 text-left">
            {/*
              V418: 原先是个三元链, 末尾一律"系统告警"。加"密钥"分类时改成了查表 ——
              三元链每加一类都要再套一层, 而漏掉的那类**不会报错**, 只会显示成"系统告警",
              让人以为是别的问题。查表至少把映射集中在一处。
            */}
            <div className="text-[11px] font-semibold">{ALERT_CATEGORY_LABELS[t.category] ?? "系统告警"}</div>
            <p className="mt-0.5 line-clamp-2 text-[10px] leading-4 opacity-90">{t.message}</p>
          </button>
          <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
