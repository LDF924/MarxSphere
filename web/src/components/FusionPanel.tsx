/**
 * FusionPanel — 科研中心融合容器(M1-M6 Vue 完整版单一形态)
 * 顶部马克思深色 chrome(标题 + 返回), 主体为 Vue 子应用 iframe。
 * Vue 子应用 dev 经 /soc proxy; 生产走 fastify-static web/dist/soc。
 */
import React from "react";

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

export default function FusionPanel({ tab }: { tab: FusionTabDef }) {
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "hsl(222 47% 7%)" }}>
      {/* 融合 chrome(马克思深色主题: 背景 hsl222/7, 边框 hsl217/20, 主蓝 hsl214/48) */}
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
      </div>
      {/* 主体: Vue 完整版 */}
      <iframe
        src={`/soc/index.html#${tab.vueRoute}`}
        title={tab.title}
        className="min-h-0 flex-1"
        style={{ width: "100%", border: 0, background: "#0a1120" }}
        allow="clipboard-write; clipboard-read"
      />
    </div>
  );
}
