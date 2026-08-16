// DragHandle.tsx — 通用分栏拖拽把手（overlay 方式，不改 grid 结构）
// 用法：在 grid 容器内放 <DragHandle leftVar="--filter-w" storageKey="xxx" />
// grid 列宽需用 var(--filter-w) 引用
import { useEffect, useRef } from "react";

interface DragHandleProps {
  /** 左列宽度 CSS 变量名（如 --filter-w）*/
  leftVar: string;
  /** 默认宽度（px）*/
  defaultWidth: number;
  /** localStorage 键 */
  storageKey: string;
  /** 宽度范围 */
  minWidth?: number;
  maxWidth?: number;
  /** 把手水平偏移（相对左列边缘）*/
  offset?: number;
}

export function DragHandle({ leftVar, defaultWidth, storageKey, minWidth = 160, maxWidth = 480, offset = -6 }: DragHandleProps) {
  const draggingRef = useRef(false);

  const readWidth = (): number => {
    try {
      const stored = localStorage.getItem(storageKey);
      const n = stored ? Number(stored) : defaultWidth;
      return n >= minWidth && n <= maxWidth ? n : defaultWidth;
    } catch {
      return defaultWidth;
    }
  };

  /** 同步宽度到 grid 内联 style + CSS 变量 + localStorage */
  const applyWidth = (w: number) => {
    try { localStorage.setItem(storageKey, String(w)); } catch { /* 忽略 */ }
    // 找使用该变量的 grid（把手兄弟中的 grid）
    const handle = handleRef.current;
    if (handle && handle.parentElement) {
      const grid = Array.from(handle.parentElement.children).find(c => c.tagName === "DIV" && (c.className || "").includes("grid"));
      if (grid) (grid as HTMLElement).style.setProperty(leftVar, `${w}px`);
    }
    document.documentElement.style.setProperty(leftVar, `${w}px`);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = readWidth();

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const w = Math.min(maxWidth, Math.max(minWidth, startW + (ev.clientX - startX)));
      applyWidth(w);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
  };

  const handleRef = useRef<HTMLDivElement | null>(null);

  // 初始从 localStorage 恢复宽度
  useEffect(() => {
    applyWidth(readWidth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={handleRef}
      className="absolute z-20 hidden w-1.5 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-primary/40 active:bg-primary/50 lg:block"
      style={{
        left: `calc(var(${leftVar}, ${defaultWidth}px) + ${offset}px)`,
        top: 0,
        bottom: 0
      }}
      onPointerDown={onPointerDown}
      title="拖动调节宽度"
    />
  );
}
