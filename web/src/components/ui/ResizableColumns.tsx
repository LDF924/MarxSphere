// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// ResizableColumns.tsx — 可拖拽分栏组件
// 左列固定拖拽宽度 + 右列自适应，拖拽把手在中间
import { useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface ResizableColumnsProps {
  left: ReactNode;
  right: ReactNode;
  /** 初始左列宽度（px） */
  initialLeft?: number;
  /** 左列最小/最大宽度 */
  minLeft?: number;
  maxLeft?: number;
  className?: string;
  /** localStorage 保存键（跨会话记住用户调整） */
  storageKey?: string;
}

export function ResizableColumns({
  left,
  right,
  initialLeft = 280,
  minLeft = 160,
  maxLeft = 480,
  className,
  storageKey
}: ResizableColumnsProps) {
  const [leftWidth, setLeftWidth] = useState(() => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          const n = Number(stored);
          if (n >= minLeft && n <= maxLeft) return n;
        }
      } catch { /* 忽略 */ }
    }
    return initialLeft;
  });
  const draggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startWidth = leftWidth;

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const delta = ev.clientX - startX;
      const next = Math.min(maxLeft, Math.max(minLeft, startWidth + delta));
      setLeftWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      if (storageKey) {
        try { localStorage.setItem(storageKey, String(leftWidth)); } catch { /* 忽略 */ }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
  };

  return (
    <div className={cn("flex min-h-0 flex-1", className)}>
      {/* 左列 */}
      <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: leftWidth }}>
        {left}
      </div>

      {/* 拖拽把手 */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        className="group relative z-10 mx-1 w-1.5 shrink-0 cursor-col-resize rounded-full transition-colors hover:bg-primary/30 active:bg-primary/50"
        title="拖动调节宽度"
      >
        <div className="absolute left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border group-hover:bg-primary/50" />
      </div>

      {/* 右列 */}
      <div className="min-h-0 min-w-0 flex-1">
        {right}
      </div>
    </div>
  );
}
