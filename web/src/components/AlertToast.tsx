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
            <div className="text-[11px] font-semibold">{t.category === "circuit_breaker" ? "熔断" : t.category === "degradation" ? "检索降级" : t.category === "reflection" ? "反思修正" : "系统告警"}</div>
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
