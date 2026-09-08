/**
 * SocialSciVueHost — 在 React 父级 iframe 内嵌 Vue3 子应用视图
 * 嵌入架构: vue 子工程独立构建到 web/dist/soc(后端 fastify-static root=web/dist 已托管),
 * 父级经 viewRegistry 注册 6 个入口, 每个渲染本宿主, route 决定子应用 hash 路由。
 * dev 模式: 根 vite.config.ts server.proxy 增 "/soc" → http://127.0.0.1:5174。
 */
import React, { useEffect, useRef } from "react";

export interface SocialSciRouteDef {
  key: string;
  label: string;
  route: string; // 子应用 hash 路由路径, 如 "/workflow/input"
}

export const SOCIALSCI_ROUTES: SocialSciRouteDef[] = [
  { key: "soc-workflow", label: "在线科研工作流", route: "/workflow/input" },
  { key: "soc-review", label: "在线科研审查", route: "/review" },
  { key: "soc-statistics", label: "在线数据分析", route: "/statistics" },
  { key: "soc-viz", label: "在线科研绘图", route: "/viz" },
  { key: "soc-editor", label: "学术文本编辑器", route: "/editor" },
  { key: "soc-quick", label: "可视化DAG编排", route: "/workbench/quick" }
];

export default function SocialSciVueHost({ route = "/workflow/input", label }: { route?: string; label?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const f = ref.current;
    if (!f) return;
    const sync = () => {
      try {
        // 让子 iframe 每次激活重新加载目标路由(父级 hash 导航时跟随)
        const want = `/soc/index.html#${route}`;
        const cur = f.contentWindow?.location.href ?? "";
        if (cur && !cur.endsWith(`#${route}`)) {
          f.contentWindow?.location.assign(want);
        }
      } catch {
        /* 跨域忽略 */
      }
    };
    sync();
  }, [route]);

  return (
    <div style={{ width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "#f3f5f8" }}>
      {label ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
          <strong style={{ fontSize: 13, color: "#1e293b" }}>{label}</strong>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>SocialSci Vue3 还原版 · 闭源实现逻辑 1:1</span>
        </div>
      ) : null}
      <iframe
        ref={ref}
        src={`/soc/index.html#${route}`}
        title={label ?? "SocialSci Vue"}
        style={{ flex: 1, width: "100%", border: 0, minHeight: 0, background: "#fff" }}
        allow="clipboard-write; clipboard-read"
      />
    </div>
  );
}
