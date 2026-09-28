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
  /**
   * 2026-09-28 加: hint 是**一串并列项**时, 按项目渲染而不是整行截断。
   *
   * 由来: 写作舱那行是「选题界定 → 框架设计 → 文献与资料 → 章节写作 → 统稿定稿」——
   *   它本来就是**五个阶段**, 却在头栏里被挤成窄窄一条(实测 351px)连成一句读到底。
   *   置 true 时按分隔符拆开、一项一个胶囊, 放不下**整块换行**;
   *   而原来的 `truncate` 会在窄屏把后面的阶段直接截掉, 用户看不到全貌。
   * 不传则维持原来的单行行为 —— 其余 tab 的 hint 是一句话, 不需要拆。
   */
  hintList?: boolean;
  /** 返回科研中心 */
  onBack?: () => void;
}

/**
 * 把 hint 拆成「一句话前缀」+「并列项列表」。
 *
 * 例: "阶段化论文研究: 选题界定 → 框架设计 → 文献与资料 → 章节写作 → 统稿定稿"
 *   → { lead: "阶段化论文研究", steps: ["选题界定", "框架设计", "文献与资料", "章节写作", "统稿定稿"] }
 *
 * ⚠ 前缀与第一项**不能混成一个胶囊** —— 那正是用户要分开的地方(「阶段化论文研究」一行,
 *   五个阶段另一行)。所以先在中英文冒号处切开, 再切箭头/顿号。
 * 没有冒号时 lead 为空, 整串都当并列项。
 */
function parseHint(hint: string): { lead: string; steps: string[] } {
  const m = hint.match(/^(.*?)[：:]\s*(.+)$/);
  const lead = m ? m[1].trim() : "";
  const rest = m ? m[2] : hint;
  const steps = rest.split(/\s*(?:→|->|·|、|;|；)\s*/).map((s) => s.trim()).filter(Boolean);
  return { lead, steps };
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
    } else {
      // 已加载过 → 直接 ready(读 location 需 try/catch: dev 下 React(4174) 与 Vue(5174)
      // 跨域, 裸读 contentWindow.location.href 会抛 SecurityError — V415 修复)
      try {
        if (entry.iframe.contentWindow && entry.iframe.contentWindow.location.href) {
          setReady(true);
        }
      } catch {
        // 跨域不可读 → 以 load 事件为准(load 未触时下面兜底置 ready, 避免永远 loading)
        setReady(true);
      }
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
            ← 科研中心
          </button>
        )}
        {/*
          ⚠ 必须是 `flex-1` —— 原来这列是 `flex min-w-0 flex-col`, 宽度**由内容撑**
            (实测只有 359px, 而视口 1422px), 于是头栏右侧空了一大块, 而药丸行还在
            那 359px 里被 `flex-wrap` 挤成了两行(用户看到的正是这个)。
            撑满之后: 药丸一行放得下(实测总宽约 364px), 右侧也不再是"被截断的一小栏"。
        */}
        {/*
          ⚠ 2026-09-28 第三次修正 —— 前两版都理解反了, 记下来免得再绕:
            ① 第一版: 标题一行、hint 一行 → 用户说"栏目全是两行";
            ② 我以为是"五个阶段挤成一行"要拆开 → 把它拆成了**三行**, 更糟;
            ③ 用户要的是: **标题与说明在同一行**。五个 tab **全部**都是这个诉求,
               不只是写作舱 —— 所以这里不能按 tab 分支, 必须统一。
          现在: 一行里 `标题 · 说明[ · 胶囊…]`, 整行 nowrap + 横向滚动兜底(窄屏能滑, 不折行也不截断)。
        */}
        <div className="flex min-w-0 flex-1 items-baseline gap-x-2 overflow-x-auto">
          <span className="shrink-0 text-[13px] font-semibold" style={{ color: "hsl(210 40% 96%)" }}>{tab.title}</span>
          <span className="shrink-0 text-[10px]" style={{ color: "hsl(215 20% 45%)" }}>·</span>
          {tab.hintList ? (
            /* 并列项: 前缀与各阶段都排在**同一行**上; 不再是上下两块 */
            <>
              {parseHint(tab.hint).lead && (
                <span className="shrink-0 text-[10px]" style={{ color: "hsl(215 20% 62%)" }}>
                  {parseHint(tab.hint).lead}:
                </span>
              )}
              {parseHint(tab.hint).steps.map((step, i, arr) => (
                <React.Fragment key={step + i}>
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] leading-none"
                    style={{ background: "hsl(217 33% 18%)", color: "hsl(215 20% 72%)" }}
                  >
                    {step}
                  </span>
                  {i < arr.length - 1 && (
                    <span className="shrink-0 text-[10px]" style={{ color: "hsl(215 20% 45%)" }}>→</span>
                  )}
                </React.Fragment>
              ))}
            </>
          ) : (
            <span className="shrink-0 text-[10px]" style={{ color: "hsl(215 20% 62%)" }}>{tab.hint}</span>
          )}
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
