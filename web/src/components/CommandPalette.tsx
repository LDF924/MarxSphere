// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// CommandPalette.tsx — 命令面板(Ctrl+Shift+K, 移植 open-science CommandPalette 概念, MIT)
// 快速跳转任意视图 + 主题切换 + 新建会话; 轻量自实现(输入过滤/键盘导航/鼠标兼容)
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

export interface PaletteAction {
  id: string;
  label: string;       // 中文名
  group: string;       // 分组(对话/科研/知识/…)
  keywords?: string;   // 额外搜索词(英文名等)
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  actions,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  footer?: string;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setQuery(""); setCursor(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => {
      const hay = `${a.label} ${a.group} ${a.keywords ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [actions, query]);

  // 重置 cursor 防越界
  useEffect(() => { if (cursor >= filtered.length) setCursor(0); }, [filtered.length, cursor]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
      if (e.key === "Enter" && filtered[cursor]) { e.preventDefault(); filtered[cursor].run(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, cursor, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border/70 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            placeholder="跳转到视图 / 执行命令…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50" />
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground/60">无匹配项</div>
          ) : (
            [...new Set(filtered.map((a) => a.group))].map((group) => (
              <div key={group}>
                <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">{group}</div>
                {filtered.filter((a) => a.group === group).map((a) => {
                  const idx = filtered.indexOf(a);
                  return (
                    <button key={a.id} type="button"
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => { a.run(); onClose(); }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${cursor === idx ? "bg-primary/10 text-primary" : "text-foreground hover:bg-accent/40"}`}>
                      {a.label}
                      {cursor === idx && <span className="ml-auto text-[9px] text-muted-foreground/50">↵</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        {footer && <div className="border-t border-border/40 px-3 py-1.5 text-[9px] text-muted-foreground/50">{footer}</div>}
      </div>
    </div>
  );
}
