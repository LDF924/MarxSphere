/**
 * FusionPanel — 科研中心融合视图(React 原有面板 ↔ Vue 完整还原版 双形态切换)
 * 形态: 顶部马克思深色 chrome(标题 + 形态切换 pill), 主体渲染 React 面板或 Vue iframe。
 * Vue 子应用 dev 经 /soc proxy; 生产走 fastify-static web/dist/soc。
 */
import React, { useState } from "react";

export interface FusionTabDef {
  /** React 侧面板(value 对应的原组件) */
  legacy: React.ReactNode;
  /** Vue 完整版子应用 hash 路由 */
  vueRoute: string;
  /** 融合视图标题(避开闭源原名的重命名) */
  title: string;
  /** 能力差异说明(提示两形态) */
  hint: string;
}

export default function FusionPanel({ tab }: { tab: FusionTabDef }) {
  const [mode, setMode] = useState<"legacy" | "vue">("legacy");

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "hsl(222 47% 7%)" }}>
      {/* 融合 chrome(马克思深色主题: 背景 hsl222/7, 边框 hsl217/20, 主蓝 hsl214/48) */}
      <div
        className="flex shrink-0 items-center gap-3 px-4 py-2"
        style={{ background: "hsl(222 45% 12%)", borderBottom: "1px solid hsl(217 33% 20%)" }}
      >
        <div className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold" style={{ color: "hsl(210 40% 96%)" }}>{tab.title}</span>
          <span className="truncate text-[10px]" style={{ color: "hsl(215 20% 62%)" }}>{tab.hint}</span>
        </div>
        <div className="ml-auto flex shrink-0 rounded-lg p-0.5" style={{ background: "hsl(222 40% 18%)" }}>
          <button
            onClick={() => setMode("legacy")}
            className="rounded-md px-3 py-1 text-[11.5px] font-medium transition-colors"
            style={mode === "legacy"
              ? { background: "hsl(214 55% 48%)", color: "#fff" }
              : { color: "hsl(215 20% 62%)" }}
          >
            精简工具
          </button>
          <button
            onClick={() => setMode("vue")}
            className="rounded-md px-3 py-1 text-[11.5px] font-medium transition-colors"
            style={mode === "vue"
              ? { background: "hsl(214 55% 48%)", color: "#fff" }
              : { color: "hsl(215 20% 62%)" }}
          >
            完整工作流
          </button>
        </div>
      </div>
      {/* 主体: React 面板 or Vue iframe */}
      <div className="min-h-0 flex-1" style={{ display: mode === "legacy" ? "block" : "none", background: "hsl(222 47% 7%)" }}>
        {mode === "legacy" ? tab.legacy : null}
      </div>
      {mode === "vue" && (
        <iframe
          src={`/soc/index.html#${tab.vueRoute}`}
          title={tab.title}
          className="min-h-0 flex-1"
          style={{ width: "100%", border: 0, background: "#fff" }}
          allow="clipboard-write; clipboard-read"
        />
      )}
    </div>
  );
}
