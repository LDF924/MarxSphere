/**
 * FusionPanel — 科研中心融合容器(M1-M6 Vue 完整版单一形态)
 * 顶部马克思深色 chrome(标题 + 返回), 主体为 Vue 子应用 iframe。
 * Vue 子应用 dev 经 /soc proxy; 生产走 fastify-static web/dist/soc。
 *
 * 加载卡顿修复(单例保活 iframe 池):
 *   React 条件渲染会让 FusionPanel 在视图切换时 unmount → iframe 销毁 → Vue bundle 重新下载。
 *   改为: 模块级单例池(keepAlivePool)按 vueRoute 缓存已挂载 iframe; FusionPanel 首次进入某视图
 *   才真正创建 iframe, 之后切走再切回时把缓存的 iframe 重新插回(移动 DOM 节点, 不重载页面)。
 *   iframe 是 DOM 节点, React 卸载时如果节点已 detach 出容器, 就不会被销毁。
 */
import React, { useEffect, useRef, useState } from "react";

export interface FusionTabDef {
  /** Vue 完整版子应用 hash 路由 */
  vueRoute: string;
  /** 视图标题 */
  title: string;
  /** 能力说明(次要提示) */
  hint: string;
  /** 返回科研中心 */
  onBack?: () => void;
}

// ── 单例保活池: route → { iframe, key } ──
// React 卸载 FusionPanel 时 iframe 已 detach 到本池 → 节点不被销毁, 切回时重新挂载即恢复(无重载)
interface PoolEntry {
  iframe: HTMLIFrameElement;
  usedBy: string | null; // 当前借给哪个 panel key(防同一 iframe 被两个 tab 抢)
}
const keepAlivePool = new Map<string, PoolEntry>();
let poolHost: HTMLElement | null = null;
function ensurePoolHost() {
  if (!poolHost) {
    poolHost = document.createElement("div");
    poolHost.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;";
    document.body.appendChild(poolHost);
  }
  return poolHost;
}

export default function FusionPanel({ tab, panelKey }: { tab: FusionTabDef; panelKey: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const key = panelKey || tab.vueRoute;
  // 当前实际持有的池条目(cleanup 只归还它, 防 StrictMode/并发误归他人)
  const heldEntryRef = useRef<PoolEntry | null>(null);

  // 挂载: 从池取 iframe(首次则创建), 放入本面板容器
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensurePoolHost();
    let entry = keepAlivePool.get(key);
    if (!entry || entry.usedBy) {
      // 池无此 key 或被占用 → 新建(并顶掉旧残留, 防双份同路由 iframe)
      const prev = keepAlivePool.get(key);
      if (prev && prev.iframe.parentElement !== host) prev.iframe.remove();
      const iframe = document.createElement("iframe");
      iframe.src = `/soc/index.html#${tab.vueRoute}`;
      iframe.title = tab.title;
      iframe.setAttribute("allow", "clipboard-write; clipboard-read");
      iframe.style.cssText = "width:100%;height:100%;border:0;background:#0a1120;display:block;";
      iframe.addEventListener("load", () => setReady(true));
      entry = { iframe, usedBy: null };
      keepAlivePool.set(key, entry);
    } else if (entry.iframe.contentWindow && entry.iframe.contentWindow.location.href) {
      // 已加载过 → 直接 ready
      setReady(true);
    }
    entry.usedBy = key;
    heldEntryRef.current = entry;
    host.appendChild(entry.iframe); // 从宿主移入面板(不重新加载)
    return () => {
      // 卸载: 归还池(iframe 移回隐藏宿主保活, 页面状态不丢)
      const held = heldEntryRef.current;
      if (held && held.iframe.parentElement === host) {
        ensurePoolHost();
        poolHost!.appendChild(held.iframe);
        held.usedBy = null;
      }
      heldEntryRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "hsl(222 47% 7%)" }}>
      {/* 融合 chrome */}
      <div
        className="flex shrink-0 items-center gap-3 px-4 py-2"
        style={{ background: "hsl(222 45% 12%)", borderBottom: "1px solid hsl(217 33% 20%)" }}
      >
        {tab.onBack && (
          <button
            onClick={tab.onBack}
            title="返回科研中心"
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors hover:bg-white/10"
            style={{ color: "hsl(210 40% 96%)" }}
          >
            ← 返回
          </button>
        )}
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold" style={{ color: "hsl(210 40% 96%)" }}>{tab.title}</span>
          <span className="truncate text-[10px]" style={{ color: "hsl(215 20% 62%)" }}>{tab.hint}</span>
        </div>
        {!ready && (
          <span className="ml-auto shrink-0 text-[10px]" style={{ color: "hsl(215 20% 62%)" }}>加载中…</span>
        )}
      </div>
      {/* 主体占位: iframe 是池中 DOM 节点, 由 effect 移入 */}
      <div
        ref={hostRef}
        className="relative min-h-0 flex-1"
        style={{ position: "relative" }}
      >
        {!ready && (
          <div
            className="absolute inset-0 z-10 grid place-items-center"
            style={{ background: "hsl(222 47% 7%)", color: "hsl(215 20% 62%)", fontSize: 12 }}
          >
            正在加载工作台…
          </div>
        )}
      </div>
    </div>
  );
}
